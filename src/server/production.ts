"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { requireAdmin } from "@/server/session";
import { enqueueRecalcBatchCosts } from "@/server/cost-queue";
import { lockBatches, lockProductionOperations } from "@/server/internal/finance-operations";
import {
  reverseActivePrisadkaOperation,
  reverseActiveUpakovkaOperation,
} from "@/server/internal/cost-flow-downstream";
import { reverseActiveTorcovkaStockInTx } from "@/server/internal/cost-flow-raw";
import { isCostFlowActive } from "@/server/internal/cost-flow-state";
import { maybeFreezeBatch } from "@/server/internal/cost";
import { reversePrisadkaLine, reverseUpakovkaOperation } from "@/server/internal/production-reversal";
import {
  assertTorcovkaBlankInventoryBoundary,
  blankSpecSortKey,
  preparePrisadkaReverse,
  prepareTorcovkaBlankMutation,
  type BlankSpec,
} from "@/server/internal/inventory-integrity";
import { operationEarning, operationRatesFromSnapshots } from "@/lib/payroll";
import { requireClientRequestId } from "@/lib/request-id";
import { assertPhysicalProductionDeleteAllowed } from "@/lib/production-physical-delete-policy";
import {
  PHYSICAL_QUANTITY_EDIT_REQUIRES_RETAINED_COMMAND,
  assertQuantityEditIntegers,
  computeQuantityEditStateFingerprint,
  normalizeTargetLineId,
  type ProductionQuantityEditInput,
  type QuantityEditResult,
} from "@/server/internal/production-quantity-edit";
import { editProductionOperationQuantityInTransaction } from "@/server/internal/production-quantity-edit-tx";
import {
  assertCorrectionCommandIntegers,
  canonicalCorrectionReason,
  correctionDeltaReturned,
  type CorrectTorcovkaRailsTakenResult,
} from "@/server/internal/production-operation-correction";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import { correctTorcovkaRailsTakenInTransaction } from "@/server/internal/correct-torcovka-rails-taken-tx";
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

type OpFull = Prisma.ProductionOperationGetPayload<{
  include: { lines: true; nomenclatureLines: true };
}>;

function requireTorcovkaBlankSpecs(lines: OpFull["lines"]): BlankSpec[] {
  return lines.map((l) => {
    if (
      l.blankLengthM == null ||
      l.blankType == null ||
      l.blankSort == null ||
      l.blankMaterialId == null
    ) {
      throw new Error("Строка торцовки без спецификации заготовки");
    }
    return {
      materialId: l.blankMaterialId,
      lengthM: l.blankLengthM,
      detailType: l.blankType,
      sort: l.blankSort,
    };
  });
}

interface RefMaps {
  employeeName: Map<string, string>;
  batchName: Map<string, string>;
  batchFrozenAt: Map<string, string | null>;
  lotLength: Map<string, number>;
  lotRemaining: Map<string, number>;
  productName: Map<string, string>;
  detail: Map<string, { name: string; sort: "SORT1" | "SORT2" }>;
  logs: Map<string, ProductionChangeLogEntry[]>;
}

function computeAmount(op: OpFull, maps: RefMaps): { quantity: number; amount: number } {
  return operationEarning({
    type: op.type,
    rates: operationRatesFromSnapshots(op),
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
          id: l.id,
          // Торцовка — заготовка (по длине), присадка — конкретная деталь.
          detailName: l.detailId
            ? (maps.detail.get(l.detailId)?.name ?? "—")
            : `Заготовка ${num(l.blankLengthM)} м`,
          quantity: l.quantity,
          prisadkaTorcevaya: l.prisadkaTorcevaya,
          prisadkaPloskost: l.prisadkaPloskost,
          editStateFingerprint: computeQuantityEditStateFingerprint({
            operationId: op.id,
            operationType: op.type,
            line: l,
          }),
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
    productQty: op.productQty ?? undefined,
    editStateFingerprint:
      op.type === "UPAKOVKA"
        ? computeQuantityEditStateFingerprint({
            operationId: op.id,
            operationType: op.type,
            productId: op.productId,
            productQty: op.productQty,
            lines: op.lines,
            nomenclatureLines: op.nomenclatureLines,
          })
        : undefined,
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
    include: { lines: true, nomenclatureLines: true },
    orderBy: { createdAt: "desc" },
  });
  const maps = await buildMaps(ops);
  return ops.map((op) => serializeRow(op, maps));
}

