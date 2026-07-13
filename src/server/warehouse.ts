"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import {
  blankKey,
  buildStockSnapshot,
  normalizeReadyBuckets,
  type BlankStockRow as RawBlankRow,
  type DetailStockRow as RawStockRow,
} from "@/lib/detail-stock";
import { formatProductSku } from "@/lib/format";
import { getUnitCostSnapshot, type UnitCostSnapshot } from "@/server/cost";
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
  blanks: ProductionStockRow[];
  details: DetailStockRow[];
  fasteners: ProductionStockRow[];
  packaging: ProductionStockRow[];
  other: ProductionStockRow[];
}

export async function getWarehouseStock(): Promise<WarehouseStock> {
  const [products, productStock, details, detailStock, blankStock, items, nomStock, materials] =
    await Promise.all([
      prisma.product.findMany({ where: { status: "ACTIVE" } }),
      prisma.productStock.findMany(),
      prisma.detail.findMany({ where: { status: "ACTIVE" } }),
      prisma.detailStock.findMany(),
      prisma.blankStock.findMany(),
      prisma.nomenclatureItem.findMany({ where: { status: "ACTIVE" } }),
      prisma.nomenclatureStock.findMany(),
      prisma.material.findMany(),
    ]);

  const productQty = new Map(productStock.map((s) => [s.productId, s.quantity]));
  const nomQty = new Map(nomStock.map((s) => [s.nomenclatureId, s.quantity]));
  const materialName = new Map(materials.map((m) => [m.id, m.name]));

  const domainDetails: Detail[] = details.map((d) => ({
    id: d.id,
    name: d.name,
    materialId: d.materialId,
    detailNumber: d.detailNumber,
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
  const blankRows: RawBlankRow[] = blankStock.map((b) => ({
    materialId: b.materialId,
    lengthM: num(b.lengthM),
    detailType: b.detailType,
    sort: b.sort,
    quantity: b.quantity,
  }));
  const snapshot = buildStockSnapshot(domainDetails, rows, blankRows);

  const productRows: ProductionStockRow[] = products
    .map((p) => ({
      id: p.id,
      name: p.name,
      sku: formatProductSku(p.skuOzon, p.skuWb),
      quantity: productQty.get(p.id) ?? 0,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));

  // Заготовки (нарезанные рейки до присадки).
  const blankRowsView: ProductionStockRow[] = blankStock
    .filter((b) => b.quantity > 0)
    .map((b) => {
      const len = num(b.lengthM);
      const typeLabel = b.detailType === "POLKA" ? "полка" : "канавка";
      const sortLabel = b.sort === "SORT1" ? "1 сорт" : "2 сорт";
      const matLabel = materialName.get(b.materialId) ?? "—";
      return {
        id: blankKey(b.materialId, len, b.detailType, b.sort),
        name: `${matLabel} · ${len} м · ${typeLabel} · ${sortLabel}`,
        quantity: b.quantity,
      };
    })
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
    blanks: blankRowsView,
    details: detailRows,
    fasteners: itemRows("FASTENER"),
    packaging: itemRows("PACKAGING"),
    other: itemRows("OTHER"),
  };
}

// ============================ ИНВЕНТАРИЗАЦИЯ ===============================

type InventoryWithLines = Prisma.InventoryGetPayload<{ include: { lines: true } }>;

/** Себестоимость единицы позиции инвентаризации из снапшота оценки (A10). */
function unitCostFromSnapshot(
  valuation: UnitCostSnapshot,
  refType: string,
  refId: string,
): number {
  if (refType === "PRODUCT") return valuation.productFull.get(refId) ?? 0;
  if (refType === "NOMENCLATURE") return valuation.nomenclatureUnit.get(refId) ?? 0;
  return valuation.detailUnit.get(refId) ?? 0; // DETAIL: материал + работа
}

async function serializeDoc(
  doc: InventoryWithLines,
  valuation: UnitCostSnapshot,
): Promise<InventoryDocRow> {
  // Себестоимость единицы — из движка (A10): изделие=полная, деталь=материал+работа,
  // крепёж/упаковка=цена номенклатуры. UI считает сумму отклонения = откл × unitCost.
  const lines: InventoryLineRow[] = await Promise.all(
    doc.lines.map(async (l) => {
      let name = l.refId;
      if (l.refType === "PRODUCT") {
        const p = await prisma.product.findUnique({ where: { id: l.refId } });
        name = p?.name ?? l.refId;
      } else if (l.refType === "DETAIL") {
        const d = await prisma.detail.findUnique({ where: { id: l.refId } });
        name = d?.name ?? l.refId;
      } else {
        const n = await prisma.nomenclatureItem.findUnique({ where: { id: l.refId } });
        name = n?.name ?? l.refId;
      }
      return {
        id: l.id,
        refType: l.refType as InventoryRefType,
        refId: l.refId,
        name,
        accountedQty: l.accountedQty,
        actualQty: l.actualQty,
        unitCost: unitCostFromSnapshot(valuation, l.refType, l.refId),
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
  const [docs, valuation] = await Promise.all([
    prisma.inventory.findMany({ include: { lines: true }, orderBy: { date: "desc" } }),
    getUnitCostSnapshot(),
  ]);
  return Promise.all(docs.map((d) => serializeDoc(d, valuation)));
}

/**
 * Черновик инвентаризации с авто-заполнением учётных остатков из БД.
 *
 * `includeAllActive` — режим ПЕРВИЧНОЙ инвентаризации: в черновик попадают все
 * активные изделия/детали/номенклатура, включая позиции с нулевым учётным
 * остатком. Так можно вписать фактические количества «с нуля» при старте
 * учёта. В обычном режиме (сверка) берутся только позиции с остатком > 0.
 */
export async function createInventoryDraft(includeAllActive = false): Promise<InventoryDocRow> {
  const existing = await prisma.inventory.findFirst({ where: { status: "DRAFT" } });
  if (existing) throw new Error("Черновик инвентаризации уже существует");

  const stock = await getWarehouseStock();
  type Line = { refType: InventoryRefType; refId: string; accounted: number };
  const lines: Line[] = [];
  for (const p of stock.products)
    if (includeAllActive || p.quantity > 0)
      lines.push({ refType: "PRODUCT", refId: p.id, accounted: p.quantity });

  if (includeAllActive) {
    // stock.details содержит только детали с движением на складе; для первичной
    // инвентаризации нужны ВСЕ активные детали (в т.ч. без остатка).
    const activeDetails = await prisma.detail.findMany({
      where: { status: "ACTIVE" },
      select: { id: true },
    });
    const readyById = new Map(stock.details.map((d) => [d.id, d.ready]));
    for (const d of activeDetails)
      lines.push({ refType: "DETAIL", refId: d.id, accounted: readyById.get(d.id) ?? 0 });
  } else {
    for (const d of stock.details)
      if (d.ready > 0) lines.push({ refType: "DETAIL", refId: d.id, accounted: d.ready });
  }

  for (const n of [...stock.fasteners, ...stock.packaging, ...stock.other])
    if (includeAllActive || n.quantity > 0)
      lines.push({ refType: "NOMENCLATURE", refId: n.id, accounted: n.quantity });

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
  return serializeDoc(doc, await getUnitCostSnapshot());
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

  // Оценка отклонения по себестоимости на момент проведения (A10, «Потеря ГП»).
  // Недостача (deviation<0) → отрицательный deviationSum = убыток; в отход партий
  // НЕ попадает (сырьё здесь не участвует). Излишек — положит. справочно.
  const valuation = await getUnitCostSnapshot();

  const updated = await prisma.$transaction(async (tx) => {
    for (const line of doc.lines) {
      const deviation = line.actualQty - line.accountedQty;
      const deviationSum =
        Math.round(deviation * unitCostFromSnapshot(valuation, line.refType, line.refId) * 100) /
        100;

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
        if (!detail.prisadkaTorcevaya && !detail.prisadkaPloskost) {
          // Деталь без присадок — годна из заготовки, правим склад заготовок.
          await tx.blankStock.upsert({
            where: {
              materialId_lengthM_detailType_sort: {
                materialId: detail.materialId,
                lengthM: detail.lengthM,
                detailType: detail.detailType,
                sort: detail.sort,
              },
            },
            create: {
              materialId: detail.materialId,
              lengthM: detail.lengthM,
              detailType: detail.detailType,
              sort: detail.sort,
              quantity: line.actualQty,
            },
            update: { quantity: line.actualQty },
          });
        } else {
          // Деталь с присадками: «готово» может быть распределено по нескольким
          // корзинам (когда нужна лишь одна присадка). Сводим ВСЕ ready-корзины
          // к факту — канон = actualQty, прочие ready → 0 (A9). НЗП-корзины и
          // общий пул заготовок не трогаем.
          const existing = await tx.detailStock.findMany({
            where: { detailId: line.refId },
            select: { torcevayaDone: true, ploskostDone: true },
          });
          for (const w of normalizeReadyBuckets(detail, existing, line.actualQty)) {
            await tx.detailStock.upsert({
              where: {
                detailId_torcevayaDone_ploskostDone: {
                  detailId: line.refId,
                  torcevayaDone: w.torcevayaDone,
                  ploskostDone: w.ploskostDone,
                },
              },
              create: {
                detailId: line.refId,
                torcevayaDone: w.torcevayaDone,
                ploskostDone: w.ploskostDone,
                quantity: w.quantity,
              },
              update: { quantity: w.quantity },
            });
          }
        }
      }

      await tx.inventoryLine.update({
        where: { id: line.id },
        data: { deviation, deviationSum },
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
  return serializeDoc(updated, valuation);
}
