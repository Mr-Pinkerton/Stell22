"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { requireAdmin } from "@/server/session";
import { enqueueRecalcBatchCosts } from "@/server/cost-queue";
import { lockBatches, lockProductionOperations, lockRailLots } from "@/server/internal/finance-operations";
import { D } from "@/lib/cost";
import { maybeFreezeBatch } from "@/server/internal/cost";
import {
  applyPrisadkaPick,
  applyUpakovkaPrepared,
  reversePrisadkaLine,
  reverseUpakovkaOperation,
} from "@/server/internal/production-reversal";
import {
  blankSpecSortKey,
  preparePrisadkaEdit,
  preparePrisadkaReverse,
  prepareTorcovkaBlankMutation,
  prepareUpakovkaEdit,
} from "@/server/internal/inventory-integrity";
import { operationEarning } from "@/lib/payroll";
import { isOverRailLength } from "@/lib/torcovka";
import { dayKey } from "@/lib/entries";
import type {
  ProductionChangeLogEntry,
  ProductionDetailLine,
  ProductionEntryRow,
} from "@/mocks/production-fixtures";

const PATH = "/production";

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type OpFull = Prisma.ProductionOperationGetPayload<{ include: { lines: true } }>;

interface RefMaps {
  employeeName: Map<string, string>;
  empRates: Map<
    string,
    {
      hourly: number;
      t1: number;
      t2: number;
      pt: number;
      pp: number;
      up: number;
    }
  >;
  batchName: Map<string, string>;
  batchFrozenAt: Map<string, string | null>;
  lotLength: Map<string, number>;
  lotRemaining: Map<string, number>;
  productName: Map<string, string>;
  detail: Map<string, { name: string; sort: "SORT1" | "SORT2" }>;
  logs: Map<string, ProductionChangeLogEntry[]>;
}

function computeAmount(op: OpFull, maps: RefMaps): { quantity: number; amount: number } {
  const r = maps.empRates.get(op.employeeId);
  if (!r) return { quantity: 0, amount: 0 };

  return operationEarning({
    type: op.type,
    rates: {
      hourly: r.hourly,
      torcovkaSort1: r.t1,
      torcovkaSort2: r.t2,
      prisadkaTorcev: r.pt,
      prisadkaPlosk: r.pp,
      upakovka: r.up,
    },
    hours: num(op.hours),
    productQty: op.productQty ?? 0,
    lines: op.lines.map((l) => ({
      quantity: l.quantity,
      // ЗП торцовки — по сорту заготовки; присадка — по флагам (сорт не нужен).
      sort: l.blankSort ?? (l.detailId ? maps.detail.get(l.detailId)?.sort : undefined),
      prisadkaTorcevaya: l.prisadkaTorcevaya,
      prisadkaPloskost: l.prisadkaPloskost,
    })),
  });
}

