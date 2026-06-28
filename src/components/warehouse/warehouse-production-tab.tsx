"use client";

import { useMemo, useState } from "react";
import { DataTable, type Column } from "@/components/data-table";
import { Card, CardContent } from "@/components/ui/card";
import { SegmentTabs } from "@/components/reports/report-shared";
import {
  buildDetailStockRows,
  buildNomenclatureStockRows,
  buildProductStockRows,
  type DetailStockRow,
  type ProductionStockRow,
} from "@/lib/warehouse-stock";
import { cn } from "@/lib/utils";

type ProductionTab = "products" | "details" | "fasteners" | "packaging" | "other";

const TABS: { key: ProductionTab; label: string }[] = [
  { key: "products", label: "Изделия" },
  { key: "details", label: "Детали" },
  { key: "fasteners", label: "Крепёж" },
  { key: "packaging", label: "Упаковка" },
  { key: "other", label: "Разное" },
];

const productColumns: Column<ProductionStockRow>[] = [
  {
    key: "name",
    header: "Название",
    render: (row) => <span className="font-medium">{row.name}</span>,
  },
  {
    key: "sku",
    header: "Артикул",
    render: (row) => <span className="font-mono text-sm">{row.sku ?? "—"}</span>,
  },
  {
    key: "quantity",
    header: "Остаток",
    className: "w-28",
    render: (row) => <span className="tabular-nums">{row.quantity}</span>,
  },
];

const detailColumns: Column<DetailStockRow>[] = [
  {
    key: "name",
    header: "Название",
    render: (row) => <span className="font-medium">{row.name}</span>,
  },
  {
    key: "ready",
    header: "Готово",
    className: "w-24",
    render: (row) => <span className="tabular-nums">{row.ready}</span>,
  },
  {
    key: "pending",
    header: "На присадке",
    className: "w-28",
    render: (row) => <span className="tabular-nums">{row.pendingPrisadka}</span>,
  },
  {
    key: "quantity",
    header: "Всего",
    className: "w-24",
    render: (row) => <span className="font-medium tabular-nums">{row.quantity}</span>,
  },
];

function nomenclatureColumns(showMin: boolean): Column<ProductionStockRow>[] {
  const cols: Column<ProductionStockRow>[] = [
    {
      key: "name",
      header: "Название",
      render: (row) => <span className="font-medium">{row.name}</span>,
    },
    {
      key: "quantity",
      header: "Остаток",
      className: "w-28",
      render: (row) => (
        <span
          className={cn(
            "tabular-nums",
            showMin &&
              row.minStock != null &&
              row.quantity < row.minStock &&
              "text-amber-700 font-semibold",
          )}
        >
          {row.quantity}
        </span>
      ),
    },
  ];

  if (showMin) {
    cols.push({
      key: "minStock",
      header: "Мин.",
      className: "w-24",
      render: (row) => (
        <span className="text-muted-foreground tabular-nums">{row.minStock ?? "—"}</span>
      ),
    });
  }

  return cols;
}

export function WarehouseProductionTab() {
  const [activeTab, setActiveTab] = useState<ProductionTab>("products");

  const productRows = useMemo(() => buildProductStockRows(), []);
  const detailRows = useMemo(() => buildDetailStockRows(), []);
  const fastenerRows = useMemo(() => buildNomenclatureStockRows("FASTENER"), []);
  const packagingRows = useMemo(() => buildNomenclatureStockRows("PACKAGING"), []);
  const otherRows = useMemo(() => buildNomenclatureStockRows("OTHER"), []);

  return (
    <div className="space-y-4">
      <SegmentTabs
        ariaLabel="Склад производства"
        tabs={TABS}
        value={activeTab}
        onChange={setActiveTab}
      />

      <Card className="surface-card ring-0">
        <CardContent className="p-0">
          {activeTab === "products" && (
            <DataTable
              columns={productColumns}
              rows={productRows}
              empty="Изделий нет"
              padded
              className="border-0"
            />
          )}
          {activeTab === "details" && (
            <DataTable
              columns={detailColumns}
              rows={detailRows}
              empty="Деталей нет"
              padded
              className="border-0"
            />
          )}
          {activeTab === "fasteners" && (
            <DataTable
              columns={nomenclatureColumns(true)}
              rows={fastenerRows}
              empty="Крепежа нет"
              padded
              className="border-0"
            />
          )}
          {activeTab === "packaging" && (
            <DataTable
              columns={nomenclatureColumns(true)}
              rows={packagingRows}
              empty="Упаковки нет"
              padded
              className="border-0"
            />
          )}
          {activeTab === "other" && (
            <DataTable
              columns={nomenclatureColumns(false)}
              rows={otherRows}
              empty="Позиций нет"
              padded
              className="border-0"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
