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

export const RAW_PURCHASE_SHADOW_GATE_INVARIANT_VIOLATION =
  "RAW_PURCHASE_SHADOW_GATE_INVARIANT_VIOLATION";
export const RAW_PURCHASE_SHADOW_ACTOR_REQUIRED = "RAW_PURCHASE_SHADOW_ACTOR_REQUIRED";
export const RAW_PURCHASE_SHADOW_ACTOR_MISMATCH = "RAW_PURCHASE_SHADOW_ACTOR_MISMATCH";
export const RAW_PURCHASE_SHADOW_INVALID_QUANTITY = "RAW_PURCHASE_SHADOW_INVALID_QUANTITY";
export const RAW_PURCHASE_SHADOW_SNAPSHOT_INVALID = "RAW_PURCHASE_SHADOW_SNAPSHOT_INVALID";

export const RAW_PURCHASE_BATCH_DOMAIN = "BATCH" as const;
export const RAW_PURCHASE_SIMPLE_DOMAIN = "SIMPLE_PURCHASE" as const;
export const RAW_PURCHASE_CREATE_TYPE = "CREATE" as const;
export const RAW_PURCHASE_WRITEOFF_TYPE = "REMAINDER_WRITEOFF" as const;

export type BatchCreateCausationRailLotV1 = {
  railLotId: string;
  quantity: number;
};

export type BatchCreateCausationSnapshotV1 = {
  v: 1;
  d: typeof RAW_PURCHASE_BATCH_DOMAIN;
  type: typeof RAW_PURCHASE_CREATE_TYPE;
  commandId: string;
  requestId: string;
  batchId: string;
  railLots: BatchCreateCausationRailLotV1[];
};

export type BatchWriteOffCausationEffectV1 = {
  railLotId: string;
  quantityBefore: number;
  quantityDelta: number;
};

export type BatchWriteOffCausationSnapshotV1 = {
  v: 1;
  d: typeof RAW_PURCHASE_BATCH_DOMAIN;
  type: typeof RAW_PURCHASE_WRITEOFF_TYPE;
  commandId: string;
  requestId: string;
  batchId: string;
  totalQuantity: number;
  effects: BatchWriteOffCausationEffectV1[];
};

export type SimplePurchaseCausationSnapshotV1 = {
  v: 1;
  d: typeof RAW_PURCHASE_SIMPLE_DOMAIN;
  type: typeof RAW_PURCHASE_CREATE_TYPE;
  commandId: string;
  requestId: string;
  simplePurchaseId: string;
  nomenclatureId: string;
  quantity: number;
};

export type RawPurchaseCommandIdentity = {
  id: string;
  requestId: string;
  adminUserId: string;
  recordedAt: Date;
};

function requirePositiveInteger(value: number, allowZero = false): number {
  if (!Number.isInteger(value) || !Number.isFinite(value)) {
    throw new Error(RAW_PURCHASE_SHADOW_INVALID_QUANTITY);
  }
  if (allowZero ? value < 0 : value <= 0) {
    throw new Error(RAW_PURCHASE_SHADOW_INVALID_QUANTITY);
  }
  return value;
}

function requireNegativeInteger(value: number): number {
  if (!Number.isInteger(value) || !Number.isFinite(value) || value >= 0) {
    throw new Error(RAW_PURCHASE_SHADOW_INVALID_QUANTITY);
  }
  return value;
}

function sortByRailLotId<T extends { railLotId: string }>(rows: readonly T[]): T[] {
  return rows.slice().sort((a, b) => a.railLotId.localeCompare(b.railLotId));
}

export function requireRawPurchaseUserActor(
  actor: MovementActorSnapshot,
): Extract<MovementActorSnapshot, { actorKind: "USER" }> {
  if (actor.actorKind !== "USER") {
    throw new Error(RAW_PURCHASE_SHADOW_ACTOR_REQUIRED);
  }
  return actor;
}

export function assertRawPurchaseActorMatchesCommand(input: {
  actor: MovementActorSnapshot;
  adminUserId: string;
}): void {
  const actor = requireRawPurchaseUserActor(input.actor);
  const columns = movementActorColumns(actor);
  if (columns.userId !== input.adminUserId) {
    throw new Error(RAW_PURCHASE_SHADOW_ACTOR_MISMATCH);
  }
}

export function expectedRawPurchaseShadowInsertCount(
  effects: readonly { quantityDelta: number }[],
): number {
  return effects.filter((effect) => effect.quantityDelta !== 0).length;
}

/**
 * Fail closed if an ACTIVE raw writer observes an inactive gateway result
 * or a mismatched insert count. Rolls back the same TX.
 */
export function assertRawPurchaseShadowGatewayResult(input: {
  result: { gateActive: boolean; inserted: number };
  expectedInserted: number;
}): void {
  if (input.result.gateActive === true && input.result.inserted === input.expectedInserted) {
    return;
  }
  throw new Error(RAW_PURCHASE_SHADOW_GATE_INVARIANT_VIOLATION);
}

