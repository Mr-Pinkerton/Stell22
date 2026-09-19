import { Prisma } from "@prisma/client";
import {
  movementActorColumns,
  type MovementActorSnapshot,
} from "@/server/internal/inventory-movement-actor";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
  type MovementEffect,
} from "@/server/internal/inventory-movement-identity";
import { appendShadowInventoryMovements } from "@/server/internal/inventory-movement-shadow-gateway";

export const R05_SHADOW_GATE_INVARIANT_VIOLATION = "R05_SHADOW_GATE_INVARIANT_VIOLATION";
export const R05_SHADOW_ACTOR_MISMATCH = "R05_SHADOW_ACTOR_MISMATCH";
export const R05_CORRECTION_CAUSATION_DOMAIN = "PRODUCTION_OPERATION_MUTATION";
export const R05_CORRECTION_CAUSATION_TYPE = "R05_TORCOVKA_RAILS_TAKEN";
export const R05_CORRECTION_EFFECT_QUALIFIER = "rails-taken";

export type R05CorrectionShadowRow = {
  id: string;
  requestId: string;
  operationId: string;
  adminUserId: string;
  railLotId: string;
  batchId: string;
  expectedOldRailsTaken: number;
  newRailsTaken: number;
  deltaReturned: number;
  reason: string;
  recordedAt: Date;
};

export type R05CorrectionCausationSnapshotV1 = {
  v: 1;
  d: typeof R05_CORRECTION_CAUSATION_DOMAIN;
  type: typeof R05_CORRECTION_CAUSATION_TYPE;
  correctionId: string;
  requestId: string;
  operationId: string;
  railLotId: string;
  batchId: string;
  expectedOldRailsTaken: number;
  newRailsTaken: number;
  deltaReturned: number;
};

function requireUserActor(
  actor: MovementActorSnapshot,
): Extract<MovementActorSnapshot, { actorKind: "USER" }> {
  if (actor.actorKind !== "USER") {
    throw new Error("R-05 correction requires a retained USER actor");
  }
  return actor;
}

/** Deterministic v1 causation snapshot for an R-05 railsTaken correction. No money fields. */
export function r05CorrectionCausationSnapshotV1(
  row: Pick<
    R05CorrectionShadowRow,
    | "id"
    | "requestId"
    | "operationId"
    | "railLotId"
    | "batchId"
    | "expectedOldRailsTaken"
    | "newRailsTaken"
    | "deltaReturned"
  >,
): R05CorrectionCausationSnapshotV1 {
  return {
    v: 1,
    d: R05_CORRECTION_CAUSATION_DOMAIN,
    type: R05_CORRECTION_CAUSATION_TYPE,
    correctionId: row.id,
    requestId: row.requestId,
    operationId: row.operationId,
    railLotId: row.railLotId,
    batchId: row.batchId,
    expectedOldRailsTaken: row.expectedOldRailsTaken,
    newRailsTaken: row.newRailsTaken,
    deltaReturned: row.deltaReturned,
  };
}

export function r05CorrectionMovementEffect(
  row: Pick<R05CorrectionShadowRow, "railLotId" | "deltaReturned">,
): MovementEffect {
  return {
    role: "adjust",
    kind: "ADJUSTMENT",
    quantityDelta: row.deltaReturned,
    target: { stockDomain: "RAIL_LOT", railLotId: row.railLotId },
    qualifier: R05_CORRECTION_EFFECT_QUALIFIER,
  };
}

export function r05CorrectionEffectKey(railLotId: string): string {
  const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId });
  return effectKeyV1("adjust", canonical.targetHashV1, R05_CORRECTION_EFFECT_QUALIFIER);
}

/**
 * Fail closed if an ACTIVE R-05 writer observes an inactive gateway result
 * or anything other than exactly one inserted movement. Rolls back the same TX.
 * Schema already guarantees deltaReturned > 0.
 */
export function assertR05ShadowGatewayResult(input: {
  result: { gateActive: boolean; inserted: number };
}): void {
  if (input.result.gateActive === true && input.result.inserted === 1) return;
  throw new Error(R05_SHADOW_GATE_INVARIANT_VIOLATION);
}

/**
 * Append the single RAIL_LOT ADJUSTMENT for a newly created R-05 correction.
 * Replay must not call this. Outer SHADOW OFF skips the gateway.
 */
export async function appendR05CorrectionShadowMovement(
  tx: Prisma.TransactionClient,
  input: {
    shadowWriteActive: boolean;
    actor: MovementActorSnapshot;
    correction: R05CorrectionShadowRow;
  },
): Promise<void> {
  if (!input.shadowWriteActive) return;
  const actor = requireUserActor(input.actor);
  const columns = movementActorColumns(actor);
  if (columns.userId !== input.correction.adminUserId) {
    throw new Error(R05_SHADOW_ACTOR_MISMATCH);
  }
  const effect = r05CorrectionMovementEffect(input.correction);
  const result = await appendShadowInventoryMovements(tx, {
    effectiveAt: input.correction.recordedAt,
    actor,
    causation: {
      causationKind: "PRODUCTION_OPERATION_MUTATION",
      causationId: input.correction.id,
      causationSnapshot: r05CorrectionCausationSnapshotV1(
        input.correction,
      ) as Prisma.InputJsonValue,
      reason: input.correction.reason,
    },
    effects: [effect],
  });
  assertR05ShadowGatewayResult({ result });
}
