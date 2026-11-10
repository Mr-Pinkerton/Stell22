import { describe, expect, it } from "vitest";
import { createLocalDate } from "@/lib/dates";
import { previousDashboardPeriod, resolveDashboardPeriod } from "@/lib/dashboard-period";
import { buildDashboardKpi, buildGoalProgress, buildWasteByDay } from "@/lib/dashboard-metrics";
import type { FinanceCashFlowRow } from "@/mocks/finance-fixtures";
import type { GoalRow } from "@/mocks/goals-fixtures";
import type { DashboardSource } from "@/server/dashboard";

const LATE = "2026-10-31T21:30:00.000Z";

function cash(date: string, amount: number, flowType: "INCOME" | "EXPENSE"): FinanceCashFlowRow {
  return {
    id: `${date}-${flowType}-${amount}`,
    date,
    amount,
    flowType,
    accountName: "Касса",
    counterpartyName: null,
    description: "",
    articleName: null,
    dealName: null,
    dealId: null,
    isAutoAssigned: true,
  };
}

function source(partial: Partial<DashboardSource>): DashboardSource {
  return {
    accounts: [],
    articles: [],
    cashFlows: [],
    production: [],
    torcovkaDays: [],
    salary: [],
    waste: { batches: [], employees: [] },
    goals: [],
    batchCostMismatchIds: [],
    lowStockName: null,
    wasteThresholdPct: 0,
    ...partial,
  };
}

describe("дашборд группирует операции по хозяйственным суткам UTC+3", () => {
  const november = resolveDashboardPeriod("month", createLocalDate(2026, 10, 15));
  const october = resolveDashboardPeriod("month", createLocalDate(2026, 9, 15));
  const data = source({
    cashFlows: [cash("2026-11-01", 111, "INCOME"), cash("2026-10-15", 7, "EXPENSE")],
    production: [{ occurredAt: LATE, quantity: 7 }],
    torcovkaDays: [{ date: "2026-11-01", takenM: 2, producedM: 1 }],
  });

  it("ноябрь включает производство, приход и отход 1 ноября", () => {
    const kpi = buildDashboardKpi(data, november, previousDashboardPeriod(november));
    expect(kpi.productionQty).toBe(7);
    expect(kpi.income).toBe(111);
    expect(kpi.expense).toBe(0);
    const waste = buildWasteByDay(data, november);
    expect(waste[0]).toEqual({ date: "01.11", pct: 50 });
  });

  it("октябрь не включает ту же операцию, накладные 7 остаются в октябре", () => {
    const kpi = buildDashboardKpi(data, october, previousDashboardPeriod(october));
    expect(kpi.productionQty).toBe(0);
    expect(kpi.income).toBe(0);
    expect(kpi.expense).toBe(7);
    const labels = buildWasteByDay(data, october).map((d) => d.date);
    expect(labels).not.toContain("01.11");
  });

  it("блок целей на 21:30Z показывает ноябрь, а не октябрь", () => {
    const goal = (month: string): GoalRow => ({
      id: month,
      name: month,
      productId: "prod-1",
      productName: "Полка",
      quantity: 10,
      month,
      status: "ACTIVE",
      producedQty: month === "2026-11-01" ? 7 : 0,
    });
    const rows = buildGoalProgress(
      source({ goals: [goal("2026-10-01"), goal("2026-11-01")] }),
      new Date(LATE),
    );
    expect(rows.map((row) => row.produced)).toEqual([7]);
  });
});
