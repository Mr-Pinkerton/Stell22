import type { DashboardPeriod } from "@/lib/dashboard-period";
import {
  buildStandardWeeksInPeriod,
  isDateInDashboardPeriod,
} from "@/lib/dashboard-period";
import { goalCompletionPercent } from "@/lib/goals";
import {
  financeAccountBalance,
  financeAccounts,
  financeArticles,
  financeCashFlows,
  financeExpenseChart,
  financePeriodExpense,
  financePeriodIncome,
  financeUnassignedCount,
  type FinanceCashFlowRow,
} from "@/mocks/finance-fixtures";
import { goalRows } from "@/mocks/goals-fixtures";
import { batchCostMismatchIds } from "@/mocks/purchase-flags";
import {
  salaryReportRows,
  wasteBatchRows,
  wasteEmployeeRows,
} from "@/mocks/report-fixtures";
import { defaultAppSettings, minStockRows } from "@/mocks/settings-fixtures";
import { terminalEntries } from "@/mocks/fixtures";
import { productStock } from "@/mocks/warehouse-fixtures";
import { formatGoalMonthIso } from "@/lib/goals";
import { formatMoney } from "@/lib/format";
import type { TerminalEntry } from "@/types/domain";

export interface DashboardKpi {
  productionQty: number;
  productionDelta: number;
  productionPlanRatio: number;
  income: number;
  incomeDelta: number;
  expense: number;
  expenseDelta: number;
  accountBalance: number;
}

export interface DashboardAlert {
  id: string;
  severity: number;
  title: string;
  description: string;
  href: string;
  tone: "amber" | "red" | "violet" | "blue";
}

export interface DashboardGoalProgress {
  id: string;
  title: string;
  produced: number;
  target: number;
  pct: number;
  onTrack: boolean;
}

export interface DashboardWorkerRow {
  id: string;
  name: string;
  produced: number;
  wastePct: number;
  salary: number;
}

export interface DashboardBatchRemainder {
  id: string;
  name: string;
  remainingPct: number;
}

export interface DashboardWeekBar {
  label: string;
  fact: number;
  plan: number;
}

export interface DashboardRevenueWeek {
  label: string;
  fact: number;
  prevMonth: number;
}

export interface DashboardWasteDay {
  date: string;
  pct: number;
}

function filterCashFlows(period: DashboardPeriod, rows: FinanceCashFlowRow[]): FinanceCashFlowRow[] {
  return rows.filter((r) => isDateInDashboardPeriod(r.date, period));
}

function productionQty(entries: TerminalEntry[], period: DashboardPeriod): number {
  return entries
    .filter(
      (e) =>
        e.type === "UPAKOVKA" && isDateInDashboardPeriod(e.occurredAt.slice(0, 10), period),
    )
    .reduce((sum, e) => sum + e.quantity, 0);
}

export function formatKpiDelta(delta: number, kind: "qty" | "money"): string {
  if (delta === 0) return "без изменений";
  const sign = delta > 0 ? "+" : "";
  if (kind === "money") return `${sign}${formatMoney(delta)} к пред. периоду`;
  return `${sign}${delta} шт к пред. периоду`;
}

/** Цвет KPI «Производство»: красный → жёлтый → зелёный. */
export function productionKpiColorClass(ratio: number): string {
  if (ratio >= 1) return "text-emerald-700";
  if (ratio >= 0.5) return "text-amber-600";
  return "text-red-600";
}

export function buildDashboardKpi(
  period: DashboardPeriod,
  prev: DashboardPeriod,
  entries: TerminalEntry[] = terminalEntries,
): DashboardKpi {
  const currentRows = filterCashFlows(period, financeCashFlows);
  const prevRows = filterCashFlows(prev, financeCashFlows);

  const productionQtyCurrent = productionQty(entries, period);
  const productionQtyPrev = productionQty(entries, prev);

  const activeGoals = goalRows.filter(
    (g) => g.status === "ACTIVE" && g.month === formatGoalMonthIso(period.start),
  );
  const planQty = activeGoals.reduce((s, g) => s + g.quantity, 0) || 1;
  const productionPlanRatio = productionQtyCurrent / planQty;

  const income = financePeriodIncome(currentRows);
  const incomePrev = financePeriodIncome(prevRows);
  const expense = financePeriodExpense(currentRows);
  const expensePrev = financePeriodExpense(prevRows);

  return {
    productionQty: productionQtyCurrent,
    productionDelta: productionQtyCurrent - productionQtyPrev,
    productionPlanRatio,
    income,
    incomeDelta: income - incomePrev,
    expense,
    expenseDelta: expense - expensePrev,
    accountBalance: financeAccountBalance(financeAccounts),
  };
}

