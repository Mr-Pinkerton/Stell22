"use server";

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { requireAdmin } from "@/server/session";
import { loadStoredApiCredentials } from "@/server/settings";
import { writeSystemLog } from "@/server/system-log";
import { computeSupplyDeduction } from "@/lib/supply-stock";
import {
  formatMpSyncMessage,
  mpSyncLogLevel,
  type MpSyncReport,
  type MpSyncSideReport,
} from "@/lib/system-log";
import {
  fetchOzonCancelledSupplyOrderIds,
  fetchOzonPostings,
  fetchOzonStocks,
  fetchOzonSupplyOrders,
  isOzonConfigured,
  ozonCredentialsFrom,
} from "@/lib/ozon-api";
import {
  fetchWbIncomes,
  fetchWbSalesWithMeta,
  fetchWbStocks,
  isWbConfigured,
} from "@/lib/wb-api";
import type { SalesReportRow } from "@/mocks/report-fixtures";
import type { Marketplace, MpStockRow, ShipmentRow, ShipmentStatus } from "@/mocks/warehouse-fixtures";
import {
  mapOzonPosting,
  mapOzonStock,
  mapOzonSupplyOrder,
  mapWbIncome,
  mapWbSale,
  mapWbStock,
  type NormalizedSale,
  type NormalizedStock,
  type NormalizedSupply,
  type OzonPostingRaw,
  type OzonStockRaw,
  type OzonSupplyOrderRaw,
  type WbIncomeRaw,
  type WbSaleRaw,
  type WbStockRaw,
} from "@/lib/marketplace-map";