export function batchCreateCausationSnapshotV1(input: {
  commandId: string;
  requestId: string;
  batchId: string;
  railLots: readonly BatchCreateCausationRailLotV1[];
}): BatchCreateCausationSnapshotV1 {
  return {
    v: 1,
    d: RAW_PURCHASE_BATCH_DOMAIN,
    type: RAW_PURCHASE_CREATE_TYPE,
    commandId: input.commandId,
    requestId: input.requestId,
    batchId: input.batchId,
    railLots: sortByRailLotId(
      input.railLots.map((lot) => ({
        railLotId: lot.railLotId,
        quantity: lot.quantity,
      })),
    ),
  };
}

export function batchCreateReceiptEffects(
  lots: readonly { id: string; quantity: number }[],
): MovementEffect[] {
  const effects: MovementEffect[] = [];
  for (const lot of lots) {
    if (lot.quantity === 0) continue;
    if (lot.quantity < 0) throw new Error(RAW_PURCHASE_SHADOW_INVALID_QUANTITY);
    requirePositiveInteger(lot.quantity);
    effects.push({
      role: "receipt",
      kind: "RECEIPT",
      quantityDelta: lot.quantity,
      target: { stockDomain: "RAIL_LOT", railLotId: lot.id },
    });
  }
  return effects;
}

export function batchCreateReceiptEffectKey(railLotId: string): string {
  const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId });
  return effectKeyV1("receipt", canonical.targetHashV1);
}

export function batchWriteOffCausationSnapshotV1(input: {
  commandId: string;
  requestId: string;
  batchId: string;
  totalQuantity: number;
  effects: readonly BatchWriteOffCausationEffectV1[];
}): BatchWriteOffCausationSnapshotV1 {
  return {
    v: 1,
    d: RAW_PURCHASE_BATCH_DOMAIN,
    type: RAW_PURCHASE_WRITEOFF_TYPE,
    commandId: input.commandId,
    requestId: input.requestId,
    batchId: input.batchId,
    totalQuantity: input.totalQuantity,
    effects: sortByRailLotId(
      input.effects.map((effect) => ({
        railLotId: effect.railLotId,
        quantityBefore: effect.quantityBefore,
        quantityDelta: effect.quantityDelta,
      })),
    ),
  };
}

export function batchWriteOffMovementEffects(
  effects: readonly BatchWriteOffCausationEffectV1[],
): MovementEffect[] {
  return effects.map((effect) => {
    requireNegativeInteger(effect.quantityDelta);
    return {
      role: "writeoff" as const,
      kind: "ADJUSTMENT" as const,
      quantityDelta: effect.quantityDelta,
      target: { stockDomain: "RAIL_LOT" as const, railLotId: effect.railLotId },
    };
  });
}

export function batchWriteOffEffectKey(railLotId: string): string {
  const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId });
  return effectKeyV1("writeoff", canonical.targetHashV1);
}

export function parseRetainedWriteOffEffects(
  snapshot: unknown,
): BatchWriteOffCausationEffectV1[] {
  if (typeof snapshot !== "object" || snapshot === null || Array.isArray(snapshot)) {
    throw new Error(RAW_PURCHASE_SHADOW_SNAPSHOT_INVALID);
  }
  const rec = snapshot as Record<string, unknown>;
  if (!Array.isArray(rec.effects)) {
    throw new Error(RAW_PURCHASE_SHADOW_SNAPSHOT_INVALID);
  }
  return rec.effects.map((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(RAW_PURCHASE_SHADOW_SNAPSHOT_INVALID);
    }
    const effect = item as Record<string, unknown>;
    if (typeof effect.railLotId !== "string" || !effect.railLotId.trim()) {
      throw new Error(RAW_PURCHASE_SHADOW_SNAPSHOT_INVALID);
    }
    if (typeof effect.quantityBefore !== "number" || typeof effect.quantityDelta !== "number") {
      throw new Error(RAW_PURCHASE_SHADOW_SNAPSHOT_INVALID);
    }
    return {
      railLotId: effect.railLotId,
      quantityBefore: effect.quantityBefore,
      quantityDelta: effect.quantityDelta,
    };
  });
}

export function simplePurchaseCausationSnapshotV1(input: {
  commandId: string;
  requestId: string;
  simplePurchaseId: string;
  nomenclatureId: string;
  quantity: number;
}): SimplePurchaseCausationSnapshotV1 {
  return {
    v: 1,
    d: RAW_PURCHASE_SIMPLE_DOMAIN,
    type: RAW_PURCHASE_CREATE_TYPE,
    commandId: input.commandId,
    requestId: input.requestId,
    simplePurchaseId: input.simplePurchaseId,
    nomenclatureId: input.nomenclatureId,
    quantity: input.quantity,
  };
}

export function simplePurchaseReceiptEffect(input: {
  nomenclatureId: string;
  quantity: number;
}): MovementEffect {
  requirePositiveInteger(input.quantity);
  return {
    role: "receipt",
    kind: "RECEIPT",
    quantityDelta: input.quantity,
    target: { stockDomain: "NOMENCLATURE", nomenclatureId: input.nomenclatureId },
  };
}