export function buildDashboardAlerts(): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  const unassigned = financeUnassignedCount(financeCashFlows);

  if (unassigned > 0) {
    alerts.push({
      id: "dds-unassigned",
      severity: 90,
      title: "Неразнесённые операции ДДС",
      description: `${unassigned} операций без автоправила`,
      href: "/finance",
      tone: "amber",
    });
  }

  if (batchCostMismatchIds.size > 0) {
    alerts.push({
      id: "batch-cost",
      severity: 85,
      title: "Расхождение стоимости партии",
      description: "Введённая стоимость не совпала с расчётной",
      href: "/purchases",
      tone: "red",
    });
  }

  const highWaste = wasteBatchRows.find((b) => b.wastePct > defaultAppSettings.wasteThresholdPct);
  if (highWaste) {
    alerts.push({
      id: "waste-high",
      severity: 80,
      title: "Высокий процент отхода",
      description: `Партия «${highWaste.batchName}» — ${highWaste.wastePct}%`,
      href: "/reports",
      tone: "red",
    });
  }

  const lowStock = minStockRows.find((row) => {
    if (row.kind === "PRODUCT") {
      const key = row.id.replace("ms-prod-", "prod-");
      return (productStock[key] ?? 0) < row.minStock;
    }
    return false;
  });
  if (lowStock) {
    alerts.push({
      id: "stock-low",
      severity: 75,
      title: "Низкие остатки на складе",
      description: `${lowStock.name} ниже минимума`,
      href: "/warehouse",
      tone: "amber",
    });
  }

  const atRiskGoal = goalRows.find(
    (g) =>
      g.status === "ACTIVE" &&
      goalCompletionPercent(g.producedQty, g.quantity) < 50,
  );
  if (atRiskGoal) {
    alerts.push({
      id: "goal-risk",
      severity: 70,
      title: "Цель под угрозой",
      description: `«${atRiskGoal.name}» — прогноз ниже плана`,
      href: "/goals",
      tone: "violet",
    });
  }

  alerts.push({
    id: "material-days",
    severity: 60,
    title: "Материала хватит на 12 дней",
    description: "По статистике последних 7 дней",
    href: "/purchases",
    tone: "blue",
  });

  return alerts.sort((a, b) => b.severity - a.severity);
}

export function buildGoalProgress(now: Date = new Date()): DashboardGoalProgress[] {
  const monthIso = formatGoalMonthIso(now);
  const day = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  return goalRows
    .filter((g) => g.status === "ACTIVE" && g.month === monthIso)
    .map((g) => {
      const pct = goalCompletionPercent(g.producedQty, g.quantity);
      const projected = day > 0 ? (g.producedQty / day) * daysInMonth : 0;
      return {
        id: g.id,
        title: `${g.productName} · ${g.quantity} шт`,
        produced: g.producedQty,
        target: g.quantity,
        pct,
        onTrack: projected >= g.quantity,
      };
    });
}

export function buildTopWorkers(limit = 5): DashboardWorkerRow[] {
  const wasteMap = new Map(wasteEmployeeRows.map((w) => [w.employeeName, w.wastePct]));

  return [...salaryReportRows]
    .sort((a, b) => b.produced - a.produced)
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      name: row.employeeName,
      produced: row.produced,
      wastePct: wasteMap.get(row.employeeName) ?? 0,
      salary: row.amountDue,
    }));
}

export function buildBatchRemainders(): DashboardBatchRemainder[] {
  return wasteBatchRows
    .filter((b) => b.status === "IN_WORK")
    .map((b) => ({
      id: b.id,
      name: b.batchName,
      remainingPct: Math.round((b.remainingM / b.purchasedM) * 100),
    }))
    .sort((a, b) => a.remainingPct - b.remainingPct);
}

export function buildProductionWeekBars(period: DashboardPeriod): DashboardWeekBar[] {
  const planPerWeek = 120;
  return buildStandardWeeksInPeriod(period).map((week, i) => ({
    label: week.label,
    fact: 80 + i * 15 + (i % 2) * 10,
    plan: planPerWeek + (i % 3) * 20,
  }));
}

export function buildRevenueWeekSeries(period: DashboardPeriod): DashboardRevenueWeek[] {
  return buildStandardWeeksInPeriod(period).map((week, i) => ({
    label: week.label,
    fact: 180_000 + i * 25_000,
    prevMonth: 160_000 + i * 22_000,
  }));
}

export function buildWasteByDay(period: DashboardPeriod): DashboardWasteDay[] {
  const days: DashboardWasteDay[] = [];
  let cursor = new Date(period.start);
  let i = 0;
  while (cursor <= period.end && i < 14) {
    const iso = cursor.toISOString().slice(0, 10);
    days.push({ date: iso.slice(8, 10) + "." + iso.slice(5, 7), pct: 18 + (i % 5) * 4 });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    i += 1;
  }
  return days;
}

export function buildExpenseSlices(period: DashboardPeriod) {
  return financeExpenseChart(filterCashFlows(period, financeCashFlows), financeArticles);
}
