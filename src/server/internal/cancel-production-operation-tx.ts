import { Prisma } from "@prisma/client";
import { writeChangeLog } from "@/server/change-log";
import { cancelActiveTorcovkaOperationInTx } from "@/server/internal/cost-flow-raw";
import {
  reverseActivePrisadkaOperation,
  reverseActiveUpakovkaOperation,
} from "@/server/internal/cost-flow-downstream";
import { isCostFlowActive } from "@/server/internal/cost-flow-state";
import { lockBatches, lockProductionOperations, lockRailLots } from "@/server/internal/finance-operations";
import type { MovementActorSnapshot } from "@/server/internal/inventory-movement-actor";
import type { MovementEffect } from "@/server/internal/inventory-movement-identity";
import {
  assertTorcovkaBlankInventoryBoundary,
  blankSpecSortKey,
  preparePrisadkaReverse,
  prepareTorcovkaBlankMutation,
  type BlankSpec,
} from "@/server/internal/inventory-integrity";
import { isInventoryMovementShadowWriteActiveForWriter } from "@/server/internal/inventory-movement-shadow-write";
import { reversePrisadkaLine, reverseUpakovkaOperation } from "@/server/internal/production-reversal";
import { appendCancellationShadowMovements } from "@/server/internal/production-operation-cancel-shadow";
import {
  CANCEL_ALREADY,
  CANCEL_DOWNSTREAM_BLOCKED,
  CANCEL_FROZEN_BLOCKED,
  CANCEL_PAID_BLOCKED,
  CANCEL_REQUEST_ID_REUSE,
  STALE_OPERATION_CANCEL,
  assertCancellationPayloadMatch,
  assertSupportedCancelType,
  canonicalCancelReason,
  productionCancelFingerprint,
  type CancelCommandPayload,
} from "@/lib/production-operation-cancel";

export const CANCEL_REQUEST_LOCK_NAMESPACE = 8327;

type OpFull = Prisma.ProductionOperationGetPayload<{
  include: { lines: true; nomenclatureLines: true };
}>;

export type CancelProductionOperationTxInput = {
  actor: MovementActorSnapshot;
  adminUserId: string;
  operationId: string;
  requestId: string;
  reason: string;
  expectedStateFingerprint: string;
};

export type CancelProductionOperationTxOutcome = {
  replayed: boolean;
  cancellationId: string;
  enqueueBatchId: string | null;
};

function num(value: Prisma.Decimal | number | null): string | null {
  if (value == null) return null;
  return typeof value === "object" && "toString" in value ? value.toString() : String(value);
}

function fingerprintOf(op: OpFull): string {
  return productionCancelFingerprint({
    operationId: op.id,
    type: op.type,
    isPaid: op.isPaid,
    cancelledAt: op.cancelledAt ? op.cancelledAt.toISOString() : null,
    railsTaken: op.railsTaken,
    hours: num(op.hours),
    productQty: op.productQty,
    lines: op.lines.map((line) => ({ id: line.id, quantity: line.quantity })),
  });
}

async function acquireCancelRequestLock(tx: Prisma.TransactionClient, requestId: string): Promise<void> {
  if (typeof (tx as { $transaction?: unknown }).$transaction === "function") {
    throw new Error("Cancel request lock requires an open Prisma transaction client.");
  }
  await tx.$queryRaw`
    SELECT 1 AS acquired
    FROM (
      SELECT pg_advisory_xact_lock(
        ${CANCEL_REQUEST_LOCK_NAMESPACE}::integer,
        hashtext(${requestId})
      )
    ) AS cancel_request_lock
  `;
}

function requireTorcovkaSpecs(lines: OpFull["lines"]): BlankSpec[] {
  return lines.map((line) => {
    if (
      line.blankLengthM == null ||
      line.blankType == null ||
      line.blankSort == null ||
      line.blankMaterialId == null
    ) {
      throw new Error("Строка торцовки без спецификации заготовки");
    }
    return {
      materialId: line.blankMaterialId,
      lengthM: line.blankLengthM,
      detailType: line.blankType,
      sort: line.blankSort,
    };
  });
}

