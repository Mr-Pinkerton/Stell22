"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { enqueueRecalcBatchCosts } from "@/server/cost-queue";
import {
  applyPrisadkaPick,
  applyUpakovkaPick,
  reversePrisadkaLine,
  reverseUpakovkaOperation,
} from "@/server/terminal";
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
  lotLength: Map<string, number>;
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
    productName: op.productId ? maps.productName.get(op.productId) : undefined,
    detailLines: detailLines.length > 0 ? detailLines : undefined,
    changeLog: maps.logs.get(op.id) ?? [],
  };
}

async function buildMaps(ops: OpFull[]): Promise<RefMaps> {
  const [employees, batches, lots, products, details, logs] = await Promise.all([
    prisma.employee.findMany(),
    prisma.batch.findMany({ select: { id: true, name: true } }),
    prisma.railLot.findMany({ select: { id: true, lengthM: true } }),
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
      oldValue: String(nv.oldValue ?? ""),
      newValue: String(nv.newValue ?? ""),
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
    lotLength: new Map(lots.map((l) => [l.id, num(l.lengthM)])),
    productName: new Map(products.map((p) => [p.id, p.name])),
    detail: new Map(details.map((d) => [d.id, { name: d.name, sort: d.sort }])),
    logs: logMap,
  };
}

export async function getProductionEntries(): Promise<ProductionEntryRow[]> {
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
  if (!(newQty > 0)) throw new Error("Количество должно быть положительным");

  const op = await prisma.productionOperation.findUnique({
    where: { id },
    include: { lines: { orderBy: { id: "asc" } } },
  });
  if (!op) throw new Error("Операция не найдена");
  if (op.isPaid) throw new Error("Нельзя изменить — операция уже выплачена");

  if (op.type === "HOURS") {
    const old = num(op.hours);
    await prisma.productionOperation.update({ where: { id }, data: { hours: newQty } });
    await writeChangeLog({
      entity: "ProductionOperation",
      entityId: id,
      newValues: { field: "Количество", oldValue: old, newValue: newQty },
    });
    revalidatePath(PATH);
    return reloadRow(id);
  }

  if (op.type === "UPAKOVKA") {
    const newQtyInt = Math.round(newQty);
    const oldQty = op.productQty ?? 0;
    if (!op.productId) throw new Error("У операции не указано изделие");
    if (newQtyInt === oldQty) return reloadRow(id);

    await prisma.$transaction(async (tx) => {
      const [detailLines, nomenclatureLines] = await Promise.all([
        tx.operationDetailLine.findMany({ where: { operationId: id } }),
        tx.operationNomenclatureLine.findMany({ where: { operationId: id } }),
      ]);
      // Полная обратная разноска старого количества, затем чистое повторное
      // списание под новое — проще и надёжнее частичного дельта-пересчёта,
      // и симметрично удалению.
      await reverseUpakovkaOperation(tx, op.productId!, oldQty, detailLines, nomenclatureLines);
      await tx.operationDetailLine.deleteMany({ where: { operationId: id } });
      await tx.operationNomenclatureLine.deleteMany({ where: { operationId: id } });
      await applyUpakovkaPick(tx, id, op.productId!, newQtyInt);
      await tx.productionOperation.update({ where: { id }, data: { productQty: newQtyInt } });
      await writeChangeLog(
        {
          entity: "ProductionOperation",
          entityId: id,
          newValues: { field: "Количество", oldValue: oldQty, newValue: newQtyInt },
        },
        tx,
      );
    });

    revalidatePath(PATH);
    revalidatePath("/reports");
    return reloadRow(id);
  }

  if (op.type === "PRISADKA") {
    const line = op.lines[lineIndex];
    if (!line) throw new Error("Строка не найдена");
    const newQtyInt = Math.round(newQty);
    if (newQtyInt === line.quantity) return reloadRow(id);
    const kind: "torcev" | "plosk" = line.prisadkaTorcevaya ? "torcev" : "plosk";

    if (!line.detailId) throw new Error("Строка присадки без детали");
    const detailId = line.detailId;
    await prisma.$transaction(async (tx) => {
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
    });

    revalidatePath(PATH);
    revalidatePath("/reports");
    return reloadRow(id);
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
  if (delta === 0) return reloadRow(id);

  await prisma.$transaction(async (tx) => {
    if (delta < 0) {
      // Уменьшаем — снимаем разницу со склада заготовок (нельзя в минус).
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
      // Увеличение не должно вывести суммарную длину заготовок за длину взятых
      // реек (A8): иначе — заготовки «из воздуха», искажение отхода и цены м³.
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
  });

  // Изменился объём произведённого по партии — пересчёт её себестоимости.
  if (op.batchId) await enqueueRecalcBatchCosts(op.batchId);

  revalidatePath(PATH);
  revalidatePath("/reports");
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
  const op = await prisma.productionOperation.findUnique({
    where: { id },
    include: { lines: true, nomenclatureLines: true },
  });
  if (!op) throw new Error("Операция не найдена");
  if (op.isPaid) throw new Error("Нельзя удалить — операция уже выплачена");

  await prisma.$transaction(async (tx) => {
    if (op.type === "TORCOVKA") {
      // Снимаем произведённые заготовки со склада заготовок (нельзя в минус).
      for (const l of op.lines) {
        if (
          l.blankLengthM == null ||
          l.blankType == null ||
          l.blankSort == null ||
          l.blankMaterialId == null
        ) {
          throw new Error("Строка торцовки без спецификации заготовки");
        }
        const dec = await tx.blankStock.updateMany({
          where: {
            materialId: l.blankMaterialId,
            lengthM: l.blankLengthM,
            detailType: l.blankType,
            sort: l.blankSort,
            quantity: { gte: l.quantity },
          },
          data: { quantity: { decrement: l.quantity } },
        });
        if (dec.count === 0) {
          throw new Error("Нельзя удалить: заготовки уже прошли присадку/упаковку");
        }
      }
      // Рейки НЕ возвращаем — они уже распилены. Взятое сверх произведённого
      // станет отходом партии (см. JSDoc функции).
    } else if (op.type === "PRISADKA") {
      for (const l of op.lines) {
        await reversePrisadkaLine(tx, l);
      }
    } else if (op.type === "UPAKOVKA") {
      if (!op.productId) throw new Error("У операции не указано изделие");
      await reverseUpakovkaOperation(tx, op.productId, op.productQty ?? 0, op.lines, op.nomenclatureLines);
    }

    await tx.operationDetailLine.deleteMany({ where: { operationId: id } });
    await tx.operationNomenclatureLine.deleteMany({ where: { operationId: id } });
    await tx.productionOperation.delete({ where: { id } });
    await writeChangeLog(
      { entity: "ProductionOperation", entityId: id, oldValues: { type: op.type, deleted: true } },
      tx,
    );
  });

  // Возврат произведённого по партии — пересчёт её себестоимости.
  if (op.batchId) await enqueueRecalcBatchCosts(op.batchId);

  revalidatePath(PATH);
  revalidatePath("/reports");
}
