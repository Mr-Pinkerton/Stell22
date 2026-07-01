// Контракт «сырой ответ API маркетплейса → наши нормализованные записи».
// Чистые функции (без БД/сети) — их прогоняет и синхронизация, и тесты.
// Реальные HTTP-вызовы (когда появятся ключи) должны возвращать те же формы
// *Raw и проходить через эти же мапперы. См. docs/marketplace-api.md.

import type { Marketplace, ShipmentStatus } from "@/mocks/warehouse-fixtures";

export type SupplyStatus = ShipmentStatus;

export interface NormalizedSale {
  marketplace: Marketplace;
  externalId: string;
  sku: string;
  quantity: number; // < 0 для возвратов
  revenue: number; // ₽, < 0 для возвратов
  isReturn: boolean;
  date: Date;
}

export interface NormalizedSupply {
  marketplace: Marketplace;
  externalId: string;
  number: string | null;
  sku: string;
  quantity: number;
  status: SupplyStatus;
  warehouseName: string | null;
  createdAt: Date;
  acceptedAt: Date | null;
}

export interface NormalizedStock {
  marketplace: Marketplace;
  sku: string;
  quantity: number;
}

// ============================ WILDBERRIES ==================================

/** GET /api/v1/supplier/sales — 1 строка = 1 продажа/возврат (1 товар). */
export interface WbSaleRaw {
  date: string;
  supplierArticle: string;
  saleID: string; // S… — продажа, R… — возврат
  finishedPrice: number; // фактически уплачено покупателем
  priceWithDisc?: number;
}

export function mapWbSale(r: WbSaleRaw): NormalizedSale {
  const isReturn = r.saleID.startsWith("R");
  const price = r.finishedPrice || r.priceWithDisc || 0;
  return {
    marketplace: "WB",
    externalId: r.saleID,
    sku: r.supplierArticle,
    quantity: isReturn ? -1 : 1,
    revenue: isReturn ? -Math.abs(price) : price,
    isReturn,
    date: new Date(r.date),
  };
}

/** GET /api/v1/supplier/incomes — поставки на склад WB (FBW). */
export interface WbIncomeRaw {
  incomeId: number;
  number: string;
  date: string;
  dateClose?: string | null;
  supplierArticle: string;
  quantity: number;
  warehouseName?: string;
}

export function mapWbIncome(r: WbIncomeRaw): NormalizedSupply {
  const accepted = r.dateClose ? new Date(r.dateClose) : null;
  return {
    marketplace: "WB",
    externalId: String(r.incomeId),
    number: r.number || null,
    sku: r.supplierArticle,
    quantity: r.quantity,
    status: accepted ? "ACCEPTED" : "SHIPPED",
    warehouseName: r.warehouseName ?? null,
    createdAt: new Date(r.date),
    acceptedAt: accepted,
  };
}

/** POST /api/analytics/v1/stocks-report/wb-warehouses — остатки по складам. */
export interface WbStockRaw {
  supplierArticle: string;
  quantity: number;
}

export function mapWbStock(r: WbStockRaw): NormalizedStock {
  return {
    marketplace: "WB",
    sku: r.supplierArticle,
    quantity: r.quantity,
  };
}

// ================================ OZON =====================================

/** Товар в отправлении Ozon (FBO/FBS posting). */
export interface OzonPostingProductRaw {
  offer_id: string;
  sku?: number;
  name?: string;
  quantity: number;
  price: string; // Ozon отдаёт цену строкой
}

/** POST /v2/posting/fbo/list | /v3/posting/fbs/list. */
export interface OzonPostingRaw {
  posting_number: string;
  status: string;
  created_at: string;
  products: OzonPostingProductRaw[];
}

export function mapOzonPosting(r: OzonPostingRaw): NormalizedSale[] {
  const isReturn = r.status === "returned" || r.status === "cancelled";
  return r.products.map((p) => {
    const revenue = Number(p.price) * p.quantity;
    return {
      marketplace: "OZON" as const,
      externalId: `${r.posting_number}:${p.offer_id}`,
      sku: p.offer_id,
      quantity: isReturn ? -p.quantity : p.quantity,
      revenue: isReturn ? -revenue : revenue,
      isReturn,
      date: new Date(r.created_at),
    };
  });
}

/** POST /v3/supply-order/list (+ состав) — заявки на поставку на склад Ozon. */
export interface OzonSupplyItemRaw {
  offer_id: string;
  quantity: number;
}

export interface OzonSupplyOrderRaw {
  supply_order_id: number;
  status: string; // created / confirmed / shipped / delivered / cancelled
  created_at: string;
  warehouse_name?: string;
  items: OzonSupplyItemRaw[];
}

export function mapOzonSupplyStatus(status: string): SupplyStatus {
  switch (status) {
    case "delivered":
      return "ACCEPTED";
    case "shipped":
    case "confirmed":
      return "SHIPPED";
    default:
      return "PENDING"; // created / cancelled / неизвестный
  }
}

export function mapOzonSupplyOrder(r: OzonSupplyOrderRaw): NormalizedSupply[] {
  const status = mapOzonSupplyStatus(r.status);
  const createdAt = new Date(r.created_at);
  return r.items.map((it) => ({
    marketplace: "OZON" as const,
    externalId: String(r.supply_order_id),
    number: String(r.supply_order_id),
    sku: it.offer_id,
    quantity: it.quantity,
    status,
    warehouseName: r.warehouse_name ?? null,
    createdAt,
    acceptedAt: status === "ACCEPTED" ? createdAt : null,
  }));
}

/** POST /v1/product/info/stocks — остатки товаров. */
export interface OzonStockRaw {
  offer_id: string;
  present: number;
}

export function mapOzonStock(r: OzonStockRaw): NormalizedStock {
  return {
    marketplace: "OZON",
    sku: r.offer_id,
    quantity: r.present,
  };
}
