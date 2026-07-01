"use server";

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
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

function fetchWbIncomesRaw(products: ActiveProduct[], now: Date, rand: () => number): WbIncomeRaw[] {
  const stamp = now.getTime();
  const out: WbIncomeRaw[] = [];
  products.forEach((p, idx) => {
    if (rand() < 0.5) return; // не по каждому изделию
    const accepted = rand() < 0.6;
    out.push({
      incomeId: Number(`${stamp % 1000000}${idx}`),
      number: `WB-INC-${stamp % 100000}-${idx}`,
      date: now.toISOString(),
      dateClose: accepted ? now.toISOString() : null,
      supplierArticle: p.sku,
      quantity: 10 + Math.floor(rand() * 30),
      warehouseName: "Коледино",
    });
  });
  return out;
}

function fetchOzonSupplyOrdersRaw(products: ActiveProduct[], now: Date, rand: () => number): OzonSupplyOrderRaw[] {
  const stamp = now.getTime();
  const items = products
    .filter(() => rand() < 0.6)
    .map((p) => ({ offer_id: p.sku, quantity: 10 + Math.floor(rand() * 30) }));
  if (items.length === 0) return [];
  const statuses = ["confirmed", "shipped", "delivered"];
  return [
    {
      supply_order_id: Number(`${stamp % 1000000}`),
      status: statuses[Math.floor(rand() * statuses.length)],
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
    inWayToClient: Math.floor(rand() * 5),
    inWayFromClient: Math.floor(rand() * 3),
  }));
}

function fetchOzonStockRaw(products: ActiveProduct[], rand: () => number): OzonStockRaw[] {
  return products.map((p) => ({
    offer_id: p.sku,
    present: 10 + Math.floor(rand() * 25),
    reserved: Math.floor(rand() * 5),
  }));
}

// ============================ СИНХРОНИЗАЦИЯ ================================

export interface SyncResult {
  ok: boolean;
  salesAdded: number;
  suppliesAdded: number;
  stockUpdated: number;
  error?: string;
}

/**
 * Синхронизация с маркетплейсами. Сейчас источник — заглушка (нет ключей),
 * но данные проходят через реальные мапперы `src/lib/marketplace-map.ts` и
 * пишутся идемпотентно (upsert по внешнему id). При появлении ключей достаточно
 * заменить fetch*Raw на настоящие HTTP-вызовы — контракт не изменится.
 */
export async function syncMarketplaces(): Promise<SyncResult> {
  const dbProducts = await prisma.product.findMany({ where: { status: "ACTIVE" } });
  if (dbProducts.length === 0) {
    return { ok: false, salesAdded: 0, suppliesAdded: 0, stockUpdated: 0, error: "Нет активных изделий" };
  }

  const products: ActiveProduct[] = dbProducts.map((p) => ({
    id: p.id,
    sku: p.sku,
    salePrice: toNumber(p.salePrice),
  }));
  const idBySku = new Map(products.map((p) => [p.sku, p.id]));

  const now = new Date();
  const rand = makeRand(now.getTime());

  // 1) Сырые ответы API → нормализованные записи через мапперы.
  const sales: NormalizedSale[] = [
    ...fetchWbSalesRaw(products, now, rand).map(mapWbSale),
    ...fetchOzonPostingsRaw(products, now, rand).flatMap(mapOzonPosting),
  ];
  const supplies: NormalizedSupply[] = [
    ...fetchWbIncomesRaw(products, now, rand).map(mapWbIncome),
    ...fetchOzonSupplyOrdersRaw(products, now, rand).flatMap(mapOzonSupplyOrder),
  ];
  const stocks: NormalizedStock[] = [
    ...fetchWbStockRaw(products, rand).map(mapWbStock),
    ...fetchOzonStockRaw(products, rand).map(mapOzonStock),
  ];

  // 2) Идемпотентная запись.
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
      await tx.supply.upsert({
        where: {
          marketplace_externalId_sku: {
            marketplace: s.marketplace,
            externalId: s.externalId,
            sku: s.sku,
          },
        },
        create: {
          marketplace: s.marketplace,
          externalId: s.externalId,
          number: s.number,
          sku: s.sku,
          productId: idBySku.get(s.sku) ?? null,
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
    }

    // Остатки — полный снимок: заменяем целиком.
    await tx.mpStock.deleteMany();
    await tx.mpStock.createMany({
      data: stocks.map((s) => ({
        marketplace: s.marketplace,
        sku: s.sku,
        quantity: s.quantity,
        reserved: s.reserved,
        inWay: s.inWay,
        syncedAt: now,
      })),
    });

    await writeChangeLog(
      {
        entity: "MpStock",
        entityId: "sync",
        newValues: {
          salesAdded: sales.length,
          suppliesAdded: supplies.length,
          stockUpdated: stocks.length,
          at: now.toISOString(),
        },
      },
      tx,
    );
  });

  revalidatePath("/sales");
  revalidatePath("/warehouse");
  revalidatePath("/reports");
  return { ok: true, salesAdded: sales.length, suppliesAdded: supplies.length, stockUpdated: stocks.length };
}