function serializeRow(op: OpFull, maps: RefMaps): ProductionEntryRow {
  const { quantity, amount } = computeAmount(op, maps);
  // Строки УПАКОВКИ в op.lines — внутренний провенанс списания (для обратной
  // разноски), в UI не показываются: там редактируется количество изделий
  // одной строкой (как у ЧАСОВ), а не список деталей.
  const detailLines: ProductionDetailLine[] =
    op.type === "TORCOVKA" || op.type === "PRISADKA"
      ? op.lines.map((l) => ({
          // Торцовка — заготовка (по длине), присадка — конкретная деталь.
          detailName: l.detailId
            ? (maps.detail.get(l.detailId)?.name ?? "—")
            : `Заготовка ${num(l.blankLengthM)} м`,
          quantity: l.quantity,
          prisadkaTorcevaya: l.prisadkaTorcevaya,
          prisadkaPloskost: l.prisadkaPloskost,
        }))
      : [];

  return {
    id: op.id,
    employeeId: op.employeeId,
    employeeName: maps.employeeName.get(op.employeeId) ?? "—",
    type: op.type,
    workDate: dayKey(op.workDate),
    createdAt: op.createdAt.toISOString(),
    quantity,
    amount,
    unitRate: quantity > 0 ? round2(amount / quantity) : 0,
    isPaid: op.isPaid,
    batchName: op.batchId ? maps.batchName.get(op.batchId) : undefined,
    railsTaken: op.railsTaken ?? undefined,
    railLengthM: op.railLotId ? maps.lotLength.get(op.railLotId) : undefined,
    lotRemainingQuantity: op.railLotId ? maps.lotRemaining.get(op.railLotId) : undefined,
    producedM:
      op.type === "TORCOVKA"
        ? op.lines.reduce((sum, l) => sum + num(l.blankLengthM) * l.quantity, 0)
        : undefined,
    batchFrozenAt: op.batchId ? (maps.batchFrozenAt.get(op.batchId) ?? null) : undefined,
    productName: op.productId ? maps.productName.get(op.productId) : undefined,
    detailLines: detailLines.length > 0 ? detailLines : undefined,
    changeLog: maps.logs.get(op.id) ?? [],
  };
}

async function buildMaps(ops: OpFull[]): Promise<RefMaps> {
  const [employees, batches, lots, products, details, logs] = await Promise.all([
    prisma.employee.findMany(),
    prisma.batch.findMany({ select: { id: true, name: true, frozenAt: true } }),
    prisma.railLot.findMany({ select: { id: true, lengthM: true, remainingQuantity: true } }),
    prisma.product.findMany({ select: { id: true, name: true } }),
    prisma.detail.findMany({ select: { id: true, name: true, sort: true } }),
    prisma.changeLog.findMany({
      where: { entity: "ProductionOperation", entityId: { in: ops.map((o) => o.id) } },
      orderBy: { changedAt: "desc" },
    }),
  ]);

  const logMap = new Map<string, ProductionChangeLogEntry[]>();
  for (const log of logs) {
    const nv = (log.newValues ?? {}) as Record<string, unknown>;
    if (typeof nv.field !== "string") continue; // только правки полей, не создание
    const list = logMap.get(log.entityId) ?? [];
    list.push({
      id: log.id,
      changedAt: log.changedAt.toISOString(),
      userName: "Админ",
      field: nv.field,
      oldValue:
        nv.oldRailsTaken != null ? String(nv.oldRailsTaken) : String(nv.oldValue ?? ""),
      newValue:
        nv.newRailsTaken != null ? String(nv.newRailsTaken) : String(nv.newValue ?? ""),
    });
    logMap.set(log.entityId, list);
  }

  return {
    employeeName: new Map(employees.map((e) => [e.id, e.fullName])),
    empRates: new Map(
      employees.map((e) => [
        e.id,
        {
          hourly: num(e.hourlyRate),
          t1: num(e.rateTorcovkaSort1),
          t2: num(e.rateTorcovkaSort2),
          pt: num(e.ratePrisadkaTorcev),
          pp: num(e.ratePrisadkaPloskt),
          up: num(e.rateUpakovka),
        },
      ]),
    ),
    batchName: new Map(batches.map((b) => [b.id, b.name])),
    batchFrozenAt: new Map(
      batches.map((b) => [b.id, b.frozenAt ? b.frozenAt.toISOString() : null]),
    ),
    lotLength: new Map(lots.map((l) => [l.id, num(l.lengthM)])),
    lotRemaining: new Map(lots.map((l) => [l.id, l.remainingQuantity])),
    productName: new Map(products.map((p) => [p.id, p.name])),
    detail: new Map(details.map((d) => [d.id, { name: d.name, sort: d.sort }])),
    logs: logMap,
  };
}

