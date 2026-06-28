// Моки для отчётов (UI-прототип, Этап 2).

import {
  batches,
  details as allDetails,
  employees,
  nomenclatureItems,
  products,
  railLots,
  terminalEntries,
} from "@/mocks/fixtures";
import { financeArticles, financeCashFlows } from "@/mocks/finance-fixtures";
import { producedLines, producedProductQty } from "@/mocks/production-facts";
import { buildPurchaseRows, sectionAreaM2 } from "@/lib/batch-stats";
import {
  buildCostDetailRows,
  buildCostProductRows,
  declaredSortShares,
  factSortShares,
  periodOverheadFromCashFlows,
  sortSharesToPercents,
} from "@/lib/cost-report";
import { batchWaste, employeeWaste } from "@/lib/waste";
import type { BatchStatus, CostStatus, RailType, Sort } from "@/types/domain";

export interface PurchasePackageLine {
  id: string;
  code: string | null;
  isPackage: boolean;
  lengthM: number;
  railType: RailType;
  sort: Sort;
  quantity: number;
  remainingQuantity: number;
  volumeM3: number;
  rows?: number | null;
  layers?: number | null;
  workerName: string;
}

export interface PurchaseReportRow {
  id: string;
  name: string;
  purchaseDate: string;
  totalCost: number;
  volumeM3: number;
  sortPurchasePct: { sort1: number; sort2: number };
  sortFactPct: { sort1: number; sort2: number };
  avgCostPerM3: number;
  status: BatchStatus;
  packages: PurchasePackageLine[];
}

export interface CostDetailRow {
  id: string;
  name: string;
  batchName: string;
  workCost: number;
  materialCost: number;
  costStatus: CostStatus;
}

export interface CostProductDetailLine {
  detailName: string;
  lengthM: number;
  quantity: number;
  materialCost: number;
  workCost: number;
}

export interface CostProductRow {
  id: string;
  name: string;
  sku: string;
  material: number;
  materialPct: number;
  work: number;
  workPct: number;
  direct: number;
  directPct: number;
  overhead: number;
  overheadPct: number;
  full: number;
  details: CostProductDetailLine[];
}

export interface SalaryDayLine {
  date: string;
  hours?: number | null;
  torcovka: number;
  prisadka: number;
  upakovka: number;
  total: number;
}

export interface SalaryReportRow {
  id: string;
  employeeName: string;
  amountDue: number;
  produced: number;
  avgPerUnit: number;
  total: number;
  paid: boolean;
  paidAt?: string | null;
  days: SalaryDayLine[];
}

export interface WasteBatchRow {
  id: string;
  batchName: string;
  purchasedM: number;
  takenM: number;
  remainingM: number;
  wasteTorcovkaM: number;
  writtenOffM: number;
  wastePct: number;
  status: BatchStatus;
}

export interface WasteEmployeeRow {
  id: string;
  employeeName: string;
  takenM: number;
  producedM: number;
  wasteM: number;
  wastePct: number;
}

export interface SalesReportRow {
  id: string;
  productName: string;
  sku: string;
  soldQty: number;
  revenue: number;
}

const productionWorkers = employees.filter(
  (e) => e.status === "ACTIVE" && e.id !== "emp-2",
);

function workerForLot(lotId: string, batchId: string): string {
  if (productionWorkers.length === 0) return "—";
  const seed =
    lotId.split("").reduce((s, c) => s + c.charCodeAt(0), 0) +
    batchId.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  return productionWorkers[seed % productionWorkers.length]!.fullName;
}

function buildPackages(batchId: string): PurchasePackageLine[] {
  const batch = batches.find((b) => b.id === batchId);
  const area = batch ? sectionAreaM2(batch.sectionWidthMm, batch.sectionHeightMm) : 0;

  return railLots
    .filter((l) => l.batchId === batchId)
    .map((lot) => ({
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
      workerName: workerForLot(lot.id, batchId),
    }));
}

const purchaseBase = buildPurchaseRows(batches, railLots);

