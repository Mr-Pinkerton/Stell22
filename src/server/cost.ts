"use server";

import { Decimal } from "decimal.js";
import type {
  Batch as PrismaBatch,
  Detail as PrismaDetail,
  Employee as PrismaEmployee,
  NomenclatureItem as PrismaItem,
  Prisma,
} from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { notifyEvent } from "@/server/notifications";
import { D, distributeBatchCost, sectionAreaM2 } from "@/lib/cost";
import {
  buildCostDetailRows,
  buildCostProductRows,
  producedLinesFromOperations,
  producedProductQtyFromOperations,
  type CostDetailRow,
  type CostProductRow,
  type OperationForCost,
  type ProducedLine,
} from "@/lib/cost-report";
import type { Batch, Detail, Employee, NomenclatureItem, Product } from "@/types/domain";

// Любой клиент Prisma — обычный или транзакционный (для атомарной заморозки).
type Db = typeof prisma | Prisma.TransactionClient;

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

function dec(value: Prisma.Decimal | number | null): Decimal {
  return D(num(value));
}

// ============================ СЕРИАЛИЗАЦИЯ =================================

function serBatch(b: PrismaBatch): Batch {
  return {
    id: b.id,
    name: b.name,
    sectionWidthMm: num(b.sectionWidthMm),
    sectionHeightMm: num(b.sectionHeightMm),
    purchaseCost: num(b.purchaseCost),
    totalCost: num(b.totalCost),
    priceSort1: num(b.priceSort1),
    priceSort2: num(b.priceSort2),
    status: b.status,
    purchaseDate: b.purchaseDate.toISOString().slice(0, 10),
    note: b.note,
  };
}

function serDetail(d: PrismaDetail): Detail {
  return {
    id: d.id,
    name: d.name,
    detailNumber: d.detailNumber,
    lengthM: num(d.lengthM),
    detailType: d.detailType,
    sort: d.sort,
    prisadkaTorcevaya: d.prisadkaTorcevaya,
    prisadkaPloskost: d.prisadkaPloskost,
    status: d.status,
  };
}

function serEmployee(e: PrismaEmployee): Employee {
  return {
    id: e.id,
    fullName: e.fullName,
    pin: e.pin,
    status: e.status,
    hourlyRate: num(e.hourlyRate),
    rateTorcovkaSort1: num(e.rateTorcovkaSort1),
    rateTorcovkaSort2: num(e.rateTorcovkaSort2),
    ratePrisadkaTorcev: num(e.ratePrisadkaTorcev),
    ratePrisadkaPloskt: num(e.ratePrisadkaPloskt),
    rateUpakovka: num(e.rateUpakovka),
  };
}

function serItem(n: PrismaItem): NomenclatureItem {
  return {
    id: n.id,
    name: n.name,
    type: n.type,
    unitPrice: num(n.unitPrice),
    status: n.status,
    minStock: n.minStock,
  };
}

type ProductWithRelations = Prisma.ProductGetPayload<{
  include: { details: true; fasteners: true; extras: true };
}>;

function serProduct(p: ProductWithRelations): Product {
  return {
    id: p.id,
    name: p.name,
    skuOzon: p.skuOzon,
    skuWb: p.skuWb,
    sort: p.sort,
    packagingId: p.packagingId,
    status: p.status,
    details: p.details.map((d) => ({
      detailId: d.detailId,
      quantity: d.quantity,
    })),
    fastenerIds: p.fasteners.map((f) => ({ nomenclatureId: f.nomenclatureId, quantity: f.quantity })),
    extraIds: p.extras.map((e) => e.nomenclatureId),
  };
}

type OpWithLines = Prisma.ProductionOperationGetPayload<{ include: { lines: true } }>;

function toOperationForCost(op: OpWithLines): OperationForCost {
  return {
    type: op.type,
    batchId: op.batchId,
    productId: op.productId,
    productQty: op.productQty,
    lines: op.lines.map((l) => ({
      lengthM: l.blankLengthM == null ? null : num(l.blankLengthM),
      sort: l.blankSort,
      quantity: l.quantity,
    })),
  };
}

// ============================ ОТЧЁТ «СЕБЕСТОИМОСТЬ» =========================

export interface CostReport {
  details: CostDetailRow[];
  products: CostProductRow[];
}

/**
 * Сумма накладных периода: расходные операции ДДС (EXPENSE) по статьям,
 * чья категория помечена «Производственные (накладные)» (isOverhead).
 * ЗП производства в накладные НЕ входит — она в сдельных операциях, не в ДДС
 * по накладным статьям (cost-integrity: без двойного счёта).
 * Период пока не фильтруется — берём всё накопленное (предварительно).
 */
