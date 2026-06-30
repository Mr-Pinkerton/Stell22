"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  MARKETPLACE_LABEL,
  SHIPMENT_STATUS_LABEL,
  shipmentRows,
  type InventoryDocRow,
  type MpStockRow,
} from "@/mocks/warehouse-fixtures";
import { createInventoryDraft, type WarehouseStock } from "@/server/warehouse";
import { exportXlsx } from "@/lib/export-xlsx";
import { XLSX_FMT, type XlsxSheet } from "@/lib/xlsx-types";
import { formatIsoDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { SegmentTabs } from "@/components/reports/report-shared";

const INVENTORY_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Черновик",
  CONDUCTED: "Проведена",
  CLOSED: "Закрыта",
};
import { WarehouseMpTab } from "@/components/warehouse/warehouse-mp-tab";
import { WarehouseProductionTab } from "@/components/warehouse/warehouse-production-tab";
import { WarehouseShipmentsTab } from "@/components/warehouse/warehouse-shipments-tab";
import { WarehouseInventoryTab } from "@/components/warehouse/warehouse-inventory-tab";

type WarehouseTab = "mp" | "production" | "shipments" | "inventory";

const TABS: { key: WarehouseTab; label: string }[] = [
  { key: "mp", label: "МП" },
  { key: "production", label: "Производство" },
  { key: "shipments", label: "Поставки" },
  { key: "inventory", label: "Инвентаризация" },
];

interface WarehouseViewProps {
  stock: WarehouseStock;
  initialDocs: InventoryDocRow[];
  mpStock: MpStockRow[];
}

export function WarehouseView({ stock, initialDocs, mpStock }: WarehouseViewProps) {
  const [activeTab, setActiveTab] = useState<WarehouseTab>("mp");
  const [inventoryDocs, setInventoryDocs] = useState<InventoryDocRow[]>(initialDocs);
  const [pending, startTransition] = useTransition();
  const [exporting, startExport] = useTransition();

  const buildWarehouseSheets = (): { base: string; sheets: XlsxSheet[] } => {
    if (activeTab === "production") {
      const prodCols = [
        { header: "Название", key: "name", width: 28 },
        { header: "Остаток", key: "quantity", numFmt: XLSX_FMT.int },
      ];
      return {
        base: "склад-производство",
        sheets: [
          {
            name: "Изделия",
            columns: prodCols,
            rows: stock.products.map((r) => ({ name: r.name, quantity: r.quantity })),
          },
          {
            name: "Детали",
            columns: [
              { header: "Название", key: "name", width: 28 },
              { header: "Готово", key: "ready", numFmt: XLSX_FMT.int },
              { header: "Ждут присадку", key: "pending", numFmt: XLSX_FMT.int },
              { header: "Всего", key: "quantity", numFmt: XLSX_FMT.int },
            ],
            rows: stock.details.map((r) => ({
              name: r.name,
              ready: r.ready,
              pending: r.pendingPrisadka,
              quantity: r.quantity,
            })),
          },
          {
            name: "Крепёж",
            columns: prodCols,
            rows: stock.fasteners.map((r) => ({ name: r.name, quantity: r.quantity })),
          },
          {
            name: "Упаковка",
            columns: prodCols,
            rows: stock.packaging.map((r) => ({ name: r.name, quantity: r.quantity })),
          },
          {
            name: "Разное",
            columns: prodCols,
            rows: stock.other.map((r) => ({ name: r.name, quantity: r.quantity })),
          },
        ],
      };
    }
    if (activeTab === "shipments") {
      return {
        base: "склад-поставки",
        sheets: [
          {
            name: "Поставки",
            columns: [
              { header: "Дата", key: "date", width: 14 },
              { header: "МП", key: "mp", width: 14 },
              { header: "Артикул", key: "sku" },
              { header: "Изделие", key: "product", width: 28 },
              { header: "Кол-во", key: "quantity", numFmt: XLSX_FMT.int },
              { header: "Статус", key: "status", width: 14 },
            ],
            rows: shipmentRows.map((r) => ({
              date: formatIsoDate(r.date),
              mp: MARKETPLACE_LABEL[r.marketplace],
              sku: r.sku,
              product: r.productName,
              quantity: r.quantity,
              status: SHIPMENT_STATUS_LABEL[r.status],
            })),
          },
        ],
      };
    }
    if (activeTab === "inventory") {
      return {
        base: "склад-инвентаризация",
        sheets: [
          {
            name: "Инвентаризация",
            columns: [
              { header: "Дата", key: "date", width: 14 },
              { header: "Статус", key: "status", width: 14 },
              { header: "Позиций", key: "lines", numFmt: XLSX_FMT.int },
            ],
            rows: inventoryDocs.map((d) => ({
              date: formatIsoDate(d.date),
              status: INVENTORY_STATUS_LABEL[d.status] ?? d.status,
              lines: d.lines.length,
            })),
          },
        ],
      };
    }
    return {
      base: "склад-мп",
      sheets: [
        {
          name: "Остатки МП",
          columns: [
            { header: "Маркетплейс", key: "mp", width: 16 },
            { header: "Артикул", key: "sku" },
            { header: "Изделие", key: "product", width: 28 },
            { header: "Остаток", key: "quantity", numFmt: XLSX_FMT.int },
          ],
          rows: mpStock.map((r) => ({
            mp: MARKETPLACE_LABEL[r.marketplace],
            sku: r.sku,
            product: r.productName,
            quantity: r.quantity,
          })),
        },
      ],
    };
  };

  const handleExport = () =>
    startExport(async () => {
      try {
        const { base, sheets } = buildWarehouseSheets();
        await exportXlsx(base, sheets);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Не удалось выгрузить");
      }
    });

  const handleAdd = () => {
    if (activeTab === "inventory") {
      if (pending) return;
      startTransition(async () => {
        try {
          const doc = await createInventoryDraft();
          setInventoryDocs((prev) => [doc, ...prev]);
          toast.success("Создан черновик инвентаризации");
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Ошибка создания");
        }
      });
      return;
    }
    toast.message("Добавление — прототип");
  };

  return (
    <>
      <PageHeader
        title="Склад"
        canExport
        exporting={exporting}
        addLabel="Добавить"
        onExport={handleExport}
        onAdd={handleAdd}
      />

      <div className="space-y-4">
        <SegmentTabs
          ariaLabel="Склад"
          tabs={TABS}
          value={activeTab}
          onChange={setActiveTab}
        />

        {activeTab === "mp" && <WarehouseMpTab rows={mpStock} />}
        {activeTab === "production" && <WarehouseProductionTab stock={stock} />}
        {activeTab === "shipments" && <WarehouseShipmentsTab />}
        {activeTab === "inventory" && (
          <WarehouseInventoryTab docs={inventoryDocs} onDocsChange={setInventoryDocs} />
        )}
      </div>
    </>
  );
}