export const purchaseReportRows: PurchaseReportRow[] = purchaseBase.map((b) => {
  const batchLots = railLots.filter((l) => l.batchId === b.id);
  const batchLines = producedLines.filter((l) => l.batchId === b.id);

  // Заявленное соотношение — по закупленным рейкам; факт — по сортам
  // произведённых деталей. Без производства факт = заявленному.
  const declared = sortSharesToPercents(declaredSortShares(batchLots));
  const factShares = factSortShares(batchLines, allDetails);
  const fact = batchLines.length > 0 ? sortSharesToPercents(factShares) : declared;

  const avgCostPerM3 = b.stats.volumeM3 > 0 ? Math.round(b.totalCost / b.stats.volumeM3) : 0;

  return {
    id: b.id,
    name: b.name,
    purchaseDate: b.purchaseDate,
    totalCost: b.totalCost,
    volumeM3: b.stats.volumeM3,
    sortPurchasePct: declared,
    sortFactPct: fact,
    avgCostPerM3,
    status: b.status,
    packages: buildPackages(b.id),
  };
});

const overheadArticleNames = new Set(
  financeArticles.filter((a) => a.isOverhead).map((a) => a.name),
);
const periodOverhead = periodOverheadFromCashFlows(financeCashFlows, overheadArticleNames);

// Себестоимость считается движком (lib/cost-report) на доменных данных
// и производственных фактах (mocks/production-facts) — Этап 9.
export const costDetailRows: CostDetailRow[] = buildCostDetailRows({
  batches,
  details: allDetails,
  employees,
  lines: producedLines,
});

export const costProductRows: CostProductRow[] = buildCostProductRows({
  products,
  batches,
  details: allDetails,
  employees,
  nomenclature: nomenclatureItems,
  lines: producedLines,
  producedProductQty,
  periodOverhead,
});

function isoDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

function buildSalaryRows(): SalaryReportRow[] {
  const productionEmployees = employees.filter((e) => e.status === "ACTIVE" && e.id !== "emp-4");

  const byEmployee = new Map<
    string,
    { total: number; produced: number; byDay: Map<string, SalaryDayLine> }
  >();

  for (const emp of productionEmployees) {
    byEmployee.set(emp.id, { total: 0, produced: 0, byDay: new Map() });
  }

  for (const t of terminalEntries) {
    const bucket = byEmployee.get(t.employeeId);
    if (!bucket) continue;

    bucket.total += t.amount;
    if (t.type === "TORCOVKA" || t.type === "PRISADKA" || t.type === "UPAKOVKA") {
      bucket.produced += t.quantity;
    }

    const day = isoDateOnly(t.occurredAt);
    const line = bucket.byDay.get(day) ?? {
      date: day,
      hours: null,
      torcovka: 0,
      prisadka: 0,
      upakovka: 0,
      total: 0,
    };

    if (t.type === "HOURS") line.hours = (line.hours ?? 0) + t.quantity;
    if (t.type === "TORCOVKA") line.torcovka += t.amount;
    if (t.type === "PRISADKA") line.prisadka += t.amount;
    if (t.type === "UPAKOVKA") line.upakovka += t.amount;
    line.total += t.amount;
    bucket.byDay.set(day, line);
  }

  const rows: SalaryReportRow[] = productionEmployees.map((emp) => {
    const bucket = byEmployee.get(emp.id)!;
    const avgPerUnit = bucket.produced > 0 ? Math.round(bucket.total / bucket.produced) : 0;
    const days = [...bucket.byDay.values()].sort((a, b) => b.date.localeCompare(a.date));

    return {
      id: emp.id,
      employeeName: emp.fullName,
      amountDue: bucket.total,
      produced: bucket.produced,
      avgPerUnit,
      total: bucket.total,
      paid: emp.id === "emp-3",
      paidAt: emp.id === "emp-3" ? "2026-06-20" : null,
      days: days.slice(0, 14),
    };
  });

  return rows.sort((a, b) => {
    if (a.paid !== b.paid) return a.paid ? 1 : -1;
    if (!a.paid && !b.paid) return b.total - a.total;
    return (b.paidAt ?? "").localeCompare(a.paidAt ?? "");
  });
}

