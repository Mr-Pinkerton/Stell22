"use client";

import type { ReactNode } from "react";
import { DataTable, type Column } from "@/components/data-table";
import { TableSurface, tableHeaderClassName } from "@/components/table-surface";
import { Badge } from "@/components/ui/badge";
import {
  MARKETPLACE_LABEL,
  SHIPMENT_STATUS_LABEL,
  type ShipmentRow,
} from "@/mocks/warehouse-fixtures";
import { formatIsoDate } from "@/lib/format";

const columns: Column<ShipmentRow>[] = [
  {
    key: "date",
    header: "Дата",
    render: (row) => <span className="tabular-nums">{formatIsoDate(row.date)}</span>,
  },
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
    header: "Изделие",
    render: (row) => <span className="font-medium">{row.productName}</span>,
  },
  {
    key: "quantity",
    header: "Кол-во",
    className: "w-24",
    render: (row) => <span className="tabular-nums">{row.quantity}</span>,
  },
  {
    key: "status",
    header: "Статус",
    render: (row) => (
      <Badge
        variant={
          row.status === "ACCEPTED"
            ? "secondary"
            : row.status === "SHIPPED"
              ? "outline"
              : "outline"
        }
      >
        {SHIPMENT_STATUS_LABEL[row.status]}
      </Badge>
    ),
  },
];

interface WarehouseShipmentsTabProps {
  rows: ShipmentRow[];
  empty?: string;
  filters?: ReactNode;
}

export function WarehouseShipmentsTab({
  rows,
  empty = "Поставок нет — нажмите «Синхронизировать с МП» в разделе Продажи",
  filters,
}: WarehouseShipmentsTabProps) {
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
