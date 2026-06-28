"use client";

import { formatMoney } from "@/lib/format";
import { wastePercentClass } from "@/components/reports/report-shared";
import { DataTable, type Column } from "@/components/data-table";
import type { DashboardWorkerRow, DashboardBatchRemainder } from "@/lib/dashboard-metrics";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const workerColumns: Column<DashboardWorkerRow>[] = [
  {
    key: "name",
    header: "Сотрудник",
    render: (row) => <span className="font-medium">{row.name}</span>,
  },
  {
    key: "produced",
    header: "Произведено",
    className: "w-28",
    render: (row) => <span className="tabular-nums">{row.produced}</span>,
  },
  {
    key: "waste",
    header: "Отход",
    className: "w-24",
    render: (row) => (
      <span className={cn("tabular-nums", wastePercentClass(row.wastePct))}>
        {row.wastePct}%
      </span>
    ),
  },
  {
    key: "salary",
    header: "ЗП к выплате",
    className: "w-36",
    render: (row) => <span className="font-medium tabular-nums">{formatMoney(row.salary)}</span>,
  },
];

export function DashboardWorkersTable({ rows }: { rows: DashboardWorkerRow[] }) {
  return (
    <Card className="surface-card ring-0">
      <CardHeader>
        <CardTitle className="text-base">Топ работников</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <DataTable columns={workerColumns} rows={rows} padded className="border-0" />
      </CardContent>
    </Card>
  );
}

function remainderBarClass(pct: number): string {
  if (pct >= 50) return "bg-emerald-600";
  if (pct >= 25) return "bg-amber-500";
  return "bg-red-600";
}

export function DashboardBatchRemainders({ rows }: { rows: DashboardBatchRemainder[] }) {
  return (
    <Card className="surface-card ring-0">
      <CardHeader>
        <CardTitle className="text-base">Остаток материала по партиям</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {rows.map((row) => (
          <div key={row.id} className="space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium">{row.name}</span>
              <span className="text-muted-foreground tabular-nums">{row.remainingPct}%</span>
            </div>
            <div className="bg-muted h-2.5 overflow-hidden rounded-full">
              <div
                className={cn("h-full rounded-full transition-all", remainderBarClass(row.remainingPct))}
                style={{ width: `${row.remainingPct}%` }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
