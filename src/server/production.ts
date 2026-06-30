"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { recalcBatchCosts } from "@/server/cost";
import { operationEarning } from "@/lib/payroll";
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
      sort: maps.detail.get(l.detailId)?.sort,
      prisadkaTorcevaya: l.prisadkaTorcevaya,
      prisadkaPloskost: l.prisadkaPloskost,
    })),
  });
}

function serializeRow(op: OpFull, maps: RefMaps): ProductionEntryRow {
  const { quantity, amount } = computeAmount(op, maps);
  const detailLines: ProductionDetailLine[] = op.lines.map((l) => ({
    detailName: maps.detail.get(l.detailId)?.name ?? "—",
    quantity: l.quantity,
    prisadkaTorcevaya: l.prisadkaTorcevaya,
    prisadkaPloskost: l.prisadkaPloskost,
  }));

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
 * Правка количества строки операции до выплаты. Поддержано для торцовки
 * (корректируется сырой остаток деталей) и часов. Присадка/упаковка —
 * редактирование пока недоступно (нужна обратная разноска по стадиям/складу).
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

  if (op.type !== "TORCOVKA") {
    throw new Error("Редактирование этого типа операции пока недоступно");
  }

  const line = op.lines[lineIndex];
  if (!line) throw new Error("Строка не найдена");
  const delta = newQty - line.quantity;
  if (delta === 0) return reloadRow(id);

  await prisma.$transaction(async (tx) => {
    if (delta < 0) {
      // Уменьшаем — снимаем разницу с сырого остатка (нельзя в минус).
      const dec = await tx.detailStock.updateMany({
        where: {
          detailId: line.detailId,
          torcevayaDone: false,
          ploskostDone: false,
          quantity: { gte: -delta },
        },
        data: { quantity: { decrement: -delta } },
      });
      if (dec.count === 0) throw new Error("Нельзя уменьшить: детали уже прошли присадку/упаковку");
    } else {
      await tx.detailStock.upsert({
        where: {
          detailId_torcevayaDone_ploskostDone: {
            detailId: line.detailId,
            torcevayaDone: false,
            ploskostDone: false,
          },
        },
        create: {
          detailId: line.detailId,
          torcevayaDone: false,
          ploskostDone: false,
          quantity: delta,
        },
        update: { quantity: { increment: delta } },
      });
    }
    await tx.operationDetailLine.update({ where: { id: line.id }, data: { quantity: newQty } });
    await writeChangeLog(
      {
        entity: "ProductionOperation",
        entityId: id,
        newValues: { field: "Количество", oldValue: line.quantity, newValue: newQty },
      },
      tx,
    );
  });

  // Изменился объём произведённого по партии — пересчёт её себестоимости.
  if (op.batchId) await recalcBatchCosts({ batchId: op.batchId });

  revalidatePath(PATH);
  revalidatePath("/reports");
  return reloadRow(id);
}

/**
 * Удаление операции до выплаты с обратной разноской остатков.
 * Поддержано для торцовки (возврат реек, снятие сырых деталей) и часов.
 * Присадка/упаковка — пока недоступны (обратная разноска по стадиям/складу).
 */
export async function deleteProductionOperation(id: string): Promise<void> {
  const op = await prisma.productionOperation.findUnique({
    where: { id },
    include: { lines: true },
  });
  if (!op) throw new Error("Операция не найдена");
  if (op.isPaid) throw new Error("Нельзя удалить — операция уже выплачена");
  if (op.type === "PRISADKA" || op.type === "UPAKOVKA") {
    throw new Error("Удаление этого типа операции пока недоступно");
  }

  await prisma.$transaction(async (tx) => {
    if (op.type === "TORCOVKA") {
      // Снимаем произведённые детали с сырого остатка (нельзя в минус).
      for (const l of op.lines) {
        const dec = await tx.detailStock.updateMany({
          where: {
            detailId: l.detailId,
            torcevayaDone: false,
            ploskostDone: false,
            quantity: { gte: l.quantity },
          },
          data: { quantity: { decrement: l.quantity } },
        });
        if (dec.count === 0) {
          throw new Error("Нельзя удалить: детали уже прошли присадку/упаковку");
        }
      }
      // Возвращаем рейки в остаток партии.
      if (op.railLotId && op.railsTaken) {
        await tx.railLot.update({
          where: { id: op.railLotId },
          data: { remainingQuantity: { increment: op.railsTaken } },
        });
      }
    }

    await tx.operationDetailLine.deleteMany({ where: { operationId: id } });
    await tx.productionOperation.delete({ where: { id } });
    await writeChangeLog(
      { entity: "ProductionOperation", entityId: id, oldValues: { type: op.type, deleted: true } },
      tx,
    );
  });

  // Возврат произведённого по партии — пересчёт её себестоимости.
  if (op.batchId) await recalcBatchCosts({ batchId: op.batchId });

  revalidatePath(PATH);
  revalidatePath("/reports");
}
