// HTTP-клиент Ozon Seller API. Возвращает *Raw-типы для мапперов.
// См. docs/marketplace-api.md.

import type { OzonPostingRaw, OzonStockRaw, OzonSupplyOrderRaw } from "@/lib/marketplace-map";
import { fetchJson, MarketplaceApiError, sleep, type MpFetchResult } from "@/lib/marketplace-http";

const OZON_BASE = "https://api-seller.ozon.ru";
const PAGE_LIMIT = 1000;
const MAX_PAGES = 50;

export interface OzonCredentials {
  clientId: string;
  apiKey: string;
}

function ozonHeaders(creds: OzonCredentials): HeadersInit {
  return {
    "Client-Id": creds.clientId.trim(),
    "Api-Key": creds.apiKey.trim(),
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function ozonPost<T>(creds: OzonCredentials, path: string, body: unknown): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fetchJson<T>(`${OZON_BASE}${path}`, {
        method: "POST",
        headers: ozonHeaders(creds),
        body: JSON.stringify(body),
      });
    } catch (err) {
      lastErr = err;
      if (err instanceof MarketplaceApiError && err.status === 429 && attempt < 4) {
        await sleep(800 + attempt * 400);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function toIso(d: Date): string {
  return d.toISOString();
}

interface OzonPostingListResult {
  postings?: OzonPostingRaw[];
  has_next?: boolean;
}

async function fetchOzonPostingList(
  creds: OzonCredentials,
  path: string,
  since: Date,
  to: Date,
): Promise<OzonPostingRaw[]> {
  const out: OzonPostingRaw[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await ozonPost<{ result?: OzonPostingListResult }>(creds, path, {
      dir: "ASC",
      filter: { since: toIso(since), to: toIso(to) },
      limit: PAGE_LIMIT,
      offset,
      with: { analytics_data: true, financial_data: true },
    });

    const postings = res.result?.postings ?? [];
    out.push(...postings);

    if (!res.result?.has_next || postings.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
    await sleep(300);
  }

  return out;
}

/** FBO + FBS отправления за период (каждый список — отдельно, сбой одного не блокирует другой). */
export async function fetchOzonPostings(
  creds: OzonCredentials,
  since: Date,
  to: Date,
): Promise<OzonPostingRaw[]> {
  const out: OzonPostingRaw[] = [];
  const paths: Array<{ label: string; path: string }> = [
    { label: "fbo", path: "/v2/posting/fbo/list" },
    { label: "fbs", path: "/v3/posting/fbs/list" },
  ];
  const errors: string[] = [];

  for (const { label, path } of paths) {
    try {
      out.push(...(await fetchOzonPostingList(creds, path, since, to)));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "ошибка API";
      errors.push(`${label}: ${msg}`);
    }
  }

  if (out.length === 0 && errors.length > 0) {
    throw new MarketplaceApiError(errors.join("; "));
  }
  return out;
}

/** Статусы заявок для синхронизации (без отменённых/черновиков). */
const OZON_SUPPLY_LIST_STATES = [
  "READY_TO_SUPPLY",
  "ACCEPTED_AT_SUPPLY_WAREHOUSE",
  "IN_TRANSIT",
  "ACCEPTANCE_AT_STORAGE_WAREHOUSE",
  "REPORTS_CONFIRMATION_AWAITING",
  "COMPLETED",
] as const;

/** sort_by=1 — по дате создания (обязателен, иначе SortBy=0). */
const OZON_SUPPLY_SORT_BY_CREATED = 1;

/** Лимит заявок за один sync (новые первыми). */
const OZON_SUPPLY_MAX_ORDERS = 120;

const OZON_SUPPLY_SKIP_STATES = new Set(["CANCELLED", "REJECTED_AT_SUPPLY_WAREHOUSE"]);

/** Статусы отменённых/отклонённых заявок (для реверса списания ГП). */
const OZON_SUPPLY_CANCELLED_STATES = ["CANCELLED", "REJECTED_AT_SUPPLY_WAREHOUSE"] as const;

/** Максимум отменённых заявок за проход реверса. */
const OZON_CANCELLED_MAX_ORDERS = 500;

interface OzonSupplyGetProduct {
  offer_id?: string;
  quantity?: number;
}

export interface OzonSupplyGetOrder {
  supply_order_id?: number;
  status?: string;
  created_at?: string;
  warehouse_name?: string;
  products?: OzonSupplyGetProduct[];
  order_id?: number;
  state?: string;
  created_date?: string;
  drop_off_warehouse?: { name?: string };
  supplies?: Array<{
    state?: string;
    bundle_id?: string;
    products?: OzonSupplyGetProduct[];
    bundle?: { items?: OzonSupplyGetProduct[] };
  }>;
}

/** Парсит состав заявки (legacy get или bundle items). */
export function parseOzonSupplyOrderItems(order: OzonSupplyGetOrder): OzonSupplyGetProduct[] {
  const items: OzonSupplyGetProduct[] = [];
  const push = (list?: OzonSupplyGetProduct[]) => {
    for (const p of list ?? []) {
      if (p.offer_id && p.quantity) items.push(p);
    }
  };

  push(order.products);
  for (const supply of order.supplies ?? []) {
    push(supply.products);
    push(supply.bundle?.items);
  }
  return items;
}

export function mapOzonSupplyGetToRaw(
  order: OzonSupplyGetOrder,
  bundleItemsByBundleId?: Map<string, OzonSupplyGetProduct[]>,
): OzonSupplyOrderRaw | null {
  const id = order.order_id ?? order.supply_order_id;
  const created = order.created_date ?? order.created_at;
  const status = order.state ?? order.status ?? "created";
  const warehouse = order.drop_off_warehouse?.name ?? order.warehouse_name;
  if (!id || !created) return null;

  let items: OzonSupplyGetProduct[] = [];
  if (bundleItemsByBundleId && order.supplies?.length) {
    for (const supply of order.supplies) {
      if (supply.state && OZON_SUPPLY_SKIP_STATES.has(supply.state)) continue;
      if (supply.bundle_id) {
        items.push(...(bundleItemsByBundleId.get(supply.bundle_id) ?? []));
      }
    }
  } else {
    items = parseOzonSupplyOrderItems(order);
  }

  if (items.length === 0) return null;

  return {
    supply_order_id: id,
    status,
    created_at: created,
    warehouse_name: warehouse,
    items: items.map((p) => ({
      offer_id: p.offer_id!,
      quantity: p.quantity!,
    })),
  };
}

async function fetchOzonSupplyOrderIdsByStates(
  creds: OzonCredentials,
  since: Date,
  to: Date,
  states: readonly string[],
  maxOrders: number,
): Promise<{ ids: number[]; warnings: string[] }> {
  const ids: number[] = [];
  const warnings: string[] = [];
  let lastId: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const body: Record<string, unknown> = {
      since: toIso(since),
      to: toIso(to),
      limit: 100,
      sort_by: OZON_SUPPLY_SORT_BY_CREATED,
      filter: { states: [...states] },
    };
    if (lastId) body.last_id = lastId;

    const res = await ozonPost<{ order_ids?: number[]; last_id?: string }>(
      creds,
      "/v3/supply-order/list",
      body,
    );

    const batch = res.order_ids ?? [];
    ids.push(...batch);

    if (ids.length >= maxOrders) break;
    const next = res.last_id?.trim();
    if (!next || batch.length === 0) break;
    lastId = next;
    await sleep(300);
  }

  const unique = [...new Set(ids)];
  const truncated = unique.length > maxOrders;
  if (truncated) {
    warnings.push(
      `Ozon/поставки: в API ${unique.length} заявок, обработано ${maxOrders} (лимит sync)`,
    );
  }

  return { ids: unique.slice(0, maxOrders), warnings };
}

async function fetchOzonSupplyOrderIds(
  creds: OzonCredentials,
  since: Date,
  to: Date,
): Promise<{ ids: number[]; warnings: string[] }> {
  return fetchOzonSupplyOrderIdsByStates(
    creds,
    since,
    to,
    OZON_SUPPLY_LIST_STATES,
    OZON_SUPPLY_MAX_ORDERS,
  );
}

/**
 * ID отменённых/отклонённых заявок Ozon за период (только list — дёшево, без
 * get/bundle). Используется для восстановления списанного ГП при отмене.
 */
export async function fetchOzonCancelledSupplyOrderIds(
  creds: OzonCredentials,
  since: Date,
  to: Date,
): Promise<number[]> {
  const { ids } = await fetchOzonSupplyOrderIdsByStates(
    creds,
    since,
    to,
    OZON_SUPPLY_CANCELLED_STATES,
    OZON_CANCELLED_MAX_ORDERS,
  );
  return ids;
}

interface OzonBundleItem {
  offer_id?: string;
  quantity?: number;
}

async function fetchOzonBundleItems(
  creds: OzonCredentials,
  bundleIds: string[],
): Promise<Map<string, OzonSupplyGetProduct[]>> {
  const byBundle = new Map<string, OzonSupplyGetProduct[]>();
  const unique = [...new Set(bundleIds.filter(Boolean))];

  for (const bundleId of unique) {
    const res = await ozonPost<{ items?: OzonBundleItem[] }>(creds, "/v1/supply-order/bundle", {
      bundle_ids: [bundleId],
      limit: 100,
    });
    const items = (res.items ?? [])
      .filter((p) => p.offer_id && p.quantity)
      .map((p) => ({ offer_id: p.offer_id!, quantity: p.quantity! }));
    if (items.length) byBundle.set(bundleId, items);
    await sleep(400);
  }

  return byBundle;
}

/** Заявки на поставку FBO: list → get → bundle (состав). */
export async function fetchOzonSupplyOrders(
  creds: OzonCredentials,
  since: Date,
  to: Date,
): Promise<MpFetchResult<OzonSupplyOrderRaw[]>> {
  const { ids: orderIds, warnings } = await fetchOzonSupplyOrderIds(creds, since, to);
  if (orderIds.length === 0) return { data: [], warnings };

  const orders: OzonSupplyGetOrder[] = [];
  const getChunk = 50;

  for (let i = 0; i < orderIds.length; i += getChunk) {
    const chunk = orderIds.slice(i, i + getChunk);
    const getRes = await ozonPost<{
      result?: { orders?: OzonSupplyGetOrder[] };
      orders?: OzonSupplyGetOrder[];
    }>(creds, "/v3/supply-order/get", { order_ids: chunk });

    orders.push(...(getRes.result?.orders ?? getRes.orders ?? []));
    if (i + getChunk < orderIds.length) await sleep(300);
  }

  const bundleIds: string[] = [];
  for (const order of orders) {
    for (const supply of order.supplies ?? []) {
      if (supply.state && OZON_SUPPLY_SKIP_STATES.has(supply.state)) continue;
      if (supply.bundle_id) bundleIds.push(supply.bundle_id);
    }
  }

  const bundleItems = bundleIds.length > 0 ? await fetchOzonBundleItems(creds, bundleIds) : new Map();

  const out: OzonSupplyOrderRaw[] = [];
  for (const order of orders) {
    const raw = mapOzonSupplyGetToRaw(order, bundleItems);
    if (raw) out.push(raw);
  }
  return { data: out, warnings };
}

interface V4StockItem {
  offer_id?: string;
  stocks?: Array<{ present?: number }>;
}

interface V4StocksResponse {
  items?: V4StockItem[];
  cursor?: string;
  result?: { items?: V4StockItem[]; cursor?: string };
}

function parseV4StockItems(res: V4StocksResponse): V4StockItem[] {
  return res.items ?? res.result?.items ?? [];
}

function nextStockCursor(res: V4StocksResponse): string | undefined {
  const c = res.cursor ?? res.result?.cursor;
  return c && c.length > 0 ? c : undefined;
}

/** Остатки по offer_id (наш sku). API v4, суммируем present по складам. */
export async function fetchOzonStocks(
  creds: OzonCredentials,
  offerIds: string[],
): Promise<OzonStockRaw[]> {
  if (offerIds.length === 0) return [];

  const byOffer = new Map<string, number>();
  const chunkSize = 500;

  for (let i = 0; i < offerIds.length; i += chunkSize) {
    const chunk = offerIds.slice(i, i + chunkSize);
    let cursor: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const body: Record<string, unknown> = {
        filter: { offer_id: chunk, visibility: "ALL" },
        limit: Math.min(chunkSize, 1000),
      };
      if (cursor) body.cursor = cursor;

      const res = await ozonPost<V4StocksResponse>(creds, "/v4/product/info/stocks", body);
      const items = parseV4StockItems(res);

      for (const item of items) {
        if (!item.offer_id) continue;
        const present = (item.stocks ?? []).reduce((sum, s) => sum + (s.present ?? 0), 0);
        byOffer.set(item.offer_id, (byOffer.get(item.offer_id) ?? 0) + present);
      }

      cursor = nextStockCursor(res);
      if (!cursor || items.length === 0) break;
      await sleep(300);
    }

    if (i + chunkSize < offerIds.length) await sleep(300);
  }

  return [...byOffer.entries()].map(([offer_id, present]) => ({ offer_id, present }));
}

export function isOzonConfigured(creds: {
  clientId?: string;
  apiKey?: string;
}): boolean {
  return Boolean(creds.clientId?.trim() && creds.apiKey?.trim());
}

export function ozonCredentialsFrom(values: {
  "ozon.clientId"?: string;
  "ozon.apiKey"?: string;
}): OzonCredentials | null {
  const clientId = values["ozon.clientId"]?.trim() ?? "";
  const apiKey = values["ozon.apiKey"]?.trim() ?? "";
  if (!clientId || !apiKey) return null;
  return { clientId, apiKey };
}

export { MarketplaceApiError };
