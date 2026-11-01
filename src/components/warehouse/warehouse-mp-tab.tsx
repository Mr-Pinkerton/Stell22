"use client";

import type { ReactNode } from "react";
import { DataTable, type Column } from "@/components/data-table";
import { TableSurface, tableHeaderClassName } from "@/components/table-surface";
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
  empty?: string;
  filters?: ReactNode;
}

export function WarehouseMpTab({
  rows = mpStockRows,
  empty = "Нет данных с маркетплейсов",
  filters,
}: WarehouseMpTabProps) {
  return (
    <TableSurface filters={filters}>
      <DataTable
        columns={columns}
        rows={rows}
        empty={empty}
        padded
        className="border-0"
        headerClassName={tableHeaderClassName}
      />
    </TableSurface>
  );
}
