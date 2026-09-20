import { Prisma } from "@prisma/client";
import {
  type MovementActorSnapshot,
} from "@/server/internal/inventory-movement-actor";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
  type MovementEffect,
} from "@/server/internal/inventory-movement-identity";
import { appendShadowInventoryMovements } from "@/server/internal/inventory-movement-shadow-gateway";

export const SUPPLY_SHADOW_GATE_INVARIANT_VIOLATION =
  "SUPPLY_SHADOW_GATE_INVARIANT_VIOLATION";
export const SUPPLY_SHADOW_ACTOR_REQUIRED = "SUPPLY_SHADOW_ACTOR_REQUIRED";
export const SUPPLY_SHADOW_CONTEXT_REQUIRED = "SUPPLY_SHADOW_CONTEXT_REQUIRED";
export const SUPPLY_CAUSATION_DOMAIN = "SUPPLY" as const;
export const SUPPLY_CONSUME_TYPE = "CONSUME" as const;
export const SUPPLY_RESTORE_TYPE = "RESTORE" as const;

export type SupplyConsumeCausationSnapshotV1 = {
  v: 1;
  d: typeof SUPPLY_CAUSATION_DOMAIN;
  type: typeof SUPPLY_CONSUME_TYPE;
  supplyId: string;
  marketplace: string;
  externalId: string;
  sku: string;
  productId: string;
  stockAccountingGeneration: number;
  processedQtyAfter: number;
  deductedQtyAfter: number;
  shortfallQtyAfter: number;
  quantityDelta: number;
};

export type SupplyRestoreCausationSnapshotV1 = {
  v: 1;
  d: typeof SUPPLY_CAUSATION_DOMAIN;
  type: typeof SUPPLY_RESTORE_TYPE;
  supplyId: string;
  marketplace: string;
  externalId: string;
  sku: string;
  productId: string;
  stockAccountingGeneration: number;
  deductedQtyBeforeClose: number;
  shortfallQtyBeforeClose: number;
  quantityDelta: number;
};

export type SupplyConsumeFacts = {
  supplyId: string;
  marketplace: string;
  externalId: string;
  sku: string;
  productId: string;
  stockAccountingGeneration: number;
  processedQtyAfter: number;
  deductedQtyAfter: number;
  shortfallQtyAfter: number;
  quantityDelta: number;
};

export type SupplyRestoreFacts = {
  supplyId: string;
  marketplace: string;
  externalId: string;
  sku: string;
  productId: string;
  stockAccountingGeneration: number;
  deductedQtyBeforeClose: number;
  shortfallQtyBeforeClose: number;
  quantityDelta: number;
};

export function requireSupplyUserActor(
  actor: MovementActorSnapshot,
): Extract<MovementActorSnapshot, { actorKind: "USER" }> {
  if (actor.actorKind !== "USER") {
    throw new Error(SUPPLY_SHADOW_ACTOR_REQUIRED);
  }
  return actor;
}

export type SupplyShadowContext = {
  active: boolean;
  actor: MovementActorSnapshot;
};

/**
 * Explicit outer-gate decision. `undefined` is not OFF.
 */
export function requireSupplyShadowContext(
  shadow: SupplyShadowContext | null | undefined,
): {
  active: boolean;
  actor: Extract<MovementActorSnapshot, { actorKind: "USER" }>;
} {
  if (shadow == null || typeof shadow.active !== "boolean") {
    throw new Error(SUPPLY_SHADOW_CONTEXT_REQUIRED);
  }
  return {
    active: shadow.active,
    actor: requireSupplyUserActor(shadow.actor),
  };
}

export function supplyConsumeQualifier(
  generation: number,
  processedQtyAfter: number,
): string {
  return `g=${generation}:w=${processedQtyAfter}`;
}

export function supplyRestoreQualifier(
  generation: number,
  deductedQtyBeforeClose: number,
): string {
  return `g=${generation}:w=${deductedQtyBeforeClose}`;
}

export function supplyConsumeEffectKey(
  productId: string,
  generation: number,
  processedQtyAfter: number,
): string {
  const canonical = canonicalizeMovementTarget({ stockDomain: "PRODUCT", productId });
  return effectKeyV1(
    "consume",
    canonical.targetHashV1,
    supplyConsumeQualifier(generation, processedQtyAfter),
  );
}

export function supplyRestoreEffectKey(
  productId: string,
  generation: number,
  deductedQtyBeforeClose: number,
): string {
  const canonical = canonicalizeMovementTarget({ stockDomain: "PRODUCT", productId });
  return effectKeyV1(
    "restore",
    canonical.targetHashV1,
    supplyRestoreQualifier(generation, deductedQtyBeforeClose),
  );
}

