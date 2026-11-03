import { Decimal } from "decimal.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { loadStoredApiCredentialsInternal } from "@/server/internal/api-credentials";
import {
  type MovementActorSnapshot,
} from "@/server/internal/inventory-movement-actor";
import { isInventoryMovementShadowWriteActiveForWriter } from "@/server/internal/inventory-movement-shadow-write";
import { writeSystemLog } from "@/server/system-log";
import { retryOnceOnSyncDeadlock, runSupplySyncAccounting } from "@/server/internal/supply-deduct";
import { requireSupplyUserActor } from "@/server/internal/supply-shadow-write";
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
  fetchWbNmIdMapFromOrders,
  fetchWbSalesWithMeta,
  fetchWbStocks,
  isWbConfigured,
  mergeWbNmIdMaps,
} from "@/lib/wb-api";
import type { Marketplace } from "@/mocks/warehouse-fixtures";
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
} from "@/lib/marketplace-map";

interface ActiveProduct {
  id: string;
  skuOzon: string;
  skuWb: string;
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

export const MARKETPLACE_SYNC_CREDENTIALS_REQUIRED =
  "Синхронизация отклонена: нужны ключи и Ozon, и Wildberries. Демонстрационные данные не записываются.";

export const MARKETPLACE_SYNC_STUB_REFUSED =
  "Синхронизация отклонена: демонстрационные данные не записываются.";

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

function noteSideError(
  side: MpSyncSideReport,
  label: string,
  err: unknown,
  warnings: string[],
): void {
  const msg = apiErrorMessage(err);
  warnings.push(`${label}: ${msg}`);
  side.error = side.error ? `${side.error}; ${msg}` : msg;
}

async function fetchMarketplaceData(
  products: ActiveProduct[],
  since: Date,
  to: Date,
): Promise<FetchedMarketplaceData> {
  const creds = await loadStoredApiCredentialsInternal();
  if (!isWbConfigured(creds["wb.token"]) || !isOzonConfigured(ozonCredentialsFrom(creds) ?? {})) {
    throw new Error(MARKETPLACE_SYNC_CREDENTIALS_REQUIRED);
  }
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

  const offerIds = products.map((p) => p.skuOzon).filter(Boolean);
  const stockReplace = { wb: false, ozon: false };
  const ozonCancelledExternalIds: string[] = [];

  if (isWbConfigured(creds["wb.token"])) {
    sources.wb = "api";
    wb.mode = "api";
    const t0 = performance.now();
    let nmIdToSku = new Map<number, string>();

    try {
      const { sales: wbSalesRaw, nmIdToSku: salesMap } = await fetchWbSalesWithMeta(
        creds["wb.token"],
        since,
      );
      nmIdToSku = salesMap;
      wbSales.push(...wbSalesRaw.map(mapWbSale));
      wb.sales = wbSales.length;
    } catch (err) {
      noteSideError(wb, "WB/продажи", err, warnings);
    }

    try {
      const { data: wbIncomes, warnings: incomeWarnings } = await fetchWbIncomes(
        creds["wb.token"],
        since,
      );
      warnings.push(...incomeWarnings);
      wbSupplies.push(...wbIncomes.map(mapWbIncome));
      wb.supplies = wbSupplies.length;
    } catch (err) {
      noteSideError(wb, "WB/поставки", err, warnings);
    }

    try {
      let ordersMap = new Map<number, string>();
      if (nmIdToSku.size === 0) {
        ordersMap = await fetchWbNmIdMapFromOrders(creds["wb.token"], since).catch(
          () => new Map<number, string>(),
        );
      }
      const skuMap = mergeWbNmIdMaps(nmIdToSku, ordersMap);
      const { data: wbStocksRaw, warnings: stockWarnings } = await fetchWbStocks(
        creds["wb.token"],
        skuMap,
      );
      warnings.push(...stockWarnings);
      wbStocks.push(...wbStocksRaw.map(mapWbStock));
      wb.stocks = wbStocks.length;
      stockReplace.wb = true;
    } catch (err) {
      noteSideError(wb, "WB/остатки", err, warnings);
    }

    wb.durationMs = Math.round(performance.now() - t0);
  } else {
    throw new Error(MARKETPLACE_SYNC_CREDENTIALS_REQUIRED);
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
      const { data: ozonSuppliesRaw, warnings: supplyWarnings } = await fetchOzonSupplyOrders(
        ozonCredsNonNull,
        since,
        to,
      );
      warnings.push(...supplyWarnings);
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
    throw new Error(MARKETPLACE_SYNC_CREDENTIALS_REQUIRED);
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

export type PersistMarketplaceSyncInput = {
  actor: MovementActorSnapshot;
  sales: NormalizedSale[];
  supplies: NormalizedSupply[];
  stocks: NormalizedStock[];
  ozonCancelledExternalIds: string[];
  productIdFor: (marketplace: string, sku: string) => string | null;
  stockReplace: { wb: boolean; ozon: boolean };
  now: Date;
  sources: { wb: "api" | "stub"; ozon: "api" | "stub" };
};

/**
 * SHADOW-capable marketplace persistence transaction.
 * Writer-facing gate is the first transactional coordination action.
 */
export async function persistMarketplaceSyncInTransaction(
  tx: Prisma.TransactionClient,
  input: PersistMarketplaceSyncInput,
): Promise<{ deductedTotal: number; shortfallTotal: number; restoredTotal: number }> {
  if (input.sources.wb !== "api" || input.sources.ozon !== "api") {
    throw new Error(MARKETPLACE_SYNC_STUB_REFUSED);
  }
  const actor = requireSupplyUserActor(input.actor);
  const shadowWriteActive = await isInventoryMovementShadowWriteActiveForWriter(tx);

  for (const s of input.sales) {
    await tx.sale.upsert({
      where: { marketplace_externalId: { marketplace: s.marketplace, externalId: s.externalId } },
      create: {
        marketplace: s.marketplace,
        externalId: s.externalId,
        sku: s.sku,
        productId: input.productIdFor(s.marketplace, s.sku),
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

  const accounting = await runSupplySyncAccounting(tx, {
    supplies: input.supplies,
    ozonCancelledExternalIds: input.ozonCancelledExternalIds,
    productIdFor: input.productIdFor,
    actor,
    shadowWriteActive,
  });
  for (const s of accounting.shortfalls) {
    await writeChangeLog(
      {
        entity: "Supply",
        entityId: `${s.marketplace}:${s.externalId}:${s.sku}`,
        newValues: { event: "gp_shortfall", sku: s.sku, shortfall: s.shortfall },
      },
      tx,
    );
  }
  // Восстановление склада производства по отменённым заявкам Ozon: закрываем
  // открытый цикл учёта. Возвращаем только deductedQty; shortfallQty не
  // возвращаем — эти единицы физически не списывались. Полная недостача
  // (deductedQty=0, open=true) тоже закрывается.
  for (const result of accounting.restores) {
    if (result.closed) {
      await writeChangeLog(
        {
          entity: "Supply",
          entityId: `OZON:${result.externalId}:${result.sku}`,
          newValues: {
            event: "gp_restore_cancelled",
            sku: result.sku,
            restored: result.restored,
            generation: result.generation,
          },
        },
        tx,
      );
    }
  }

  // Остатки — полный снимок, но по каждому МП отдельно: заменяем только те
  // маркетплейсы, чьи остатки успешно получены. Иначе частичный сбой (напр.
  // Ozon упал, WB прошёл) стёр бы остатки другого маркетплейса.
  const replaceMarketplaces: Marketplace[] = [];
  if (input.stockReplace.wb) replaceMarketplaces.push("WB");
  if (input.stockReplace.ozon) replaceMarketplaces.push("OZON");
  if (replaceMarketplaces.length > 0) {
    await tx.mpStock.deleteMany({ where: { marketplace: { in: replaceMarketplaces } } });
    const rows = input.stocks.filter((s) => replaceMarketplaces.includes(s.marketplace));
    if (rows.length > 0) {
      await tx.mpStock.createMany({
        data: rows.map((s) => ({
          marketplace: s.marketplace,
          sku: s.sku,
          quantity: s.quantity,
          syncedAt: input.now,
        })),
      });
    }
  }

  await writeChangeLog(
    {
      entity: "MpStock",
      entityId: "sync",
      newValues: {
        salesAdded: input.sales.length,
        suppliesAdded: input.supplies.length,
        stockUpdated: input.stocks.length,
        deductedFromProduction: accounting.deductedTotal,
        gpShortfall: accounting.shortfallTotal,
        restoredFromCancelled: accounting.restoredTotal,
        at: input.now.toISOString(),
        sources: input.sources,
      },
    },
    tx,
  );

  return {
    deductedTotal: accounting.deductedTotal,
    shortfallTotal: accounting.shortfallTotal,
    restoredTotal: accounting.restoredTotal,
  };
}

/**
 * Синхронизация с маркетплейсами. Оба контура должны быть настроены.
 * Иначе запуск отклоняется до HTTP и до записи продаж, поставок и остатков.
 * Current contour is authenticated USER only. Capture actor outside the TX.
 */
export async function syncMarketplacesAsUserInternal(
  actor: MovementActorSnapshot,
): Promise<SyncResult> {
  const userActor = requireSupplyUserActor(actor);
  const userId = userActor.userId;
  const syncStarted = performance.now();
  const stored = await loadStoredApiCredentialsInternal();
  const wbReady = isWbConfigured(stored["wb.token"]);
  const ozonReady = isOzonConfigured(ozonCredentialsFrom(stored) ?? {});
  if (!wbReady || !ozonReady) {
    const now = new Date();
    const report: MpSyncReport = {
      since: now.toISOString(),
      to: now.toISOString(),
      ok: false,
      durationMs: Math.round(performance.now() - syncStarted),
      sources: { wb: wbReady ? "api" : "stub", ozon: ozonReady ? "api" : "stub" },
      wb: emptySideReport(wbReady ? "api" : "stub"),
      ozon: emptySideReport(ozonReady ? "api" : "stub"),
      warnings: [],
      totals: { sales: 0, supplies: 0, stocks: 0 },
      error: MARKETPLACE_SYNC_CREDENTIALS_REQUIRED,
    };
    await persistMpSyncLog(report, userId);
    return {
      ok: false,
      salesAdded: 0,
      suppliesAdded: 0,
      stockUpdated: 0,
      error: report.error,
      sources: report.sources,
    };
  }
  const now = new Date();
  const since = await getSyncSince();

  const dbProducts = await prisma.product.findMany({ where: { status: "ACTIVE" } });
  if (dbProducts.length === 0) {
    const report: MpSyncReport = {
      since: since.toISOString(),
      to: now.toISOString(),
      ok: false,
      durationMs: Math.round(performance.now() - syncStarted),
      sources: { wb: "api", ozon: "api" },
      wb: emptySideReport("api"),
      ozon: emptySideReport("api"),
      warnings: [],
      totals: { sales: 0, supplies: 0, stocks: 0 },
      error: "Нет активных изделий",
    };
    await persistMpSyncLog(report, userId);
    return { ok: false, salesAdded: 0, suppliesAdded: 0, stockUpdated: 0, error: report.error };
  }

  const products: ActiveProduct[] = dbProducts.map((p) => ({
    id: p.id,
    skuOzon: p.skuOzon,
    skuWb: p.skuWb,
  }));
  // Сопоставление по МП: продажи/поставки/остатки Ozon ищем по skuOzon, WB — по skuWb.
  const idByOzonSku = new Map(products.filter((p) => p.skuOzon).map((p) => [p.skuOzon, p.id]));
  const idByWbSku = new Map(products.filter((p) => p.skuWb).map((p) => [p.skuWb, p.id]));
  const productIdForRecord = (marketplace: string, sku: string): string | null =>
    (marketplace === "OZON" ? idByOzonSku.get(sku) : idByWbSku.get(sku)) ?? null;

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

  const bothLive = sources.wb === "api" && sources.ozon === "api";
  const noData = sales.length === 0 && supplies.length === 0 && stocks.length === 0;

  if (!bothLive) {
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
      error: MARKETPLACE_SYNC_STUB_REFUSED,
    };
    await persistMpSyncLog(report, userId);
    return {
      ok: false,
      salesAdded: 0,
      suppliesAdded: 0,
      stockUpdated: 0,
      error: report.error,
      warnings: warnings.length > 0 ? warnings : undefined,
      sources,
    };
  }

  if (warnings.length > 0 && noData) {
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
  await retryOnceOnSyncDeadlock(async () => {
    deductedTotal = 0;
    shortfallTotal = 0;
    restoredTotal = 0;
    await prisma.$transaction(async (tx) => {
      const accounting = await persistMarketplaceSyncInTransaction(tx, {
        actor: userActor,
        sales,
        supplies,
        stocks,
        ozonCancelledExternalIds,
        productIdFor: productIdForRecord,
        stockReplace,
        now,
        sources,
      });
      deductedTotal = accounting.deductedTotal;
      shortfallTotal = accounting.shortfallTotal;
      restoredTotal = accounting.restoredTotal;
    });
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

  return {
    ok: true,
    salesAdded: sales.length,
    suppliesAdded: supplies.length,
    stockUpdated: stocks.length,
    warnings: warnings.length > 0 ? warnings : undefined,
    sources,
  };
}
