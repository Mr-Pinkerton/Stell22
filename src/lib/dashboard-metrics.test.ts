import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLocalDate } from "@/lib/dates";
import { previousDashboardPeriod, resolveDashboardPeriod, type DashboardPeriod } from "@/lib/dashboard-period";
import {
  buildDashboardKpi,
  buildGoalProgress,
  buildRevenueWeekSeries,
  buildWasteByDay,
} from "@/lib/dashboard-metrics";
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

describe("график поступлений считает кассу, а не продажи", () => {
  it("поступление 500 не превращается в выручку 1000", () => {
    const november = resolveDashboardPeriod("month", createLocalDate(2026, 10, 15));
    const october = previousDashboardPeriod(november);
    const salesRevenue = 1000;
    const series = buildRevenueWeekSeries(
      source({ cashFlows: [cash("2026-11-15", 500, "INCOME")] }),
      november,
      october,
    );
    const fact = series.reduce((sum, week) => sum + week.fact, 0);
    expect(fact).toBe(500);
    expect(fact).not.toBe(salesRevenue);
  });
});

describe("график отхода покрывает каждый день периода", () => {
  const boundaryNovember: DashboardPeriod = {
    mode: "month",
    start: new Date("2026-10-31T21:00:00.000Z"),
    end: new Date("2026-11-30T20:59:59.999Z"),
  };

  it("ноябрь содержит 30 дней и начинается с 01.11", () => {
    const waste = buildWasteByDay(
      source({
        torcovkaDays: [
          { date: "2026-11-01", takenM: 2, producedM: 1 },
          { date: "2026-11-14", takenM: 4, producedM: 2 },
        ],
      }),
      boundaryNovember,
    );
    expect(waste).toHaveLength(30);
    expect(waste[0]).toEqual({ date: "01.11", pct: 50 });
    expect(waste[1]).toEqual({ date: "02.11", pct: 0 });
    expect(waste[13]).toEqual({ date: "14.11", pct: 50 });
    expect(waste.map((day) => day.date)).not.toContain("31.10");
    expect(waste.at(-1)?.date).toBe("30.11");
  });

  it("месяц из 31 дня содержит 31 позицию", () => {
    const january = resolveDashboardPeriod("month", createLocalDate(2026, 0, 15));
    const waste = buildWasteByDay(source({}), january);
    expect(waste).toHaveLength(31);
    expect(waste[0]?.date).toBe("01.01");
    expect(waste.at(-1)?.date).toBe("31.01");
  });
});

describe("конец периода отхода не зависит от зоны хоста", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const script = `
    import * as metricsNs from "./src/lib/dashboard-metrics.ts";
    const metrics = metricsNs.buildWasteByDay ? metricsNs : metricsNs.default;
    const waste = metrics.buildWasteByDay(
      {
        torcovkaDays: [
          { date: "2026-11-01", takenM: 2, producedM: 1 },
          { date: "2026-11-14", takenM: 4, producedM: 2 },
        ],
      },
      {
        mode: "month",
        start: new Date("2026-10-31T21:00:00.000Z"),
        end: new Date("2026-11-30T20:59:59.999Z"),
      },
    );
    console.log(JSON.stringify({
      length: waste.length,
      first: waste[0],
      second: waste[1],
      day14: waste[13],
      last: waste.at(-1),
    }));
  `;

  function run(tz: string) {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: root, env: { ...process.env, TZ: tz }, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
      length: number;
      first: { date: string; pct: number };
      second: { date: string; pct: number };
      day14: { date: string; pct: number };
      last: { date: string; pct: number };
    };
  }

  it.each(["UTC", "Europe/Moscow", "Asia/Tokyo"])(
    "%s: ноябрь 01.11–30.11, 30 дней",
    (tz) => {
      const out = run(tz);
      expect(out.length).toBe(30);
      expect(out.first).toEqual({ date: "01.11", pct: 50 });
      expect(out.second).toEqual({ date: "02.11", pct: 0 });
      expect(out.day14).toEqual({ date: "14.11", pct: 50 });
      expect(out.last).toEqual({ date: "30.11", pct: 0 });
    },
  );
});


