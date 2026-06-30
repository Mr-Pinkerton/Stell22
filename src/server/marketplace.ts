"use server";

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import type { SalesReportRow } from "@/mocks/report-fixtures";
import type { Marketplace, MpStockRow } from "@/mocks/warehouse-fixtures";

const MARKETPLACES: Marketplace[] = ["OZON", "WB"];

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
 * (оба маркетплейса вместе). Источник наполнения — синхронизация (заглушка API).
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

// ============================ СИНХРОНИЗАЦИЯ (ЗАГЛУШКА) =====================

export interface SyncResult {
  ok: boolean;
  salesAdded: number;
  stockUpdated: number;
  error?: string;
}

/**
 * Синхронизация с маркетплейсами — ЗАГЛУШКА вместо реальных Ozon/WB API
 * (нет ключей; формат ответа имитируем). Дописывает новые продажи «с момента
 * прошлой синхронизации» и обновляет снимок остатков. Реальные HTTP-вызовы
 * подключатся здесь же при появлении ключей (Этап 13 roadmap).
 */
export async function syncMarketplaces(): Promise<SyncResult> {
  const products = await prisma.product.findMany({ where: { status: "ACTIVE" } });
  if (products.length === 0) {
    return { ok: false, salesAdded: 0, stockUpdated: 0, error: "Нет активных изделий" };
  }

  const now = new Date();
  // Псевдослучайно, но стабильно в пределах вызова.
  let seed = now.getTime() % 100000;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const saleData: {
    marketplace: string;
    sku: string;
    productId: string;
    quantity: number;
    revenue: Decimal;
    date: Date;
  }[] = [];
  const stockData: { marketplace: string; sku: string; quantity: number; syncedAt: Date }[] = [];

  for (const p of products) {
    const price = new Decimal(toNumber(p.salePrice));
    for (const mp of MARKETPLACES) {
      const sold = 3 + Math.floor(rand() * 6); // 3..8 продаж за интервал
      saleData.push({
        marketplace: mp,
        sku: p.sku,
        productId: p.id,
        quantity: sold,
        revenue: price.times(sold),
        date: now,
      });
      stockData.push({
        marketplace: mp,
        sku: p.sku,
        quantity: 10 + Math.floor(rand() * 25), // снимок остатка 10..34
        syncedAt: now,
      });
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.sale.createMany({
      data: saleData.map((s) => ({
        marketplace: s.marketplace,
        sku: s.sku,
        productId: s.productId,
        quantity: s.quantity,
        revenue: s.revenue.toFixed(2),
        date: s.date,
      })),
    });
    // Остатки — полный снимок (модель без уникального ключа): заменяем целиком.
    await tx.mpStock.deleteMany();
    await tx.mpStock.createMany({ data: stockData });
    await writeChangeLog(
      {
        entity: "MpStock",
        entityId: "sync",
        newValues: { salesAdded: saleData.length, stockUpdated: stockData.length, at: now.toISOString() },
      },
      tx,
    );
  });

  revalidatePath("/sales");
  revalidatePath("/warehouse");
  revalidatePath("/reports");
  return { ok: true, salesAdded: saleData.length, stockUpdated: stockData.length };
}
