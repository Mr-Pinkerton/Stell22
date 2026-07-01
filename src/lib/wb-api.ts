// HTTP-клиент Wildberries (Statistics + Analytics). Возвращает *Raw-типы для мапперов.
// См. docs/marketplace-api.md.

import type { WbIncomeRaw, WbSaleRaw, WbStockRaw } from "@/lib/marketplace-map";
import { fetchJson, MarketplaceApiError, sleep } from "@/lib/marketplace-http";

const STATISTICS_BASE = "https://statistics-api.wildberries.ru";
const ANALYTICS_BASE = "https://seller-analytics-api.wildberries.ru";
const SUPPLIES_BASE = "https://supplies-api.wildberries.ru";

const MAX_PAGES = 50;
const PAGE_DELAY_MS = 2_000;
const SUPPLY_DELAY_MS = 2_100;
const MAX_WB_SUPPLIES = 80;

interface WbSaleApiRow {
  date: string;
  lastChangeDate?: string;
  supplierArticle: string;
  saleID: string;
  finishedPrice: number;
  priceWithDisc?: number;
  nmId?: number;
}

interface WbIncomeApiRow {
  incomeId: number;
  number: string;
  date: string;
  dateClose?: string | null;
  lastChangeDate?: string;
  supplierArticle: string;
  quantity: number;
  warehouseName?: string;
}

interface WbWarehouseStockRow {
  nmId: number;
  quantity: number;
}

function wbHeaders(token: string): HeadersInit {
  return { Authorization: token.trim(), Accept: "application/json" };
}

