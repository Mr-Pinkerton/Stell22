"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { requireAdmin } from "@/server/session";
import {
  blankKey,
  buildStockSnapshot,
  isNoPrisadkaDetail,
  isReady,
  type BlankStockRow as RawBlankRow,
  type DetailStockRow as RawStockRow,
} from "@/lib/detail-stock";
import { formatProductSku } from "@/lib/format";
import type { UnitCostSnapshot } from "@/server/cost";
import { getUnitCostSnapshot } from "@/server/internal/cost";
import type { Detail } from "@/types/domain";
import type { ProductionStockRow, DetailStockRow } from "@/lib/warehouse-stock";
import {
  formatBlankPoolLabel,
  inventoryDeviation,
  inventoryDeviationSum,
} from "@/lib/warehouse-stock";
import { conductInventoryInTransaction } from "@/server/internal/inventory-conduct";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import {
  ALREADY_CONDUCTED,
  DRAFT_ALREADY_EXISTS,
  blankSpecSortKey,
  isDraftUniqueViolation,
  lockInventoryForUpdate,
  uniqueSortedBlankSpecs,
  type BlankSpec,
} from "@/server/internal/inventory-integrity";
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
  await requireAdmin();
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
      const matLabel = materialName.get(b.materialId) ?? "—";
      return {
        id: blankKey(b.materialId, len, b.detailType, b.sort),
        name: formatBlankPoolLabel({
          materialName: matLabel,
          lengthM: len,
          detailType: b.detailType,
          sort: b.sort,
        }),
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
  if (refType === "BLANK") return valuation.blankUnit.get(refId) ?? 0;
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
      } else if (l.refType === "BLANK") {
        const b = await prisma.blankStock.findUnique({ where: { id: l.refId } });
        if (b) {
          const mat = await prisma.material.findUnique({ where: { id: b.materialId } });
          name = formatBlankPoolLabel({
            materialName: mat?.name ?? "—",
            lengthM: num(b.lengthM),
            detailType: b.detailType,
            sort: b.sort,
          });
        }
      } else if (l.refType === "DETAIL") {
        const d = await prisma.detail.findUnique({ where: { id: l.refId } });
        name = d?.name ?? l.refId;
      } else {
        const n = await prisma.nomenclatureItem.findUnique({ where: { id: l.refId } });
        name = n?.name ?? l.refId;
      }
      const unitCost = unitCostFromSnapshot(valuation, l.refType, l.refId);
      const frozen = doc.status === "CONDUCTED" || doc.status === "CLOSED";
      const deviation = frozen ? l.deviation : inventoryDeviation(l.accountedQty, l.actualQty);
      const deviationSum = frozen
        ? num(l.deviationSum)
        : inventoryDeviationSum(deviation, unitCost);
      return {
        id: l.id,
        refType: l.refType as InventoryRefType,
        refId: l.refId,
        name,
        accountedQty: l.accountedQty,
        actualQty: l.actualQty,
        unitCost: frozen ? 0 : unitCost,
        deviation,
        deviationSum,
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
  await requireAdmin();
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
 * активные изделия, уникальные физические пулы заготовок (no-prisadka spec),
 * готовые детали с присадкой и номенклатура, включая позиции с нулевым учётным
 * остатком. Для отсутствующего BlankStock по такому spec создаётся строка qty=0.
 * В обычном режиме (сверка) берутся только позиции с остатком > 0.
 */
export async function createInventoryDraft(includeAllActive = false): Promise<InventoryDocRow> {
  await requireAdmin();

  type Line = { refType: InventoryRefType; refId: string; accounted: number };
  let doc;
  let lineCount = 0;
  try {
    doc = await prisma.$transaction(async (tx) => {
      const existing = await tx.inventory.findFirst({ where: { status: "DRAFT" } });
      if (existing) throw new Error(DRAFT_ALREADY_EXISTS);

      const [products, productStock, details, detailStock, items, nomStock] = await Promise.all([
        tx.product.findMany({ where: { status: "ACTIVE" } }),
        tx.productStock.findMany(),
        tx.detail.findMany({ where: { status: "ACTIVE" } }),
        tx.detailStock.findMany(),
        tx.nomenclatureItem.findMany({ where: { status: "ACTIVE" } }),
        tx.nomenclatureStock.findMany(),
      ]);

      const productQty = new Map(productStock.map((s) => [s.productId, s.quantity]));
      const nomQty = new Map(nomStock.map((n) => [n.nomenclatureId, n.quantity]));
      const bucketsByDetail = new Map<string, typeof detailStock>();
      for (const row of detailStock) {
        const list = bucketsByDetail.get(row.detailId) ?? [];
        list.push(row);
        bucketsByDetail.set(row.detailId, list);
      }

      const lines: Line[] = [];
      for (const p of [...products].sort((a, b) => a.id.localeCompare(b.id))) {
        const qty = productQty.get(p.id) ?? 0;
        if (includeAllActive || qty > 0) {
          lines.push({ refType: "PRODUCT", refId: p.id, accounted: qty });
        }
      }

      const noPrisadka = details.filter(isNoPrisadkaDetail);
      const prisadkaDetails = details.filter((d) => !isNoPrisadkaDetail(d));
      const specByKey = new Map<string, BlankSpec>();
      for (const d of noPrisadka) {
        const spec: BlankSpec = {
          materialId: d.materialId,
          lengthM: d.lengthM,
          detailType: d.detailType,
          sort: d.sort,
        };
        specByKey.set(blankSpecSortKey(spec), spec);
      }
      const specs = uniqueSortedBlankSpecs(specByKey.values());

      if (includeAllActive && specs.length > 0) {
        await tx.blankStock.createMany({
          data: specs.map((spec) => ({
            materialId: spec.materialId,
            lengthM: spec.lengthM,
            detailType: spec.detailType,
            sort: spec.sort,
            quantity: 0,
          })),
          skipDuplicates: true,
        });
      }

      const blankRows =
        specs.length === 0
          ? []
          : await tx.blankStock.findMany({
              where: {
                OR: specs.map((spec) => ({
                  materialId: spec.materialId,
                  lengthM: spec.lengthM,
                  detailType: spec.detailType,
                  sort: spec.sort,
                })),
              },
            });
      const blankByKey = new Map(blankRows.map((b) => [blankSpecSortKey(b), b]));
      for (const spec of specs) {
        const row = blankByKey.get(blankSpecSortKey(spec));
        const qty = row?.quantity ?? 0;
        if (!row) continue;
        if (!includeAllActive && qty <= 0) continue;
        lines.push({ refType: "BLANK", refId: row.id, accounted: qty });
      }

      for (const d of [...prisadkaDetails].sort((a, b) => a.id.localeCompare(b.id))) {
        const ready = (bucketsByDetail.get(d.id) ?? [])
          .filter((r) => isReady(d, r.torcevayaDone, r.ploskostDone))
          .reduce((sum, r) => sum + r.quantity, 0);
        if (includeAllActive || ready > 0) {
          lines.push({ refType: "DETAIL", refId: d.id, accounted: ready });
        }
      }

      for (const n of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
        const qty = nomQty.get(n.id) ?? 0;
        if (includeAllActive || qty > 0) {
          lines.push({ refType: "NOMENCLATURE", refId: n.id, accounted: qty });
        }
      }

      lineCount = lines.length;
      return tx.inventory.create({
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
    });
  } catch (err) {
    if (isDraftUniqueViolation(err)) throw new Error(DRAFT_ALREADY_EXISTS);
    throw err;
  }
  await writeChangeLog({
    entity: "Inventory",
    entityId: doc.id,
    newValues: { status: "DRAFT", lines: lineCount },
  });
  revalidatePath(PATH);
  return serializeDoc(doc, await getUnitCostSnapshot());
}

export async function updateInventoryLineActual(
  lineId: string,
  actualQty: number,
): Promise<void> {
  await requireAdmin();
  if (!(actualQty >= 0)) throw new Error("Некорректное количество");

  await prisma.$transaction(async (tx) => {
    const existing = await tx.inventoryLine.findUnique({
      where: { id: lineId },
      select: { inventoryId: true },
    });
    if (!existing) throw new Error("Строка не найдена");

    const locked = await lockInventoryForUpdate(tx, existing.inventoryId);
    if (!locked) throw new Error("Инвентаризация не найдена");
    if (locked.status !== "DRAFT") throw new Error(ALREADY_CONDUCTED);

    const line = await tx.inventoryLine.findUnique({ where: { id: lineId } });
    if (!line) throw new Error("Строка не найдена");

    await tx.inventoryLine.update({ where: { id: lineId }, data: { actualQty } });
    await writeChangeLog(
      {
        entity: "InventoryLine",
        entityId: lineId,
        oldValues: { actualQty: line.actualQty },
        newValues: { actualQty },
      },
      tx,
    );
  });

  revalidatePath(PATH);
}

/**
 * Проведение инвентаризации: корректирует остатки до фактических и фиксирует
 * отклонения. Недостача ГП/деталей/крепежа → «Потеря ГП» (финансовая проводка —
 * Этап 10). Сырьё (рейки) в этой инвентаризации не участвует.
 */
export async function conductInventory(docId: string): Promise<InventoryDocRow> {
  const admin = await requireAdmin();
  const actor = userMovementActorFromAdmin(admin);

  const updated = await prisma.$transaction(
    async (tx) => conductInventoryInTransaction(tx, { docId, actor }),
    { timeout: 20_000, maxWait: 20_000 },
  );

  revalidatePath(PATH);
  return serializeDoc(updated, await getUnitCostSnapshot());
}

/**
 * BD-16.3: удаление черновика. Остатки не меняются — DRAFT ничего не применял.
 * CONDUCTED удалить нельзя (BD-16.4). Устаревший DRAFT удаляют и создают заново
 * (BD-16.5); accountedQty не перезаписывается.
 */
export async function deleteInventoryDraft(docId: string): Promise<void> {
  await requireAdmin();

  await prisma.$transaction(async (tx) => {
    const locked = await lockInventoryForUpdate(tx, docId);
    if (!locked) throw new Error("Инвентаризация не найдена");
    if (locked.status !== "DRAFT") throw new Error(ALREADY_CONDUCTED);

    const lineCount = await tx.inventoryLine.count({ where: { inventoryId: docId } });

    await tx.inventoryLine.deleteMany({ where: { inventoryId: docId } });
    await tx.inventory.delete({ where: { id: docId } });

    await writeChangeLog(
      {
        entity: "Inventory",
        entityId: docId,
        oldValues: { status: "DRAFT", lines: lineCount, action: "delete" },
      },
      tx,
    );
  });

  revalidatePath(PATH);
}
