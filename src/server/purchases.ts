"use server";

import { revalidatePath } from "next/cache";
import type { Batch as PrismaBatch, RailLot as PrismaRailLot } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { recalcBatchCosts } from "@/server/cost";
import { sectionAreaM2, type PurchaseBatchRow } from "@/lib/batch-stats";
import type { NomenclatureItem, RailType, Sort } from "@/types/domain";

const PATH = "/purchases";

function num(value: PrismaBatch[keyof PrismaBatch] | PrismaRailLot[keyof PrismaRailLot]): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value
    ? (value as { toNumber: () => number }).toNumber()
    : Number(value);
}

// Batch + его рейки → строка таблицы закупок (со статистикой и сигналом расхождения).
function toRow(batch: PrismaBatch, lots: PrismaRailLot[]): PurchaseBatchRow {
  const own = lots.filter((l) => l.batchId === batch.id);
  const wMm = num(batch.sectionWidthMm);
  const hMm = num(batch.sectionHeightMm);
  const area = sectionAreaM2(wMm, hMm);

  let railCount = 0;
  let totalLengthM = 0;
  let volumeM3 = 0;
  let vol1 = 0;
  let vol2 = 0;

  for (const lot of own) {
    const len = num(lot.lengthM);
    const vol = lot.quantity * area * len;
    railCount += lot.quantity;
    totalLengthM += lot.quantity * len;
    volumeM3 += vol;
    if (lot.sort === "SORT1") vol1 += vol;
    else vol2 += vol;
  }

  const purchaseCost = num(batch.purchaseCost);
  const p1 = num(batch.priceSort1);
  const p2 = num(batch.priceSort2);
  // Проверка из v2: сумма по ценам сортов должна сходиться со «Стоимостью партии».
  const calc = p1 * vol1 + p2 * vol2;
  const costMismatch = p1 > 0 && p2 > 0 && Math.abs(calc - purchaseCost) > 1;

  return {
    id: batch.id,
    name: batch.name,
    sectionWidthMm: wMm,
    sectionHeightMm: hMm,
    purchaseCost,
    totalCost: num(batch.totalCost),
    priceSort1: p1,
    priceSort2: p2,
    status: batch.status,
    purchaseDate: batch.purchaseDate.toISOString().slice(0, 10),
    note: batch.note,
    stats: {
      railCount,
      totalLengthM,
      volumeM3,
      packageCount: own.filter((l) => l.isPackage).length,
    },
    costMismatch,
  };
}

async function loadRow(batchId: string): Promise<PurchaseBatchRow> {
  const [batch, lots] = await Promise.all([
    prisma.batch.findUniqueOrThrow({ where: { id: batchId } }),
    prisma.railLot.findMany({ where: { batchId } }),
  ]);
  return toRow(batch, lots);
}

// ============================ ЧТЕНИЕ =======================================

export interface PurchasesData {
  rows: PurchaseBatchRow[];
  items: NomenclatureItem[];
}

export async function getPurchasesData(): Promise<PurchasesData> {
  const [batches, lots, items] = await Promise.all([
    prisma.batch.findMany({ orderBy: { purchaseDate: "desc" } }),
    prisma.railLot.findMany(),
    prisma.nomenclatureItem.findMany({ where: { status: "ACTIVE" }, orderBy: { name: "asc" } }),
  ]);
  return {
    rows: batches.map((b) => toRow(b, lots)),
    items: items.map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      unitPrice: num(n.unitPrice),
      status: n.status,
      minStock: n.minStock,
    })),
  };
}

// ============================ ПАРТИЯ РЕЙКИ =================================

export interface BatchRailInput {
  mode: "package" | "piece";
  lengthM: number;
  railType: RailType;
  sort: Sort;
  quantity: number;
  rows?: number | null;
  layers?: number | null;
}