function blankEffect(line: OpFull["lines"][number], quantityDelta: number, qualifier: string): MovementEffect {
  if (
    line.blankLengthM == null ||
    line.blankType == null ||
    line.blankSort == null ||
    line.blankMaterialId == null
  ) {
    throw new Error("Нет спецификации заготовки для возврата");
  }
  return {
    role: "adjust",
    kind: "ADJUSTMENT",
    quantityDelta,
    qualifier,
    target: {
      stockDomain: "BLANK",
      materialId: line.blankMaterialId,
      lengthM: line.blankLengthM,
      detailType: line.blankType,
      sort: line.blankSort,
    },
  };
}

function prisadkaDest(line: OpFull["lines"][number]): { torcevayaDone: boolean; ploskostDone: boolean } {
  const kind = line.prisadkaTorcevaya ? "torcev" : "plosk";
  return {
    torcevayaDone: line.sourceIsBlank ? kind === "torcev" : kind === "torcev" ? true : line.sourceTorcevayaDone,
    ploskostDone: line.sourceIsBlank ? kind === "plosk" : kind === "plosk" ? true : line.sourcePloskostDone,
  };
}

function shadowEffects(op: OpFull): MovementEffect[] {
  const effects: MovementEffect[] = [];
  if (op.type === "HOURS") return effects;
  if (op.type === "TORCOVKA") {
    if (op.railLotId == null || op.railsTaken == null) {
      throw new Error("У операции не указаны пакет и количество реек");
    }
    effects.push({
      role: "adjust",
      kind: "ADJUSTMENT",
      quantityDelta: op.railsTaken,
      qualifier: "rail",
      target: { stockDomain: "RAIL_LOT", railLotId: op.railLotId },
    });
    for (const line of op.lines) {
      if (line.quantity === 0) continue;
      effects.push(blankEffect(line, -line.quantity, `blank:${line.id}`));
    }
    return effects;
  }
  if (op.type === "PRISADKA") {
    for (const line of op.lines) {
      if (!line.detailId || line.quantity === 0) continue;
      const dest = prisadkaDest(line);
      effects.push({
        role: "adjust",
        kind: "ADJUSTMENT",
        quantityDelta: -line.quantity,
        qualifier: `dest:${line.id}`,
        target: {
          stockDomain: "DETAIL",
          detailId: line.detailId,
          torcevayaDone: dest.torcevayaDone,
          ploskostDone: dest.ploskostDone,
        },
      });
      if (line.sourceIsBlank) {
        effects.push(blankEffect(line, line.quantity, `src:${line.id}`));
      } else {
        effects.push({
          role: "adjust",
          kind: "ADJUSTMENT",
          quantityDelta: line.quantity,
          qualifier: `src:${line.id}`,
          target: {
            stockDomain: "DETAIL",
            detailId: line.detailId,
            torcevayaDone: line.sourceTorcevayaDone,
            ploskostDone: line.sourcePloskostDone,
          },
        });
      }
    }
    return effects;
  }
  if (op.productId != null && op.productQty != null && op.productQty !== 0) {
    effects.push({
      role: "adjust",
      kind: "ADJUSTMENT",
      quantityDelta: -op.productQty,
      qualifier: "product",
      target: { stockDomain: "PRODUCT", productId: op.productId },
    });
  }
  for (const line of op.lines) {
    if (line.quantity === 0) continue;
    if (line.sourceIsBlank) {
      effects.push(blankEffect(line, line.quantity, `src:${line.id}`));
      continue;
    }
    if (!line.detailId) throw new Error("Строка упаковки без детали");
    effects.push({
      role: "adjust",
      kind: "ADJUSTMENT",
      quantityDelta: line.quantity,
      qualifier: `src:${line.id}`,
      target: {
        stockDomain: "DETAIL",
        detailId: line.detailId,
        torcevayaDone: line.sourceTorcevayaDone,
        ploskostDone: line.sourcePloskostDone,
      },
    });
  }
  for (const line of op.nomenclatureLines) {
    if (line.quantity === 0) continue;
    effects.push({
      role: "adjust",
      kind: "ADJUSTMENT",
      quantityDelta: line.quantity,
      qualifier: `nom:${line.id}`,
      target: { stockDomain: "NOMENCLATURE", nomenclatureId: line.nomenclatureId },
    });
  }
  return effects;
}