function toNumber(value: { toNumber: () => number } | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

// ============================ ОТЧЁТ «ПРОДАЖИ» ==============================

export interface SalesData {
  rows: SalesReportRow[];
  totalQty: number;
  totalRevenue: number;
  lastSyncedAt: string | null;
}

/**
 * Продажи МП на реальных данных (таблица Sale). Агрегируем по артикулу/изделию
 * (оба маркетплейса вместе). Возвраты учтены отрицательными кол-вом/выручкой.
 */
export async function getSalesData(): Promise<SalesData> {
  const [sales, products, lastStock] = await Promise.all([
    prisma.sale.findMany({ orderBy: { date: "desc" } }),
    prisma.product.findMany({ select: { id: true, name: true, sku: true } }),
    prisma.mpStock.findFirst({ orderBy: { syncedAt: "desc" }, select: { syncedAt: true } }),
  ]);

  const nameBySku = new Map(products.map((p) => [p.sku, p.name]));
  const nameById = new Map(products.map((p) => [p.id, p.name]));

  const agg = new Map<string, SalesReportRow>();
  let totalQty = 0;
  let totalRevenue = 0;
  for (const s of sales) {
    const revenue = toNumber(s.revenue);
    totalQty += s.quantity;
    totalRevenue += revenue;
    const existing = agg.get(s.sku);
    if (existing) {
      existing.soldQty += s.quantity;
      existing.revenue += revenue;
    } else {
      agg.set(s.sku, {
        id: s.sku,
        productName: (s.productId ? nameById.get(s.productId) : null) ?? nameBySku.get(s.sku) ?? s.sku,
        sku: s.sku,
        soldQty: s.quantity,
        revenue,
      });
    }
  }

  return {
    rows: [...agg.values()].sort((a, b) => b.revenue - a.revenue),
    totalQty,
    totalRevenue,
    lastSyncedAt: lastStock?.syncedAt.toISOString() ?? null,
  };
}

// ============================ ОСТАТКИ МП ===================================

export async function getMpStock(): Promise<MpStockRow[]> {
  const [stock, products] = await Promise.all([
    prisma.mpStock.findMany({ orderBy: [{ marketplace: "asc" }, { sku: "asc" }] }),
    prisma.product.findMany({ select: { sku: true, name: true } }),
  ]);
  const nameBySku = new Map(products.map((p) => [p.sku, p.name]));
  return stock.map((s) => ({
    id: s.id,
    marketplace: s.marketplace as Marketplace,
    sku: s.sku,
    productName: nameBySku.get(s.sku) ?? s.sku,
    quantity: s.quantity,
  }));
}

// ============================ ПОСТАВКИ =====================================

export async function getSupplies(): Promise<ShipmentRow[]> {
  const [supplies, products] = await Promise.all([
    prisma.supply.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.product.findMany({ select: { sku: true, name: true } }),
  ]);
  const nameBySku = new Map(products.map((p) => [p.sku, p.name]));
  return supplies.map((s) => ({
    id: s.id,
    date: (s.acceptedAt ?? s.createdAt).toISOString(),
    marketplace: s.marketplace as Marketplace,
    sku: s.sku,
    productName: nameBySku.get(s.sku) ?? s.sku,
    quantity: s.quantity,
    status: s.status as ShipmentStatus,
  }));
}

// ================== ПОЛУЧЕНИЕ СЫРЫХ ДАННЫХ API (ЗАГЛУШКА) ==================
// Реальные HTTP-вызовы подключаются здесь при появлении ключей
// (см. docs/marketplace-api.md). До тех пор генерируем ответы в формате API,
// чтобы контракт «сырой ответ → модели» (мапперы) был честным и рабочим.

interface ActiveProduct {
  id: string;
  sku: string;
  salePrice: number;
}

function makeRand(seed: number) {
  let s = seed % 0x7fffffff || 1;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function fetchWbSalesRaw(products: ActiveProduct[], now: Date, rand: () => number): WbSaleRaw[] {
  const stamp = now.getTime();
  const out: WbSaleRaw[] = [];
  for (const p of products) {
    const count = 2 + Math.floor(rand() * 4); // 2..5 продаж
    for (let i = 0; i < count; i++) {
      const isReturn = rand() < 0.1; // ~10% возвраты
      out.push({
        date: now.toISOString(),
        supplierArticle: p.sku,
        saleID: `${isReturn ? "R" : "S"}-${stamp}-${p.sku}-${i}`,
        finishedPrice: Math.round(p.salePrice * (0.9 + rand() * 0.2)),
      });
    }
  }
  return out;
}

function fetchOzonPostingsRaw(products: ActiveProduct[], now: Date, rand: () => number): OzonPostingRaw[] {
  const stamp = now.getTime();
  return products.map((p) => ({
    posting_number: `${stamp}-${p.sku}`,
    status: "delivered",
    created_at: now.toISOString(),
    products: [
      {
        offer_id: p.sku,
        quantity: 1 + Math.floor(rand() * 3), // 1..3
        price: p.salePrice.toFixed(2),
      },
    ],
  }));
}

// Поставки — детерминированные (стабильный externalId), чтобы повторная
// синхронизация была идемпотентна и не списывала склад производства повторно
// (см. deductedQty). Реальные поставки придут из API с собственными id.
function fetchWbIncomesRaw(products: ActiveProduct[], now: Date): WbIncomeRaw[] {
  return products.map((p, idx) => {
    const accepted = idx % 2 === 0; // часть принята, часть в пути (обе отгружены)
    return {
      incomeId: 900000 + idx,
      number: `WB-INC-${900000 + idx}`,
      date: now.toISOString(),
      dateClose: accepted ? now.toISOString() : null,
      supplierArticle: p.sku,
      quantity: 5 + (idx % 4),
      warehouseName: "Коледино",
    };
  });
}

function fetchOzonSupplyOrdersRaw(products: ActiveProduct[], now: Date): OzonSupplyOrderRaw[] {
  const items = products.map((p, idx) => ({ offer_id: p.sku, quantity: 3 + (idx % 3) }));
  if (items.length === 0) return [];
  return [
    {
      supply_order_id: 800001,
      status: "shipped",
      created_at: now.toISOString(),
      warehouse_name: "Хоругвино",
      items,
    },
  ];
}

function fetchWbStockRaw(products: ActiveProduct[], rand: () => number): WbStockRaw[] {
  return products.map((p) => ({
    supplierArticle: p.sku,
    quantity: 10 + Math.floor(rand() * 25),
  }));
}

function fetchOzonStockRaw(products: ActiveProduct[], rand: () => number): OzonStockRaw[] {
  return products.map((p) => ({
    offer_id: p.sku,
    present: 10 + Math.floor(rand() * 25),
  }));
}

// ============================ СИНХРОНИЗАЦИЯ ================================

export interface SyncResult {
  ok: boolean;
  salesAdded: number;
  suppliesAdded: number;
  stockUpdated: number;
  error?: string;
  warnings?: string[];
  sources?: { wb: "api" | "stub"; ozon: "api" | "stub" };
}

const SYNC_LOOKBACK_DAYS = 90;
/** Окно поиска отменённых заявок Ozon для реверса списания (шире обычного). */
const CANCELLED_LOOKBACK_DAYS = 90;

async function getSyncSince(): Promise<Date> {
  const [lastSale, lastSupply] = await Promise.all([
    prisma.sale.findFirst({ orderBy: { date: "desc" }, select: { date: true } }),
    prisma.supply.findFirst({ orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
  ]);
  const candidates = [lastSale?.date, lastSupply?.createdAt].filter(Boolean) as Date[];
  if (candidates.length > 0) {
    const latest = candidates.reduce((a, b) => (a > b ? a : b));
    return new Date(latest.getTime() - 24 * 60 * 60 * 1000);
  }
  return new Date(Date.now() - SYNC_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
}

function emptySideReport(mode: "api" | "stub"): MpSyncSideReport {
  return { mode, sales: 0, supplies: 0, stocks: 0, durationMs: 0 };
}

interface FetchedMarketplaceData {
  sales: NormalizedSale[];
  supplies: NormalizedSupply[];
  stocks: NormalizedStock[];
  warnings: string[];
  sources: { wb: "api" | "stub"; ozon: "api" | "stub" };
  /** Успешно ли получены остатки по каждому МП (для частичной замены снимка). */
  stockReplace: { wb: boolean; ozon: boolean };
  /** externalId отменённых/отклонённых заявок Ozon (для реверса списания ГП). */
  ozonCancelledExternalIds: string[];
  wb: MpSyncSideReport;
  ozon: MpSyncSideReport;
}

function apiErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "ошибка API";
}

function noteSideError(side: MpSyncSideReport, label: string, err: unknown, warnings: string[]): void {
  const msg = apiErrorMessage(err);
  warnings.push(`${label}: ${msg}`);
  side.error = side.error ? `${side.error}; ${msg}` : msg;
}

async function fetchMarketplaceData(
  products: ActiveProduct[],
  since: Date,
  to: Date,
): Promise<FetchedMarketplaceData> {
  const creds = await loadStoredApiCredentials();
  const warnings: string[] = [];
  const sources: { wb: "api" | "stub"; ozon: "api" | "stub" } = { wb: "stub", ozon: "stub" };
  const wb = emptySideReport("stub");
  const ozon = emptySideReport("stub");

  const wbSales: NormalizedSale[] = [];
  const wbSupplies: NormalizedSupply[] = [];
  const wbStocks: NormalizedStock[] = [];
  const ozonSales: NormalizedSale[] = [];
  const ozonSupplies: NormalizedSupply[] = [];
  const ozonStocks: NormalizedStock[] = [];

  const rand = makeRand(to.getTime());
  const offerIds = products.map((p) => p.sku);
  const stockReplace = { wb: false, ozon: false };
  const ozonCancelledExternalIds: string[] = [];

  if (isWbConfigured(creds["wb.token"])) {
    sources.wb = "api";
    wb.mode = "api";
    const t0 = performance.now();
    let nmIdToSku = new Map<number, string>();

    try {
      const { sales: wbSalesRaw, nmIdToSku: map } = await fetchWbSalesWithMeta(
        creds["wb.token"],
        since,
      );
      nmIdToSku = map;
      wbSales.push(...wbSalesRaw.map(mapWbSale));
      wb.sales = wbSales.length;
    } catch (err) {
      noteSideError(wb, "WB/продажи", err, warnings);
    }

    try {
      const wbIncomes = await fetchWbIncomes(creds["wb.token"], since);
      wbSupplies.push(...wbIncomes.map(mapWbIncome));
      wb.supplies = wbSupplies.length;
    } catch (err) {
      noteSideError(wb, "WB/поставки", err, warnings);
    }

    try {
      const wbStocksRaw = await fetchWbStocks(creds["wb.token"], nmIdToSku);
      wbStocks.push(...wbStocksRaw.map(mapWbStock));
      wb.stocks = wbStocks.length;
      stockReplace.wb = true;
    } catch (err) {
      noteSideError(wb, "WB/остатки", err, warnings);
    }

    wb.durationMs = Math.round(performance.now() - t0);
  } else {
    wbSales.push(...fetchWbSalesRaw(products, to, rand).map(mapWbSale));
    wbSupplies.push(...fetchWbIncomesRaw(products, to).map(mapWbIncome));
    wbStocks.push(...fetchWbStockRaw(products, rand).map(mapWbStock));
    wb.sales = wbSales.length;
    wb.supplies = wbSupplies.length;
    wb.stocks = wbStocks.length;
    stockReplace.wb = true;
  }

  const ozonCreds = ozonCredentialsFrom(creds);
  if (isOzonConfigured(ozonCreds ?? {})) {
    sources.ozon = "api";
    ozon.mode = "api";
    const t0 = performance.now();
    const ozonCredsNonNull = ozonCreds!;

    try {
      const ozonPostings = await fetchOzonPostings(ozonCredsNonNull, since, to);
      ozonSales.push(...ozonPostings.flatMap(mapOzonPosting));
      ozon.sales = ozonSales.length;
    } catch (err) {
      noteSideError(ozon, "Ozon/продажи", err, warnings);
    }

    try {
      const ozonSuppliesRaw = await fetchOzonSupplyOrders(ozonCredsNonNull, since, to);
      ozonSupplies.push(...ozonSuppliesRaw.flatMap(mapOzonSupplyOrder));
      ozon.supplies = ozonSupplies.length;
    } catch (err) {
      noteSideError(ozon, "Ozon/поставки", err, warnings);
    }

    try {
      const ozonStocksRaw = await fetchOzonStocks(ozonCredsNonNull, offerIds);
      ozonStocks.push(...ozonStocksRaw.map(mapOzonStock));
      ozon.stocks = ozonStocks.length;
      stockReplace.ozon = true;
    } catch (err) {
      noteSideError(ozon, "Ozon/остатки", err, warnings);
    }

    // Отменённые заявки за широкое окно — для реверса ранее списанного ГП.
    // Не блокирует остальной sync: сбой лишь пишет предупреждение.
    try {
      const cancelledSince = new Date(to.getTime() - CANCELLED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
      const cancelledIds = await fetchOzonCancelledSupplyOrderIds(
        ozonCredsNonNull,
        cancelledSince,
        to,
      );
      ozonCancelledExternalIds.push(...cancelledIds.map((id) => String(id)));
    } catch (err) {
      noteSideError(ozon, "Ozon/отмены", err, warnings);
    }

    ozon.durationMs = Math.round(performance.now() - t0);
  } else {
    ozonSales.push(...fetchOzonPostingsRaw(products, to, rand).flatMap(mapOzonPosting));
    ozonSupplies.push(...fetchOzonSupplyOrdersRaw(products, to).flatMap(mapOzonSupplyOrder));
    ozonStocks.push(...fetchOzonStockRaw(products, rand).map(mapOzonStock));
    ozon.sales = ozonSales.length;
    ozon.supplies = ozonSupplies.length;
    ozon.stocks = ozonStocks.length;
    stockReplace.ozon = true;
  }

  return {
    sales: [...wbSales, ...ozonSales],
    supplies: [...wbSupplies, ...ozonSupplies],
    stocks: [...wbStocks, ...ozonStocks],
    warnings,
    sources,
    stockReplace,
    ozonCancelledExternalIds,
    wb,
    ozon,
  };
}

async function persistMpSyncLog(report: MpSyncReport, userId: string): Promise<void> {
  await writeSystemLog({
    level: mpSyncLogLevel(report),
    source: "Маркетплейсы",
    message: formatMpSyncMessage(report),
    details: report as unknown as Record<string, unknown>,
    userId,
  });
}

/**
 * Синхронизация с маркетплейсами. При сохранённых ключах — реальные HTTP-вызовы
 * (см. src/lib/wb-api.ts, src/lib/ozon-api.ts); иначе — демо-заглушки.
 */
export async function syncMarketplaces(): Promise<SyncResult> {
  const admin = await requireAdmin();
  return syncMarketplacesAsUser(admin.id);
}

/** Синхронизация от имени пользователя (для CLI без cookie-сессии). */
export async function syncMarketplacesAsUser(userId: string): Promise<SyncResult> {
  const syncStarted = performance.now();
  const now = new Date();
  const since = await getSyncSince();

  const dbProducts = await prisma.product.findMany({ where: { status: "ACTIVE" } });
  if (dbProducts.length === 0) {
    const report: MpSyncReport = {
      since: since.toISOString(),
      to: now.toISOString(),
      ok: false,
      durationMs: Math.round(performance.now() - syncStarted),
      sources: { wb: "stub", ozon: "stub" },
      wb: emptySideReport("stub"),
      ozon: emptySideReport("stub"),
      warnings: [],
      totals: { sales: 0, supplies: 0, stocks: 0 },
      error: "Нет активных изделий",
    };
    await persistMpSyncLog(report, userId);
    return { ok: false, salesAdded: 0, suppliesAdded: 0, stockUpdated: 0, error: report.error };
  }

  const products: ActiveProduct[] = dbProducts.map((p) => ({
    id: p.id,
    sku: p.sku,
    salePrice: toNumber(p.salePrice),
  }));
  const idBySku = new Map(products.map((p) => [p.sku, p.id]));

  const fetched = await fetchMarketplaceData(products, since, now);
  const {
    sales,
    supplies,
    stocks,
    warnings,
    sources,
    stockReplace,
    ozonCancelledExternalIds,
    wb,
    ozon,
  } = fetched;

  const apiConfigured = sources.wb === "api" || sources.ozon === "api";
  const noData = sales.length === 0 && supplies.length === 0 && stocks.length === 0;

  if (apiConfigured && warnings.length > 0 && noData) {
    const report: MpSyncReport = {
      since: since.toISOString(),
      to: now.toISOString(),
      ok: false,
      durationMs: Math.round(performance.now() - syncStarted),
      sources,
      wb,
      ozon,
      warnings,
      totals: { sales: 0, supplies: 0, stocks: 0 },
      error: warnings.join("; "),
    };
    await persistMpSyncLog(report, userId);
    return {
      ok: false,
      salesAdded: 0,
      suppliesAdded: 0,
      stockUpdated: 0,
      error: report.error,
      warnings,
      sources,
    };
  }
  let deductedTotal = 0;
  let shortfallTotal = 0;
  let restoredTotal = 0;
  await prisma.$transaction(async (tx) => {
    for (const s of sales) {
      await tx.sale.upsert({
        where: { marketplace_externalId: { marketplace: s.marketplace, externalId: s.externalId } },
        create: {
          marketplace: s.marketplace,
          externalId: s.externalId,
          sku: s.sku,
          productId: idBySku.get(s.sku) ?? null,
          quantity: s.quantity,
          revenue: new Decimal(s.revenue).toFixed(2),
          isReturn: s.isReturn,
          date: s.date,
        },
        update: {
          quantity: s.quantity,
          revenue: new Decimal(s.revenue).toFixed(2),
          isReturn: s.isReturn,
          date: s.date,
        },
      });
    }

    for (const s of supplies) {
      const productId = idBySku.get(s.sku) ?? null;
      const key = {
        marketplace_externalId_sku: {
          marketplace: s.marketplace,
          externalId: s.externalId,
          sku: s.sku,
        },
      };
      const existing = await tx.supply.findUnique({ where: key });
      const alreadyDeducted = existing?.deductedQty ?? 0;
      const alreadyShort = existing?.shortfallQty ?? 0;

      await tx.supply.upsert({
        where: key,
        create: {
          marketplace: s.marketplace,
          externalId: s.externalId,
          number: s.number,
          sku: s.sku,
          productId,
          quantity: s.quantity,
          status: s.status,
          warehouseName: s.warehouseName,
          createdAt: s.createdAt,
          acceptedAt: s.acceptedAt,
        },
        update: {
          quantity: s.quantity,
          status: s.status,
          acceptedAt: s.acceptedAt,
          warehouseName: s.warehouseName,
        },
      });

      // Списание со склада производства: отгрузка (SHIPPED/ACCEPTED) означает,
      // что изделия физически ушли со склада. Учитываем «новую» часть
      // (quantity − уже учтённое), где учтённое = фактически списано + недостача.
      // deductedQty хранит именно ФАКТ (для корректного восстановления при
      // отмене), shortfallQty — учтённую недостачу (чтобы не пытаться списать
      // её повторно каждую синхронизацию). Нельзя в минус — недостача = «потеря ГП».
      const shipped = s.status === "SHIPPED" || s.status === "ACCEPTED";
      const target = shipped ? s.quantity : 0;
      if (target > alreadyDeducted + alreadyShort && productId) {
        const ps = await tx.productStock.findUnique({ where: { productId } });
        const { toRemove, shortfall, newDeducted, newShort } = computeSupplyDeduction({
          targetQty: target,
          alreadyDeducted,
          alreadyShort,
          available: ps?.quantity ?? 0,
        });
        if (toRemove > 0) {
          await tx.productStock.update({
            where: { productId },
            data: { quantity: { decrement: toRemove } },
          });
          deductedTotal += toRemove;
        }
        if (shortfall > 0) {
          shortfallTotal += shortfall;
          await writeChangeLog(
            {
              entity: "Supply",
              entityId: `${s.marketplace}:${s.externalId}:${s.sku}`,
              newValues: { event: "gp_shortfall", sku: s.sku, shortfall },
            },
            tx,
          );
        }
        await tx.supply.update({
          where: key,
          data: { deductedQty: newDeducted, shortfallQty: newShort },
        });
      }
    }

    // Восстановление склада производства по отменённым заявкам Ozon: если ранее
    // списали ГП, а заявку отменили/отклонили — возвращаем ровно фактически
    // списанное (deductedQty) и обнуляем счётчики. shortfallQty не возвращаем —
    // эти единицы физически не списывались.
    for (const externalId of ozonCancelledExternalIds) {
      const rows = await tx.supply.findMany({
        where: { marketplace: "OZON", externalId, deductedQty: { gt: 0 } },
      });
      for (const row of rows) {
        if (row.productId && row.deductedQty > 0) {
          await tx.productStock.upsert({
            where: { productId: row.productId },
            create: { productId: row.productId, quantity: row.deductedQty },
            update: { quantity: { increment: row.deductedQty } },
          });
          restoredTotal += row.deductedQty;
          await writeChangeLog(
            {
              entity: "Supply",
              entityId: `OZON:${externalId}:${row.sku}`,
              newValues: {
                event: "gp_restore_cancelled",
                sku: row.sku,
                restored: row.deductedQty,
              },
            },
            tx,
          );
        }
        await tx.supply.update({
          where: { id: row.id },
          data: { deductedQty: 0, shortfallQty: 0, status: "PENDING" },
        });
      }
    }

    // Остатки — полный снимок, но по каждому МП отдельно: заменяем только те
    // маркетплейсы, чьи остатки успешно получены. Иначе частичный сбой (напр.
    // Ozon упал, WB прошёл) стёр бы остатки другого маркетплейса.
    const replaceMarketplaces: Marketplace[] = [];
    if (stockReplace.wb) replaceMarketplaces.push("WB");
    if (stockReplace.ozon) replaceMarketplaces.push("OZON");
    if (replaceMarketplaces.length > 0) {
      await tx.mpStock.deleteMany({ where: { marketplace: { in: replaceMarketplaces } } });
      const rows = stocks.filter((s) => replaceMarketplaces.includes(s.marketplace));
      if (rows.length > 0) {
        await tx.mpStock.createMany({
          data: rows.map((s) => ({
            marketplace: s.marketplace,
            sku: s.sku,
            quantity: s.quantity,
            syncedAt: now,
          })),
        });
      }
    }

    await writeChangeLog(
      {
        entity: "MpStock",
        entityId: "sync",
        newValues: {
          salesAdded: sales.length,
          suppliesAdded: supplies.length,
          stockUpdated: stocks.length,
          deductedFromProduction: deductedTotal,
          gpShortfall: shortfallTotal,
          restoredFromCancelled: restoredTotal,
          at: now.toISOString(),
          sources,
        },
      },
      tx,
    );
  });

  const report: MpSyncReport = {
    since: since.toISOString(),
    to: now.toISOString(),
    ok: true,
    durationMs: Math.round(performance.now() - syncStarted),
    sources,
    wb,
    ozon,
    warnings,
    totals: {
      sales: sales.length,
      supplies: supplies.length,
      stocks: stocks.length,
      deductedFromProduction: deductedTotal,
      gpShortfall: shortfallTotal,
      restoredFromCancelled: restoredTotal,
    },
  };
  await persistMpSyncLog(report, userId);

  try {
    revalidatePath("/sales");
    revalidatePath("/warehouse");
    revalidatePath("/reports");
    revalidatePath("/settings");
  } catch {
    // вне Next.js runtime (CLI-скрипты)
  }
  return {
    ok: true,
    salesAdded: sales.length,
    suppliesAdded: supplies.length,
    stockUpdated: stocks.length,
    warnings: warnings.length > 0 ? warnings : undefined,
    sources,
  };
}
