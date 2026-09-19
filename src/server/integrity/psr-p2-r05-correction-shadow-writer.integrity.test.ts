/**
 * PSR-P2 R-05 TORCOVKA correction SHADOW writer.
 * Trigger reject is integrity-only and keyed by actorDisplaySnapshot.
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));

const adminState = vi.hoisted(() => ({
  current: {
    id: "integrity-admin",
    name: "Admin",
    email: "admin@test.local",
    role: "ADMIN",
  },
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => ({ ...adminState.current }),
  requireTerminalEmployee: async (expectedEmployeeId?: string) => ({
    id: expectedEmployeeId ?? "integrity-session-employee",
    fullName: "Integrity Employee",
  }),
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { D } from "@/lib/cost";
import { consumeRailValue } from "@/lib/cost-foundation";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import { lockProductionOperations } from "@/server/internal/finance-operations";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import {
  INVENTORY_MOVEMENT_SHADOW_LOCK_KEY,
  INVENTORY_MOVEMENT_SHADOW_LOCK_NS,
} from "@/server/internal/inventory-movement-shadow-coordination";
import { utcNaiveTimestampString } from "@/server/internal/inventory-movement-time";
import {
  INVENTORY_MOVEMENT_SHADOW_WRITE_KEY,
  InventoryMovementShadowWriteConfigError,
  setInventoryMovementShadowWriteGate,
} from "@/server/internal/inventory-movement-shadow-write";
import { REQUEST_ID_REUSE } from "@/server/internal/production-operation-correction";
import { correctTorcovkaRailsTakenInTransaction } from "@/server/internal/correct-torcovka-rails-taken-tx";
import {
  r05CorrectionCausationSnapshotV1,
  r05CorrectionEffectKey,
} from "@/server/internal/r05-correction-shadow-write";
import { correctTorcovkaRailsTaken } from "@/server/production";
import { submitTorcovka } from "@/server/terminal";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  integrityDatabaseUrl,
  resetIntegrityCostFreeze,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
const BARRIER_TIMEOUT_MS = 25_000;
const REJECT_ACTOR = "INTEGRITY_REJECT_IM";
const CONCURRENCY_TIMEOUT_MS = 20_000;

function d(value: Prisma.Decimal | string | number | null | undefined) {
  if (value == null) return null;
  return D(typeof value === "object" ? value.toString() : value);
}

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BARRIER_TIMEOUT_MS) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`barrier: ${label}`);
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`QueryTimeout: ${label} exceeded ${CONCURRENCY_TIMEOUT_MS}ms`)),
      CONCURRENCY_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(!enabled)("PSR-P2 R-05 correction SHADOW writer", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];
  let prismaC: PrismaClient;

  beforeAll(async () => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
    prismaC = new PrismaClient({ datasourceUrl: integrityDatabaseUrl() });
    await prismaA.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION stell22_integrity_reject_im_insert()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."actorDisplaySnapshot" = '${REJECT_ACTOR}' THEN
          RAISE EXCEPTION 'integrity reject InventoryMovement insert';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prismaA.$executeRawUnsafe(`DROP TRIGGER IF EXISTS stell22_integrity_reject_im_insert ON "InventoryMovement"`);
    await prismaA.$executeRawUnsafe(`
      CREATE TRIGGER stell22_integrity_reject_im_insert
      BEFORE INSERT ON "InventoryMovement"
      FOR EACH ROW EXECUTE FUNCTION stell22_integrity_reject_im_insert();
    `);
  });

  beforeEach(async () => {
    adminState.current = {
      id: "integrity-admin",
      name: "Admin",
      email: "admin@test.local",
      role: "ADMIN",
    };
    await resetIntegrityCostFreeze(prismaA);
  });

  afterAll(async () => {
    await prismaA
      ?.$executeRawUnsafe(`DROP TRIGGER IF EXISTS stell22_integrity_reject_im_insert ON "InventoryMovement"`)
      .catch(() => {});
    await prismaA
      ?.$executeRawUnsafe(`DROP FUNCTION IF EXISTS stell22_integrity_reject_im_insert()`)
      .catch(() => {});
    await prismaA?.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`).catch(() => {});
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
    await prismaC?.$disconnect();
  });

  async function setShadowGate(active: boolean) {
    await prismaA.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, active);
    }, txOpts);
  }

  async function setCostFlowActive(active: boolean) {
    await prismaA.setting.upsert({
      where: { key: PRODUCTION_COST_FLOW_KEY },
      create: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active } },
      update: { value: { version: 1, active } },
    });
  }

  async function advisoryCounts() {
    const rows = await prismaA.$queryRaw<Array<{ mode: string; granted: boolean; n: bigint }>>`
      SELECT mode, granted, count(*)::bigint AS n
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}
        AND objid = ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}
      GROUP BY mode, granted
    `;
    const count = (mode: string, granted: boolean) =>
      Number(rows.find((row) => row.mode === mode && row.granted === granted)?.n ?? 0);
    return {
      sharedGranted: count("ShareLock", true),
      exclusiveGranted: count("ExclusiveLock", true),
      exclusiveWaiting: count("ExclusiveLock", false),
    };
  }

  async function seedOp(suffix: string, railsTaken = 10, remaining = 10, lotLengthM = "4") {
    const material = await prismaA.material.create({
      data: { name: `r05w-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        rateTorcovkaSort1: 10,
        rateTorcovkaSort2: 10,
      },
    });
    const batch = await prismaA.batch.create({
      data: {
        name: `batch-${suffix}`,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 10_000,
        totalCost: 10_000,
        priceSort1: 30_000,
        priceSort2: 20_000,
        purchaseDate: new Date("2026-01-15T00:00:00.000Z"),
        status: "IN_WORK",
      },
    });
    const lot = await prismaA.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: new Prisma.Decimal(lotLengthM),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: railsTaken + remaining,
        remainingQuantity: remaining,
      },
    });
    const op = await prismaA.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId: emp.id,
        clientRequestId: `test:r05w:seed:${suffix}`,
        batchId: batch.id,
        railLotId: lot.id,
        railsTaken,
        workDate: new Date("2026-09-01T00:00:00.000Z"),
        rateSnapshotVersion: 1,
        lines: {
          create: [
            {
              quantity: 4,
              blankLengthM: new Prisma.Decimal("1"),
              blankType: "POLKA",
              blankSort: "SORT1",
              blankMaterialId: material.id,
            },
          ],
        },
      },
    });
    await prismaA.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: new Prisma.Decimal("1"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 4,
      },
    });
    return { material, emp, batch, lot, op };
  }

  async function expectR05Movement(opts: {
    correctionId: string;
    railLotId: string;
    delta: number;
    reason: string;
    requestId: string;
    operationId: string;
    batchId: string;
    expectedOld: number;
    newTaken: number;
  }) {
    const rows = await prismaA.inventoryMovement.findMany({
      where: { causationKind: "PRODUCTION_OPERATION_MUTATION", causationId: opts.correctionId },
    });
    expect(rows).toHaveLength(1);
    const movement = rows[0]!;
    expect(movement.stockDomain).toBe("RAIL_LOT");
    expect(movement.kind).toBe("ADJUSTMENT");
    expect(movement.quantityDelta).toBe(opts.delta);
    expect(movement.railLotId).toBe(opts.railLotId);
    expect(movement.effectKey).toBe(r05CorrectionEffectKey(opts.railLotId));
    expect(movement.causationKind).toBe("PRODUCTION_OPERATION_MUTATION");
    expect(movement.causationId).toBe(opts.correctionId);
    expect(movement.actorKind).toBe("USER");
    expect(movement.userId).toBe(adminState.current.id);
    expect(movement.actorDisplaySnapshot).toBe(adminState.current.name);
    expect(movement.employeeId).toBeNull();
    expect(movement.systemActorKey).toBeNull();
    expect(movement.reason).toBe(opts.reason);
    expect(movement.authority).toBe("SHADOW");
    expect(movement.epochId).toBeNull();
    expect(movement.targetSnapshot).toEqual({ v: 1, d: "RAIL_LOT", railLotId: opts.railLotId });
    expect(movement.causationSnapshot).toEqual(
      r05CorrectionCausationSnapshotV1({
        id: opts.correctionId,
        requestId: opts.requestId,
        operationId: opts.operationId,
        railLotId: opts.railLotId,
        batchId: opts.batchId,
        expectedOldRailsTaken: opts.expectedOld,
        newRailsTaken: opts.newTaken,
        deltaReturned: opts.delta,
      }),
    );
    return movement;
  }

  it("SHADOW missing/inactive 10→7: one correction, RailLot +3, railsTaken=7, ChangeLog preserved, movements 0; replay stays 0", async () => {
    const seeded = await seedOp(`off-${Date.now()}`);
    const logsBefore = await prismaA.changeLog.count();
    const payload = {
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "over-entered",
      requestId: `r05w-off-${seeded.op.id}`,
    };
    const first = await correctTorcovkaRailsTaken(payload);
    expect(first.replayed).toBe(false);
    expect(first.deltaReturned).toBe(3);
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(13);
    expect((await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } })).railsTaken).toBe(7);
    expect(await prismaA.changeLog.count()).toBe(logsBefore + 1);
    expect(await prismaA.inventoryMovement.count()).toBe(0);

    const replay = await correctTorcovkaRailsTaken(payload);
    expect(replay.replayed).toBe(true);
    expect(replay.correctionId).toBe(first.correctionId);
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(13);
    expect(await prismaA.changeLog.count()).toBe(logsBefore + 1);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("SHADOW ACTIVE 10→7 writes exactly one RAIL_LOT ADJUSTMENT +3", async () => {
    const seeded = await seedOp(`on-${Date.now()}`);
    await setShadowGate(true);
    const reason = "canonical-reason";
    const result = await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason,
      requestId: `r05w-on-${seeded.op.id}`,
    });
    expect(result.replayed).toBe(false);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(13);
    expect((await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } })).railsTaken).toBe(7);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    await expectR05Movement({
      correctionId: result.correctionId,
      railLotId: seeded.lot.id,
      delta: 3,
      reason,
      requestId: result.requestId,
      operationId: seeded.op.id,
      batchId: seeded.batch.id,
      expectedOld: 10,
      newTaken: 7,
    });
  });

  it("SHADOW ACTIVE retry: same requestId replays with no second physical effect, ChangeLog, or movement", async () => {
    const seeded = await seedOp(`retry-${Date.now()}`);
    await setShadowGate(true);
    const payload = {
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "retry-me",
      requestId: `r05w-retry-${seeded.op.id}`,
    };
    const first = await correctTorcovkaRailsTaken(payload);
    const logs = await prismaA.changeLog.count();
    const replay = await correctTorcovkaRailsTaken(payload);
    expect(replay.replayed).toBe(true);
    expect(replay.correctionId).toBe(first.correctionId);
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(13);
    expect(await prismaA.changeLog.count()).toBe(logs);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });

  it("SHADOW OFF success then SHADOW ON replay does not backfill a movement", async () => {
    const seeded = await seedOp(`nobf-${Date.now()}`);
    const payload = {
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "no-backfill",
      requestId: `r05w-nobf-${seeded.op.id}`,
    };
    const first = await correctTorcovkaRailsTaken(payload);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    await setShadowGate(true);
    const replay = await correctTorcovkaRailsTaken(payload);
    expect(replay.replayed).toBe(true);
    expect(replay.correctionId).toBe(first.correctionId);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(13);
  });

  it("concurrent identical requestId: one correction, one physical effect, one movement, waiter replay", async () => {
    const seeded = await seedOp(`conc-${Date.now()}`);
    await setShadowGate(true);
    const payload = {
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "same-command",
      requestId: `r05w-conc-${seeded.op.id}`,
    };
    const settled = await withTimeout(
      Promise.allSettled([correctTorcovkaRailsTaken(payload), correctTorcovkaRailsTaken(payload)]),
      "concurrent identical writer",
    );
    const ok = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof correctTorcovkaRailsTaken>>
    >[];
    expect(ok).toHaveLength(2);
    expect(ok[0]!.value.correctionId).toBe(ok[1]!.value.correctionId);
    expect(ok.filter((s) => s.value.replayed)).toHaveLength(1);
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(13);
    expect(await prismaA.changeLog.count({ where: { entityId: seeded.op.id } })).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });

  it("concurrent different requestIds same expectedOld: winner one movement, loser STALE none; refreshed second movement", async () => {
    const seeded = await seedOp(`stale-${Date.now()}`);
    await setShadowGate(true);
    const settled = await withTimeout(
      Promise.allSettled([
        correctTorcovkaRailsTaken({
          operationId: seeded.op.id,
          expectedOldRailsTaken: 10,
          newRailsTaken: 8,
          reason: "A",
          requestId: `r05w-stale-a-${seeded.op.id}`,
        }),
        correctTorcovkaRailsTaken({
          operationId: seeded.op.id,
          expectedOldRailsTaken: 10,
          newRailsTaken: 6,
          reason: "B",
          requestId: `r05w-stale-b-${seeded.op.id}`,
        }),
      ]),
      "concurrent different writer",
    );
    const ok = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof correctTorcovkaRailsTaken>>
    >[];
    const failed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String(failed[0]!.reason)).toContain("STALE_CORRECTION");
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    const winner = ok[0]!.value;
    expect([6, 8]).toContain(winner.newRailsTaken);
    await expectR05Movement({
      correctionId: winner.correctionId,
      railLotId: seeded.lot.id,
      delta: winner.deltaReturned,
      reason: winner.newRailsTaken === 8 ? "A" : "B",
      requestId: winner.requestId,
      operationId: seeded.op.id,
      batchId: seeded.batch.id,
      expectedOld: 10,
      newTaken: winner.newRailsTaken,
    });

    const next = await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      expectedOldRailsTaken: winner.newRailsTaken,
      newRailsTaken: winner.newRailsTaken - 2,
      reason: "refreshed",
      requestId: `r05w-stale-c-${seeded.op.id}`,
    });
    expect(next.replayed).toBe(false);
    expect(next.deltaReturned).toBe(2);
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(2);
    expect(await prismaA.inventoryMovement.count()).toBe(2);
    const expectedRemaining = 10 + winner.deltaReturned + 2;
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(
      expectedRemaining,
    );
    expect((await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } })).railsTaken).toBe(
      winner.newRailsTaken - 2,
    );
  });

  it("REQUEST_ID_REUSE with altered payload does not mutate, correct, move, or extra ChangeLog", async () => {
    const seeded = await seedOp(`reuse-${Date.now()}`);
    await setShadowGate(true);
    const requestId = `r05w-reuse-${seeded.op.id}`;
    await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "original",
      requestId,
    });
    const logs = await prismaA.changeLog.count();
    const lotBefore = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        expectedOldRailsTaken: 10,
        newRailsTaken: 6,
        reason: "original",
        requestId,
      }),
    ).rejects.toThrow(REQUEST_ID_REUSE);
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        expectedOldRailsTaken: 9,
        newRailsTaken: 7,
        reason: "original",
        requestId,
      }),
    ).rejects.toThrow(REQUEST_ID_REUSE);
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        expectedOldRailsTaken: 10,
        newRailsTaken: 7,
        reason: "other-reason",
        requestId,
      }),
    ).rejects.toThrow(REQUEST_ID_REUSE);
    adminState.current = { ...adminState.current, id: "other-admin" };
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        expectedOldRailsTaken: 10,
        newRailsTaken: 7,
        reason: "original",
        requestId,
      }),
    ).rejects.toThrow(REQUEST_ID_REUSE);
    adminState.current = { ...adminState.current, id: "integrity-admin" };
    const other = await seedOp(`reuse-other-${Date.now()}`);
    await expect(
      correctTorcovkaRailsTaken({
        operationId: other.op.id,
        expectedOldRailsTaken: 10,
        newRailsTaken: 7,
        reason: "original",
        requestId,
      }),
    ).rejects.toThrow(REQUEST_ID_REUSE);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(
      lotBefore.remainingQuantity,
    );
    expect((await prismaA.productionOperation.findUniqueOrThrow({ where: { id: other.op.id } })).railsTaken).toBe(10);
    expect(await prismaA.productionOperationCorrection.count({ where: { requestId } })).toBe(1);
    expect(await prismaA.changeLog.count()).toBe(logs);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });

  it("malformed SHADOW gate fails before request-lock effects, correction, physical mutation, ChangeLog, movement", async () => {
    const seeded = await seedOp(`bad-${Date.now()}`);
    await prismaA.setting.upsert({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
      create: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value: { version: 99, active: true } },
      update: { value: { version: 99, active: true } },
    });
    const logsBefore = await prismaA.changeLog.count();
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        expectedOldRailsTaken: 10,
        newRailsTaken: 7,
        reason: "malformed",
        requestId: `r05w-bad-${seeded.op.id}`,
      }),
    ).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(0);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(10);
    expect((await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } })).railsTaken).toBe(10);
    expect(await prismaA.changeLog.count()).toBe(logsBefore);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("READ COMMITTED second requestId lookup sees a concurrently committed retained row and replays", async () => {
    const seeded = await seedOp(`rc-${Date.now()}`);
    const requestId = `r05w-rc-${seeded.op.id}`;
    const reason = "legacy-insert";
    const hold = { release: () => {}, ready: false, pid: 0 };
    const holding = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      const pid = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
      hold.pid = pid[0]!.pid;
      await lockProductionOperations(tx, [seeded.op.id]);
      hold.ready = true;
      await holding;
    }, { maxWait: 30_000, timeout: 30_000 });
    await waitUntil(() => hold.ready, "operation held");
    const waiter = correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason,
      requestId,
    });
    await waitUntil(async () => (await advisoryCounts()).sharedGranted >= 1, "SHARED granted");
    await waitUntil(async () => {
      const activity = await prismaA.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.wait_event_type = 'Lock'
          AND a.pid <> ${hold.pid}
      `;
      return (activity[0]?.n ?? 0) >= 1;
    }, "waiter blocked on later business lock");
    await prismaC.productionOperationCorrection.create({
      data: {
        requestId,
        operationId: seeded.op.id,
        adminUserId: "integrity-admin",
        railLotId: seeded.lot.id,
        batchId: seeded.batch.id,
        expectedOldRailsTaken: 10,
        newRailsTaken: 7,
        deltaReturned: 3,
        reason,
      },
    });
    hold.release();
    await holder;
    const result = await waiter;
    expect(result.replayed).toBe(true);
    expect(await prismaA.productionOperationCorrection.count({ where: { requestId } })).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(10);
    expect((await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } })).railsTaken).toBe(10);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("gate-flip: SHARED taken before business lock; EXCLUSIVE waits; correction then gate OFF", async () => {
    const seeded = await seedOp(`flip-${Date.now()}`);
    await setShadowGate(true);
    const hold = { release: () => {}, ready: false };
    const holding = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      await lockProductionOperations(tx, [seeded.op.id]);
      hold.ready = true;
      await holding;
    }, txOpts);
    await waitUntil(() => hold.ready, "operation held");
    const submit = correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "gate-flip",
      requestId: `r05w-flip-${seeded.op.id}`,
    });
    await waitUntil(async () => (await advisoryCounts()).sharedGranted >= 1, "SHARED granted");
    let gateFinished = false;
    const gateOff = prismaC
      .$transaction(async (tx) => {
        await setInventoryMovementShadowWriteGate(tx, false);
        gateFinished = true;
        return true;
      }, txOpts)
      .catch((err) => err as Error);
    await waitUntil(async () => (await advisoryCounts()).exclusiveWaiting >= 1, "EXCLUSIVE waiting");
    expect(gateFinished).toBe(false);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(10);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    hold.release();
    await holder;
    const result = await submit;
    await gateOff;
    expect(gateFinished).toBe(true);
    expect(result.replayed).toBe(false);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(13);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    const gate = await prismaA.setting.findUniqueOrThrow({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
    });
    expect(gate.value).toMatchObject({ version: 1, active: false });
  });

  it("movement-layer INSERT reject rolls back correction, RailLot, op, ChangeLog, and movement", async () => {
    const seeded = await seedOp(`rb-${Date.now()}`);
    await setShadowGate(true);
    adminState.current = { ...adminState.current, name: REJECT_ACTOR };
    const logsBefore = await prismaA.changeLog.count();
    const lotBefore = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const opBefore = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const batchBefore = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        expectedOldRailsTaken: 10,
        newRailsTaken: 7,
        reason: "rollback",
        requestId: `r05w-rb-${seeded.op.id}`,
      }),
    ).rejects.toThrow(/integrity reject InventoryMovement insert/);
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(0);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } })).remainingQuantity).toBe(
      lotBefore.remainingQuantity,
    );
    expect((await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } })).railsTaken).toBe(
      opBefore.railsTaken,
    );
    expect(await prismaA.changeLog.count()).toBe(logsBefore);
    const batchAfter = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    expect(batchAfter.status).toBe(batchBefore.status);
    expect(batchAfter.closedAt).toEqual(batchBefore.closedAt);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("non-UTC session stores correction.recordedAt and movement.effectiveAt as the same UTC instant", async () => {
    const seeded = await seedOp(`tz-${Date.now()}`);
    await setShadowGate(true);
    const actor = userMovementActorFromAdmin(adminState.current);
    const requestId = `r05w-tz-${seeded.op.id}`;
    await prismaA.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/New_York'`);
        const tz = await tx.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`;
        expect(tz[0]?.tz).toBe("America/New_York");
        await correctTorcovkaRailsTakenInTransaction(tx, {
          actor,
          operationId: seeded.op.id,
          requestId,
          expectedOldRailsTaken: 10,
          newRailsTaken: 7,
          deltaReturned: 3,
          reason: "tz",
        });
      },
      { ...txOpts, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    const correction = await prismaA.productionOperationCorrection.findUniqueOrThrow({ where: { requestId } });
    const movement = await prismaA.inventoryMovement.findFirstOrThrow({
      where: { causationId: correction.id },
    });
    const db = await prismaA.$queryRaw<Array<{ recorded_utc: string; effective: string }>>`
      SELECT
        to_char((c."recordedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS recorded_utc,
        to_char(m."effectiveAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS effective
      FROM "ProductionOperationCorrection" c
      JOIN "InventoryMovement" m ON m."causationId" = c.id
      WHERE c.id = ${correction.id}
      LIMIT 1
    `;
    expect(db[0]?.recorded_utc).toBe(db[0]?.effective);
    expect(utcNaiveTimestampString(correction.recordedAt)).toBe(db[0]?.effective);
    expect(correction.recordedAt.toISOString()).toBe(movement.effectiveAt.toISOString());
  });

  it("ACTIVE cost-flow 10→7 keeps monetary semantics and still emits RAIL_LOT +3", async () => {
    await setCostFlowActive(true);
    const suffix = `cf-${Date.now()}`;
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        rateTorcovkaSort1: 12,
        rateTorcovkaSort2: 8,
      },
    });
    const batch = await prismaA.batch.create({
      data: {
        name: `batch-${suffix}`,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 10_000,
        totalCost: 10_000,
        priceSort1: 30_000,
        priceSort2: 20_000,
        purchaseDate: new Date("2026-01-15T00:00:00.000Z"),
        status: "IN_WORK",
      },
    });
    const lot = await prismaA.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: new Prisma.Decimal("2"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: 10,
        remainingQuantity: 10,
        initialValue: new Prisma.Decimal("10000.000001"),
        remainingValue: new Prisma.Decimal("10000.000001"),
      },
    });
    const input = {
      employeeId: emp.id,
      batchId: batch.id,
      railLotId: lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1.8, sort: "SORT1" as const, quantity: 7 }],
      clientRequestId: `r05w-cf-torc-${suffix}`,
    };
    let created = await submitTorcovka(input);
    if (created.status === "ACK_REQUIRED") {
      created = await submitTorcovka({
        ...input,
        plausibilityAck: {
          kind: "SUSPICIOUS",
          railsTaken: created.railsTaken,
          takenM: created.takenM,
          producedM: created.producedM,
          wastePct: created.wastePct,
        },
      });
    }
    expect(created.status).toBe("CREATED");
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: lot.id },
      include: { lines: true },
    });
    const lotAfterTorc = await prismaA.railLot.findUniqueOrThrow({ where: { id: lot.id } });
    const blankAfterTorc = await prismaA.blankStock.findUnique({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId: material.id,
          lengthM: 1.8,
          detailType: "POLKA",
          sort: "SORT1",
        },
      },
    });
    const oldConsumed = d(op.consumedRawValue)!;
    const oldLabor = d(op.pieceLaborCost)!;
    const split = consumeRailValue({
      remainingQuantity: 10,
      remainingValue: oldConsumed,
      railsTaken: 7,
    });
    await setShadowGate(true);
    const result = await correctTorcovkaRailsTaken({
      operationId: op.id,
      expectedOldRailsTaken: op.railsTaken ?? 10,
      newRailsTaken: 7,
      reason: "over-entered rails",
      requestId: `r05w-cf-${suffix}`,
    });
    const lotAfter = await prismaA.railLot.findUniqueOrThrow({ where: { id: lot.id } });
    const opAfter = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    const blank = await prismaA.blankStock.findUnique({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId: material.id,
          lengthM: 1.8,
          detailType: "POLKA",
          sort: "SORT1",
        },
      },
    });
    expect(opAfter.railsTaken).toBe(7);
    expect(d(opAfter.consumedRawValue)!.equals(split.consumedRawValue)).toBe(true);
    expect(d(opAfter.consumedRawValue)!.plus(split.newRemainingValue).equals(oldConsumed)).toBe(true);
    expect(lotAfter.remainingQuantity).toBe(lotAfterTorc.remainingQuantity + 3);
    expect(d(lotAfter.remainingValue)!.equals(d(lotAfterTorc.remainingValue)!.plus(split.newRemainingValue))).toBe(
      true,
    );
    expect(blank?.quantity).toBe(blankAfterTorc?.quantity);
    expect(d(blank?.laborValue)!.equals(d(blankAfterTorc?.laborValue)!)).toBe(true);
    expect(d(opAfter.pieceLaborCost)!.equals(oldLabor)).toBe(true);
    expect(await prismaA.inventoryMovement.count({ where: { causationKind: "PRODUCTION_OPERATION_MUTATION" } })).toBe(
      1,
    );
    await expectR05Movement({
      correctionId: result.correctionId,
      railLotId: lot.id,
      delta: 3,
      reason: "over-entered rails",
      requestId: result.requestId,
      operationId: op.id,
      batchId: batch.id,
      expectedOld: 10,
      newTaken: 7,
    });
  });
});