async function reversePhysical(
  tx: Prisma.TransactionClient,
  op: OpFull,
  costFlowActive: boolean,
): Promise<void> {
  if (op.type === "HOURS") return;
  if (op.type === "TORCOVKA") {
    if (!op.railLotId || op.railsTaken == null) {
      throw new Error("У операции не указаны пакет и количество реек");
    }
    await lockRailLots(tx, [op.railLotId]);
    const lot = await tx.railLot.findUnique({ where: { id: op.railLotId } });
    if (!lot) throw new Error("Пакет реек не найден");
    const specs = requireTorcovkaSpecs(op.lines);
    if (costFlowActive) {
      await assertTorcovkaBlankInventoryBoundary(tx, op.createdAt, specs);
      await cancelActiveTorcovkaOperationInTx({ tx, op, lot });
      return;
    }
    if (lot.remainingValue != null || op.consumedRawValue != null) {
      throw new Error(
        "Денежный учёт выключен, но у торцовки есть денежный снимок. Аннулирование заблокировано.",
      );
    }
    if (lot.remainingQuantity + op.railsTaken > lot.quantity) {
      throw new Error("Нельзя аннулировать: остаток пакета не сходится с этой торцовкой.");
    }
    await prepareTorcovkaBlankMutation(tx, op.createdAt, specs);
    const sorted = [...op.lines].sort((a, b) =>
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
    for (const line of sorted) {
      const dec = await tx.blankStock.updateMany({
        where: {
          materialId: line.blankMaterialId!,
          lengthM: line.blankLengthM!,
          detailType: line.blankType!,
          sort: line.blankSort!,
          quantity: { gte: line.quantity },
        },
        data: { quantity: { decrement: line.quantity } },
      });
      if (dec.count === 0) throw new Error(CANCEL_DOWNSTREAM_BLOCKED);
    }
    await tx.railLot.update({
      where: { id: lot.id },
      data: { remainingQuantity: { increment: op.railsTaken } },
    });
    return;
  }
  if (op.type === "PRISADKA") {
    if (costFlowActive) {
      await reverseActivePrisadkaOperation(tx, op);
      return;
    }
    await preparePrisadkaReverse(tx, op.createdAt, op.lines);
    for (const line of op.lines) await reversePrisadkaLine(tx, line);
    return;
  }
  if (!op.productId) throw new Error("У операции не указано изделие");
  if (costFlowActive) {
    await reverseActiveUpakovkaOperation(tx, op);
    return;
  }
  await reverseUpakovkaOperation(
    tx,
    op.productId,
    op.productQty ?? 0,
    op.lines,
    op.nomenclatureLines,
    op.createdAt,
  );
}

export async function cancelProductionOperationInTransaction(
  tx: Prisma.TransactionClient,
  input: CancelProductionOperationTxInput,
): Promise<CancelProductionOperationTxOutcome> {
  const reason = canonicalCancelReason(input.reason);
  const shadowWriteActive = await isInventoryMovementShadowWriteActiveForWriter(tx);
  await acquireCancelRequestLock(tx, input.requestId);
  const payload: CancelCommandPayload = {
    operationId: input.operationId,
    adminUserId: input.adminUserId,
    reason,
    expectedStateFingerprint: input.expectedStateFingerprint,
  };
  const existing = await tx.productionOperationCancellation.findUnique({
    where: { requestId: input.requestId },
  });
  if (existing) {
    assertCancellationPayloadMatch(
      {
        operationId: existing.operationId,
        adminUserId: existing.adminUserId,
        reason: existing.reason,
        expectedStateFingerprint: existing.expectedStateFingerprint,
      },
      payload,
    );
    return { replayed: true, cancellationId: existing.id, enqueueBatchId: null };
  }

  await lockProductionOperations(tx, [input.operationId]);
  const raced = await tx.productionOperationCancellation.findUnique({
    where: { requestId: input.requestId },
  });
  if (raced) {
    assertCancellationPayloadMatch(
      {
        operationId: raced.operationId,
        adminUserId: raced.adminUserId,
        reason: raced.reason,
        expectedStateFingerprint: raced.expectedStateFingerprint,
      },
      payload,
    );
    return { replayed: true, cancellationId: raced.id, enqueueBatchId: null };
  }

  const op = await tx.productionOperation.findUnique({
    where: { id: input.operationId },
    include: { lines: true, nomenclatureLines: true },
  });
  if (!op) throw new Error("Операция не найдена");
  assertSupportedCancelType(op.type);
  if (op.isPaid) throw new Error(CANCEL_PAID_BLOCKED);
  if (op.cancelledAt) throw new Error(CANCEL_ALREADY);
  if (fingerprintOf(op) !== input.expectedStateFingerprint) throw new Error(STALE_OPERATION_CANCEL);
  if (op.batchId) {
    await lockBatches(tx, [op.batchId]);
    const batch = await tx.batch.findUnique({ where: { id: op.batchId }, select: { frozenAt: true } });
    if (batch?.frozenAt) throw new Error(CANCEL_FROZEN_BLOCKED);
  }

  const other = await tx.productionOperationCancellation.findUnique({
    where: { operationId: op.id },
  });
  if (other) throw new Error(CANCEL_REQUEST_ID_REUSE);

  const effects = shadowEffects(op);
  const costFlowActive = await isCostFlowActive(tx);
  await reversePhysical(tx, op, costFlowActive);
  await tx.productionOperation.update({
    where: { id: op.id },
    data: { cancelledAt: new Date() },
  });
  const cancellation = await tx.productionOperationCancellation.create({
    data: {
      requestId: input.requestId,
      operationId: op.id,
      adminUserId: input.adminUserId,
      operationType: op.type,
      reason,
      expectedStateFingerprint: input.expectedStateFingerprint,
      effectSnapshot: {
        v: 1,
        type: op.type,
        railsTaken: op.railsTaken,
        hours: num(op.hours),
        productQty: op.productQty,
        lines: op.lines.map((line) => ({ id: line.id, quantity: line.quantity })),
      } as Prisma.InputJsonValue,
    },
  });
  await appendCancellationShadowMovements(tx, {
    shadowWriteActive,
    actor: input.actor,
    cancellation: {
      id: cancellation.id,
      requestId: cancellation.requestId,
      adminUserId: cancellation.adminUserId,
      operationId: cancellation.operationId,
      recordedAt: cancellation.recordedAt,
      reason,
    },
    effects,
  });
  await writeChangeLog(
    {
      entity: "ProductionOperation",
      entityId: op.id,
      userId: input.adminUserId,
      oldValues: {
        type: op.type,
        cancelledAt: null,
        railsTaken: op.railsTaken,
        hours: num(op.hours),
        productQty: op.productQty,
        lines: op.lines.map((line) => ({ id: line.id, quantity: line.quantity })),
      },
      newValues: {
        field: "Аннулирование",
        oldValue: "в учёте",
        newValue: reason,
        cancelledAt: cancellation.recordedAt.toISOString(),
        reason,
        requestId: input.requestId,
        commandId: cancellation.id,
      },
    },
    tx,
  );
  return { replayed: false, cancellationId: cancellation.id, enqueueBatchId: op.batchId };
}
