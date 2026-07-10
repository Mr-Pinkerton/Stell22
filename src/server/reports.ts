"use server";

import type {
  Batch as PrismaBatch,
  Prisma,
  RailLot as PrismaRailLot,
} from "@prisma/client";
import { prisma } from "@/server/db";
import { computeBatchStats } from "@/lib/batch-stats";
import {
  declaredSortShares,
  factSortShares,
  producedLinesFromOperations,
  sortSharesToPercents,
  type OperationForCost,
} from "@/lib/cost-report";
import { batchWaste, employeeWaste } from "@/lib/waste";
import type { Batch, RailLot } from "@/types/domain";
import type {
  PurchasePackageLine,
  PurchaseReportRow,
  WasteBatchRow,
  WasteEmployeeRow,
} from "@/mocks/report-fixtures";

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

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

function serLot(l: PrismaRailLot): RailLot {
  return {
    id: l.id,
    batchId: l.batchId,
    lengthM: num(l.lengthM),
    railType: l.railType,
    sort: l.sort,
    isPackage: l.isPackage,
    code: l.code,
    rows: l.rows,
    layers: l.layers,
    quantity: l.quantity,
    remainingQuantity: l.remainingQuantity,
  };
}

type TorcovkaOp = Prisma.ProductionOperationGetPayload<{ include: { lines: true } }>;

