"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { dayKey } from "@/lib/entries";
import {
  createEmptyInventoryDoc,
  inventoryDocs as mockInventoryDocs,
  type InventoryDocRow,
} from "@/mocks/warehouse-fixtures";
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

export function WarehouseView() {
  const [activeTab, setActiveTab] = useState<WarehouseTab>("mp");
  const [inventoryDocs, setInventoryDocs] = useState<InventoryDocRow[]>(mockInventoryDocs);

  const hasDraft = useMemo(
    () => inventoryDocs.some((d) => d.status === "DRAFT"),
    [inventoryDocs],
  );

  const handleAdd = () => {
    if (activeTab === "inventory") {
      if (hasDraft) {
        toast.message("Уже есть черновик инвентаризации");
        return;
      }
      const doc = createEmptyInventoryDoc(dayKey(new Date()));
      setInventoryDocs((prev) => [doc, ...prev]);
      setActiveTab("inventory");
      toast.success("Создан черновик инвентаризации");
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

        {activeTab === "mp" && <WarehouseMpTab />}
        {activeTab === "production" && <WarehouseProductionTab />}
        {activeTab === "shipments" && <WarehouseShipmentsTab />}
        {activeTab === "inventory" && (
          <WarehouseInventoryTab docs={inventoryDocs} onDocsChange={setInventoryDocs} />
        )}
      </div>
    </>
  );
}
