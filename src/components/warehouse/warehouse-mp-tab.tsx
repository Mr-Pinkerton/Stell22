"use client";

import { DataTable, type Column } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";
import { mpStockRows, MARKETPLACE_LABEL, type MpStockRow } from "@/mocks/warehouse-fixtures";

const columns: Column<MpStockRow>[] = [
  {
    key: "marketplace",
    header: "МП",
    render: (row) => MARKETPLACE_LABEL[row.marketplace],
  },
  {
    key: "sku",
    header: "Артикул",
    render: (row) => <span className="font-mono text-sm">{row.sku}</span>,
  },
  {
    key: "productName",
    header: "Название",
    render: (row) => <span className="font-medium">{row.productName}</span>,
  },
  {
    key: "quantity",
    header: "Остаток",
    className: "w-28",
    render: (row) => <span className="tabular-nums">{row.quantity}</span>,
  },
];

interface WarehouseMpTabProps {
  rows?: MpStockRow[];
}

export function WarehouseMpTab({ rows = mpStockRows }: WarehouseMpTabProps) {
  return (
    <Card className="surface-card ring-0">
      <CardContent className="p-0">
        <DataTable columns={columns} rows={rows} empty="Нет данных с маркетплейсов" padded className="border-0" />
      </CardContent>
    </Card>
  );
}
