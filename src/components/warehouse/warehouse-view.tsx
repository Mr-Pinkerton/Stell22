"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { type InventoryDocRow, type MpStockRow } from "@/mocks/warehouse-fixtures";
import { createInventoryDraft, type WarehouseStock } from "@/server/warehouse";
import { PageHeader } from "@/components/page-header";
import { SegmentTabs } from "@/components/reports/report-shared";
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
        addLabel="Добавить"
        onExport={() => toast.message("Экспорт — прототип")}
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
