import type { InventoryStatus } from "@/types/domain";

export type Marketplace = "OZON" | "WB";

export const MARKETPLACE_LABEL: Record<Marketplace, string> = {
  OZON: "Ozon",
  WB: "Wildberries",
};

/** Остатки на складах маркетплейсов (мок API). */
export interface MpStockRow {
  id: string;
  marketplace: Marketplace;
  sku: string;
  productName: string;
  quantity: number;
}

export type ShipmentStatus = "PENDING" | "SHIPPED" | "ACCEPTED";

export const SHIPMENT_STATUS_LABEL: Record<ShipmentStatus, string> = {
  PENDING: "Ожидает",
  SHIPPED: "Отгружена",
  ACCEPTED: "Принята",
};

/** Поставки на МП (мок API). */
export interface ShipmentRow {
  id: string;
  date: string;
  marketplace: Marketplace;
  sku: string;
  productName: string;
  quantity: number;
  status: ShipmentStatus;
}

export type InventoryRefType = "DETAIL" | "PRODUCT" | "NOMENCLATURE";

export interface InventoryLineRow {
  id: string;
  refType: InventoryRefType;
  refId: string;
  name: string;
  accountedQty: number;
  actualQty: number;
  /** Условная себестоимость единицы для расчёта суммы отклонения (прототип). */
  unitCost: number;
}

export interface InventoryDocRow {
  id: string;
  date: string;
  status: InventoryStatus;
  lines: InventoryLineRow[];
}

/** Остатки изделий на производственном складе. */
export const productStock: Record<string, number> = {
  "prod-1": 42,
  "prod-2": 18,
};

export const mpStockRows: MpStockRow[] = [
  {
    id: "mp-1",
    marketplace: "OZON",
    sku: "ART-001",
    productName: "Полка настенная",
    quantity: 28,
  },
  {
    id: "mp-2",
    marketplace: "OZON",
    sku: "ART-002",
    productName: "Полка угловая",
    quantity: 12,
  },
  {
    id: "mp-3",
    marketplace: "WB",
    sku: "ART-001",
    productName: "Полка настенная",
    quantity: 15,
  },
  {
    id: "mp-4",
    marketplace: "WB",
    sku: "ART-002",
    productName: "Полка угловая",
    quantity: 7,
  },
];

function line(
  id: string,
  refType: InventoryRefType,
  refId: string,
  name: string,
  accountedQty: number,
  actualQty: number,
  unitCost: number,
): InventoryLineRow {
  return { id, refType, refId, name, accountedQty, actualQty, unitCost };
}

/** Текущая инвентаризация + архив проведённых. */
export const inventoryDocs: InventoryDocRow[] = [
  {
    id: "inv-draft",
    date: "2026-06-28",
    status: "DRAFT",
    lines: [
      line("invl-1", "PRODUCT", "prod-1", "Полка настенная", 42, 42, 850),
      line("invl-2", "PRODUCT", "prod-2", "Полка угловая", 18, 18, 920),
      line("invl-3", "DETAIL", "det-1", "Полка 600", 90, 90, 45),
      line("invl-4", "DETAIL", "det-2", "Канавка 720", 24, 22, 52),
      line("invl-5", "NOMENCLATURE", "nom-1", "Саморез 4x40", 800, 795, 1.5),
      line("invl-6", "NOMENCLATURE", "nom-2", "Коробка стандарт", 40, 40, 35),
    ],
  },
  {
    id: "inv-1",
    date: "2026-05-31",
    status: "CONDUCTED",
    lines: [
      line("invl-h1", "PRODUCT", "prod-1", "Полка настенная", 35, 34, 820),
      line("invl-h2", "NOMENCLATURE", "nom-1", "Саморез 4x40", 720, 718, 1.5),
    ],
  },
  {
    id: "inv-2",
    date: "2026-04-30",
    status: "CLOSED",
    lines: [
      line("invl-h3", "DETAIL", "det-1", "Полка 600", 110, 108, 42),
      line("invl-h4", "NOMENCLATURE", "nom-2", "Коробка стандарт", 55, 55, 35),
    ],
  },
];

export function createEmptyInventoryDoc(date: string): InventoryDocRow {
  return {
    id: `inv-${Date.now()}`,
    date,
    status: "DRAFT",
    lines: [],
  };
}