async function reloadRow(id: string): Promise<ProductionEntryRow> {
  const op = await prisma.productionOperation.findUniqueOrThrow({
    where: { id },
    include: { lines: true, nomenclatureLines: true },
  });
  const maps = await buildMaps([op]);
  return serializeRow(op, maps);
}

/**
 * HOURS quantity edit only. Physical A/B/C must use
 * `editProductionOperationQuantity` (stable target / CAS / requestId).
 */
export async function updateProductionLineQuantity(
  id: string,
  _lineIndex: number,
  newQty: number,
): Promise<ProductionEntryRow> {
  await requireAdmin();
  if (!(newQty > 0)) throw new Error("Количество должно быть положительным");

  const peek = await prisma.productionOperation.findUnique({
    where: { id },
    select: { id: true, type: true },
  });
  if (!peek) throw new Error("Операция не найдена");
  if (peek.type !== "HOURS") {
    throw new Error(PHYSICAL_QUANTITY_EDIT_REQUIRES_RETAINED_COMMAND);
  }

  await prisma.$transaction(async (tx) => {
    await lockProductionOperations(tx, [id]);
    const op = await tx.productionOperation.findUnique({ where: { id } });
    if (!op) throw new Error("Операция не найдена");
    if (op.isPaid) throw new Error("Нельзя изменить — операция уже выплачена");
    if (op.type !== "HOURS") {
      throw new Error(PHYSICAL_QUANTITY_EDIT_REQUIRES_RETAINED_COMMAND);
    }
    const old = num(op.hours);
    if (old === newQty) return;
    await tx.productionOperation.update({ where: { id }, data: { hours: newQty } });
    await writeChangeLog(
      {
        entity: "ProductionOperation",
        entityId: id,
        newValues: { field: "Количество", oldValue: old, newValue: newQty },
      },
      tx,
    );
  });
  revalidatePath(PATH);
  return reloadRow(id);
}

export async function editProductionOperationQuantity(
  input: ProductionQuantityEditInput,
): Promise<QuantityEditResult & { entry: ProductionEntryRow }> {
  const admin = await requireAdmin();
  const actor = userMovementActorFromAdmin(admin);
  const requestId = requireClientRequestId(input.requestId);
  const targetLineId = normalizeTargetLineId(input.targetLineId);
  assertQuantityEditIntegers({
    expectedOldQuantity: input.expectedOldQuantity,
    newQuantity: input.newQuantity,
  });

  let enqueueBatchId: string | null = null;
  let revalidateReports = false;
  const outcome: { value: QuantityEditResult | null } = { value: null };

  await prisma.$transaction(
    async (tx) => {
      const inner = await editProductionOperationQuantityInTransaction(tx, {
        actor,
        operationId: input.operationId,
        requestId,
        targetLineId,
        expectedOldQuantity: input.expectedOldQuantity,
        newQuantity: input.newQuantity,
        expectedStateFingerprint: input.expectedStateFingerprint,
      });
      outcome.value = inner.result;
      enqueueBatchId = inner.enqueueBatchId;
      revalidateReports = inner.revalidateReports;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 20_000,
      timeout: 20_000,
    },
  );

  if (!outcome.value) throw new Error("Правка количества не записана");
  if (enqueueBatchId) await enqueueRecalcBatchCosts(enqueueBatchId);
  revalidatePath(PATH);
  if (revalidateReports) revalidatePath("/reports");
  return { ...outcome.value, entry: await reloadRow(input.operationId) };
}