export function supplyConsumeCausationSnapshotV1(
  facts: SupplyConsumeFacts,
): SupplyConsumeCausationSnapshotV1 {
  return {
    v: 1,
    d: SUPPLY_CAUSATION_DOMAIN,
    type: SUPPLY_CONSUME_TYPE,
    supplyId: facts.supplyId,
    marketplace: facts.marketplace,
    externalId: facts.externalId,
    sku: facts.sku,
    productId: facts.productId,
    stockAccountingGeneration: facts.stockAccountingGeneration,
    processedQtyAfter: facts.processedQtyAfter,
    deductedQtyAfter: facts.deductedQtyAfter,
    shortfallQtyAfter: facts.shortfallQtyAfter,
    quantityDelta: facts.quantityDelta,
  };
}

export function supplyRestoreCausationSnapshotV1(
  facts: SupplyRestoreFacts,
): SupplyRestoreCausationSnapshotV1 {
  return {
    v: 1,
    d: SUPPLY_CAUSATION_DOMAIN,
    type: SUPPLY_RESTORE_TYPE,
    supplyId: facts.supplyId,
    marketplace: facts.marketplace,
    externalId: facts.externalId,
    sku: facts.sku,
    productId: facts.productId,
    stockAccountingGeneration: facts.stockAccountingGeneration,
    deductedQtyBeforeClose: facts.deductedQtyBeforeClose,
    shortfallQtyBeforeClose: facts.shortfallQtyBeforeClose,
    quantityDelta: facts.quantityDelta,
  };
}

export function supplyConsumeMovementEffect(facts: SupplyConsumeFacts): MovementEffect {
  return {
    role: "consume",
    kind: "CONSUMPTION",
    quantityDelta: facts.quantityDelta,
    target: { stockDomain: "PRODUCT", productId: facts.productId },
    qualifier: supplyConsumeQualifier(
      facts.stockAccountingGeneration,
      facts.processedQtyAfter,
    ),
  };
}

export function supplyRestoreMovementEffect(facts: SupplyRestoreFacts): MovementEffect {
  return {
    role: "restore",
    kind: "ADJUSTMENT",
    quantityDelta: facts.quantityDelta,
    target: { stockDomain: "PRODUCT", productId: facts.productId },
    qualifier: supplyRestoreQualifier(
      facts.stockAccountingGeneration,
      facts.deductedQtyBeforeClose,
    ),
  };
}

/**
 * Fail closed if an ACTIVE Supply writer observes an inactive gateway result
 * or anything other than exactly one inserted movement. Rolls back the same TX.
 */
export function assertSupplyShadowGatewayResult(input: {
  result: { gateActive: boolean; inserted: number };
}): void {
  if (input.result.gateActive === true && input.result.inserted === 1) return;
  throw new Error(SUPPLY_SHADOW_GATE_INVARIANT_VIOLATION);
}

/**
 * Append the consume CONSUMPTION for an actual ProductStock decrement.
 * Full shortfall / retry / no-op must not call this.
 */
export async function appendSupplyConsumeShadowMovement(
  tx: Prisma.TransactionClient,
  input: {
    shadowWriteActive: boolean;
    actor: MovementActorSnapshot;
    occurredAt: Date;
    facts: SupplyConsumeFacts;
  },
): Promise<void> {
  if (!input.shadowWriteActive) return;
  const actor = requireSupplyUserActor(input.actor);
  const result = await appendShadowInventoryMovements(tx, {
    effectiveAt: input.occurredAt,
    actor,
    causation: {
      causationKind: "SUPPLY",
      causationId: input.facts.supplyId,
      causationSnapshot: supplyConsumeCausationSnapshotV1(
        input.facts,
      ) as Prisma.InputJsonValue,
      reason: null,
    },
    effects: [supplyConsumeMovementEffect(input.facts)],
  });
  assertSupplyShadowGatewayResult({ result });
}

/**
 * Append the restore ADJUSTMENT for an actual Ozon ProductStock increment.
 * Zero-restore / already-closed retry must not call this.
 */
export async function appendSupplyRestoreShadowMovement(
  tx: Prisma.TransactionClient,
  input: {
    shadowWriteActive: boolean;
    actor: MovementActorSnapshot;
    occurredAt: Date;
    facts: SupplyRestoreFacts;
  },
): Promise<void> {
  if (!input.shadowWriteActive) return;
  const actor = requireSupplyUserActor(input.actor);
  const result = await appendShadowInventoryMovements(tx, {
    effectiveAt: input.occurredAt,
    actor,
    causation: {
      causationKind: "SUPPLY",
      causationId: input.facts.supplyId,
      causationSnapshot: supplyRestoreCausationSnapshotV1(
        input.facts,
      ) as Prisma.InputJsonValue,
      reason: null,
    },
    effects: [supplyRestoreMovementEffect(input.facts)],
  });
  assertSupplyShadowGatewayResult({ result });
}
