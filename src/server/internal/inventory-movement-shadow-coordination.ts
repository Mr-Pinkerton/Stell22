import type { Prisma } from "@prisma/client";

/**
 * PostgreSQL two-int transaction advisory lock for InventoryMovement SHADOW
 * coordination. Both values are int4-safe JS numbers.
 *
 * key1 = namespace (Stell22 InventoryMovement SHADOW)
 * key2 = single coordination object
 *
 * SHARED  pg_advisory_xact_lock_shared(key1, key2) — future SHADOW writers
 * EXCLUSIVE pg_advisory_xact_lock(key1, key2) — gate ON/OFF + SHADOW reset
 */
export const INVENTORY_MOVEMENT_SHADOW_LOCK_NS = 8322;
export const INVENTORY_MOVEMENT_SHADOW_LOCK_KEY = 1;

export const INVENTORY_MOVEMENT_SHADOW_TX_REQUIRED =
  "InventoryMovement SHADOW coordination requires an open Prisma transaction client.";

export class InventoryMovementShadowCoordinationError extends Error {
  constructor(message = INVENTORY_MOVEMENT_SHADOW_TX_REQUIRED) {
    super(message);
    this.name = "InventoryMovementShadowCoordinationError";
  }
}

export function assertInventoryMovementShadowTransactionClient(
  tx: Prisma.TransactionClient,
): void {
  if (typeof (tx as { $transaction?: unknown }).$transaction === "function") {
    throw new InventoryMovementShadowCoordinationError();
  }
}

export async function acquireInventoryMovementShadowWriterLock(
  tx: Prisma.TransactionClient,
): Promise<void> {
  assertInventoryMovementShadowTransactionClient(tx);
  // Prisma $queryRaw cannot deserialize PostgreSQL void; wrap as integer.
  await tx.$queryRaw`
    SELECT 1 AS acquired
    FROM (
      SELECT pg_advisory_xact_lock_shared(
        ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
        ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
      )
    ) AS inventory_movement_shadow_writer_lock
  `;
}

/**
 * EXCLUSIVE control-plane lock. One primitive for gate ON/OFF and SHADOW reset.
 */
export async function acquireInventoryMovementShadowControlLock(
  tx: Prisma.TransactionClient,
): Promise<void> {
  assertInventoryMovementShadowTransactionClient(tx);
  await tx.$queryRaw`
    SELECT 1 AS acquired
    FROM (
      SELECT pg_advisory_xact_lock(
        ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
        ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
      )
    ) AS inventory_movement_shadow_control_lock
  `;
}

/** Narrow alias: reset uses the same EXCLUSIVE control primitive and key pair. */
export const acquireInventoryMovementShadowResetLock =
  acquireInventoryMovementShadowControlLock;
