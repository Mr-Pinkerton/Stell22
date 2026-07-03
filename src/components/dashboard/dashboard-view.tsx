"use client";

import { useMemo, useState } from "react";
import type { DateFilterValue } from "@/components/date-filter";
import {
  previousDashboardPeriod,
  resolveDashboardPeriod,
  type DashboardPeriodMode,
} from "@/lib/dashboard-period";
import {
  buildBatchRemainders,
  buildDashboardAlerts,
  buildDashboardKpi,
  buildExpenseSlices,
  buildGoalProgress,
  buildProductionWeekBars,
  buildRevenueWeekSeries,
  buildTopWorkers,
  buildWasteByDay,
  formatKpiDelta,
  productionKpiColorClass,
} from "@/lib/dashboard-metrics";
import { formatMoney } from "@/lib/format";
import { createLocalDate } from "@/lib/dates";
import type { DashboardSource } from "@/server/dashboard";
import { KpiTile } from "@/components/kpi-tile";
import { AccountBalanceTile } from "@/components/account-balance-tile";
import {
  DashboardPeriodFilter,
  getDefaultDashboardCustomRange,
} from "@/components/dashboard/dashboard-period-filter";
import { DashboardAlertsBlock } from "@/components/dashboard/dashboard-alerts-block";
import { DashboardChartsRow } from "@/components/dashboard/dashboard-charts";
import { DashboardGoalsBlock } from "@/components/dashboard/dashboard-goals-block";
import {
  DashboardBatchRemainders,
  DashboardWorkersTable,
} from "@/components/dashboard/dashboard-tables";

export function DashboardView({ source }: { source: DashboardSource }) {
  const [mode, setMode] = useState<DashboardPeriodMode>("month");
  const [customRange, setCustomRange] = useState<DateFilterValue>(getDefaultDashboardCustomRange);

  const period = useMemo(() => {
    const now = new Date();
    if (mode === "custom" && customRange.rangeStart && customRange.rangeEnd) {
      return resolveDashboardPeriod("custom", now, {
        start: customRange.rangeStart,
        end: customRange.rangeEnd,
      });
    }
    if (mode === "custom") {
      const m = customRange.month;
      const end = createLocalDate(m.getFullYear(), m.getMonth() + 1, 0);
      return resolveDashboardPeriod("custom", now, { start: m, end });
    }
    return resolveDashboardPeriod(mode, now);
  }, [mode, customRange]);

  const prevPeriod = useMemo(() => previousDashboardPeriod(period), [period]);

  const kpi = useMemo(() => buildDashboardKpi(source, period, prevPeriod), [source, period, prevPeriod]);
  const alerts = useMemo(() => buildDashboardAlerts(source), [source]);
  const goals = useMemo(() => buildGoalProgress(source), [source]);
  const workers = useMemo(() => buildTopWorkers(source), [source]);
  const batches = useMemo(() => buildBatchRemainders(source), [source]);
  const productionChart = useMemo(() => buildProductionWeekBars(source, period), [source, period]);
  const revenueChart = useMemo(
    () => buildRevenueWeekSeries(source, period, prevPeriod),
    [source, period, prevPeriod],
  );
  const expenseChart = useMemo(() => buildExpenseSlices(source, period), [source, period]);
  const wasteChart = useMemo(() => buildWasteByDay(source, period), [source, period]);

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">Дашборд</h1>
        <DashboardPeriodFilter
          mode={mode}
          onModeChange={setMode}
          customRange={customRange}
          onCustomRangeChange={setCustomRange}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiTile
          title="Производство"
          value={`${kpi.productionQty} шт`}
          delta={formatKpiDelta(kpi.productionDelta, "qty")}
          deltaPositive={kpi.productionDelta > 0 ? true : kpi.productionDelta < 0 ? false : undefined}
          valueClassName={productionKpiColorClass(kpi.productionPlanRatio)}
          hint="за период"
        />
        <KpiTile
          title="Поступления"
          value={formatMoney(kpi.income)}
          delta={formatKpiDelta(kpi.incomeDelta, "money")}
          deltaPositive={kpi.incomeDelta > 0 ? true : kpi.incomeDelta < 0 ? false : undefined}
          hint="за период"
        />
        <KpiTile
          title="Затраты"
          value={formatMoney(kpi.expense)}
          delta={formatKpiDelta(kpi.expenseDelta, "money")}
          deltaPositive={kpi.expenseDelta < 0 ? true : kpi.expenseDelta > 0 ? false : undefined}
          hint="за период"
        />
        <AccountBalanceTile accounts={source.accounts} />
      </div>

      <DashboardAlertsBlock alerts={alerts} />

      <DashboardChartsRow
        production={productionChart}
        revenue={revenueChart}
        expense={expenseChart}
        waste={wasteChart}
      />

      <DashboardGoalsBlock goals={goals} />

      <div className="grid gap-4 lg:grid-cols-2">
        <DashboardWorkersTable rows={workers} />
        <DashboardBatchRemainders rows={batches} />
      </div>
    </div>
  );
}