async function wbRequest<T>(url: string, init: RequestInit): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fetchJson<T>(url, init);
    } catch (err) {
      lastErr = err;
      if (err instanceof MarketplaceApiError && err.status === 429 && attempt < 4) {
        await sleep(2_000 + attempt * 1_000);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function wbGet<T>(base: string, path: string, token: string): Promise<T> {
  return wbRequest<T>(`${base}${path}`, { method: "GET", headers: wbHeaders(token) });
}

async function wbSuppliesPost<T>(path: string, token: string, body: unknown): Promise<T> {
  return wbRequest<T>(`${SUPPLIES_BASE}${path}`, {
    method: "POST",
    headers: { ...wbHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function wbSuppliesGet<T>(path: string, token: string): Promise<T> {
  return wbGet<T>(SUPPLIES_BASE, path, token);
}

async function wbAnalyticsPost<T>(path: string, token: string, body: unknown): Promise<T> {
  return wbRequest<T>(`${ANALYTICS_BASE}${path}`, {
    method: "POST",
    headers: { ...wbHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface WbSupplyRow {
  supplyID?: number | null;
  preorderID?: number;
  createDate?: string;
  factDate?: string;
  updatedDate?: string;
  statusID?: number;
}

interface WbGoodInSupply {
  vendorCode?: string;
  quantity?: number;
}

/** Нормализация statusID FBW → наш SupplyStatus. */
export function mapWbSupplyStatusFromId(statusId?: number): "PENDING" | "SHIPPED" | "ACCEPTED" {
  switch (statusId) {
    case 5:
      return "ACCEPTED";
    case 3:
    case 4:
    case 6:
      return "SHIPPED";
    default:
      return "PENDING";
  }
}

async function fetchWbIncomesLegacy(token: string, dateFrom: Date): Promise<WbIncomeRaw[]> {
  const out: WbIncomeRaw[] = [];
  let cursor = dateFrom.toISOString();

  for (let page = 0; page < MAX_PAGES; page++) {
    const path = `/api/v1/supplier/incomes?dateFrom=${encodeURIComponent(cursor)}`;
    const batch = await wbGet<WbIncomeApiRow[]>(STATISTICS_BASE, path, token);
    if (!Array.isArray(batch) || batch.length === 0) break;

    for (const row of batch) {
      out.push({
        incomeId: row.incomeId,
        number: row.number,
        date: row.date,
        dateClose: row.dateClose,
        supplierArticle: row.supplierArticle,
        quantity: row.quantity,
        warehouseName: row.warehouseName,
      });
    }

    const last = batch[batch.length - 1];
    const next = last.lastChangeDate ?? last.date;
    if (next === cursor) break;
    cursor = next;
    await sleep(PAGE_DELAY_MS);
  }

  return out;
}

/** FBW supplies API (замена снятого Statistics /supplier/incomes). */
async function fetchWbIncomesFbw(token: string, dateFrom: Date): Promise<WbIncomeRaw[]> {
  const from = dateFrom.toISOString();
  const till = new Date().toISOString();

  const supplies = await wbSuppliesPost<WbSupplyRow[]>(
    "/api/v1/supplies?limit=1000",
    token,
    {
      dates: [{ from, till, type: "createDate" }],
      statusIDs: [3, 4, 5, 6],
    },
  );

  if (!Array.isArray(supplies)) return [];

  const out: WbIncomeRaw[] = [];
  for (const supply of supplies.slice(0, MAX_WB_SUPPLIES)) {
    const isPreorder = !supply.supplyID;
    const id = supply.supplyID ?? supply.preorderID;
    if (!id) continue;

    const goods = await wbSuppliesGet<WbGoodInSupply[]>(
      `/api/v1/supplies/${id}/goods?limit=1000&isPreorderID=${isPreorder}`,
      token,
    );

    const status = mapWbSupplyStatusFromId(supply.statusID);
    const dateClose =
      status === "ACCEPTED" ? (supply.factDate ?? supply.updatedDate ?? null) : null;

    for (const row of goods ?? []) {
      if (!row.vendorCode || !row.quantity) continue;
      out.push({
        incomeId: id,
        number: String(id),
        date: supply.createDate ?? from,
        dateClose,
        supplierArticle: row.vendorCode,
        quantity: row.quantity,
        status,
      });
    }

    await sleep(SUPPLY_DELAY_MS);
  }

  return out;
}

/** Поставки FBW: legacy Statistics incomes или Supplies API. */
export async function fetchWbIncomes(token: string, dateFrom: Date): Promise<WbIncomeRaw[]> {
  try {
    return await fetchWbIncomesLegacy(token, dateFrom);
  } catch (err) {
    if (err instanceof MarketplaceApiError && err.status === 404) {
      return fetchWbIncomesFbw(token, dateFrom);
    }
    throw err;
  }
}

/**
 * Остатки на складах WB. Агрегируем quantity по nmId, затем маппим на артикул
 * через nmId→supplierArticle из продаж (если карта пуста — пропускаем позицию).
 */
export async function fetchWbStocks(
  token: string,
  nmIdToSku: Map<number, string>,
): Promise<WbStockRaw[]> {
  const byNmId = new Map<number, number>();
  let offset = 0;
  const limit = 1000;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await wbAnalyticsPost<{ data?: { items?: WbWarehouseStockRow[] } }>(
      "/api/analytics/v1/stocks-report/wb-warehouses",
      token,
      { limit, offset },
    );
    const items = res.data?.items ?? [];
    if (items.length === 0) break;

    for (const row of items) {
      byNmId.set(row.nmId, (byNmId.get(row.nmId) ?? 0) + row.quantity);
    }

    if (items.length < limit) break;
    offset += limit;
    await sleep(PAGE_DELAY_MS);
  }

  const out: WbStockRaw[] = [];
  for (const [nmId, quantity] of byNmId) {
    const sku = nmIdToSku.get(nmId);
    if (!sku) continue;
    out.push({ supplierArticle: sku, quantity });
  }
  return out;
}

/** Строит карту nmId → артикул из сырых строк продаж WB. */
export function buildWbNmIdMap(rows: WbSaleApiRow[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const row of rows) {
    if (row.nmId && row.supplierArticle) {
      map.set(row.nmId, row.supplierArticle);
    }
  }
  return map;
}

/** Внутренний fetch с nmId для построения карты остатков. */
export async function fetchWbSalesWithMeta(
  token: string,
  dateFrom: Date,
): Promise<{ sales: WbSaleRaw[]; nmIdToSku: Map<number, string> }> {
  const rawRows: WbSaleApiRow[] = [];
  let cursor = dateFrom.toISOString();

  for (let page = 0; page < MAX_PAGES; page++) {
    const path = `/api/v1/supplier/sales?dateFrom=${encodeURIComponent(cursor)}`;
    const batch = await wbGet<WbSaleApiRow[]>(STATISTICS_BASE, path, token);
    if (!Array.isArray(batch) || batch.length === 0) break;
    rawRows.push(...batch);

    const last = batch[batch.length - 1];
    const next = last.lastChangeDate ?? last.date;
    if (next === cursor) break;
    cursor = next;
    await sleep(PAGE_DELAY_MS);
  }

  return {
    sales: rawRows.map((row) => ({
      date: row.date,
      supplierArticle: row.supplierArticle,
      saleID: row.saleID,
      finishedPrice: row.finishedPrice,
      priceWithDisc: row.priceWithDisc,
    })),
    nmIdToSku: buildWbNmIdMap(rawRows),
  };
}

export function isWbConfigured(token: string | undefined): boolean {
  return Boolean(token?.trim());
}

export { MarketplaceApiError };
