"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { buildStockSnapshot, type DetailStockRow as RawStockRow } from "@/lib/detail-stock";
import { formatProductSku } from "@/lib/format";
import type { Detail } from "@/types/domain";
import type { ProductionStockRow, DetailStockRow } from "@/lib/warehouse-stock";
import type {
  InventoryDocRow,
  InventoryLineRow,
  InventoryRefType,
} from "@/mocks/warehouse-fixtures";

const PATH = "/warehouse";

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

// ============================ ОСТАТКИ ПРОИЗВОДСТВА =========================

export interface WarehouseStock {
  products: ProductionStockRow[];
  details: DetailStockRow[];
  fasteners: ProductionStockRow[];
  packaging: ProductionStockRow[];
  other: ProductionStockRow[];
}

export async function getWarehouseStock(): Promise<WarehouseStock> {
  const [products, productStock, details, detailStock, items, nomStock] = await Promise.all([
    prisma.product.findMany({ where: { status: "ACTIVE" } }),
    prisma.productStock.findMany(),
    prisma.detail.findMany({ where: { status: "ACTIVE" } }),
    prisma.detailStock.findMany(),
    prisma.nomenclatureItem.findMany({ where: { status: "ACTIVE" } }),
    prisma.nomenclatureStock.findMany(),
  ]);

  const productQty = new Map(productStock.map((s) => [s.productId, s.quantity]));
  const nomQty = new Map(nomStock.map((s) => [s.nomenclatureId, s.quantity]));

  const domainDetails: Detail[] = details.map((d) => ({
    id: d.id,
    name: d.name,
    lengthM: num(d.lengthM),
    detailType: d.detailType,
    sort: d.sort,
    prisadkaTorcevaya: d.prisadkaTorcevaya,
    prisadkaPloskost: d.prisadkaPloskost,
    status: d.status,
  }));
  const rows: RawStockRow[] = detailStock.map((r) => ({
    detailId: r.detailId,
    torcevayaDone: r.torcevayaDone,
    ploskostDone: r.ploskostDone,
    quantity: r.quantity,
  }));
  const snapshot = buildStockSnapshot(domainDetails, rows);

  const productRows: ProductionStockRow[] = products
    .map((p) => ({
      id: p.id,
      name: p.name,
      sku: formatProductSku(p.skuOzon, p.skuWb),
      quantity: productQty.get(p.id) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const detailById = new Map(domainDetails.map((d) => [d.id, d]));
  const detailIds = new Set([
    ...Object.keys(snapshot.detailsReady),
    ...Object.keys(snapshot.prisadkaPending),
  ]);
  const detailRows: DetailStockRow[] = [];
  for (const id of detailIds) {
    const detail = detailById.get(id);
    if (!detail) continue;
    const ready = snapshot.detailsReady[id] ?? 0;
    const pend = snapshot.prisadkaPending[id];
    const pendingPrisadka = (pend?.torcev ?? 0) + (pend?.plosk ?? 0);
    detailRows.push({
      id,
      name: detail.name,
      quantity: ready + pendingPrisadka,
      ready,
      pendingPrisadka,
    });
  }
  detailRows.sort((a, b) => a.name.localeCompare(b.name, "ru"));

  const itemRows = (type: "FASTENER" | "PACKAGING" | "OTHER"): ProductionStockRow[] =>
    items
      .filter((n) => n.type === type)
      .map((n) => ({
        id: n.id,
        name: n.name,
        quantity: nomQty.get(n.id) ?? 0,
        minStock: n.minStock ?? undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  return {
    products: productRows,
    details: detailRows,
    fasteners: itemRows("FASTENER"),
    packaging: itemRows("PACKAGING"),
    other: itemRows("OTHER"),
  };
}

// ============================ ИНВЕНТАРИЗАЦИЯ ===============================

type InventoryWithLines = Prisma.InventoryGetPayload<{ include: { lines: true } }>;

async function serializeDoc(doc: InventoryWithLines): Promise<InventoryDocRow> {
  // Имена и условная себестоимость единицы (для крепежа/упаковки — цена;
  // для деталей/изделий точная себестоимость появится с движком, Этап 9).
  const lines: InventoryLineRow[] = await Promise.all(
    doc.lines.map(async (l) => {
      let name = l.refId;
      let unitCost = 0;
      if (l.refType === "PRODUCT") {
        const p = await prisma.product.findUnique({ where: { id: l.refId } });
        name = p?.name ?? l.refId;
      } else if (l.refType === "DETAIL") {
        const d = await prisma.detail.findUnique({ where: { id: l.refId } });
        name = d?.name ?? l.refId;
      } else {
        const n = await prisma.nomenclatureItem.findUnique({ where: { id: l.refId } });
        name = n?.name ?? l.refId;
        unitCost = num(n?.unitPrice ?? 0);
      }
      return {
        id: l.id,
        refType: l.refType as InventoryRefType,
        refId: l.refId,
        name,
        accountedQty: l.accountedQty,
        actualQty: l.actualQty,
        unitCost,
      };
    }),
  );

  return {
    id: doc.id,
    date: doc.date.toISOString().slice(0, 10),
    status: doc.status,
    lines,
  };
}

export async function getInventoryDocs(): Promise<InventoryDocRow[]> {
  const docs = await prisma.inventory.findMany({
    include: { lines: true },
    orderBy: { date: "desc" },
  });
  return Promise.all(docs.map(serializeDoc));
}

/** Черновик инвентаризации с авто-заполнением учётных остатков из БД. */
export async function createInventoryDraft(): Promise<InventoryDocRow> {
  const existing = await prisma.inventory.findFirst({ where: { status: "DRAFT" } });
  if (existing) throw new Error("Черновик инвентаризации уже существует");

  const stock = await getWarehouseStock();
  type Line = { refType: InventoryRefType; refId: string; accounted: number };
  const lines: Line[] = [];
  for (const p of stock.products) if (p.quantity > 0) lines.push({ refType: "PRODUCT", refId: p.id, accounted: p.quantity });
  for (const d of stock.details) if (d.ready > 0) lines.push({ refType: "DETAIL", refId: d.id, accounted: d.ready });
  for (const n of [...stock.fasteners, ...stock.packaging, ...stock.other])
    if (n.quantity > 0) lines.push({ refType: "NOMENCLATURE", refId: n.id, accounted: n.quantity });

  const doc = await prisma.inventory.create({
    data: {
      date: new Date(),
      status: "DRAFT",
      lines: {
        create: lines.map((l) => ({
          refType: l.refType,
          refId: l.refId,
          accountedQty: l.accounted,
          actualQty: l.accounted,
          deviation: 0,
          deviationSum: 0,
        })),
      },
    },
    include: { lines: true },
  });
  await writeChangeLog({
    entity: "Inventory",
    entityId: doc.id,
    newValues: { status: "DRAFT", lines: lines.length },
  });
  revalidatePath(PATH);
  return serializeDoc(doc);
}

export async function updateInventoryLineActual(
  lineId: string,
  actualQty: number,
): Promise<void> {
  if (!(actualQty >= 0)) throw new Error("Некорректное количество");
  const line = await prisma.inventoryLine.findUnique({
    where: { id: lineId },
    include: { inventory: true },
  });
  if (!line) throw new Error("Строка не найдена");
  if (line.inventory.status !== "DRAFT") throw new Error("Инвентаризация уже проведена");

  await prisma.inventoryLine.update({ where: { id: lineId }, data: { actualQty } });
  await writeChangeLog({
    entity: "InventoryLine",
    entityId: lineId,
    oldValues: { actualQty: line.actualQty },
    newValues: { actualQty },
  });
  revalidatePath(PATH);
}

/**
 * Проведение инвентаризации: корректирует остатки до фактических и фиксирует
 * отклонения. Недостача ГП/деталей/крепежа → «Потеря ГП» (финансовая проводка —
 * Этап 10). Сырьё (рейки) в этой инвентаризации не участвует.
 */
export async function conductInventory(docId: string): Promise<InventoryDocRow> {
  const doc = await prisma.inventory.findUnique({ where: { id: docId }, include: { lines: true } });
  if (!doc) throw new Error("Инвентаризация не найдена");
  if (doc.status !== "DRAFT") throw new Error("Инвентаризация уже проведена");

  const updated = await prisma.$transaction(async (tx) => {
    for (const line of doc.lines) {
      const deviation = line.actualQty - line.accountedQty;

      if (line.refType === "PRODUCT") {
        await tx.productStock.upsert({
          where: { productId: line.refId },
          create: { productId: line.refId, quantity: line.actualQty },
          update: { quantity: line.actualQty },
        });
      } else if (line.refType === "NOMENCLATURE") {
        await tx.nomenclatureStock.upsert({
          where: { nomenclatureId: line.refId },
          create: { nomenclatureId: line.refId, quantity: line.actualQty },
          update: { quantity: line.actualQty },
        });
      } else {
        // DETAIL: корректируем строку «готово» (все требуемые присадки выполнены).
        const detail = await tx.detail.findUniqueOrThrow({ where: { id: line.refId } });
        await tx.detailStock.upsert({
          where: {
            detailId_torcevayaDone_ploskostDone: {
              detailId: line.refId,
              torcevayaDone: detail.prisadkaTorcevaya,
              ploskostDone: detail.prisadkaPloskost,
            },
          },
          create: {
            detailId: line.refId,
            torcevayaDone: detail.prisadkaTorcevaya,
            ploskostDone: detail.prisadkaPloskost,
            quantity: line.actualQty,
          },
          update: { quantity: line.actualQty },
        });
      }

      await tx.inventoryLine.update({
        where: { id: line.id },
        data: { deviation },
      });
    }

    const result = await tx.inventory.update({
      where: { id: docId },
      data: { status: "CONDUCTED" },
      include: { lines: true },
    });
    // Лог внутри транзакции — аудит атомарен с коррекцией остатков.
    await writeChangeLog(
      {
        entity: "Inventory",
        entityId: docId,
        oldValues: { status: "DRAFT" },
        newValues: { status: "CONDUCTED", lines: doc.lines.length },
      },
      tx,
    );
    return result;
  });

  revalidatePath(PATH);
  return serializeDoc(updated);
}