export function simplePurchaseReceiptEffectKey(nomenclatureId: string): string {
  const canonical = canonicalizeMovementTarget({
    stockDomain: "NOMENCLATURE",
    nomenclatureId,
  });
  return effectKeyV1("receipt", canonical.targetHashV1);
}

async function appendRawPurchaseShadowMovements(
  tx: Prisma.TransactionClient,
  input: {
    shadowWriteActive: boolean;
    actor: MovementActorSnapshot;
    adminUserId: string;
    effectiveAt: Date;
    causationKind: "BATCH" | "SIMPLE_PURCHASE";
    causationId: string;
    causationSnapshot: Prisma.InputJsonValue;
    effects: readonly MovementEffect[];
  },
): Promise<void> {
  if (!input.shadowWriteActive) return;
  assertRawPurchaseActorMatchesCommand({
    actor: input.actor,
    adminUserId: input.adminUserId,
  });
  const expectedInserted = expectedRawPurchaseShadowInsertCount(input.effects);
  const result = await appendShadowInventoryMovements(tx, {
    effectiveAt: input.effectiveAt,
    actor: requireRawPurchaseUserActor(input.actor),
    causation: {
      causationKind: input.causationKind,
      causationId: input.causationId,
      causationSnapshot: input.causationSnapshot,
      reason: null,
    },
    effects: input.effects,
  });
  assertRawPurchaseShadowGatewayResult({ result, expectedInserted });
}

/** Newly created Batch receipts from actual RailLot rows. Replay must not call this. */
export async function appendBatchCreateShadowMovements(
  tx: Prisma.TransactionClient,
  input: {
    shadowWriteActive: boolean;
    actor: MovementActorSnapshot;
    command: RawPurchaseCommandIdentity & { batchId: string };
    createdLots: readonly { id: string; quantity: number }[];
  },
): Promise<void> {
  const effects = batchCreateReceiptEffects(input.createdLots);
  await appendRawPurchaseShadowMovements(tx, {
    shadowWriteActive: input.shadowWriteActive,
    actor: input.actor,
    adminUserId: input.command.adminUserId,
    effectiveAt: input.command.recordedAt,
    causationKind: "BATCH",
    causationId: input.command.id,
    causationSnapshot: batchCreateCausationSnapshotV1({
      commandId: input.command.id,
      requestId: input.command.requestId,
      batchId: input.command.batchId,
      railLots: input.createdLots.map((lot) => ({
        railLotId: lot.id,
        quantity: lot.quantity,
      })),
    }) as Prisma.InputJsonValue,
    effects,
  });
}

/** Write-off movements from the retained pre-mutation snapshot. Replay must not call this. */
export async function appendBatchWriteOffShadowMovements(
  tx: Prisma.TransactionClient,
  input: {
    shadowWriteActive: boolean;
    actor: MovementActorSnapshot;
    command: RawPurchaseCommandIdentity & {
      batchId: string;
      totalQuantity: number;
      effectSnapshot: unknown;
    };
  },
): Promise<void> {
  const retained = parseRetainedWriteOffEffects(input.command.effectSnapshot);
  const effects = batchWriteOffMovementEffects(retained);
  await appendRawPurchaseShadowMovements(tx, {
    shadowWriteActive: input.shadowWriteActive,
    actor: input.actor,
    adminUserId: input.command.adminUserId,
    effectiveAt: input.command.recordedAt,
    causationKind: "BATCH",
    causationId: input.command.id,
    causationSnapshot: batchWriteOffCausationSnapshotV1({
      commandId: input.command.id,
      requestId: input.command.requestId,
      batchId: input.command.batchId,
      totalQuantity: input.command.totalQuantity,
      effects: retained,
    }) as Prisma.InputJsonValue,
    effects,
  });
}

/** New SimplePurchase receipt. Replay must not call this. causationId is SimplePurchase.id. */
export async function appendSimplePurchaseShadowMovement(
  tx: Prisma.TransactionClient,
  input: {
    shadowWriteActive: boolean;
    actor: MovementActorSnapshot;
    command: RawPurchaseCommandIdentity;
    purchase: { id: string; nomenclatureId: string; quantity: number };
  },
): Promise<void> {
  const effect = simplePurchaseReceiptEffect({
    nomenclatureId: input.purchase.nomenclatureId,
    quantity: input.purchase.quantity,
  });
  await appendRawPurchaseShadowMovements(tx, {
    shadowWriteActive: input.shadowWriteActive,
    actor: input.actor,
    adminUserId: input.command.adminUserId,
    effectiveAt: input.command.recordedAt,
    causationKind: "SIMPLE_PURCHASE",
    causationId: input.purchase.id,
    causationSnapshot: simplePurchaseCausationSnapshotV1({
      commandId: input.command.id,
      requestId: input.command.requestId,
      simplePurchaseId: input.purchase.id,
      nomenclatureId: input.purchase.nomenclatureId,
      quantity: input.purchase.quantity,
    }) as Prisma.InputJsonValue,
    effects: [effect],
  });
}
