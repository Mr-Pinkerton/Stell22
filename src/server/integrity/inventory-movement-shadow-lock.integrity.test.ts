import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIntegrityClients, ensureIntegritySchema } from "./harness";
import {
  INVENTORY_MOVEMENT_SHADOW_LOCK_KEY,
  INVENTORY_MOVEMENT_SHADOW_LOCK_NS,
  acquireInventoryMovementShadowControlLock,
  acquireInventoryMovementShadowResetLock,
  acquireInventoryMovementShadowWriterLock,
} from "@/server/internal/inventory-movement-shadow-coordination";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe.skipIf(!enabled)("InventoryMovement SHADOW advisory transaction locks", () => {
  let dbA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let dbB: ReturnType<typeof createIntegrityClients>["prismaB"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA: dbA, prismaB: dbB } = createIntegrityClients());
  });

  afterAll(async () => {
    await dbA?.$disconnect();
    await dbB?.$disconnect();
  });

  it("A: SHARED + SHARED coexist", async () => {
    const hold = deferred();
    const locked = deferred();
    const tx1 = dbA.$transaction(async (tx) => {
      await acquireInventoryMovementShadowWriterLock(tx);
      locked.resolve();
      await hold.promise;
    }, txOpts);
    await locked.promise;
    const shared = await dbB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock_shared(
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
        ) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    }, txOpts);
    expect(shared).toBe(true);
    hold.resolve();
    await tx1;
  });

  it("B: SHARED blocks EXCLUSIVE until SHARED ends", async () => {
    const hold = deferred();
    const locked = deferred();
    const tx1 = dbA.$transaction(async (tx) => {
      await acquireInventoryMovementShadowWriterLock(tx);
      locked.resolve();
      await hold.promise;
    }, txOpts);
    await locked.promise;
    const exclusiveWhileShared = await dbB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
        ) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    }, txOpts);
    expect(exclusiveWhileShared).toBe(false);
    hold.resolve();
    await tx1;
    const exclusiveAfter = await dbB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
        ) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    }, txOpts);
    expect(exclusiveAfter).toBe(true);
  });

  it("C: EXCLUSIVE blocks SHARED until EXCLUSIVE ends", async () => {
    const hold = deferred();
    const locked = deferred();
    const tx1 = dbA.$transaction(async (tx) => {
      await acquireInventoryMovementShadowResetLock(tx);
      locked.resolve();
      await hold.promise;
    }, txOpts);
    await locked.promise;
    const sharedWhileExclusive = await dbB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock_shared(
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
        ) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    }, txOpts);
    expect(sharedWhileExclusive).toBe(false);
    hold.resolve();
    await tx1;
    const sharedAfter = await dbB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock_shared(
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
        ) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    }, txOpts);
    expect(sharedAfter).toBe(true);
  });

  it("D: lock is transaction-scoped; commit and rollback release it", async () => {
    await dbA.$transaction(async (tx) => {
      await acquireInventoryMovementShadowResetLock(tx);
    }, txOpts);
    const afterCommit = await dbB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
        ) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    }, txOpts);
    expect(afterCommit).toBe(true);

    await expect(
      dbA.$transaction(async (tx) => {
        await acquireInventoryMovementShadowResetLock(tx);
        throw new Error("rollback-lock");
      }, txOpts),
    ).rejects.toThrow("rollback-lock");

    const afterRollback = await dbB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
        ) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    }, txOpts);
    expect(afterRollback).toBe(true);
  });

  it("control A: running writer blocks gate control", async () => {
    const hold = deferred();
    const locked = deferred();
    const tx1 = dbA.$transaction(async (tx) => {
      await acquireInventoryMovementShadowWriterLock(tx);
      locked.resolve();
      await hold.promise;
    }, txOpts);
    await locked.promise;
    const exclusiveWhileShared = await dbB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
        ) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    }, txOpts);
    expect(exclusiveWhileShared).toBe(false);
    hold.resolve();
    await tx1;
    const exclusiveAfter = await dbB.$transaction(async (tx) => {
      await acquireInventoryMovementShadowControlLock(tx);
      return true;
    }, txOpts);
    expect(exclusiveAfter).toBe(true);
  });

  it("control B: running gate control blocks writer", async () => {
    const hold = deferred();
    const locked = deferred();
    const tx1 = dbA.$transaction(async (tx) => {
      await acquireInventoryMovementShadowControlLock(tx);
      locked.resolve();
      await hold.promise;
    }, txOpts);
    await locked.promise;
    const sharedWhileExclusive = await dbB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock_shared(
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
        ) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    }, txOpts);
    expect(sharedWhileExclusive).toBe(false);
    hold.resolve();
    await tx1;
    const sharedAfter = await dbB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock_shared(
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
        ) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    }, txOpts);
    expect(sharedAfter).toBe(true);
  });

  it("control C: reset and gate control are mutually exclusive", async () => {
    const hold = deferred();
    const locked = deferred();
    const tx1 = dbA.$transaction(async (tx) => {
      await acquireInventoryMovementShadowControlLock(tx);
      locked.resolve();
      await hold.promise;
    }, txOpts);
    await locked.promise;
    const secondExclusive = await dbB.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
        SELECT pg_try_advisory_xact_lock(
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}::integer,
          ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}::integer
        ) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    }, txOpts);
    expect(secondExclusive).toBe(false);
    hold.resolve();
    await tx1;
    const after = await dbB.$transaction(async (tx) => {
      await acquireInventoryMovementShadowResetLock(tx);
      return true;
    }, txOpts);
    expect(after).toBe(true);
  });
});
