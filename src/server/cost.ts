"use server";

import { revalidatePath } from "next/cache";
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
    sku: p.sku,
    sort: p.sort,
    salePrice: num(p.salePrice),
    packagingId: p.packagingId,
    status: p.status,
    details: p.details.map((d) => ({ detailId: d.detailId, quantity: d.quantity })),
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
    lines: op.lines.map((l) => ({ detailId: l.detailId, quantity: l.quantity })),
  };
}

// ============================ ОТЧЁТ «СЕБЕСТОИМОСТЬ» =========================

export interface CostReport {
  details: CostDetailRow[];
  products: CostProductRow[];
}

/**
 * Отчёт себестоимости на реальных данных производства (Этап 9).
 * Произведённые детали — из операций ТОРЦОВКИ, изделия — из УПАКОВКИ.
 * Накладные = 0 (распределение производственных расходов — Этап 10/12),
 * поэтому полная себестоимость = прямой.
 */
export async function getCostReport(): Promise<CostReport> {
  const [batches, details, employees, items, products, ops] = await Promise.all([
    prisma.batch.findMany({ orderBy: { purchaseDate: "desc" } }),
    prisma.detail.findMany(),
    prisma.employee.findMany(),
    prisma.nomenclatureItem.findMany(),
    prisma.product.findMany({ include: { details: true, fasteners: true, extras: true } }),
    prisma.productionOperation.findMany({
      where: { type: { in: ["TORCOVKA", "UPAKOVKA"] } },
      include: { lines: true },
    }),
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
      details: domainDetails,
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
      periodOverhead: 0,
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
  detailsById: Map<string, PrismaDetail>,
): BatchSnapshotData | null {
  const lines = allLines.filter((l) => l.batchId === batch.id);
  if (lines.length === 0) return null;

  let len1 = D(0);
  let len2 = D(0);
  for (const line of lines) {
    const detail = detailsById.get(line.detailId);
    if (!detail) continue;
    const len = dec(detail.lengthM).times(line.quantity);
    if (detail.sort === "SORT1") len1 = len1.plus(len);
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
 * Пересчёт ПРЕДВАРИТЕЛЬНЫХ снапшотов открытых партий (closedAt == null).
 * Закрытые партии заморожены (cost-integrity) и не пересчитываются.
 * Вызывается синхронно из операций производства/закупок.
 */
export async function recalcBatchCosts(opts: { batchId?: string; db?: Db } = {}): Promise<void> {
  const db = opts.db ?? prisma;

  const batches = await db.batch.findMany({
    where: { closedAt: null, ...(opts.batchId ? { id: opts.batchId } : {}) },
  });
  if (batches.length === 0) return;

  const batchIds = batches.map((b) => b.id);
  const [ops, details] = await Promise.all([
    db.productionOperation.findMany({
      where: { type: "TORCOVKA", batchId: { in: batchIds } },
      include: { lines: true },
    }),
    db.detail.findMany(),
  ]);

  const lines = producedLinesFromOperations(ops.map(toOperationForCost));
  const detailsById = new Map(details.map((d) => [d.id, d]));

  for (const batch of batches) {
    // У открытой партии возможен только PRELIMINARY-снапшот — заменяем его.
    await db.batchCost.deleteMany({ where: { batchId: batch.id, status: "PRELIMINARY" } });
    const snapshot = computeBatchSnapshot(batch, lines, detailsById);
    if (!snapshot) continue;
    await db.batchCost.create({
      data: { batchId: batch.id, status: "PRELIMINARY", ...snapshot },
    });
  }
}

/**
 * Закрытие партии: перевод в архив, заморозка себестоимости (снапшот FINAL).
 * После заморозки снапшот не пересчитывается (recalcBatchCosts пропускает
 * закрытые партии). Идемпотентно для уже закрытой партии — ошибка.
 */
export async function closeBatch(id: string): Promise<void> {
  const before = await prisma.batch.findUnique({ where: { id } });
  if (!before) throw new Error("Партия не найдена");
  if (before.closedAt) throw new Error("Партия уже закрыта");

  await prisma.$transaction(async (tx) => {
    const details = await tx.detail.findMany();
    const ops = await tx.productionOperation.findMany({
      where: { type: "TORCOVKA", batchId: id },
      include: { lines: true },
    });
    const lines = producedLinesFromOperations(ops.map(toOperationForCost));
    const detailsById = new Map(details.map((d) => [d.id, d]));
    const snapshot = computeBatchSnapshot(before, lines, detailsById);

    await tx.batch.update({
      where: { id },
      data: { status: "ARCHIVED", closedAt: new Date() },
    });

    // Замораживаем: убираем предварительный снапшот, фиксируем FINAL.
    await tx.batchCost.deleteMany({ where: { batchId: id } });
    if (snapshot) {
      await tx.batchCost.create({ data: { batchId: id, status: "FINAL", ...snapshot } });
    }

    await writeChangeLog(
      {
        entity: "Batch",
        entityId: id,
        oldValues: { status: before.status, closedAt: null },
        newValues: { status: "ARCHIVED", closedAt: new Date().toISOString(), costFrozen: true },
      },
      tx,
    );
  });

  revalidatePath("/purchases");
  revalidatePath("/reports");
}
