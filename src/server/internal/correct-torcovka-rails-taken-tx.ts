import { Prisma } from "@prisma/client";
import { writeChangeLog } from "@/server/change-log";
import { D } from "@/lib/cost";
import { lockBatches, lockProductionOperations, lockRailLots } from "@/server/internal/finance-operations";
import { correctActiveTorcovkaRailsTakenInTx } from "@/server/internal/cost-flow-raw";
import { isCostFlowActive } from "@/server/internal/cost-flow-state";
import {
  assertTorcovkaBlankInventoryBoundary,
  type BlankSpec,
} from "@/server/internal/inventory-integrity";
import type { MovementActorSnapshot } from "@/server/internal/inventory-movement-actor";
import { isInventoryMovementShadowWriteActiveForWriter } from "@/server/internal/inventory-movement-shadow-write";
import {
  STALE_CORRECTION,
  acquireCorrectionRequestLock,
  assertCorrectionPayloadMatch,
  correctionResultFromRow,
  type CorrectTorcovkaRailsTakenResult,
} from "@/server/internal/production-operation-correction";
import { appendR05CorrectionShadowMovement } from "@/server/internal/r05-correction-shadow-write";

type OpFull = Prisma.ProductionOperationGetPayload<{ include: { lines: true } }>;

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

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

function requireUserActor(
  actor: MovementActorSnapshot,
): Extract<MovementActorSnapshot, { actorKind: "USER" }> {
  if (actor.actorKind !== "USER") {
    throw new Error("R-05 correction requires a retained USER actor");
  }
  return actor;
}

export type CorrectTorcovkaRailsTakenTxInput = {
  actor: MovementActorSnapshot;
  operationId: string;
  requestId: string;
  expectedOldRailsTaken: number;
  newRailsTaken: number;
  deltaReturned: number;
  reason: string;
};

export type CorrectTorcovkaRailsTakenTxOutcome = {
  result: CorrectTorcovkaRailsTakenResult;
  enqueueBatchId: string | null;
};

/**
 * Physical R-05 TORCOVKA railsTaken correction TX body.
 * Caller opens READ COMMITTED and captures the USER actor outside this helper.
 */
