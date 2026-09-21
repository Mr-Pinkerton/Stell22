import { Prisma } from "@prisma/client";
import {
  movementActorColumns,
  type MovementActorSnapshot,
} from "@/server/internal/inventory-movement-actor";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
  type MovementEffect,
  type MovementTarget,
} from "@/server/internal/inventory-movement-identity";
import { appendShadowInventoryMovements } from "@/server/internal/inventory-movement-shadow-gateway";
import {
  assertNoMoneyInQuantityEditContract,
  type QuantityEditPhysicalAdjustment,
} from "@/server/internal/production-quantity-edit";
import type { OperationType, RailType, Sort } from "@/types/domain";

export const QUANTITY_EDIT_SHADOW_GATE_INVARIANT_VIOLATION =
  "QUANTITY_EDIT_SHADOW_GATE_INVARIANT_VIOLATION";
export const QUANTITY_EDIT_SHADOW_ACTOR_MISMATCH = "QUANTITY_EDIT_SHADOW_ACTOR_MISMATCH";
export const QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID = "QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID";
export const QUANTITY_EDIT_CAUSATION_DOMAIN = "PRODUCTION_OPERATION_MUTATION";
export const QUANTITY_EDIT_CAUSATION_TYPE = "QUANTITY_EDIT";

export type QuantityEditPhysicalOperationType = "TORCOVKA" | "PRISADKA" | "UPAKOVKA";

export type QuantityEditShadowRow = {
  id: string;
  requestId: string;
  operationId: string;
  adminUserId: string;
  actorDisplaySnapshot: string;
  operationType: OperationType;
  targetLineId: string | null;
  expectedOldQuantity: number;
  newQuantity: number;
  recordedAt: Date;
  effectSnapshot: unknown;
};

export type QuantityEditCausationSnapshotV1 = {
  v: 1;
  d: typeof QUANTITY_EDIT_CAUSATION_DOMAIN;
  type: typeof QUANTITY_EDIT_CAUSATION_TYPE;
  quantityEditId: string;
  requestId: string;
  operationId: string;
  operationType: QuantityEditPhysicalOperationType;
  targetLineId: string | null;
  expectedOldQuantity: number;
  newQuantity: number;
  effectSnapshotVersion: 1;
};

