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
  blendedCostPerMeterByMaterial,
  buildBatchSnapshots,
  buildCostDetailRows,
  buildCostProductRows,
  detailWorkCost,
  producedLinesFromOperations,
  producedProductQtyFromOperations,
  type AvgRates,
  type CostDetailRow,
  type CostProductRow,
  type FrozenBatchCost,
  type OperationForCost,
  type ProducedLine,
} from "@/lib/cost-report";
import { actualProductionRates, type ProductionRateOp } from "@/lib/payroll";
import { dayKey } from "@/lib/entries";
import { getMonthPeriod, type Period } from "@/lib/dates";
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
    materialId: b.materialId,
    sectionWidthMm: num(b.sectionWidthMm),
    sectionHeightMm: num(b.sectionHeightMm),
    purchaseCost: num(b.purchaseCost),
    totalCost: num(b.totalCost),
    priceSort1: num(b.priceSort1),
    priceSort2: num(b.priceSort2),
    status: b.status,
    purchaseDate: b.purchaseDate.toISOString().slice(0, 10),
    note: b.note,
    frozenAt: b.frozenAt ? b.frozenAt.toISOString() : null,
  };
}

function serDetail(d: PrismaDetail): Detail {
  return {
    id: d.id,
    name: d.name,
    materialId: d.materialId,
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
    materialId: p.materialId,
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
 * Только подтверждённые счета (A13): операции из карантина импорта не считаем.
 * `period` ограничивает выборку по дате ДДС; без периода — всё накопленное (A11).
 */
export async function getPeriodOverhead(
  period?: Period | null,
  db: Db = prisma,
): Promise<Decimal> {
  const flows = await db.cashFlow.findMany({
    where: {
      flowType: "EXPENSE",
      article: { category: { isOverhead: true } },
      // Карантин (A13): накладные с неподтверждённого счёта импорта не считаем —
      // как и в ДДС/KPI/себестоимости сделок.
      account: { confirmed: true },
      ...(period ? { date: { gte: period.start, lte: period.end } } : {}),
    },
    select: { amount: true },
  });
  return flows.reduce((sum, f) => sum.plus(dec(f.amount)), D(0));
}

/**
 * Отчёт себестоимости на реальных данных производства (Этап 9 + 12).
 * Произведённые детали — из операций ТОРЦОВКИ, изделия — из УПАКОВКИ.
 * Накладные распределяются пропорционально прямой себестоимости периода
 * (см. «МОДЕЛЬ СЕБЕСТОИМОСТИ» в v2). Полная = прямая + накладные.
 *
 * Периодность (A11/A12): дата производства = дата упаковки/операции (`workDate`).
 * ОХВАТ отчёта (какие строки, произведённые изделия, работа, накладные) —
 * ограничен `period`. Но ОЦЕНКА ₽/м³ каждой партии считается по ПОЛНОМУ её
 * производству (снапшоты на `fullLines`), иначе отход исказит цену заготовки.
 * `period = null` → отчёт за всё время; по умолчанию — текущий календарный месяц.
 */
/**
 * Единый контекст расчёта себестоимости (общий для отчёта и оценки склада) —
 * один путь загрузки/снапшотов/ставок, чтобы формулы не расходились (A15).
 */
interface CostContext {
  domainBatches: Batch[];
  domainDetails: Detail[];
  domainEmployees: Employee[];
  products: Product[];
  nomenclature: NomenclatureItem[];
  snapshots: ReturnType<typeof buildBatchSnapshots>;
  frozen: Map<string, FrozenBatchCost>;
  actualRates: AvgRates;
  periodLines: ProducedLine[];
  fullLines: ProducedLine[];
  producedProductQty: Record<string, number>;
  periodOverhead: Decimal;
}

async function loadCostContext(period: Period | null): Promise<CostContext> {
  const [batches, details, employees, items, products, ops, periodOverhead, finalCosts] =
    await Promise.all([
      prisma.batch.findMany({ orderBy: { purchaseDate: "desc" } }),
      prisma.detail.findMany(),
      prisma.employee.findMany(),
      prisma.nomenclatureItem.findMany(),
      prisma.product.findMany({ include: { details: true, fasteners: true, extras: true } }),
      // Все типы операций — торцовка/упаковка дают произведённое, а HOURS и
      // присадка нужны для факт. средних расценок работы (A6).
      prisma.productionOperation.findMany({ include: { lines: true } }),
      getPeriodOverhead(period),
      prisma.batchCost.findMany({ where: { status: "FINAL" } }),
    ]);

  const inPeriod = (d: Date): boolean =>
    !period || (d >= period.start && d <= period.end);
  const periodOps = ops.filter((op) => inPeriod(op.workDate));

  // ОЦЕНКА: ₽/м³ партии — по полному её производству (весь отход зашит в цену).
  const fullLines = producedLinesFromOperations(ops.map(toOperationForCost));
  // ОХВАТ: строки деталей и произведённые изделия — только за период.
  const periodOpsForCost = periodOps.map(toOperationForCost);
  const periodLines = producedLinesFromOperations(periodOpsForCost);
  const producedProductQty = producedProductQtyFromOperations(periodOpsForCost);

  // Работа в себестоимости — фактическая средняя по производству (A6, v2 §2):
  // сдельная ставка исполнителя + доля почасовой оплаты его смены, а не
  // среднее по карточкам всех активных. Считаем по операциям периода.
  const ZERO_RATES = {
    hourly: 0,
    torcovkaSort1: 0,
    torcovkaSort2: 0,
    prisadkaTorcev: 0,
    prisadkaPlosk: 0,
    upakovka: 0,
  };
  const ratesByEmp = new Map(
    employees.map((e) => [
      e.id,
      {
        hourly: num(e.hourlyRate),
        torcovkaSort1: num(e.rateTorcovkaSort1),
        torcovkaSort2: num(e.rateTorcovkaSort2),
        prisadkaTorcev: num(e.ratePrisadkaTorcev),
        prisadkaPlosk: num(e.ratePrisadkaPloskt),
        upakovka: num(e.rateUpakovka),
      },
    ]),
  );
  const detailSort = new Map(details.map((d) => [d.id, d.sort]));
  const rateOps: ProductionRateOp[] = periodOps.map((op) => ({
    type: op.type,
    employeeId: op.employeeId,
    dayKey: dayKey(op.workDate),
    rates: ratesByEmp.get(op.employeeId) ?? ZERO_RATES,
    hours: num(op.hours),
    productQty: op.productQty,
    lines: op.lines.map((l) => ({
      quantity: l.quantity,
      sort: l.blankSort ?? (l.detailId ? detailSort.get(l.detailId) : undefined),
      prisadkaTorcevaya: l.prisadkaTorcevaya,
      prisadkaPloskost: l.prisadkaPloskost,
    })),
  }));
  const unit = actualProductionRates(rateOps);
  const actualRates: AvgRates = {
    torcovkaSort1: D(unit.torcovkaSort1),
    torcovkaSort2: D(unit.torcovkaSort2),
    prisadkaTorcev: D(unit.prisadkaTorcev),
    prisadkaPlosk: D(unit.prisadkaPlosk),
    upakovka: D(unit.upakovka),
  };

  // Замороженные партии: берём сохранённый FINAL-снапшот, а не live-пересчёт
  // (A3, cost-integrity — заморозку править нельзя).
  const frozen = new Map<string, FrozenBatchCost>(
    finalCosts.map((c) => [
      c.batchId,
      {
        volumeSort1: num(c.volumeSort1),
        volumeSort2: num(c.volumeSort2),
        costSort1: num(c.costSort1),
        costSort2: num(c.costSort2),
        pricePerM3Sort1: num(c.pricePerM3Sort1),
        pricePerM3Sort2: num(c.pricePerM3Sort2),
      },
    ]),
  );

  const domainBatches = batches.map(serBatch);
  const domainDetails = details.map(serDetail);
  const domainEmployees = employees.map(serEmployee);

  // Снапшоты — по ПОЛНОМУ производству (оценка ₽/м³), общие для деталей и изделий.
  const snapshots = buildBatchSnapshots({ batches: domainBatches, lines: fullLines, frozen });

  return {
    domainBatches,
    domainDetails,
    domainEmployees,
    products: products.map(serProduct),
    nomenclature: items.map(serItem),
    snapshots,
    frozen,
    actualRates,
    periodLines,
    fullLines,
    producedProductQty,
    periodOverhead,
  };
}

/** Строки таба «Изделия» из контекста (общий вызов для отчёта и оценки). */
function productRowsFromContext(ctx: CostContext): CostProductRow[] {
  return buildCostProductRows({
    products: ctx.products,
    batches: ctx.domainBatches,
    details: ctx.domainDetails,
    employees: ctx.domainEmployees,
    nomenclature: ctx.nomenclature,
    lines: ctx.fullLines,
    producedProductQty: ctx.producedProductQty,
    periodOverhead: ctx.periodOverhead,
    frozen: ctx.frozen,
    rates: ctx.actualRates,
    snapshots: ctx.snapshots,
  });
}

export async function getCostReport(
  period: Period | null = getMonthPeriod(),
): Promise<CostReport> {
  const ctx = await loadCostContext(period);
  return {
    details: buildCostDetailRows({
      batches: ctx.domainBatches,
      employees: ctx.domainEmployees,
      lines: ctx.periodLines, // охват периода
      frozen: ctx.frozen,
      rates: ctx.actualRates,
      snapshots: ctx.snapshots, // оценка по полному производству
    }),
    products: productRowsFromContext(ctx),
  };
}

/**
 * Себестоимость единицы для оценки склада/инвентаризации (A10, «Потеря ГП»).
 *  - product: полная себестоимость (материал+работа+доп+накладные);
 *  - detail: материал (WAC ₽/м по породе×сорту × длина) + работа (факт. ставки);
 *  - nomenclature: цена номенклатуры.
 * Значения — снапшот на момент вызова (себестоимость не заморожена, PRELIMINARY).
 */
export interface UnitCostSnapshot {
  productFull: Map<string, number>;
  detailUnit: Map<string, number>;
  nomenclatureUnit: Map<string, number>;
}

export async function getUnitCostSnapshot(
  period: Period | null = getMonthPeriod(),
): Promise<UnitCostSnapshot> {
  const ctx = await loadCostContext(period);

  const productFull = new Map(productRowsFromContext(ctx).map((r) => [r.id, r.full]));

  const batchMaterial = new Map(ctx.domainBatches.map((b) => [b.id, b.materialId]));
  const perMeterByMaterial = blendedCostPerMeterByMaterial(ctx.snapshots, batchMaterial);
  const detailUnit = new Map<string, number>();
  for (const d of ctx.domainDetails) {
    const pm = perMeterByMaterial.get(d.materialId);
    const perM = pm ? (d.sort === "SORT1" ? pm.sort1 : pm.sort2) : D(0);
    const material = perM.times(D(d.lengthM));
    const work = detailWorkCost(d, ctx.actualRates);
    detailUnit.set(d.id, material.plus(work).toDecimalPlaces(2).toNumber());
  }

  const nomenclatureUnit = new Map(ctx.nomenclature.map((n) => [n.id, n.unitPrice]));

  return { productFull, detailUnit, nomenclatureUnit };
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
