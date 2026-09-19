import type { Prisma } from "@prisma/client";
import { writeChangeLog } from "@/server/change-log";
import { D } from "@/lib/cost";
import {
  approvalCodeMatches,
  approvalHmacSecret,
  parseApprovalCode,
  TORCOVKA_APPROVAL_CONSUMED_ORPHAN,
  TORCOVKA_APPROVAL_MAX_ATTEMPTS,
  TORCOVKA_WRONG_CODE_MESSAGE,
} from "@/lib/torcovka-approval";
import {
  computeTorcovkaWasteMetrics,
  decideTorcovkaSubmit,
  type TorcovkaPlausibilityAck,
} from "@/lib/torcovka-plausibility";
import { archiveBatchIfDepleted } from "@/server/internal/cost";
import { applyActiveTorcovkaInTx } from "@/server/internal/cost-flow-raw";
import { isCostFlowActive } from "@/server/internal/cost-flow-state";
import { blankSpecSortKey } from "@/server/internal/inventory-integrity";
import {
  canonicalLengthDecimal,
  canonicalizeTorcovkaPicks,
  torcovkaPicksForLog,
} from "@/server/internal/blank-length";
import { lockRailLots } from "@/server/internal/finance-operations";
import type { MovementActorSnapshot } from "@/server/internal/inventory-movement-actor";
import { isInventoryMovementShadowWriteActiveForWriter } from "@/server/internal/inventory-movement-shadow-write";
import { planProductionShadowMovements } from "@/server/internal/production-movement-plan";
import { appendProductionShadowMovements } from "@/server/internal/production-shadow-write";
import {
  loadRetainedProductionOperation,
  lockAndReadRateSnapshots,
  snapshotFieldsForLog,
} from "@/server/internal/production-terminal-shared";
import { updateEventMessage } from "@/server/internal/notification-event";
import {
  approvalSnapshotDiffers,
  invalidateTorcovkaApprovalIfNotNeeded,
  lockTorcovkaApprovalByClientRequestId,
  TORCOVKA_APPROVAL_REDACT_USED,
  type TorcovkaApprovalSnapshot,
} from "@/server/internal/torcovka-approval";

export type TorcovkaTxResult =
  | { status: "CREATED_NEW" }
  | { status: "IDEMPOTENT_REPLAY" }
  | {
      status: "ACK_REQUIRED";
      band: "SUSPICIOUS";
      railsTaken: number;
      takenM: string;
      producedM: string;
      wastePct: string;
    }
  | { status: "APPROVAL_NEEDED"; snapshot: TorcovkaApprovalSnapshot }
  | { status: "WRONG_CODE"; failedAttempts: number; snapshot: TorcovkaApprovalSnapshot }
  | { status: "EXPIRED"; snapshot: TorcovkaApprovalSnapshot }
  | { status: "METRICS_CHANGED"; snapshot: TorcovkaApprovalSnapshot };

export type SubmitTorcovkaTxInput = {
  actor: MovementActorSnapshot;
  employeeId: string;
  clientRequestId: string;
  batchId: string;
  railLotId: string;
  railsTaken: number;
  picks: ReturnType<typeof canonicalizeTorcovkaPicks>;
  plausibilityAck: TorcovkaPlausibilityAck | undefined;
  code: ReturnType<typeof parseApprovalCode>;
};

function approvalSnapshotFromMetrics(
  clientRequestId: string,
  employeeId: string,
  batchId: string,
  railLotId: string,
  railsTaken: number,
  metrics: ReturnType<typeof computeTorcovkaWasteMetrics>,
): TorcovkaApprovalSnapshot {
  return {
    clientRequestId,
    employeeId,
    batchId,
    railLotId,
    railsTaken,
    takenM: metrics.canon.takenM,
    producedM: metrics.canon.producedM,
    wasteM: metrics.canon.wasteM,
    wastePct: metrics.canon.wastePct,
  };
}