function snapshotInvalid(detail: string): Error {
  return new Error(`${QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonblankString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw snapshotInvalid(field);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw snapshotInvalid(field);
  return value;
}

function requireFiniteNonzeroInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value === 0) {
    throw snapshotInvalid(field);
  }
  return value;
}

function requireRailType(value: unknown, field: string): RailType {
  if (value !== "POLKA" && value !== "KANAVKA") throw snapshotInvalid(field);
  return value;
}

function requireSort(value: unknown, field: string): Sort {
  if (value !== "SORT1" && value !== "SORT2") throw snapshotInvalid(field);
  return value;
}

function requirePhysicalOperationType(value: unknown): QuantityEditPhysicalOperationType {
  if (
    value !== "TORCOVKA" &&
    value !== "PRISADKA" &&
    value !== "UPAKOVKA"
  ) {
    throw snapshotInvalid("operationType");
  }
  return value;
}

function requireUserActor(
  actor: MovementActorSnapshot,
): Extract<MovementActorSnapshot, { actorKind: "USER" }> {
  if (actor.actorKind !== "USER") {
    throw new Error("Quantity-edit SHADOW writer requires a retained USER actor");
  }
  return actor;
}

function retainedLedgerActor(row: QuantityEditShadowRow): Extract<
  MovementActorSnapshot,
  { actorKind: "USER" }
> {
  return {
    actorKind: "USER",
    userId: row.adminUserId,
    actorDisplaySnapshot: row.actorDisplaySnapshot,
  };
}

/** Deterministic v1 causation snapshot for an A/B/C quantity edit. No money fields. */
export function quantityEditCausationSnapshotV1(
  row: Pick<
    QuantityEditShadowRow,
    | "id"
    | "requestId"
    | "operationId"
    | "operationType"
    | "targetLineId"
    | "expectedOldQuantity"
    | "newQuantity"
  >,
): QuantityEditCausationSnapshotV1 {
  return {
    v: 1,
    d: QUANTITY_EDIT_CAUSATION_DOMAIN,
    type: QUANTITY_EDIT_CAUSATION_TYPE,
    quantityEditId: row.id,
    requestId: row.requestId,
    operationId: row.operationId,
    operationType: requirePhysicalOperationType(row.operationType),
    targetLineId: row.targetLineId,
    expectedOldQuantity: row.expectedOldQuantity,
    newQuantity: row.newQuantity,
    effectSnapshotVersion: 1,
  };
}

export function quantityEditMovementTarget(
  adjustment: QuantityEditPhysicalAdjustment,
): MovementTarget {
  if (adjustment.targetType === "BLANK") {
    return {
      stockDomain: "BLANK",
      materialId: adjustment.materialId,
      lengthM: adjustment.lengthM,
      detailType: adjustment.detailType,
      sort: adjustment.sort,
    };
  }
  if (adjustment.targetType === "DETAIL") {
    return {
      stockDomain: "DETAIL",
      detailId: adjustment.detailId,
      torcevayaDone: adjustment.torcevayaDone,
      ploskostDone: adjustment.ploskostDone,
    };
  }
  if (adjustment.targetType === "NOMENCLATURE") {
    return { stockDomain: "NOMENCLATURE", nomenclatureId: adjustment.nomenclatureId };
  }
  return { stockDomain: "PRODUCT", productId: adjustment.productId };
}

export function quantityEditMovementEffect(
  adjustment: QuantityEditPhysicalAdjustment,
): MovementEffect {
  return {
    role: "adjust",
    kind: "ADJUSTMENT",
    quantityDelta: adjustment.quantityDelta,
    target: quantityEditMovementTarget(adjustment),
  };
}

export function quantityEditEffectKey(target: MovementTarget): string {
  const canonical = canonicalizeMovementTarget(target);
  return effectKeyV1("adjust", canonical.targetHashV1);
}

function parseOnePhysicalAdjustment(raw: unknown, index: number): QuantityEditPhysicalAdjustment {
  if (!isRecord(raw)) throw snapshotInvalid(`physicalAdjustments[${index}]`);
  const quantityDelta = requireFiniteNonzeroInteger(raw.quantityDelta, `physicalAdjustments[${index}].quantityDelta`);
  const targetType = raw.targetType;
  if (targetType === "BLANK") {
    return {
      targetType: "BLANK",
      materialId: requireNonblankString(raw.materialId, `physicalAdjustments[${index}].materialId`),
      lengthM: requireNonblankString(raw.lengthM, `physicalAdjustments[${index}].lengthM`),
      detailType: requireRailType(raw.detailType, `physicalAdjustments[${index}].detailType`),
      sort: requireSort(raw.sort, `physicalAdjustments[${index}].sort`),
      quantityDelta,
    };
  }
  if (targetType === "DETAIL") {
    return {
      targetType: "DETAIL",
      detailId: requireNonblankString(raw.detailId, `physicalAdjustments[${index}].detailId`),
      torcevayaDone: requireBoolean(raw.torcevayaDone, `physicalAdjustments[${index}].torcevayaDone`),
      ploskostDone: requireBoolean(raw.ploskostDone, `physicalAdjustments[${index}].ploskostDone`),
      quantityDelta,
    };
  }
  if (targetType === "NOMENCLATURE") {
    return {
      targetType: "NOMENCLATURE",
      nomenclatureId: requireNonblankString(
        raw.nomenclatureId,
        `physicalAdjustments[${index}].nomenclatureId`,
      ),
      quantityDelta,
    };
  }
  if (targetType === "PRODUCT") {
    return {
      targetType: "PRODUCT",
      productId: requireNonblankString(raw.productId, `physicalAdjustments[${index}].productId`),
      quantityDelta,
    };
  }
  throw snapshotInvalid(`physicalAdjustments[${index}].targetType`);
}

/**
 * Fail closed on a malformed retained Package 2 effectSnapshot.
 * Does not reconstruct or repair the snapshot.
 */
export function parseQuantityEditPhysicalAdjustments(
  effectSnapshot: unknown,
): QuantityEditPhysicalAdjustment[] {
  if (!isRecord(effectSnapshot)) throw snapshotInvalid("effectSnapshot");
  if (effectSnapshot.v !== 1) throw snapshotInvalid("effectSnapshot.v");
  if (!Array.isArray(effectSnapshot.physicalAdjustments)) {
    throw snapshotInvalid("physicalAdjustments");
  }
  assertNoMoneyInQuantityEditContract(effectSnapshot);
  const seen = new Set<string>();
  return effectSnapshot.physicalAdjustments.map((raw, index) => {
    const adjustment = parseOnePhysicalAdjustment(raw, index);
    const canonical = canonicalizeMovementTarget(quantityEditMovementTarget(adjustment));
    if (seen.has(canonical.targetHashV1)) {
      throw snapshotInvalid(`duplicate canonical target ${canonical.stockDomain}`);
    }
    seen.add(canonical.targetHashV1);
    return adjustment;
  });
}

/**
 * Fail closed if an ACTIVE Package 3 writer observes an inactive gateway
 * result or a mismatched insert count. Rolls back the same TX.
 */
export function assertQuantityEditShadowGatewayResult(input: {
  result: { gateActive: boolean; inserted: number };
  expectedInserted: number;
}): void {
  if (input.result.gateActive === true && input.result.inserted === input.expectedInserted) return;
  throw new Error(QUANTITY_EDIT_SHADOW_GATE_INVARIANT_VIOLATION);
}

/**
 * Append one ADJUSTMENT per retained nonzero physicalAdjustment for a newly
 * created ProductionOperationQuantityEdit. Replay must not call this.
 * Outer SHADOW OFF skips the gateway.
 */
export async function appendQuantityEditShadowMovements(
  tx: Prisma.TransactionClient,
  input: {
    shadowWriteActive: boolean;
    actor: MovementActorSnapshot;
    quantityEdit: QuantityEditShadowRow;
  },
): Promise<void> {
  if (!input.shadowWriteActive) return;
  const actor = requireUserActor(input.actor);
  const columns = movementActorColumns(actor);
  if (columns.userId !== input.quantityEdit.adminUserId) {
    throw new Error(QUANTITY_EDIT_SHADOW_ACTOR_MISMATCH);
  }
  const adjustments = parseQuantityEditPhysicalAdjustments(input.quantityEdit.effectSnapshot);
  const effects = adjustments.map(quantityEditMovementEffect);
  const causationSnapshot = quantityEditCausationSnapshotV1(input.quantityEdit);
  assertNoMoneyInQuantityEditContract(causationSnapshot);
  const ledgerActor = retainedLedgerActor(input.quantityEdit);
  const result = await appendShadowInventoryMovements(tx, {
    effectiveAt: input.quantityEdit.recordedAt,
    actor: ledgerActor,
    causation: {
      causationKind: "PRODUCTION_OPERATION_MUTATION",
      causationId: input.quantityEdit.id,
      causationSnapshot: causationSnapshot as Prisma.InputJsonValue,
      reason: null,
    },
    effects,
  });
  assertQuantityEditShadowGatewayResult({ result, expectedInserted: effects.length });
}
