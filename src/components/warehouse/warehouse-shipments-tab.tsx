"use client";

import { DataTable, type Column } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  shipmentRows,
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
  rows?: ShipmentRow[];
}

export function WarehouseShipmentsTab({ rows = shipmentRows }: WarehouseShipmentsTabProps) {
  return (
    <Card className="surface-card ring-0">
      <CardContent className="p-0">
        <DataTable columns={columns} rows={rows} empty="Поставок нет" padded className="border-0" />
      </CardContent>
    </Card>
  );
}
