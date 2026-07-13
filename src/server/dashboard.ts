"use server";

import { prisma } from "@/server/db";
import { getFinanceData } from "@/server/finance";
import { getSalaryReport } from "@/server/payroll";
import { getWasteReport, type WasteReport } from "@/server/reports";
import { getGoalsData } from "@/server/goals";
import { getPurchasesData } from "@/server/purchases";
import { getAppSettings } from "@/server/settings";
import type {
  FinanceAccount,
  FinanceArticle,
  FinanceCashFlowRow,
} from "@/mocks/finance-fixtures";
import type { GoalRow } from "@/mocks/goals-fixtures";
import type { SalaryReportRow } from "@/mocks/report-fixtures";

export interface ProductionEntry {
  occurredAt: string;
  quantity: number;
}

export interface TorcovkaDay {
  date: string;
  takenM: number;
  producedM: number;
}

/** Сырые данные дашборда (без фильтра периода — период применяется на клиенте). */
export interface DashboardSource {
  accounts: FinanceAccount[];
  articles: FinanceArticle[];
  cashFlows: FinanceCashFlowRow[];
  production: ProductionEntry[];
  torcovkaDays: TorcovkaDay[];
  salary: SalaryReportRow[];
  waste: WasteReport;
  goals: GoalRow[];
  batchCostMismatchIds: string[];
  lowStockName: string | null;
  /** Порог отхода из настроек (A20) — для алерта и графика. */
  wasteThresholdPct: number;
}

function num(value: { toNumber: () => number } | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

export async function getDashboardData(): Promise<DashboardSource> {
  const [finance, salary, waste, goalsData, purchases, ops, lots, nomStock, nomItems, appSettings] =
    await Promise.all([
      getFinanceData(),
      getSalaryReport(),
      getWasteReport(),
      getGoalsData(),
      getPurchasesData(),
      prisma.productionOperation.findMany({
        where: { type: { in: ["TORCOVKA", "UPAKOVKA"] } },
        include: { lines: true },
      }),
      prisma.railLot.findMany({ select: { id: true, lengthM: true } }),
      prisma.nomenclatureStock.findMany(),
      prisma.nomenclatureItem.findMany({ where: { minStock: { not: null } } }),
      getAppSettings(),
    ]);

  const lotLength = new Map(lots.map((l) => [l.id, num(l.lengthM)]));

  const production: ProductionEntry[] = [];
  const torcovkaByDay = new Map<string, { takenM: number; producedM: number }>();
  for (const op of ops) {
    const date = op.workDate.toISOString().slice(0, 10);
    if (op.type === "UPAKOVKA") {
      production.push({ occurredAt: op.workDate.toISOString(), quantity: op.productQty ?? 0 });
    } else {
      const takenM = (op.railLotId ? lotLength.get(op.railLotId) ?? 0 : 0) * (op.railsTaken ?? 0);
      // Произведённые метры — из спецификации заготовки (длина × кол-во).
      const producedM = op.lines.reduce((s, l) => s + num(l.blankLengthM) * l.quantity, 0);
      const acc = torcovkaByDay.get(date) ?? { takenM: 0, producedM: 0 };
      acc.takenM += takenM;
      acc.producedM += producedM;
      torcovkaByDay.set(date, acc);
    }
  }

  // Низкий остаток крепежа/упаковки: остаток ниже минимума.
  const stockByNom = new Map(nomStock.map((s) => [s.nomenclatureId, s.quantity]));
  const low = nomItems.find(
    (n) => n.minStock != null && (stockByNom.get(n.id) ?? 0) < n.minStock,
  );

  return {
    accounts: finance.accounts,
    articles: finance.articles,
    cashFlows: finance.cashFlows,
    production,
    torcovkaDays: [...torcovkaByDay.entries()].map(([date, v]) => ({ date, ...v })),
    salary,
    waste,
    goals: goalsData.goals,
    batchCostMismatchIds: purchases.rows.filter((r) => r.costMismatch).map((r) => r.id),
    lowStockName: low?.name ?? null,
    wasteThresholdPct: appSettings.wasteThresholdPct,
  };
}