/**
 * Удаление операции до выплаты.
 *  - TORCOVKA / PRISADKA / UPAKOVKA: fail-closed reject after lock/load and
 *    before any physical reverse (`assertPhysicalProductionDeleteAllowed`).
 *    Unreachable TORCOVKA reverse code is left in place.
 *  - HOURS: hard-delete of the hours row (not physical).
 * Paid operations remain rejected by the paid guard.
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
    assertPhysicalProductionDeleteAllowed(op.type);

    if (op.type === "TORCOVKA") {
      const costFlowActive = await isCostFlowActive(tx);
      if (costFlowActive) {
        const specs = requireTorcovkaBlankSpecs(op.lines);
        await assertTorcovkaBlankInventoryBoundary(tx, op.createdAt, specs);
        await reverseActiveTorcovkaStockInTx({ tx, op });
        if (op.batchId) await lockBatches(tx, [op.batchId]);
      } else {
        if (op.batchId) await lockBatches(tx, [op.batchId]);
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
      }
    } else if (op.type === "PRISADKA") {
      if (await isCostFlowActive(tx)) {
        await reverseActivePrisadkaOperation(tx, op);
      } else {
        await preparePrisadkaReverse(tx, op.createdAt, op.lines);
        for (const l of op.lines) {
          await reversePrisadkaLine(tx, l);
        }
      }
    } else if (op.type === "UPAKOVKA") {
      if (!op.productId) throw new Error("У операции не указано изделие");
      if (await isCostFlowActive(tx)) {
        await reverseActiveUpakovkaOperation(tx, op);
      } else {
        await reverseUpakovkaOperation(
          tx,
          op.productId,
          op.productQty ?? 0,
          op.lines,
          op.nomenclatureLines,
          op.createdAt,
        );
      }
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

export type { CorrectTorcovkaRailsTakenResult };

export async function correctTorcovkaRailsTaken(input: {
  operationId: string;
  expectedOldRailsTaken: number;
  newRailsTaken: number;
  reason: string;
  requestId: string;
}): Promise<CorrectTorcovkaRailsTakenResult & { entry: ProductionEntryRow }> {
  const admin = await requireAdmin();
  const actor = userMovementActorFromAdmin(admin);
  const { operationId } = input;
  const requestId = requireClientRequestId(input.requestId);
  const reason = canonicalCorrectionReason(input.reason);
  if (!reason) throw new Error("Укажите причину исправления");
  assertCorrectionCommandIntegers({
    expectedOldRailsTaken: input.expectedOldRailsTaken,
    newRailsTaken: input.newRailsTaken,
  });
  const expectedOldRailsTaken = input.expectedOldRailsTaken;
  const newRailsTaken = input.newRailsTaken;
  const deltaReturned = correctionDeltaReturned(expectedOldRailsTaken, newRailsTaken);

  let enqueueBatchId: string | null = null;
  const outcome: { value: CorrectTorcovkaRailsTakenResult | null } = { value: null };

  await prisma.$transaction(
    async (tx) => {
      const inner = await correctTorcovkaRailsTakenInTransaction(tx, {
        actor,
        operationId,
        requestId,
        expectedOldRailsTaken,
        newRailsTaken,
        deltaReturned,
        reason,
      });
      outcome.value = inner.result;
      enqueueBatchId = inner.enqueueBatchId;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 20_000,
      timeout: 20_000,
    },
  );

  if (!outcome.value) throw new Error("Исправление реек не записано");
  if (enqueueBatchId) await enqueueRecalcBatchCosts(enqueueBatchId);

  revalidatePath(PATH);
  revalidatePath("/reports");
  revalidatePath("/purchases");
  revalidatePath("/", "layout");
  return { ...outcome.value, entry: await reloadRow(operationId) };
}