function toOperationForCost(op: TorcovkaOp): OperationForCost {
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

// ============================ ОТЧЁТ «ЗАКУПКИ» ==============================

/**
 * Отчёт «Закупки» на реальных данных: соотношение сортов закупка/факт.
 * Заявленное — по закупленным рейкам; фактическое — по сортам произведённых
 * деталей (операции ТОРЦОВКИ). Без производства факт = заявленному.
 * Работник пакета — последний торцевавший из этого пакета (по дате операции).
 */
export async function getPurchaseReport(): Promise<PurchaseReportRow[]> {
  const [batches, lots, ops, employees] = await Promise.all([
    prisma.batch.findMany({ orderBy: { purchaseDate: "desc" } }),
    prisma.railLot.findMany(),
    prisma.productionOperation.findMany({
      where: { type: "TORCOVKA" },
      include: { lines: true },
      orderBy: { workDate: "asc" },
    }),
    prisma.employee.findMany({ select: { id: true, fullName: true } }),
  ]);

  const domainBatches = batches.map(serBatch);
  const domainLots = lots.map(serLot);
  const producedLines = producedLinesFromOperations(ops.map(toOperationForCost));

  const empName = new Map(employees.map((e) => [e.id, e.fullName]));
  // Последняя торцовка по каждому пакету (ops уже отсортированы по дате) → работник.
  const workerByLot = new Map<string, string>();
  for (const op of ops) {
    if (op.railLotId) workerByLot.set(op.railLotId, empName.get(op.employeeId) ?? "—");
  }

  return domainBatches.map((batch) => {
    const batchLots = domainLots.filter((l) => l.batchId === batch.id);
    const batchLines = producedLines.filter((l) => l.batchId === batch.id);
    const stats = computeBatchStats(batch, domainLots);

    const declared = sortSharesToPercents(declaredSortShares(batchLots));
    const fact =
      batchLines.length > 0 ? sortSharesToPercents(factSortShares(batchLines)) : declared;

    const area = batch.sectionWidthMm && batch.sectionHeightMm
      ? (batch.sectionWidthMm / 1000) * (batch.sectionHeightMm / 1000)
      : 0;

    const packages: PurchasePackageLine[] = batchLots.map((lot) => ({
      id: lot.id,
      code: lot.code ?? null,
      isPackage: lot.isPackage,
      lengthM: lot.lengthM,
      railType: lot.railType,
      sort: lot.sort,
      quantity: lot.quantity,
      remainingQuantity: lot.remainingQuantity,
      volumeM3: lot.quantity * area * lot.lengthM,
      rows: lot.rows,
      layers: lot.layers,
      workerName: workerByLot.get(lot.id) ?? "—",
    }));

    return {
      id: batch.id,
      name: batch.name,
      purchaseDate: batch.purchaseDate,
      totalCost: batch.totalCost,
      volumeM3: stats.volumeM3,
      sortPurchasePct: declared,
      sortFactPct: fact,
      avgCostPerM3: stats.volumeM3 > 0 ? Math.round(batch.totalCost / stats.volumeM3) : 0,
      status: batch.status,
      packages,
    };
  });
}

// ============================ ОТЧЁТ «ПРОЦЕНТ ОТХОДА» =======================

export interface WasteReport {
  batches: WasteBatchRow[];
  employees: WasteEmployeeRow[];
}

/**
 * Отчёт «Процент отхода» на реальных данных.
 * Метры взятого — railsTaken × длина рейки пакета (ТОРЦОВКА); произведённого —
 * Σ длина детали × количество. Списано = (закуплено − остаток) − взято
 * (когда часть пакета списана в отход без производства). Проценты — движок
 * lib/waste, чтобы числа были внутренне согласованы (cost-integrity).
 */
export async function getWasteReport(): Promise<WasteReport> {
  const [batches, lots, ops, employees] = await Promise.all([
    prisma.batch.findMany({ orderBy: { purchaseDate: "desc" } }),
    prisma.railLot.findMany(),
    prisma.productionOperation.findMany({
      where: { type: "TORCOVKA" },
      include: { lines: true },
    }),
    prisma.employee.findMany({ select: { id: true, fullName: true } }),
  ]);

  const lotLength = new Map(lots.map((l) => [l.id, num(l.lengthM)]));

  // Произведённые метры — из спецификации заготовки (длина × кол-во).
  const producedM = (op: TorcovkaOp) =>
    op.lines.reduce((s, l) => s + num(l.blankLengthM) * l.quantity, 0);
  const takenM = (op: TorcovkaOp) =>
    (op.railLotId ? lotLength.get(op.railLotId) ?? 0 : 0) * (op.railsTaken ?? 0);

  // --- по партиям ---
  const batchRows: WasteBatchRow[] = batches.map((b) => {
    const own = lots.filter((l) => l.batchId === b.id);
    const purchasedM = own.reduce((s, l) => s + l.quantity * num(l.lengthM), 0);
    const remainingM = own.reduce((s, l) => s + l.remainingQuantity * num(l.lengthM), 0);
    const batchOps = ops.filter((o) => o.batchId === b.id);
    const taken = batchOps.reduce((s, o) => s + takenM(o), 0);
    const produced = batchOps.reduce((s, o) => s + producedM(o), 0);
    // Списано = (закуплено − остаток) − взято торцовкой (если пакет ушёл в отход).
    const writtenOffM = Math.max(0, purchasedM - remainingM - taken);

    const w = batchWaste({ purchasedM, takenM: taken, producedM: produced, writtenOffM });
    return {
      id: b.id,
      batchName: b.name,
      purchasedM: Math.round(purchasedM),
      takenM: Math.round(taken),
      remainingM: Math.round(w.remainingM.toNumber()),
      wasteTorcovkaM: Math.round(w.wasteTorcovkaM.toNumber()),
      writtenOffM: Math.round(w.writtenOffM.toNumber()),
      wastePct: Math.round(w.wastePct.toNumber()),
      status: b.status,
    };
  });

  // --- по работникам (только те, кто торцевал) ---
  const empName = new Map(employees.map((e) => [e.id, e.fullName]));
  const byEmp = new Map<string, { taken: number; produced: number }>();
  for (const op of ops) {
    const acc = byEmp.get(op.employeeId) ?? { taken: 0, produced: 0 };
    acc.taken += takenM(op);
    acc.produced += producedM(op);
    byEmp.set(op.employeeId, acc);
  }
  const employeeRows: WasteEmployeeRow[] = [...byEmp.entries()]
    .map(([id, acc]) => {
      const w = employeeWaste(acc.taken, acc.produced);
      return {
        id,
        employeeName: empName.get(id) ?? "—",
        takenM: Math.round(acc.taken),
        producedM: Math.round(acc.produced),
        wasteM: Math.round(w.wasteM.toNumber()),
        wastePct: Math.round(w.wastePct.toNumber()),
      };
    })
    .sort((a, b) => b.wastePct - a.wastePct);

  return { batches: batchRows, employees: employeeRows };
}