export interface BatchFormValues {
  name: string;
  /** ISO yyyy-mm-dd; null → текущая дата. */
  purchaseDate: string | null;
  sectionWidthMm: number | null;
  sectionHeightMm: number | null;
  purchaseCost: number | null;
  priceSort1: number | null;
  priceSort2: number | null;
  note: string;
  rails: BatchRailInput[];
}

function parseDate(iso: string | null): Date {
  if (!iso) return new Date();
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function packageCode(): string {
  return `PKG-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

const RAIL_TYPE_LABEL: Record<RailType, string> = { POLKA: "Полка", KANAVKA: "Канавка" };
const SORT_LABEL: Record<Sort, string> = { SORT1: "Сорт 1", SORT2: "Сорт 2" };

export interface PackageLabelData {
  code: string;
  title: string;
  subtitle: string;
}

/** Этикетки пакетов партии (коды + параметры рейки) для печати. */
export async function getBatchLabels(batchId: string): Promise<PackageLabelData[]> {
  const batch = await prisma.batch.findUnique({
    where: { id: batchId },
    include: { railLots: { where: { isPackage: true }, orderBy: { code: "asc" } } },
  });
  if (!batch) return [];
  return batch.railLots
    .filter((l) => l.code)
    .map((l) => ({
      code: l.code as string,
      title: batch.name,
      subtitle: `${RAIL_TYPE_LABEL[l.railType as RailType]} · ${SORT_LABEL[l.sort as Sort]} · ${num(l.lengthM)} м · ${l.quantity} шт`,
    }));
}

function validateBatch(v: BatchFormValues) {
  if (!v.name.trim()) throw new Error("Название партии обязательно");
  if (!v.sectionWidthMm || !v.sectionHeightMm) throw new Error("Укажите сечение рейки");
  if (!v.purchaseCost || v.purchaseCost <= 0) throw new Error("Укажите стоимость партии");
}

export async function createBatch(values: BatchFormValues): Promise<PurchaseBatchRow> {
  validateBatch(values);

  const created = await prisma.batch.create({
    data: {
      name: values.name.trim(),
      sectionWidthMm: values.sectionWidthMm ?? 0,
      sectionHeightMm: values.sectionHeightMm ?? 0,
      purchaseCost: values.purchaseCost ?? 0,
      totalCost: values.purchaseCost ?? 0, // при создании = закупочной (доставка из Сделок позже)
      priceSort1: values.priceSort1 ?? 0,
      priceSort2: values.priceSort2 ?? 0,
      status: "IN_WORK",
      purchaseDate: parseDate(values.purchaseDate),
      note: values.note.trim() || null,
      railLots: {
        create: values.rails.map((r) => ({
          lengthM: r.lengthM,
          railType: r.railType,
          sort: r.sort,
          isPackage: r.mode === "package",
          code: r.mode === "package" ? packageCode() : null,
          rows: r.rows ?? null,
          layers: r.layers ?? null,
          quantity: r.quantity,
          remainingQuantity: r.quantity,
        })),
      },
    },
  });

  await writeChangeLog({
    entity: "Batch",
    entityId: created.id,
    newValues: { name: created.name, purchaseCost: num(created.purchaseCost) },
  });
  revalidatePath(PATH);
  return loadRow(created.id);
}

/**
 * Редактирование партии: меняем только скалярные поля (название, сечение,
 * финансы, примечание). Рейки/остатки не трогаем — они списываются в терминале
 * и их правка ведётся отдельно (чтобы не сбить remainingQuantity).
 */
export async function updateBatch(id: string, values: BatchFormValues): Promise<PurchaseBatchRow> {
  validateBatch(values);

  const before = await prisma.batch.findUnique({ where: { id } });
  if (!before) throw new Error("Партия не найдена");

  const updated = await prisma.batch.update({
    where: { id },
    data: {
      name: values.name.trim(),
      sectionWidthMm: values.sectionWidthMm ?? 0,
      sectionHeightMm: values.sectionHeightMm ?? 0,
      purchaseCost: values.purchaseCost ?? 0,
      priceSort1: values.priceSort1 ?? 0,
      priceSort2: values.priceSort2 ?? 0,
      purchaseDate: parseDate(values.purchaseDate),
      note: values.note.trim() || null,
    },
  });

  await writeChangeLog({
    entity: "Batch",
    entityId: id,
    oldValues: { name: before.name, purchaseCost: num(before.purchaseCost) },
    newValues: { name: updated.name, purchaseCost: num(updated.purchaseCost) },
  });

  // Стоимость/сечение/цены сортов влияют на распределение — пересчёт (если открыта).
  await recalcBatchCosts({ batchId: id });

  revalidatePath(PATH);
  revalidatePath("/reports");
  return loadRow(id);
}

/** Списать остаток партии в отход: обнуляем остатки всех реек. */
export async function writeOffBatchRemainder(id: string): Promise<PurchaseBatchRow> {
  const lots = await prisma.railLot.findMany({ where: { batchId: id } });
  const remaining = lots.reduce((s, l) => s + l.remainingQuantity, 0);
  if (remaining <= 0) throw new Error("Остаток уже нулевой");

  await prisma.railLot.updateMany({
    where: { batchId: id, remainingQuantity: { gt: 0 } },
    data: { remainingQuantity: 0 },
  });
  await writeChangeLog({
    entity: "Batch",
    entityId: id,
    oldValues: { remainingRails: remaining },
    newValues: { remainingRails: 0, writeOff: "отход" },
  });
  revalidatePath(PATH);
  return loadRow(id);
}

export async function deleteBatch(id: string): Promise<void> {
  const [ops, deals] = await Promise.all([
    prisma.productionOperation.count({ where: { batchId: id } }),
    prisma.dealItem.count({ where: { batchId: id } }),
  ]);
  if (ops > 0 || deals > 0) {
    throw new Error("Нельзя удалить: по партии есть движения материала или привязка к сделке.");
  }
  const before = await prisma.batch.findUnique({ where: { id } });
  if (!before) throw new Error("Партия не найдена");

  await prisma.$transaction([
    prisma.batchCost.deleteMany({ where: { batchId: id } }),
    prisma.railLot.deleteMany({ where: { batchId: id } }),
    prisma.batch.delete({ where: { id } }),
  ]);
  await writeChangeLog({
    entity: "Batch",
    entityId: id,
    oldValues: { name: before.name, status: before.status },
  });
  revalidatePath(PATH);
}

// ============================ ПРОСТАЯ ЗАКУПКА ==============================

export interface SimplePurchaseFormValues {
  nomenclatureId: string;
  quantity: number | null;
  unitPrice: number | null;
  /** ISO yyyy-mm-dd; null → текущая дата. */
  purchaseDate: string | null;
}

export async function createSimplePurchase(values: SimplePurchaseFormValues): Promise<void> {
  if (!values.nomenclatureId) throw new Error("Выберите номенклатуру");
  if (!values.quantity || values.quantity <= 0) throw new Error("Укажите количество");
  if (values.unitPrice == null || values.unitPrice < 0) throw new Error("Укажите цену");

  const qty = values.quantity;
  const created = await prisma.$transaction(async (tx) => {
    const purchase = await tx.simplePurchase.create({
      data: {
        nomenclatureId: values.nomenclatureId,
        quantity: qty,
        unitPrice: values.unitPrice ?? 0,
        purchaseDate: parseDate(values.purchaseDate),
      },
    });
    // Приход на склад крепежа/упаковки/разного.
    await tx.nomenclatureStock.upsert({
      where: { nomenclatureId: values.nomenclatureId },
      create: { nomenclatureId: values.nomenclatureId, quantity: qty },
      update: { quantity: { increment: qty } },
    });
    return purchase;
  });
  await writeChangeLog({
    entity: "SimplePurchase",
    entityId: created.id,
    newValues: { nomenclatureId: created.nomenclatureId, quantity: created.quantity },
  });
  revalidatePath(PATH);
}
