"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  MARKETPLACE_LABEL,
  SHIPMENT_STATUS_LABEL,
  type InventoryDocRow,
  type Marketplace,
  type MpStockRow,
  type ShipmentRow,
} from "@/mocks/warehouse-fixtures";
import { createInventoryDraft, type WarehouseStock } from "@/server/warehouse";
import { exportXlsx } from "@/lib/export-xlsx";
import { XLSX_FMT, type XlsxSheet } from "@/lib/xlsx-types";
import { formatIsoDate } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { FiltersBar } from "@/components/filters-bar";
import { filterSelectTriggerClass } from "@/components/filter-fields";
import { SegmentTabs } from "@/components/reports/report-shared";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  filterMpStockRows,
  filterShipmentRows,
  getDefaultMpTableFilters,
  getDefaultShipmentTableFilters,
  isMpExtraFiltersDefault,
  isShipmentExtraFiltersDefault,
  WAREHOUSE_FILTER_ALL,
  type WarehouseMarketplaceFilter,
  type WarehouseShipmentStatusFilter,
} from "@/lib/warehouse-table-filters";
import { WarehouseMpTab } from "@/components/warehouse/warehouse-mp-tab";
import { WarehouseProductionTab } from "@/components/warehouse/warehouse-production-tab";
import { WarehouseShipmentsTab } from "@/components/warehouse/warehouse-shipments-tab";
import { WarehouseInventoryTab } from "@/components/warehouse/warehouse-inventory-tab";

const INVENTORY_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Черновик",
  CONDUCTED: "Проведена",
  CLOSED: "Закрыта",
};

type WarehouseTab = "mp" | "production" | "shipments" | "inventory";

const TABS: { key: WarehouseTab; label: string }[] = [
  { key: "mp", label: "МП" },
  { key: "production", label: "Производство" },
  { key: "shipments", label: "Поставки" },
  { key: "inventory", label: "Инвентаризация" },
];

const MARKETPLACE_FILTER_OPTIONS: { value: WarehouseMarketplaceFilter; label: string }[] = [
  { value: WAREHOUSE_FILTER_ALL, label: "Все маркетплейсы" },
  ...(Object.keys(MARKETPLACE_LABEL) as Marketplace[]).map((key) => ({
    value: key,
    label: MARKETPLACE_LABEL[key],
  })),
];

const SHIPMENT_STATUS_FILTER_OPTIONS: { value: WarehouseShipmentStatusFilter; label: string }[] = [
  { value: WAREHOUSE_FILTER_ALL, label: "Все статусы" },
  ...(Object.keys(SHIPMENT_STATUS_LABEL) as Array<keyof typeof SHIPMENT_STATUS_LABEL>).map(
    (key) => ({ value: key, label: SHIPMENT_STATUS_LABEL[key] }),
  ),
];

const filterSelectContentClass = "rounded-xl shadow-balanced ring-0 p-1.5";
const marketplaceSelectTriggerClass = cn(filterSelectTriggerClass, "w-48");
const statusSelectTriggerClass = cn(filterSelectTriggerClass, "w-44");

function MarketplaceFilterSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: WarehouseMarketplaceFilter;
  onChange: (value: WarehouseMarketplaceFilter) => void;
}) {
  const label =
    MARKETPLACE_FILTER_OPTIONS.find((o) => o.value === value)?.label ?? "Все маркетплейсы";
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id} className="cursor-default">
        Маркетплейс
      </Label>
      <Select
        value={value}
        onValueChange={(v) =>
          onChange(
            v != null && (v === WAREHOUSE_FILTER_ALL || v in MARKETPLACE_LABEL)
              ? (v as WarehouseMarketplaceFilter)
              : WAREHOUSE_FILTER_ALL,
          )
        }
      >
        <SelectTrigger id={id} className={marketplaceSelectTriggerClass}>
          <SelectValue placeholder="Все маркетплейсы">{label}</SelectValue>
        </SelectTrigger>
        <SelectContent
          className={filterSelectContentClass}
          side="bottom"
          sideOffset={8}
          alignItemWithTrigger={false}
        >
          {MARKETPLACE_FILTER_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="cursor-pointer rounded-lg">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ShipmentStatusFilterSelect({
  value,
  onChange,
}: {
  value: WarehouseShipmentStatusFilter;
  onChange: (value: WarehouseShipmentStatusFilter) => void;
}) {
  const label =
    SHIPMENT_STATUS_FILTER_OPTIONS.find((o) => o.value === value)?.label ?? "Все статусы";
  return (
    <div className="grid gap-1.5">
      <Label htmlFor="f-shipment-status" className="cursor-default">
        Статус
      </Label>
      <Select
        value={value}
        onValueChange={(v) =>
          onChange(
            v != null && (v === WAREHOUSE_FILTER_ALL || v in SHIPMENT_STATUS_LABEL)
              ? (v as WarehouseShipmentStatusFilter)
              : WAREHOUSE_FILTER_ALL,
          )
        }
      >
        <SelectTrigger id="f-shipment-status" className={statusSelectTriggerClass}>
          <SelectValue placeholder="Все статусы">{label}</SelectValue>
        </SelectTrigger>
        <SelectContent
          className={filterSelectContentClass}
          side="bottom"
          sideOffset={8}
          alignItemWithTrigger={false}
        >
          {SHIPMENT_STATUS_FILTER_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value} className="cursor-pointer rounded-lg">
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

interface WarehouseViewProps {
  stock: WarehouseStock;
  initialDocs: InventoryDocRow[];
  mpStock: MpStockRow[];
  supplies: ShipmentRow[];
}

export function WarehouseView({ stock, initialDocs, mpStock, supplies }: WarehouseViewProps) {
  const [activeTab, setActiveTab] = useState<WarehouseTab>("mp");
  const [mpSearch, setMpSearch] = useState("");
  const [mpMarketplace, setMpMarketplace] =
    useState<WarehouseMarketplaceFilter>(WAREHOUSE_FILTER_ALL);
  const [shipmentSearch, setShipmentSearch] = useState("");
  const [shipmentMarketplace, setShipmentMarketplace] =
    useState<WarehouseMarketplaceFilter>(WAREHOUSE_FILTER_ALL);
  const [shipmentStatus, setShipmentStatus] =
    useState<WarehouseShipmentStatusFilter>(WAREHOUSE_FILTER_ALL);
  const [inventoryDocs, setInventoryDocs] = useState<InventoryDocRow[]>(initialDocs);
  const [pending, startTransition] = useTransition();
  const [exporting, startExport] = useTransition();

  const visibleMpRows = useMemo(
    () => filterMpStockRows(mpStock, { search: mpSearch, marketplace: mpMarketplace }),
    [mpStock, mpSearch, mpMarketplace],
  );

  const visibleShipmentRows = useMemo(
    () =>
      filterShipmentRows(supplies, {
        search: shipmentSearch,
        marketplace: shipmentMarketplace,
        status: shipmentStatus,
      }),
    [supplies, shipmentSearch, shipmentMarketplace, shipmentStatus],
  );

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
            rows: visibleShipmentRows.map((r) => ({
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
          rows: visibleMpRows.map((r) => ({
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

        {activeTab === "mp" && (
          <FiltersBar
            search
            searchPlaceholder="SKU или изделие"
            searchValue={mpSearch}
            onSearchChange={setMpSearch}
            extraFilters={
              <MarketplaceFilterSelect
                id="f-mp-marketplace"
                value={mpMarketplace}
                onChange={setMpMarketplace}
              />
            }
            extraFiltersDirty={!isMpExtraFiltersDefault({ search: mpSearch, marketplace: mpMarketplace })}
            onResetExtraFilters={() => {
              setMpMarketplace(getDefaultMpTableFilters().marketplace);
            }}
          />
        )}
        {activeTab === "shipments" && (
          <FiltersBar
            search
            searchPlaceholder="SKU или изделие"
            searchValue={shipmentSearch}
            onSearchChange={setShipmentSearch}
            extraFilters={
              <>
                <MarketplaceFilterSelect
                  id="f-shipment-marketplace"
                  value={shipmentMarketplace}
                  onChange={setShipmentMarketplace}
                />
                <ShipmentStatusFilterSelect
                  value={shipmentStatus}
                  onChange={setShipmentStatus}
                />
              </>
            }
            extraFiltersDirty={
              !isShipmentExtraFiltersDefault({
                search: shipmentSearch,
                marketplace: shipmentMarketplace,
                status: shipmentStatus,
              })
            }
            onResetExtraFilters={() => {
              const defaults = getDefaultShipmentTableFilters();
              setShipmentMarketplace(defaults.marketplace);
              setShipmentStatus(defaults.status);
            }}
          />
        )}

        {activeTab === "mp" && (
          <WarehouseMpTab
            rows={visibleMpRows}
            empty={
              mpStock.length === 0
                ? "Нет данных с маркетплейсов"
                : "Нет строк по выбранным фильтрам"
            }
          />
        )}
        {activeTab === "production" && <WarehouseProductionTab stock={stock} />}
        {activeTab === "shipments" && (
          <WarehouseShipmentsTab
            rows={visibleShipmentRows}
            empty={
              supplies.length === 0
                ? "Поставок нет — нажмите «Синхронизировать с МП» в разделе Продажи"
                : "Нет строк по выбранным фильтрам"
            }
          />
        )}
        {activeTab === "inventory" && (
          <WarehouseInventoryTab docs={inventoryDocs} onDocsChange={setInventoryDocs} />
        )}
      </div>
    </>
  );
}
