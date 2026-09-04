"use server";

import { prisma } from "@/server/db";
import { requireAdmin } from "@/server/session";
import { revalidatePath } from "next/cache";
import { syncMarketplacesAsUserInternal } from "@/server/internal/marketplace-sync";
import type { SalesReportRow } from "@/mocks/report-fixtures";
import type {
  Marketplace,
  MpStockRow,
  ShipmentRow,
  ShipmentStatus,
} from "@/mocks/warehouse-fixtures";

function toNumber(value: { toNumber: () => number } | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

/**
 * Артикул записи МП → название изделия. У изделия два артикула (Ozon и WB),
 * поэтому в карту заносим оба ключа — так продажи/остатки/поставки любого МП
 * находят изделие по своему артикулу.
 */
function buildNameBySku(
  products: { name: string; skuOzon: string; skuWb: string }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of products) {
    if (p.skuOzon) map.set(p.skuOzon, p.name);
    if (p.skuWb) map.set(p.skuWb, p.name);
  }
  return map;
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
  await requireAdmin();
  const [sales, products, lastStock] = await Promise.all([
    prisma.sale.findMany({ orderBy: { date: "desc" } }),
    prisma.product.findMany({ select: { id: true, name: true, skuOzon: true, skuWb: true } }),
    prisma.mpStock.findFirst({ orderBy: { syncedAt: "desc" }, select: { syncedAt: true } }),
  ]);

  const nameBySku = buildNameBySku(products);
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
        productName:
          (s.productId ? nameById.get(s.productId) : null) ?? nameBySku.get(s.sku) ?? s.sku,
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
  await requireAdmin();
  const [stock, products] = await Promise.all([
    prisma.mpStock.findMany({ orderBy: [{ marketplace: "asc" }, { sku: "asc" }] }),
    prisma.product.findMany({ select: { name: true, skuOzon: true, skuWb: true } }),
  ]);
  const nameBySku = buildNameBySku(products);
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
  await requireAdmin();
  const [supplies, products] = await Promise.all([
    prisma.supply.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.product.findMany({ select: { name: true, skuOzon: true, skuWb: true } }),
  ]);
  const nameBySku = buildNameBySku(products);
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

export interface SyncResult {
  ok: boolean;
  salesAdded: number;
  suppliesAdded: number;
  stockUpdated: number;
  error?: string;
  warnings?: string[];
  sources?: { wb: "api" | "stub"; ozon: "api" | "stub" };
}

/** Синхронизация маркетплейсов для текущего администратора. */
export async function syncMarketplaces(): Promise<SyncResult> {
  const admin = await requireAdmin();
  const result = await syncMarketplacesAsUserInternal(admin.id);
  revalidatePath("/sales");
  revalidatePath("/warehouse");
  revalidatePath("/reports");
  revalidatePath("/settings");
  return result;
}