export async function correctTorcovkaRailsTakenInTransaction(
  tx: Prisma.TransactionClient,
  input: CorrectTorcovkaRailsTakenTxInput,
): Promise<CorrectTorcovkaRailsTakenTxOutcome> {
  const actor = requireUserActor(input.actor);
  const {
    operationId,
    requestId,
    expectedOldRailsTaken,
    newRailsTaken,
    deltaReturned,
    reason,
  } = input;
  const command = {
    operationId,
    adminUserId: actor.userId,
    expectedOldRailsTaken,
    newRailsTaken,
    reason,
  };

  const shadowWriteActive = await isInventoryMovementShadowWriteActiveForWriter(tx);
  await acquireCorrectionRequestLock(tx, requestId);

  const applyExisting = (existing: {
    id: string;
    requestId: string;
    operationId: string;
    adminUserId: string;
    expectedOldRailsTaken: number;
    newRailsTaken: number;
    deltaReturned: number;
    reason: string;
    recordedAt: Date;
  }): CorrectTorcovkaRailsTakenTxOutcome => {
    assertCorrectionPayloadMatch(
      {
        operationId: existing.operationId,
        adminUserId: existing.adminUserId,
        expectedOldRailsTaken: existing.expectedOldRailsTaken,
        newRailsTaken: existing.newRailsTaken,
        reason: existing.reason,
      },
      command,
    );
    return { result: correctionResultFromRow(existing, true), enqueueBatchId: null };
  };

  const existing = await tx.productionOperationCorrection.findUnique({
    where: { requestId },
  });
  if (existing) {
    return applyExisting(existing);
  }

  await lockProductionOperations(tx, [operationId]);

  const raced = await tx.productionOperationCorrection.findUnique({
    where: { requestId },
  });
  if (raced) {
    return applyExisting(raced);
  }

  const op = await tx.productionOperation.findUnique({
    where: { id: operationId },
    include: { lines: true },
  });
  if (!op) throw new Error("Операция не найдена");
  if (op.type !== "TORCOVKA") throw new Error("Исправление реек доступно только для торцовки");
  if (!op.railLotId || !op.batchId || op.railsTaken == null) {
    throw new Error("У операции не указаны пакет и количество реек");
  }
  if (op.isPaid) throw new Error("Нельзя исправить — операция уже выплачена");
  if (op.railsTaken !== expectedOldRailsTaken) {
    throw new Error(STALE_CORRECTION);
  }

  const persistCorrection = async () =>
    tx.productionOperationCorrection.create({
      data: {
        requestId,
        operationId,
        adminUserId: actor.userId,
        railLotId: op.railLotId!,
        batchId: op.batchId!,
        expectedOldRailsTaken,
        newRailsTaken,
        deltaReturned,
        reason,
      },
    });

  const costFlowActive = await isCostFlowActive(tx);
  if (costFlowActive) {
    await lockRailLots(tx, [op.railLotId]);
    const lot = await tx.railLot.findUnique({ where: { id: op.railLotId } });
    if (!lot) throw new Error("Пакет реек не найден");
    const producedM = op.lines.reduce(
      (sum, l) => sum.plus(D(num(l.blankLengthM)).times(l.quantity)),
      D(0),
    );
    const newTakenM = D(newRailsTaken).times(D(lot.lengthM));
    if (producedM.gt(newTakenM)) {
      throw new Error("Суммарная длина заготовок превышает длину взятых реек");
    }
    const batchPeek = await tx.batch.findUnique({ where: { id: op.batchId } });
    if (!batchPeek) throw new Error("Партия не найдена");
    if (batchPeek.frozenAt != null) {
      throw new Error("Нельзя исправить — себестоимость партии заморожена");
    }
    await assertTorcovkaBlankInventoryBoundary(tx, op.createdAt, requireTorcovkaBlankSpecs(op.lines));
    const row = await persistCorrection();
    await correctActiveTorcovkaRailsTakenInTx({
      tx,
      op: { ...op, railsTaken: expectedOldRailsTaken },
      lot,
      newRailsTaken,
    });
    await lockBatches(tx, [op.batchId]);
    const batch = await tx.batch.findUnique({ where: { id: op.batchId } });
    if (!batch) throw new Error("Партия не найдена");
    if (batch.frozenAt != null) {
      throw new Error("Нельзя исправить — себестоимость партии заморожена");
    }
    await appendR05CorrectionShadowMovement(tx, {
      shadowWriteActive,
      actor,
      correction: row,
    });
    await writeChangeLog(
      {
        entity: "ProductionOperation",
        entityId: operationId,
        userId: actor.userId,
        newValues: {
          field: "railsTaken",
          oldRailsTaken: expectedOldRailsTaken,
          newRailsTaken,
          deltaReturned,
          reason,
          correctionId: row.id,
          requestId,
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
          userId: actor.userId,
          newValues: { reopened: true, viaOperationId: operationId, correctionId: row.id },
        },
        tx,
      );
    }
    return { result: correctionResultFromRow(row, false), enqueueBatchId: op.batchId };
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

  await assertTorcovkaBlankInventoryBoundary(tx, op.createdAt, requireTorcovkaBlankSpecs(op.lines));

  const row = await persistCorrection();

  await tx.railLot.update({
    where: { id: op.railLotId },
    data: { remainingQuantity: { increment: deltaReturned } },
  });
  await tx.productionOperation.update({
    where: { id: operationId },
    data: { railsTaken: newRailsTaken },
  });
  await appendR05CorrectionShadowMovement(tx, {
    shadowWriteActive,
    actor,
    correction: row,
  });
  await writeChangeLog(
    {
      entity: "ProductionOperation",
      entityId: operationId,
      userId: actor.userId,
      newValues: {
        field: "railsTaken",
        oldRailsTaken: expectedOldRailsTaken,
        newRailsTaken,
        deltaReturned,
        reason,
        correctionId: row.id,
        requestId,
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
        userId: actor.userId,
        newValues: { reopened: true, viaOperationId: operationId, correctionId: row.id },
      },
      tx,
    );
  }

  return { result: correctionResultFromRow(row, false), enqueueBatchId: op.batchId };
}
