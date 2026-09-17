import type { Prisma } from "@prisma/client";
import {
  acquireInventoryMovementShadowControlLock,
  acquireInventoryMovementShadowWriterLock,
  assertInventoryMovementShadowTransactionClient,
} from "./inventory-movement-shadow-coordination";

export const INVENTORY_MOVEMENT_SHADOW_WRITE_KEY = "inventory_movement_shadow_write";

export const INVENTORY_MOVEMENT_SHADOW_WRITE_MALFORMED_SETTING =
  "Некорректная настройка inventory_movement_shadow_write. Запись теневого регистра заблокирована.";

export class InventoryMovementShadowWriteConfigError extends Error {
  constructor(message = INVENTORY_MOVEMENT_SHADOW_WRITE_MALFORMED_SETTING) {
    super(message);
    this.name = "InventoryMovementShadowWriteConfigError";
  }
}

/**
 * PSR-Q-004 SHADOW write gate parser. Absent Setting is handled by readers.
 * Malformed / unsupported version fail closed.
 * Independent from production_cost_flow.
 */
export function parseInventoryMovementShadowWriteValue(value: unknown): { active: boolean } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InventoryMovementShadowWriteConfigError();
  }
  const rec = value as Record<string, unknown>;
  if (rec.version !== 1) throw new InventoryMovementShadowWriteConfigError();
  if (typeof rec.active !== "boolean") throw new InventoryMovementShadowWriteConfigError();
  return { active: rec.active };
}

async function readInventoryMovementShadowWriteSetting(
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const row = await tx.setting.findUnique({
    where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
  });
  if (!row) return false;
  return parseInventoryMovementShadowWriteValue(row.value).active;
}

/**
 * Reset-only gate read. Does not acquire coordination.
 * Call only after acquireInventoryMovementShadowControlLock(tx) in the same TX.
 */
export async function readInventoryMovementShadowWriteGate(
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  assertInventoryMovementShadowTransactionClient(tx);
  return readInventoryMovementShadowWriteSetting(tx);
}

/**
 * Supported SHADOW gate mutation. Requires an open Prisma.TransactionClient.
 * Acquires EXCLUSIVE control lock, then upserts { version: 1, active }.
 * Do not pass root prisma. Independent from production_cost_flow.
 */
export async function setInventoryMovementShadowWriteGate(
  tx: Prisma.TransactionClient,
  active: boolean,
): Promise<boolean> {
  await acquireInventoryMovementShadowControlLock(tx);
  const value = { version: 1, active };
  await tx.setting.upsert({
    where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
    create: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value },
    update: { value },
  });
  return active;
}

/**
 * Writer-facing SHADOW gate. Requires an open Prisma.TransactionClient.
 * Acquires SHARED transaction advisory lock, then reads the Setting.
 * Do not pass root prisma — the lock would not outlive the writer TX.
 */
export async function isInventoryMovementShadowWriteActiveForWriter(
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  await acquireInventoryMovementShadowWriterLock(tx);
  return readInventoryMovementShadowWriteSetting(tx);
}
