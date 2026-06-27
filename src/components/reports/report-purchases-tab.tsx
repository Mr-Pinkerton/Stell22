"use client";

import { useMemo } from "react";
import {
  purchaseReportKpis,
  purchaseReportRows,
  type PurchaseReportRow,
} from "@/mocks/report-fixtures";
import { formatIsoDate, formatMoney, formatVolume } from "@/lib/format";
import { KpiTile } from "@/components/kpi-tile";
import { DataTable, type Column } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

interface ReportPurchasesTabProps {
  showArchive: boolean;
}

function sortPct(p: { sort1: number; sort2: number }) {
  return `${p.sort1}% / ${p.sort2}%`;
}

export function ReportPurchasesTab({ showArchive }: ReportPurchasesTabProps) {
  const rows = useMemo(
    () =>
      purchaseReportRows.filter((r) => showArchive || r.status !== "ARCHIVED"),
    [showArchive],
  );

  const kpis = useMemo(() => purchaseReportKpis(rows), [rows]);

  const columns: Column<PurchaseReportRow>[] = [
    {
      key: "name",
      header: "Партия",
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "purchaseDate",
      header: "Дата",
      className: "tabular-nums",
      render: (row) => formatIsoDate(row.purchaseDate),
    },
    {
      key: "totalCost",
      header: "Стоимость",
      className: "tabular-nums",
      render: (row) => formatMoney(row.totalCost),
    },
    {
      key: "volumeM3",
      header: "Объём",
      className: "tabular-nums",
      render: (row) => formatVolume(row.volumeM3),
    },
    {
      key: "sortPurchase",
      header: "Сорта закупка",
      className: "tabular-nums text-xs",
      render: (row) => sortPct(row.sortPurchasePct),
    },
    {
      key: "sortFact",
      header: "Сорта факт",
      className: "tabular-nums text-xs",
      render: (row) => sortPct(row.sortFactPct),
    },
    {
      key: "avgCostPerM3",
      header: "₽/м³",
      className: "tabular-nums",
      render: (row) => formatMoney(row.avgCostPerM3),
    },
    {
      key: "status",
      header: "Статус",
      render: (row) => (
        <Badge variant={row.status === "IN_WORK" ? "secondary" : "outline"}>
          {row.status === "IN_WORK" ? "В работе" : "Архив"}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile title="Всего партий" value={String(kpis.batchCount)} />
        <KpiTile title="Общая сумма" value={formatMoney(kpis.totalCost)} />
        <KpiTile title="Общий объём" value={formatVolume(kpis.totalVolume)} />
        <KpiTile title="Средняя стоимость за куб" value={formatMoney(kpis.avgCostPerM3)} />
      </div>

      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          <DataTable
            columns={columns}
            rows={rows}
            empty="Партии за период не найдены"
            className="border-0"
            padded
          />
        </CardContent>
      </Card>
    </div>
  );
}