export async function submitTorcovkaInTransaction(
  tx: Prisma.TransactionClient,
  input: SubmitTorcovkaTxInput,
): Promise<TorcovkaTxResult> {
  const {
    actor,
    employeeId,
    clientRequestId,
    batchId,
    railLotId,
    railsTaken,
    picks,
    plausibilityAck,
    code,
  } = input;

  const shadowWriteActive = await isInventoryMovementShadowWriteActiveForWriter(tx);
  const existingBeforeLock = await tx.productionOperation.findUnique({
    where: { clientRequestId },
    select: { id: true, employeeId: true },
  });
  if (existingBeforeLock) {
    await invalidateTorcovkaApprovalIfNotNeeded(tx, clientRequestId, existingBeforeLock.employeeId, {
      committedOpExists: true,
    });
    return { status: "IDEMPOTENT_REPLAY" as const };
  }

  await lockRailLots(tx, [railLotId]);
  const existingAfterLock = await tx.productionOperation.findUnique({
    where: { clientRequestId },
    select: { id: true, employeeId: true },
  });
  if (existingAfterLock) {
    await invalidateTorcovkaApprovalIfNotNeeded(tx, clientRequestId, existingAfterLock.employeeId, {
      committedOpExists: true,
    });
    return { status: "IDEMPOTENT_REPLAY" as const };
  }
  const lot = await tx.railLot.findUnique({ where: { id: railLotId } });
  if (!lot || lot.batchId !== batchId) throw new Error("Пакет реек не найден");
  const batch = await tx.batch.findUniqueOrThrow({ where: { id: batchId } });
  const materialId = batch.materialId;

  for (const p of picks) {
    if (D(p.lengthM).gt(D(lot.lengthM))) {
      throw new Error("Длина заготовки превышает длину рейки пакета");
    }
  }

  const metrics = computeTorcovkaWasteMetrics(railsTaken, lot.lengthM, picks);
  if (metrics.producedM.gt(metrics.takenM)) {
    throw new Error("Суммарная длина заготовок превышает длину взятых реек");
  }

  const snapshot = approvalSnapshotFromMetrics(
    clientRequestId,
    employeeId,
    batchId,
    railLotId,
    railsTaken,
    metrics,
  );

  const decision = decideTorcovkaSubmit({
    railsTaken,
    metrics,
    ack: plausibilityAck,
  });

  if (decision.status === "ACK_REQUIRED" && decision.band === "SUSPICIOUS") {
    return {
      status: "ACK_REQUIRED" as const,
      band: "SUSPICIOUS" as const,
      railsTaken: decision.railsTaken,
      takenM: decision.takenM,
      producedM: decision.producedM,
      wastePct: decision.wastePct,
    };
  }

  let persist = decision.status === "CREATED" ? decision.persist : null;
  let approvalMeta: {
    approvalId: string;
    generation: number;
    consumedAt: Date;
  } | null = null;

  if (decision.status === "ACK_REQUIRED" && decision.band === "EXTREME") {
    if (code === null) {
      return { status: "APPROVAL_NEEDED" as const, snapshot };
    }

    await lockTorcovkaApprovalByClientRequestId(tx, clientRequestId);
    const approval = await tx.torcovkaApproval.findUnique({
      where: { clientRequestId },
    });
    if (!approval) {
      return { status: "EXPIRED" as const, snapshot };
    }
    if (approval.consumedAt) {
      throw new Error(TORCOVKA_APPROVAL_CONSUMED_ORPHAN);
    }
    if (approval.employeeId !== employeeId) {
      throw new Error(TORCOVKA_WRONG_CODE_MESSAGE);
    }
    const now = new Date();
    if (approval.expiresAt <= now) {
      return { status: "EXPIRED" as const, snapshot };
    }
    if (approval.failedAttempts >= TORCOVKA_APPROVAL_MAX_ATTEMPTS) {
      return { status: "EXPIRED" as const, snapshot };
    }
    if (approvalSnapshotDiffers(approval, snapshot)) {
      return { status: "METRICS_CHANGED" as const, snapshot };
    }
    if (!approvalCodeMatches(code, approval.codeHash, approvalHmacSecret())) {
      const updated = await tx.torcovkaApproval.update({
        where: { clientRequestId },
        data: { failedAttempts: { increment: 1 } },
      });
      return {
        status: "WRONG_CODE" as const,
        failedAttempts: updated.failedAttempts,
        snapshot,
      };
    }

    const verified = decideTorcovkaSubmit({
      railsTaken,
      metrics,
      approvalVerified: true,
    });
    if (verified.status !== "CREATED") {
      throw new Error("Не удалось подтвердить высокий отход");
    }
    persist = verified.persist;
    const consumedAt = now;
    await tx.torcovkaApproval.update({
      where: { clientRequestId },
      data: { consumedAt },
    });
    await updateEventMessage(approval.notificationKey, TORCOVKA_APPROVAL_REDACT_USED, tx);
    approvalMeta = {
      approvalId: approval.id,
      generation: approval.generation,
      consumedAt,
    };
  }

  if (!persist) {
    throw new Error("Неверный тип подтверждения отхода");
  }

  if (!approvalMeta) {
    await invalidateTorcovkaApprovalIfNotNeeded(tx, clientRequestId, employeeId);
  }

  const rateSnapshots = await lockAndReadRateSnapshots(tx, employeeId);
  const costFlowActive = await isCostFlowActive(tx);
  const occurredAt = new Date();

  let opId: string;
  if (costFlowActive) {
    const created = await applyActiveTorcovkaInTx({
      tx,
      employeeId,
      clientRequestId,
      batchId,
      railLotId,
      railsTaken,
      picks,
      persist,
      rateSnapshots,
      occurredAt,
      lot,
      materialId,
    });
    opId = created.opId;
  } else {
    const dec = await tx.railLot.updateMany({
      where: { id: railLotId, batchId, remainingQuantity: { gte: railsTaken } },
      data: { remainingQuantity: { decrement: railsTaken } },
    });
    if (dec.count === 0) throw new Error("Недостаточно реек в пакете");

    const op = await tx.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId,
        clientRequestId,
        batchId,
        railLotId,
        railsTaken,
        torcovkaSubmitAckBand: persist.torcovkaSubmitAckBand,
        torcovkaSubmitWasteReason: persist.torcovkaSubmitWasteReason,
        torcovkaSubmitWasteNote: persist.torcovkaSubmitWasteNote,
        workDate: occurredAt,
        ...rateSnapshots,
        lines: {
          create: picks.map((p) => ({
            quantity: p.quantity,
            blankLengthM: canonicalLengthDecimal(p.lengthMFixed4),
            blankType: lot.railType,
            blankSort: p.sort,
            blankMaterialId: materialId,
          })),
        },
      },
    });
    opId = op.id;

    const sortedBlankPicks = [...picks].sort((a, b) =>
      blankSpecSortKey({
        materialId,
        lengthM: a.lengthM,
        detailType: lot.railType,
        sort: a.sort,
      }).localeCompare(
        blankSpecSortKey({
          materialId,
          lengthM: b.lengthM,
          detailType: lot.railType,
          sort: b.sort,
        }),
      ),
    );
    for (const p of sortedBlankPicks) {
      const lengthM = canonicalLengthDecimal(p.lengthMFixed4);
      await tx.blankStock.upsert({
        where: {
          materialId_lengthM_detailType_sort: {
            materialId,
            lengthM,
            detailType: lot.railType,
            sort: p.sort,
          },
        },
        create: {
          materialId,
          lengthM,
          detailType: lot.railType,
          sort: p.sort,
          quantity: p.quantity,
        },
        update: { quantity: { increment: p.quantity } },
      });
    }
  }

  const retained = await loadRetainedProductionOperation(tx, opId);
  const plan = planProductionShadowMovements({ kind: "TORCOVKA", operation: retained });
  await appendProductionShadowMovements(tx, {
    shadowWriteActive,
    actor,
    occurredAt,
    operationId: retained.id,
    plan,
  });

  const changeLogValues: Record<string, unknown> = {
    type: "TORCOVKA",
    batchId,
    railLotId,
    railsTaken,
    picks: torcovkaPicksForLog(picks),
    ...snapshotFieldsForLog(rateSnapshots),
  };
  if (approvalMeta) {
    changeLogValues.approvalRequired = true;
    changeLogValues.approvalId = approvalMeta.approvalId;
    changeLogValues.generation = approvalMeta.generation;
    changeLogValues.consumedAt = approvalMeta.consumedAt.toISOString();
    changeLogValues.takenM = snapshot.takenM;
    changeLogValues.producedM = snapshot.producedM;
    changeLogValues.wasteM = snapshot.wasteM;
    changeLogValues.wastePct = snapshot.wastePct;
  }

  await writeChangeLog(
    {
      entity: "ProductionOperation",
      entityId: opId,
      newValues: changeLogValues,
    },
    tx,
  );

  if (!approvalMeta) {
    await invalidateTorcovkaApprovalIfNotNeeded(tx, clientRequestId, employeeId);
  }

  await archiveBatchIfDepleted(tx, batchId);
  return { status: "CREATED_NEW" as const };
}
