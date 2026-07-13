import type { DashboardPeriod } from "@/lib/dashboard-period";
import {
  buildStandardWeeksInPeriod,
  isDateInDashboardPeriod,
} from "@/lib/dashboard-period";
import { formatGoalMonthIso, goalCompletionPercent } from "@/lib/goals";
import {
  financeAccountBalance,
  financeExpenseChart,
  financePeriodExpense,
  financePeriodIncome,
  financeUnassignedCount,
  type ExpenseChartSlice,
  type FinanceCashFlowRow,
} from "@/mocks/finance-fixtures";
import { isAccountConfirmed } from "@/lib/account-balance";
import { formatMoney } from "@/lib/format";
import type { DashboardSource, ProductionEntry } from "@/server/dashboard";

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

function rangePeriod(start: Date, end: Date): DashboardPeriod {
  return { mode: "custom", start, end };
}

function filterCashFlows(period: DashboardPeriod, rows: FinanceCashFlowRow[]): FinanceCashFlowRow[] {
  return rows.filter((r) => isDateInDashboardPeriod(r.date, period));
}

function productionQty(entries: ProductionEntry[], period: DashboardPeriod): number {
  return entries
    .filter((e) => isDateInDashboardPeriod(e.occurredAt.slice(0, 10), period))
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
  source: DashboardSource,
  period: DashboardPeriod,
  prev: DashboardPeriod,
): DashboardKpi {
  const currentRows = filterCashFlows(period, source.cashFlows);
  const prevRows = filterCashFlows(prev, source.cashFlows);

  const productionQtyCurrent = productionQty(source.production, period);
  const productionQtyPrev = productionQty(source.production, prev);

  const activeGoals = source.goals.filter(
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
    // Неподтверждённые счета (карантин авто-импорта) не учитываются в остатке.
    accountBalance: financeAccountBalance(source.accounts.filter((a) => isAccountConfirmed(a.confirmed))),
  };
}

export function buildDashboardAlerts(source: DashboardSource): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  const unassigned = financeUnassignedCount(source.cashFlows);

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

  if (source.batchCostMismatchIds.length > 0) {
    alerts.push({
      id: "batch-cost",
      severity: 85,
      title: "Расхождение стоимости партии",
      description: "Введённая стоимость не совпала с расчётной",
      href: "/purchases",
      tone: "red",
    });
  }

  const highWaste = source.waste.batches.find(
    (b) => b.wastePct > source.wasteThresholdPct,
  );
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

  if (source.lowStockName) {
    alerts.push({
      id: "stock-low",
      severity: 75,
      title: "Низкие остатки на складе",
      description: `${source.lowStockName} ниже минимума`,
      href: "/warehouse",
      tone: "amber",
    });
  }

  const atRiskGoal = source.goals.find(
    (g) => g.status === "ACTIVE" && goalCompletionPercent(g.producedQty, g.quantity) < 50,
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

  return alerts.sort((a, b) => b.severity - a.severity);
}

export function buildGoalProgress(
  source: DashboardSource,
  now: Date = new Date(),
): DashboardGoalProgress[] {
  const monthIso = formatGoalMonthIso(now);
  const day = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

  return source.goals
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

export function buildTopWorkers(source: DashboardSource, limit = 5): DashboardWorkerRow[] {
  const wasteMap = new Map(source.waste.employees.map((w) => [w.employeeName, w.wastePct]));

  return [...source.salary]
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

export function buildBatchRemainders(source: DashboardSource): DashboardBatchRemainder[] {
  return source.waste.batches
    .filter((b) => b.status === "IN_WORK")
    .map((b) => ({
      id: b.id,
      name: b.batchName,
      remainingPct: b.purchasedM > 0 ? Math.round((b.remainingM / b.purchasedM) * 100) : 0,
    }))
    .sort((a, b) => a.remainingPct - b.remainingPct);
}

/** Недельный план = месячная цель активных целей / число недель месяца. */
function weeklyPlanForPeriod(source: DashboardSource, period: DashboardPeriod): number {
  const monthlyTarget = source.goals
    .filter((g) => g.status === "ACTIVE" && g.month === formatGoalMonthIso(period.start))
    .reduce((s, g) => s + g.quantity, 0);
  const monthStart = new Date(period.start.getFullYear(), period.start.getMonth(), 1);
  const monthEnd = new Date(period.start.getFullYear(), period.start.getMonth() + 1, 0);
  const monthWeeks = buildStandardWeeksInPeriod(rangePeriod(monthStart, monthEnd)).length || 1;
  return Math.round(monthlyTarget / monthWeeks);
}

export function buildProductionWeekBars(
  source: DashboardSource,
  period: DashboardPeriod,
): DashboardWeekBar[] {
  const plan = weeklyPlanForPeriod(source, period);
  return buildStandardWeeksInPeriod(period).map((week) => ({
    label: week.label,
    fact: productionQty(source.production, rangePeriod(week.start, week.end)),
    plan,
  }));
}

export function buildRevenueWeekSeries(
  source: DashboardSource,
  period: DashboardPeriod,
  prev: DashboardPeriod,
): DashboardRevenueWeek[] {
  const prevWeeks = buildStandardWeeksInPeriod(prev);
  return buildStandardWeeksInPeriod(period).map((week, i) => {
    const prevWeek = prevWeeks[i];
    return {
      label: week.label,
      fact: financePeriodIncome(filterCashFlows(rangePeriod(week.start, week.end), source.cashFlows)),
      prevMonth: prevWeek
        ? financePeriodIncome(
            filterCashFlows(rangePeriod(prevWeek.start, prevWeek.end), source.cashFlows),
          )
        : 0,
    };
  });
}

export function buildWasteByDay(
  source: DashboardSource,
  period: DashboardPeriod,
): DashboardWasteDay[] {
  const byDay = new Map(source.torcovkaDays.map((d) => [d.date, d]));
  const days: DashboardWasteDay[] = [];
  let cursor = new Date(period.start);
  let i = 0;
  while (cursor <= period.end && i < 14) {
    const iso = cursor.toISOString().slice(0, 10);
    const d = byDay.get(iso);
    const pct = d && d.takenM > 0 ? Math.round(((d.takenM - d.producedM) / d.takenM) * 100) : 0;
    days.push({ date: iso.slice(8, 10) + "." + iso.slice(5, 7), pct: Math.max(0, pct) });
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1);
    i += 1;
  }
  return days;
}

export function buildExpenseSlices(
  source: DashboardSource,
  period: DashboardPeriod,
): ExpenseChartSlice[] {
  return financeExpenseChart(filterCashFlows(period, source.cashFlows), source.articles);
}