export async function getPeriodOverhead(db: Db = prisma): Promise<Decimal> {
  const flows = await db.cashFlow.findMany({
    where: { flowType: "EXPENSE", article: { category: { isOverhead: true } } },
    select: { amount: true },
  });
  return flows.reduce((sum, f) => sum.plus(dec(f.amount)), D(0));
}

/**
 * Отчёт себестоимости на реальных данных производства (Этап 9 + 12).
 * Произведённые детали — из операций ТОРЦОВКИ, изделия — из УПАКОВКИ.
 * Накладные распределяются пропорционально прямой себестоимости периода
 * (см. «МОДЕЛЬ СЕБЕСТОИМОСТИ» в v2). Полная = прямая + накладные.
 */
export async function getCostReport(): Promise<CostReport> {
  const [batches, details, employees, items, products, ops, periodOverhead] = await Promise.all([
    prisma.batch.findMany({ orderBy: { purchaseDate: "desc" } }),
    prisma.detail.findMany(),
    prisma.employee.findMany(),
    prisma.nomenclatureItem.findMany(),
    prisma.product.findMany({ include: { details: true, fasteners: true, extras: true } }),
    prisma.productionOperation.findMany({
      where: { type: { in: ["TORCOVKA", "UPAKOVKA"] } },
      include: { lines: true },
    }),
    getPeriodOverhead(),
  ]);

  const opsForCost = ops.map(toOperationForCost);
  const lines = producedLinesFromOperations(opsForCost);
  const producedProductQty = producedProductQtyFromOperations(opsForCost);

  const domainBatches = batches.map(serBatch);
  const domainDetails = details.map(serDetail);
  const domainEmployees = employees.map(serEmployee);

  return {
    details: buildCostDetailRows({
      batches: domainBatches,
      employees: domainEmployees,
      lines,
    }),
    products: buildCostProductRows({
      products: products.map(serProduct),
      batches: domainBatches,
      details: domainDetails,
      employees: domainEmployees,
      nomenclature: items.map(serItem),
      lines,
      producedProductQty,
      periodOverhead,
    }),
  };
}

// ============================ СНАПШОТЫ ПАРТИЙ ===============================

interface BatchSnapshotData {
  volumeSort1: string;
  volumeSort2: string;
  costSort1: string;
  costSort2: string;
  pricePerM3Sort1: string;
  pricePerM3Sort2: string;
}

/** Снапшот распределения стоимости партии по сортам, либо null без производства. */
function computeBatchSnapshot(
  batch: PrismaBatch,
  allLines: ProducedLine[],
): BatchSnapshotData | null {
  const lines = allLines.filter((l) => l.batchId === batch.id);
  if (lines.length === 0) return null;

  let len1 = D(0);
  let len2 = D(0);
  for (const line of lines) {
    const len = dec(line.lengthM).times(line.quantity);
    if (line.sort === "SORT1") len1 = len1.plus(len);
    else len2 = len2.plus(len);
  }

  const dist = distributeBatchCost({
    totalCost: dec(batch.totalCost),
    priceSort1: dec(batch.priceSort1),
    priceSort2: dec(batch.priceSort2),
    sectionAreaM2: sectionAreaM2(num(batch.sectionWidthMm), num(batch.sectionHeightMm)),
    producedLengthSort1: len1,
    producedLengthSort2: len2,
  });

  // Полную точность отдаём в Postgres строкой — он округлит до scale столбца.
  return {
    volumeSort1: dist.volumeSort1.toString(),
    volumeSort2: dist.volumeSort2.toString(),
    costSort1: dist.costSort1.toString(),
    costSort2: dist.costSort2.toString(),
    pricePerM3Sort1: dist.pricePerM3Sort1.toString(),
    pricePerM3Sort2: dist.pricePerM3Sort2.toString(),
  };
}

/**
 * Пересчёт ПРЕДВАРИТЕЛЬНЫХ снапшотов незамороженных партий (frozenAt == null).
 * Выработанная (архивная), но ещё не выплаченная партия пересчитывается —
 * заморожена только после выплаты всех операций (cost-integrity).
 * Вызывается синхронно из операций производства/закупок.
 */
export async function recalcBatchCosts(opts: { batchId?: string; db?: Db } = {}): Promise<void> {
  const db = opts.db ?? prisma;

  const batches = await db.batch.findMany({
    where: { frozenAt: null, ...(opts.batchId ? { id: opts.batchId } : {}) },
  });
  if (batches.length === 0) return;

  const batchIds = batches.map((b) => b.id);
  const ops = await db.productionOperation.findMany({
    where: { type: "TORCOVKA", batchId: { in: batchIds } },
    include: { lines: true },
  });

  const lines = producedLinesFromOperations(ops.map(toOperationForCost));

  for (const batch of batches) {
    // У открытой партии возможен только PRELIMINARY-снапшот — заменяем его.
    await db.batchCost.deleteMany({ where: { batchId: batch.id, status: "PRELIMINARY" } });
    const snapshot = computeBatchSnapshot(batch, lines);
    if (!snapshot) continue;
    await db.batchCost.create({
      data: { batchId: batch.id, status: "PRELIMINARY", ...snapshot },
    });
  }
}

