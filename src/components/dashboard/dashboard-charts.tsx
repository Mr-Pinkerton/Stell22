"use client";

import { useMemo } from "react";
import { wastePercentClass } from "@/components/reports/report-shared";
import { FinanceExpenseChart } from "@/components/finance/finance-expense-chart";
import { defaultAppSettings } from "@/mocks/settings-fixtures";
import type {
  DashboardRevenueWeek,
  DashboardWasteDay,
  DashboardWeekBar,
} from "@/lib/dashboard-metrics";
import type { ExpenseChartSlice } from "@/mocks/finance-fixtures";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const CHART_H = 200;
const PAD = { top: 12, right: 12, bottom: 28, left: 36 };

interface ProductionBarChartProps {
  data: DashboardWeekBar[];
}

export function ProductionBarChart({ data }: ProductionBarChartProps) {
  const max = useMemo(
    () => Math.max(...data.flatMap((d) => [d.fact, d.plan]), 1),
    [data],
  );

  if (data.length === 0) {
    return <EmptyChart />;
  }

  const innerW = 400;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const groupW = innerW / data.length;
  const barW = Math.min(18, groupW / 3);

  return (
    <svg viewBox={`0 0 ${innerW + PAD.left + PAD.right} ${CHART_H}`} className="w-full">
      {data.map((d, i) => {
        const x = PAD.left + i * groupW + groupW / 2;
        const factH = (d.fact / max) * innerH;
        const planH = (d.plan / max) * innerH;
        return (
          <g key={d.label}>
            <rect
              x={x - barW - 2}
              y={PAD.top + innerH - factH}
              width={barW}
              height={factH}
              rx={3}
              className="fill-brand"
            />
            <rect
              x={x + 2}
              y={PAD.top + innerH - planH}
              width={barW}
              height={planH}
              rx={3}
              className="fill-muted-foreground/35"
            />
            <text
              x={x}
              y={CHART_H - 6}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {d.label}
            </text>
          </g>
        );
      })}
      <text x={PAD.left} y={12} className="fill-muted-foreground text-[10px]">
        шт
      </text>
    </svg>
  );
}

interface RevenueLineChartProps {
  data: DashboardRevenueWeek[];
}

export function RevenueLineChart({ data }: RevenueLineChartProps) {
  const max = useMemo(
    () => Math.max(...data.flatMap((d) => [d.fact, d.prevMonth]), 1),
    [data],
  );

  if (data.length === 0) return <EmptyChart />;

  const innerW = 400;
  const innerH = CHART_H - PAD.top - PAD.bottom;

  const points = (key: "fact" | "prevMonth") =>
    data
      .map((d, i) => {
        const x = PAD.left + (i / Math.max(data.length - 1, 1)) * innerW;
        const y = PAD.top + innerH - (d[key] / max) * innerH;
        return `${x},${y}`;
      })
      .join(" ");

  return (
    <svg viewBox={`0 0 ${innerW + PAD.left + PAD.right} ${CHART_H}`} className="w-full">
      <polyline points={points("prevMonth")} fill="none" className="stroke-muted-foreground/50" strokeWidth={2} />
      <polyline points={points("fact")} fill="none" className="stroke-brand" strokeWidth={2.5} />
      {data.map((d, i) => {
        const x = PAD.left + (i / Math.max(data.length - 1, 1)) * innerW;
        return (
          <text key={d.label} x={x} y={CHART_H - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">
            {d.label}
          </text>
        );
      })}
      <text x={PAD.left} y={12} className="fill-muted-foreground text-[10px]">
        ₽
      </text>
    </svg>
  );
}

interface WasteLineChartProps {
  data: DashboardWasteDay[];
  threshold?: number;
}

export function WasteLineChart({ data, threshold = defaultAppSettings.wasteThresholdPct }: WasteLineChartProps) {
  const max = useMemo(() => Math.max(...data.map((d) => d.pct), threshold, 1), [data, threshold]);

  if (data.length === 0) return <EmptyChart />;

  const innerW = 400;
  const innerH = CHART_H - PAD.top - PAD.bottom;
  const thresholdY = PAD.top + innerH - (threshold / max) * innerH;

  const line = data
    .map((d, i) => {
      const x = PAD.left + (i / Math.max(data.length - 1, 1)) * innerW;
      const y = PAD.top + innerH - (d.pct / max) * innerH;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${innerW + PAD.left + PAD.right} ${CHART_H}`} className="w-full">
      <line
        x1={PAD.left}
        x2={PAD.left + innerW}
        y1={thresholdY}
        y2={thresholdY}
        className="stroke-amber-500"
        strokeDasharray="4 4"
        strokeWidth={1.5}
      />
      <polyline points={line} fill="none" className="stroke-emerald-600" strokeWidth={2} />
      {data.map((d, i) => {
        const x = PAD.left + (i / Math.max(data.length - 1, 1)) * innerW;
        const y = PAD.top + innerH - (d.pct / max) * innerH;
        return (
          <circle key={d.date} cx={x} cy={y} r={3} className={cn("fill-current", wastePercentClass(d.pct))} />
        );
      })}
    </svg>
  );
}

export function DashboardChartsRow({
  production,
  revenue,
  expense,
  waste,
}: {
  production: DashboardWeekBar[];
  revenue: DashboardRevenueWeek[];
  expense: ExpenseChartSlice[];
  waste: DashboardWasteDay[];
}) {
  return (
    <>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="surface-card ring-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Производство vs план</CardTitle>
          </CardHeader>
          <CardContent>
            <ProductionBarChart data={production} />
            <div className="text-muted-foreground mt-2 flex gap-4 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="bg-brand inline-block size-2.5 rounded-sm" /> Факт
              </span>
              <span className="flex items-center gap-1.5">
                <span className="bg-muted-foreground/35 inline-block size-2.5 rounded-sm" /> План
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="surface-card ring-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Выручка vs прошлый месяц</CardTitle>
          </CardHeader>
          <CardContent>
            <RevenueLineChart data={revenue} />
            <div className="text-muted-foreground mt-2 flex gap-4 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="bg-brand inline-block h-0.5 w-4" /> Факт
              </span>
              <span className="flex items-center gap-1.5">
                <span className="bg-muted-foreground/50 inline-block h-0.5 w-4" /> Прошлый месяц
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="surface-card ring-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Структура расходов</CardTitle>
          </CardHeader>
          <CardContent className="flex min-h-[14rem] items-center justify-center">
            <FinanceExpenseChart slices={expense} />
          </CardContent>
        </Card>

        <Card className="surface-card ring-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Процент отхода по дням</CardTitle>
          </CardHeader>
          <CardContent>
            <WasteLineChart data={waste} />
            <p className="text-muted-foreground mt-2 text-xs">
              Порог {defaultAppSettings.wasteThresholdPct}% — пунктир
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function EmptyChart() {
  return (
    <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
      Нет данных за период
    </div>
  );
}