export const salaryReportRows: SalaryReportRow[] = buildSalaryRows();

// Сырые входы отхода (взято/произведено/списано). Процент и производные —
// считает движок lib/waste, чтобы числа были внутренне согласованы. В Части B
// эти длины придут из операций терминала.
interface WasteBatchInput {
  id: string;
  batchName: string;
  purchasedM: number;
  takenM: number;
  producedM: number;
  writtenOffM: number;
  status: BatchStatus;
}

const wasteBatchInputs: WasteBatchInput[] = [
  { id: "wb-1", batchName: "Волочек 2419", purchasedM: 1240, takenM: 980, producedM: 905, writtenOffM: 18, status: "IN_WORK" },
  { id: "wb-2", batchName: "Сосна 3020", purchasedM: 860, takenM: 720, producedM: 560, writtenOffM: 7, status: "IN_WORK" },
  { id: "wb-3", batchName: "Ель 1812", purchasedM: 640, takenM: 610, producedM: 560, writtenOffM: 4, status: "ARCHIVED" },
  { id: "wb-4", batchName: "Бук 4025", purchasedM: 520, takenM: 410, producedM: 270, writtenOffM: 10, status: "IN_WORK" },
];

export const wasteBatchRows: WasteBatchRow[] = wasteBatchInputs.map((b) => {
  const w = batchWaste(b);
  return {
    id: b.id,
    batchName: b.batchName,
    purchasedM: b.purchasedM,
    takenM: b.takenM,
    remainingM: w.remainingM.toNumber(),
    wasteTorcovkaM: w.wasteTorcovkaM.toNumber(),
    writtenOffM: w.writtenOffM.toNumber(),
    wastePct: Math.round(w.wastePct.toNumber()),
    status: b.status,
  };
});

interface WasteEmployeeInput {
  id: string;
  employeeName: string;
  takenM: number;
  producedM: number;
}

const wasteEmployeeInputs: WasteEmployeeInput[] = [
  { id: "we-1", employeeName: employees[0].fullName, takenM: 1420, producedM: 1180 },
  { id: "we-2", employeeName: employees[2].fullName, takenM: 980, producedM: 720 },
  { id: "we-3", employeeName: employees[1].fullName, takenM: 0, producedM: 0 },
];

export const wasteEmployeeRows: WasteEmployeeRow[] = wasteEmployeeInputs.map((e) => {
  const w = employeeWaste(e.takenM, e.producedM);
  return {
    id: e.id,
    employeeName: e.employeeName,
    takenM: e.takenM,
    producedM: e.producedM,
    wasteM: w.wasteM.toNumber(),
    wastePct: Math.round(w.wastePct.toNumber()),
  };
});

export const salesReportRows: SalesReportRow[] = [
  {
    id: "sr-1",
    productName: products[0].name,
    sku: products[0].sku,
    soldQty: 124,
    revenue: 148_800,
  },
  {
    id: "sr-2",
    productName: products[1].name,
    sku: products[1].sku,
    soldQty: 86,
    revenue: 129_000,
  },
  {
    id: "sr-3",
    productName: "Полка мини",
    sku: "ART-003",
    soldQty: 42,
    revenue: 33_600,
  },
];

export function purchaseReportKpis(rows: PurchaseReportRow[]) {
  const totalCost = rows.reduce((s, r) => s + r.totalCost, 0);
  const totalVolume = rows.reduce((s, r) => s + r.volumeM3, 0);
  return {
    batchCount: rows.length,
    totalCost,
    totalVolume,
    avgCostPerM3: totalVolume > 0 ? Math.round(totalCost / totalVolume) : 0,
  };
}

export function salaryReportKpis(rows: SalaryReportRow[]) {
  const unpaid = rows.filter((r) => !r.paid);
  return {
    workerCount: unpaid.length,
    totalSalary: unpaid.reduce((s, r) => s + r.total, 0),
  };
}