export async function getProductionEntries(): Promise<ProductionEntryRow[]> {
  await requireAdmin();
  const ops = await prisma.productionOperation.findMany({
    include: { lines: true },
    orderBy: { createdAt: "desc" },
  });
  const maps = await buildMaps(ops);
  return ops.map((op) => serializeRow(op, maps));
}

async function reloadRow(id: string): Promise<ProductionEntryRow> {
  const op = await prisma.productionOperation.findUniqueOrThrow({
    where: { id },
    include: { lines: true },
  });
  const maps = await buildMaps([op]);
  return serializeRow(op, maps);
}

/**
 * Правка количества строки операции до выплаты.
 *  - TORCOVKA: корректируется сырой остаток произведённой детали.
 *  - HOURS / UPAKOVKA: одна синтетическая строка (часы / изделия), правка —
 *    как в HOURS для часов; для УПАКОВКИ — полная обратная разноска старого
 *    количества и повторное списание материалов под новое (см. ниже).
 *  - PRISADKA: обратная разноска конкретной строки (в исходную комбинацию
 *    присадки) и повторное списание под новое количество — источники могут
 *    оказаться другими (актуальный остаток на момент правки).
 */
export async function updateProductionLineQuantity(
  id: string,
  lineIndex: number,
  newQty: number,
): Promise<ProductionEntryRow> {
  await requireAdmin();
  if (!(newQty > 0)) throw new Error("Количество должно быть положительным");

  let enqueueBatchId: string | null = null;
  let revalidateReports = false;

  await prisma.$transaction(async (tx) => {
    await lockProductionOperations(tx, [id]);
    const op = await tx.productionOperation.findUnique({
      where: { id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    if (!op) throw new Error("Операция не найдена");
    if (op.isPaid) throw new Error("Нельзя изменить — операция уже выплачена");

    if (op.type === "HOURS") {
      const old = num(op.hours);
      await tx.productionOperation.update({ where: { id }, data: { hours: newQty } });
      await writeChangeLog(
        {
          entity: "ProductionOperation",
          entityId: id,
          newValues: { field: "Количество", oldValue: old, newValue: newQty },
        },
        tx,
      );
      return;
    }

    if (op.type === "UPAKOVKA") {
      const newQtyInt = Math.round(newQty);
      const oldQty = op.productQty ?? 0;
      if (!op.productId) throw new Error("У операции не указано изделие");
      if (newQtyInt === oldQty) return;

      const [detailLines, nomenclatureLines] = await Promise.all([
        tx.operationDetailLine.findMany({ where: { operationId: id } }),
        tx.operationNomenclatureLine.findMany({ where: { operationId: id } }),
      ]);
      const prepared = await prepareUpakovkaEdit(
        tx,
        op.createdAt,
        op.productId,
        detailLines,
        nomenclatureLines,
      );
      await reverseUpakovkaOperation(
        tx,
        op.productId,
        oldQty,
        detailLines,
        nomenclatureLines,
        op.createdAt,
      );
      await tx.operationDetailLine.deleteMany({ where: { operationId: id } });
      await tx.operationNomenclatureLine.deleteMany({ where: { operationId: id } });
      await applyUpakovkaPrepared(tx, id, newQtyInt, prepared);
      await tx.productionOperation.update({ where: { id }, data: { productQty: newQtyInt } });
      await writeChangeLog(
        {
          entity: "ProductionOperation",
          entityId: id,
          newValues: { field: "Количество", oldValue: oldQty, newValue: newQtyInt },
        },
        tx,
      );
      revalidateReports = true;
      return;
    }

    if (op.type === "PRISADKA") {
      const line = op.lines[lineIndex];
      if (!line) throw new Error("Строка не найдена");
      const newQtyInt = Math.round(newQty);
      if (newQtyInt === line.quantity) return;
      const kind: "torcev" | "plosk" = line.prisadkaTorcevaya ? "torcev" : "plosk";
      if (!line.detailId) throw new Error("Строка присадки без детали");
      const detailId = line.detailId;
      await preparePrisadkaEdit(tx, op.createdAt, line, newQtyInt);
      await reversePrisadkaLine(tx, line);
      await tx.operationDetailLine.delete({ where: { id: line.id } });
      await applyPrisadkaPick(tx, id, detailId, kind, newQtyInt);
      await writeChangeLog(
        {
          entity: "ProductionOperation",
          entityId: id,
          newValues: { field: "Количество", oldValue: line.quantity, newValue: newQtyInt },
        },
        tx,
      );
      revalidateReports = true;
      return;
    }

    if (op.type !== "TORCOVKA") {
      throw new Error("Редактирование этого типа операции пока недоступно");
    }

    const line = op.lines[lineIndex];
    if (!line) throw new Error("Строка не найдена");
    const { blankLengthM, blankType, blankSort, blankMaterialId } = line;
    if (blankLengthM == null || blankType == null || blankSort == null || blankMaterialId == null) {
      throw new Error("Строка торцовки без спецификации заготовки");
    }
    const lineId = line.id;
    const oldQty = line.quantity;
    const delta = newQty - oldQty;
    if (delta === 0) return;

    await prepareTorcovkaBlankMutation(tx, op.createdAt, [
      {
        materialId: blankMaterialId,
        lengthM: blankLengthM,
        detailType: blankType,
        sort: blankSort,
      },
    ]);

    if (delta < 0) {
      const dec = await tx.blankStock.updateMany({
        where: {
          materialId: blankMaterialId,
          lengthM: blankLengthM,
          detailType: blankType,
          sort: blankSort,
          quantity: { gte: -delta },
        },
        data: { quantity: { decrement: -delta } },
      });
      if (dec.count === 0) throw new Error("Нельзя уменьшить: заготовки уже прошли присадку/упаковку");
    } else {
      if (op.railLotId && op.railsTaken) {
        const lot = await tx.railLot.findUnique({ where: { id: op.railLotId } });
        const takenLengthM = op.railsTaken * (lot ? num(lot.lengthM) : 0);
        const usedLengthM = op.lines.reduce(
          (sum, l) => sum + num(l.blankLengthM) * (l.id === lineId ? newQty : l.quantity),
          0,
        );
        if (isOverRailLength(takenLengthM, usedLengthM)) {
          throw new Error("Суммарная длина заготовок превышает длину взятых реек");
        }
      }
      await tx.blankStock.upsert({
        where: {
          materialId_lengthM_detailType_sort: {
            materialId: blankMaterialId,
            lengthM: blankLengthM,
            detailType: blankType,
            sort: blankSort,
          },
        },
        create: {
          materialId: blankMaterialId,
          lengthM: blankLengthM,
          detailType: blankType,
          sort: blankSort,
          quantity: delta,
        },
        update: { quantity: { increment: delta } },
      });
    }
    await tx.operationDetailLine.update({ where: { id: lineId }, data: { quantity: newQty } });
    await writeChangeLog(
      {
        entity: "ProductionOperation",
        entityId: id,
        newValues: { field: "Количество", oldValue: oldQty, newValue: newQty },
      },
      tx,
    );
    enqueueBatchId = op.batchId;
    revalidateReports = true;
  });

  if (enqueueBatchId) await enqueueRecalcBatchCosts(enqueueBatchId);

  revalidatePath(PATH);
  if (revalidateReports) revalidatePath("/reports");
  return reloadRow(id);
}

/**
 * Удаление операции до выплаты с полной обратной разноской остатков:
 *  - TORCOVKA: снимаем произведённые детали с сырого остатка. Рейки НЕ
 *    возвращаются в пакет — они уже физически распилены (торцовка
 *    необратима), удаление лишь исправляет запись о том, что из них
 *    произвели. Взятые рейки при этом перестают учитываться как «взято»
 *    (операции больше нет), а `remainingQuantity` пакета не меняется — эта
 *    разница автоматически попадает в отчёт «Процент отхода» как списание
 *    сверх произведённого (`writtenOffM`, см. src/server/reports.ts и
 *    src/lib/waste.ts), а не гасится искусственным возвратом целых реек;
 *  - PRISADKA: возврат каждой строки в исходную комбинацию присадки;
 *  - UPAKOVKA: возврат деталей/крепежа/упаковки, снятие изделия со склада;
 *  - HOURS: просто удаление записи (не затрагивает склад).
 * Бросает, если материал уже ушёл дальше по цепочке (упаковка/продажа) —
 * в этом случае удаление невозможно без нарушения cost-integrity.
 */
export async function deleteProductionOperation(id: string): Promise<void> {
  await requireAdmin();

  let enqueueBatchId: string | null = null;

  await prisma.$transaction(async (tx) => {
    await lockProductionOperations(tx, [id]);
    const op = await tx.productionOperation.findUnique({
      where: { id },
      include: { lines: true, nomenclatureLines: true },
    });
    if (!op) throw new Error("Операция не найдена");
    if (op.isPaid) throw new Error("Нельзя удалить — операция уже выплачена");

    if (op.type === "TORCOVKA" && op.batchId) {
      await lockBatches(tx, [op.batchId]);
    }

    if (op.type === "TORCOVKA") {
      const specs = [];
      for (const l of op.lines) {
        if (
          l.blankLengthM == null ||
          l.blankType == null ||
          l.blankSort == null ||
          l.blankMaterialId == null
        ) {
          throw new Error("Строка торцовки без спецификации заготовки");
        }
        specs.push({
          materialId: l.blankMaterialId,
          lengthM: l.blankLengthM,
          detailType: l.blankType,
          sort: l.blankSort,
        });
      }
      await prepareTorcovkaBlankMutation(tx, op.createdAt, specs);
      const sortedLines = [...op.lines].sort((a, b) =>
        blankSpecSortKey({
          materialId: a.blankMaterialId!,
          lengthM: a.blankLengthM!,
          detailType: a.blankType!,
          sort: a.blankSort!,
        }).localeCompare(
          blankSpecSortKey({
            materialId: b.blankMaterialId!,
            lengthM: b.blankLengthM!,
            detailType: b.blankType!,
            sort: b.blankSort!,
          }),
        ),
      );
      for (const l of sortedLines) {
        const dec = await tx.blankStock.updateMany({
          where: {
            materialId: l.blankMaterialId!,
            lengthM: l.blankLengthM!,
            detailType: l.blankType!,
            sort: l.blankSort!,
            quantity: { gte: l.quantity },
          },
          data: { quantity: { decrement: l.quantity } },
        });
        if (dec.count === 0) {
          throw new Error("Нельзя удалить: заготовки уже прошли присадку/упаковку");
        }
      }
    } else if (op.type === "PRISADKA") {
      await preparePrisadkaReverse(tx, op.createdAt, op.lines);
      for (const l of op.lines) {
        await reversePrisadkaLine(tx, l);
      }
    } else if (op.type === "UPAKOVKA") {
      if (!op.productId) throw new Error("У операции не указано изделие");
      await reverseUpakovkaOperation(
        tx,
        op.productId,
        op.productQty ?? 0,
        op.lines,
        op.nomenclatureLines,
        op.createdAt,
      );
    }

    await tx.operationDetailLine.deleteMany({ where: { operationId: id } });
    await tx.operationNomenclatureLine.deleteMany({ where: { operationId: id } });
    await tx.productionOperation.delete({ where: { id } });
    await writeChangeLog(
      { entity: "ProductionOperation", entityId: id, oldValues: { type: op.type, deleted: true } },
      tx,
    );
    if (op.type === "TORCOVKA" && op.batchId) {
      await maybeFreezeBatch(tx, op.batchId, { batchAlreadyLocked: true });
    }
    enqueueBatchId = op.batchId;
  });

  if (enqueueBatchId) await enqueueRecalcBatchCosts(enqueueBatchId);

  revalidatePath(PATH);
  revalidatePath("/reports");
}

export async function correctTorcovkaRailsTaken(input: {
  operationId: string;
  newRailsTaken: number;
  reason: string;
}): Promise<ProductionEntryRow> {
  await requireAdmin();
  const { operationId } = input;
  const newRailsTaken = input.newRailsTaken;
  const reason = input.reason.trim();
  if (!reason) throw new Error("Укажите причину исправления");
  if (!Number.isInteger(newRailsTaken) || newRailsTaken <= 0) {
    throw new Error("Количество реек должно быть целым и больше нуля");
  }

  let enqueueBatchId: string | null = null;

  await prisma.$transaction(async (tx) => {
    await lockProductionOperations(tx, [operationId]);
    const op = await tx.productionOperation.findUnique({
      where: { id: operationId },
      include: { lines: true },
    });
    if (!op) throw new Error("Операция не найдена");
    if (op.type !== "TORCOVKA") throw new Error("Исправление реек доступно только для торцовки");
    if (!op.railLotId || !op.batchId || op.railsTaken == null) {
      throw new Error("У операции не указаны пакет и количество реек");
    }
    const oldRailsTaken = op.railsTaken;
    if (!(newRailsTaken < oldRailsTaken)) {
      throw new Error("Можно только уменьшить количество фактически взятых реек");
    }

    await lockRailLots(tx, [op.railLotId]);
    const lot = await tx.railLot.findUnique({ where: { id: op.railLotId } });
    if (!lot) throw new Error("Пакет реек не найден");

    await lockBatches(tx, [op.batchId]);
    const batch = await tx.batch.findUnique({ where: { id: op.batchId } });
    if (!batch) throw new Error("Партия не найдена");
    if (batch.frozenAt != null) {
      throw new Error("Нельзя исправить — себестоимость партии заморожена");
    }

    const producedM = op.lines.reduce(
      (sum, l) => sum.plus(D(num(l.blankLengthM)).times(l.quantity)),
      D(0),
    );
    const newTakenM = D(newRailsTaken).times(D(lot.lengthM));
    if (producedM.gt(newTakenM)) {
      throw new Error("Суммарная длина заготовок превышает длину взятых реек");
    }

    const delta = oldRailsTaken - newRailsTaken;
    await tx.railLot.update({
      where: { id: op.railLotId },
      data: { remainingQuantity: { increment: delta } },
    });
    await tx.productionOperation.update({
      where: { id: operationId },
      data: { railsTaken: newRailsTaken },
    });
    await writeChangeLog(
      {
        entity: "ProductionOperation",
        entityId: operationId,
        newValues: {
          field: "railsTaken",
          oldRailsTaken,
          newRailsTaken,
          deltaReturned: delta,
          reason,
        },
      },
      tx,
    );

    const lots = await tx.railLot.findMany({
      where: { batchId: op.batchId },
      select: { remainingQuantity: true },
    });
    const remaining = lots.reduce((s, l) => s + l.remainingQuantity, 0);
    if (remaining > 0 && (batch.status !== "IN_WORK" || batch.closedAt != null)) {
      await tx.batch.update({
        where: { id: op.batchId },
        data: { status: "IN_WORK", closedAt: null },
      });
      await writeChangeLog(
        {
          entity: "Batch",
          entityId: op.batchId,
          newValues: { reopened: true, viaOperationId: operationId },
        },
        tx,
      );
    }

    enqueueBatchId = op.batchId;
  });

  if (enqueueBatchId) await enqueueRecalcBatchCosts(enqueueBatchId);

  revalidatePath(PATH);
  revalidatePath("/reports");
  revalidatePath("/purchases");
  revalidatePath("/", "layout");
  return reloadRow(operationId);
}
