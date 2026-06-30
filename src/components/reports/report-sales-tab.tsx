"use client";

import type { SalesReportRow } from "@/mocks/report-fixtures";
import { formatMoney } from "@/lib/format";
import { DataTable, type Column } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";

export function ReportSalesTab({ rows }: { rows: SalesReportRow[] }) {
  const columns: Column<SalesReportRow>[] = [
    {
      key: "productName",
      header: "Изделие",
      render: (row) => <span className="font-medium">{row.productName}</span>,
    },
    {
      key: "sku",
      header: "Артикул",
      className: "tabular-nums",
      render: (row) => row.sku,
    },
    {
      key: "soldQty",
      header: "Продано",
      className: "tabular-nums",
      render: (row) => `${row.soldQty} шт`,
    },
    {
      key: "revenue",
      header: "Выручка",
      className: "tabular-nums",
      render: (row) => formatMoney(row.revenue),
    },
    {
      key: "avgPrice",
      header: "Средняя цена",
      className: "tabular-nums",
      render: (row) =>
        formatMoney(row.soldQty > 0 ? Math.round(row.revenue / row.soldQty) : 0),
    },
  ];

  return (
    <Card className="surface-card ring-0">
      <CardContent className="p-0">
        <DataTable
          columns={columns}
          rows={rows}
          empty="Продажи за период не найдены"
          className="border-0"
          padded
        />
      </CardContent>
    </Card>
  );
}