/**
 * Заморозка себестоимости партии: снапшот FINAL + frozenAt.
 * Вызывается ТОЛЬКО когда партия выработана (closedAt) и все её операции
 * торцовки выплачены — править распределение больше нельзя. После заморозки
 * recalcBatchCosts партию пропускает (frozenAt != null).
 */
async function freezeBatch(tx: Prisma.TransactionClient, batch: PrismaBatch): Promise<void> {
  const ops = await tx.productionOperation.findMany({
    where: { type: "TORCOVKA", batchId: batch.id },
    include: { lines: true },
  });
  const lines = producedLinesFromOperations(ops.map(toOperationForCost));
  const snapshot = computeBatchSnapshot(batch, lines);

  await tx.batch.update({ where: { id: batch.id }, data: { frozenAt: new Date() } });

  // Замораживаем: убираем предварительный снапшот, фиксируем FINAL.
  await tx.batchCost.deleteMany({ where: { batchId: batch.id } });
  if (snapshot) {
    await tx.batchCost.create({ data: { batchId: batch.id, status: "FINAL", ...snapshot } });
  }

  await writeChangeLog(
    {
      entity: "Batch",
      entityId: batch.id,
      newValues: { frozenAt: new Date().toISOString(), costFrozen: true },
    },
    tx,
  );
  await notifyEvent(
    {
      key: `event:batch-frozen:${batch.id}`,
      title: `Партия «${batch.name}»`,
      message: "Себестоимость заморожена — все операции выплачены",
      tone: "SUCCESS",
      href: "/reports",
    },
    tx,
  );
}

/**
 * Заморозить партию, если она уже выработана (closedAt) и ВСЕ её операции
 * торцовки выплачены. До выплаты снапшот остаётся PRELIMINARY и пересчитывается
 * при правках операций (cost-integrity: «правка до выплаты → пересчёт
 * предварительных»). Вызывается из выплаты ЗП и из архивации при выработке.
 */
export async function maybeFreezeBatch(
  tx: Prisma.TransactionClient,
  batchId: string,
): Promise<boolean> {
  const batch = await tx.batch.findUnique({ where: { id: batchId } });
  if (!batch || batch.frozenAt) return false;
  // Замораживаем только выработанную (архивную) партию.
  if (!batch.closedAt) return false;

  const unpaid = await tx.productionOperation.count({
    where: { batchId, type: "TORCOVKA", isPaid: false },
  });
  if (unpaid > 0) return false;

  await freezeBatch(tx, batch);
  return true;
}

/**
 * Архивация партии при выработке: весь остаток реек списан/выработан
 * (Σ остатка = 0) → статус ARCHIVED + closedAt. Себестоимость НЕ замораживается
 * (снапшот остаётся PRELIMINARY, правки операций продолжают пересчёт). Если все
 * операции уже выплачены — сразу же замораживает (maybeFreezeBatch).
 * Вызывается внутри транзакции операции (торцовка/списание остатка).
 */
export async function archiveBatchIfDepleted(
  tx: Prisma.TransactionClient,
  batchId: string,
): Promise<boolean> {
  const batch = await tx.batch.findUnique({ where: { id: batchId } });
  if (!batch || batch.closedAt) return false;

  const lots = await tx.railLot.findMany({
    where: { batchId },
    select: { remainingQuantity: true },
  });
  // Партия без реек ещё не выработана — не закрываем по «пустому» остатку.
  if (lots.length === 0) return false;
  const remaining = lots.reduce((s, l) => s + l.remainingQuantity, 0);
  if (remaining > 0) return false;

  await tx.batch.update({
    where: { id: batchId },
    data: { status: "ARCHIVED", closedAt: new Date() },
  });
  await writeChangeLog(
    {
      entity: "Batch",
      entityId: batchId,
      oldValues: { status: batch.status, closedAt: null },
      newValues: { status: "ARCHIVED", closedAt: new Date().toISOString(), depleted: true },
    },
    tx,
  );
  await notifyEvent(
    {
      key: `event:batch-closed:${batchId}`,
      title: `Партия «${batch.name}»`,
      message: "Выработана — остаток списан, партия в архиве",
      tone: "SUCCESS",
      href: "/purchases",
    },
    tx,
  );

  // Если по партии уже всё выплачено — можно замораживать сразу.
  await maybeFreezeBatch(tx, batchId);
  return true;
}
