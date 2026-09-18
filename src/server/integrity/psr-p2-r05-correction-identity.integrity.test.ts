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
  requireTerminalEmployee: async () => {},
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { correctTorcovkaRailsTaken } from "@/server/production";
import {
  REQUEST_ID_REUSE,
  STALE_CORRECTION,
} from "@/server/internal/production-operation-correction";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityCostFreeze,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const CONCURRENCY_TIMEOUT_MS = 20_000;

function isCheckViolation(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return code === "P2004" || code === "23514" || /23514/.test(text) || /check constraint/i.test(text);
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

describe.skipIf(!enabled)("PSR-P2 R-05 ProductionOperationCorrection", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA } = createIntegrityClients());
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
    await prismaA?.$disconnect();
  });

  async function seedOp(suffix: string, railsTaken = 10, remaining = 10, lotLengthM = "4") {
    const material = await prismaA.material.create({
      data: { name: `r05-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
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
        clientRequestId: `test:r05:seed:${suffix}`,
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

  it("A: 10→7 one correction, RailLot +3, one ChangeLog", async () => {
    const seeded = await seedOp(`a-${Date.now()}`);
    const logsBefore = await prismaA.changeLog.count();
    const result = await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "over-entered",
      requestId: `r05-a-${seeded.op.id}`,
    });
    expect(result.replayed).toBe(false);
    expect(result.deltaReturned).toBe(3);
    expect(result.oldRailsTaken).toBe(10);
    expect(result.newRailsTaken).toBe(7);
    expect(result.operationId).toBe(seeded.op.id);
    const rows = await prismaA.productionOperationCorrection.findMany({
      where: { operationId: seeded.op.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(result.correctionId);
    expect(rows[0]!.deltaReturned).toBe(3);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    expect(lot.remainingQuantity).toBe(13);
    expect(op.railsTaken).toBe(7);
    expect(await prismaA.changeLog.count()).toBe(logsBefore + 1);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("B: sequential 10→8 then 8→6 two identities, RailLot +4", async () => {
    const seeded = await seedOp(`b-${Date.now()}`);
    const first = await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 8,
      reason: "first",
      requestId: `r05-b1-${seeded.op.id}`,
    });
    const second = await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      expectedOldRailsTaken: 8,
      newRailsTaken: 6,
      reason: "second",
      requestId: `r05-b2-${seeded.op.id}`,
    });
    expect(first.correctionId).not.toBe(second.correctionId);
    expect(first.requestId).not.toBe(second.requestId);
    expect(second.replayed).toBe(false);
    const rows = await prismaA.productionOperationCorrection.findMany({
      where: { operationId: seeded.op.id },
    });
    expect(rows).toHaveLength(2);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    expect(lot.remainingQuantity).toBe(14);
    expect(op.railsTaken).toBe(6);
  });

  it("C: identical retry after success is replayed, no physical duplicate", async () => {
    const seeded = await seedOp(`c-${Date.now()}`);
    const payload = {
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "retry-me",
      requestId: `r05-c-${seeded.op.id}`,
    };
    const first = await correctTorcovkaRailsTaken(payload);
    const logs = await prismaA.changeLog.count();
    const second = await correctTorcovkaRailsTaken(payload);
    expect(second.replayed).toBe(true);
    expect(second.correctionId).toBe(first.correctionId);
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(1);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    expect(lot.remainingQuantity).toBe(13);
    expect(op.railsTaken).toBe(7);
    expect(await prismaA.changeLog.count()).toBe(logs);
  });

  it("D: concurrent identical requestId converges on one identity", async () => {
    const seeded = await seedOp(`d-${Date.now()}`);
    const payload = {
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "same-command",
      requestId: `r05-d-${seeded.op.id}`,
    };
    const settled = await withTimeout(
      Promise.allSettled([correctTorcovkaRailsTaken(payload), correctTorcovkaRailsTaken(payload)]),
      "concurrent identical",
    );
    const ok = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof correctTorcovkaRailsTaken>>
    >[];
    expect(ok).toHaveLength(2);
    expect(ok[0]!.value.correctionId).toBe(ok[1]!.value.correctionId);
    expect(ok.filter((s) => s.value.replayed)).toHaveLength(1);
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(1);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    expect(lot.remainingQuantity).toBe(13);
    expect(await prismaA.changeLog.count({ where: { entityId: seeded.op.id } })).toBe(1);
  });

  it("E: concurrent different expectedOld=10 commands: one success, one STALE", async () => {
    const seeded = await seedOp(`e-${Date.now()}`);
    const settled = await withTimeout(
      Promise.allSettled([
        correctTorcovkaRailsTaken({
          operationId: seeded.op.id,
          expectedOldRailsTaken: 10,
          newRailsTaken: 8,
          reason: "A",
          requestId: `r05-e-a-${seeded.op.id}`,
        }),
        correctTorcovkaRailsTaken({
          operationId: seeded.op.id,
          expectedOldRailsTaken: 10,
          newRailsTaken: 6,
          reason: "B",
          requestId: `r05-e-b-${seeded.op.id}`,
        }),
      ]),
      "concurrent different",
    );
    const ok = settled.filter((s) => s.status === "fulfilled");
    const failed = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(String(failed[0]!.reason)).toContain("STALE_CORRECTION");
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(1);
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    expect([6, 8]).toContain(op.railsTaken);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    if (op.railsTaken === 8) expect(lot.remainingQuantity).toBe(12);
    if (op.railsTaken === 6) expect(lot.remainingQuantity).toBe(14);
  });

  it("F: after stale winner 10→8, refreshed 8→6 with new requestId succeeds", async () => {
    const seeded = await seedOp(`f-${Date.now()}`);
    await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 8,
      reason: "winner",
      requestId: `r05-f1-${seeded.op.id}`,
    });
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        expectedOldRailsTaken: 10,
        newRailsTaken: 6,
        reason: "stale",
        requestId: `r05-f2-${seeded.op.id}`,
      }),
    ).rejects.toThrow(STALE_CORRECTION);
    const next = await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      expectedOldRailsTaken: 8,
      newRailsTaken: 6,
      reason: "refreshed",
      requestId: `r05-f3-${seeded.op.id}`,
    });
    expect(next.replayed).toBe(false);
    expect(next.deltaReturned).toBe(2);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    expect(lot.remainingQuantity).toBe(14);
    expect(op.railsTaken).toBe(6);
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(2);
  });

  it("G: requestId reuse with different payload is rejected and does not mutate", async () => {
    const seeded = await seedOp(`g-${Date.now()}`);
    const requestId = `r05-g-${seeded.op.id}`;
    await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "original",
      requestId,
    });
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
    const other = await seedOp(`g-other-${Date.now()}`);
    await expect(
      correctTorcovkaRailsTaken({
        operationId: other.op.id,
        expectedOldRailsTaken: 10,
        newRailsTaken: 7,
        reason: "original",
        requestId,
      }),
    ).rejects.toThrow(REQUEST_ID_REUSE);
    const otherOp = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: other.op.id } });
    const otherLot = await prismaA.railLot.findUniqueOrThrow({ where: { id: other.lot.id } });
    expect(otherOp.railsTaken).toBe(10);
    expect(otherLot.remainingQuantity).toBe(10);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    expect(lot.remainingQuantity).toBe(lotBefore.remainingQuantity);
    expect(await prismaA.productionOperationCorrection.count({ where: { requestId } })).toBe(1);
  });

  it("H: paid/frozen after commit still replays; new request is rejected", async () => {
    const seeded = await seedOp(`h-${Date.now()}`);
    const payload = {
      operationId: seeded.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "then-paid",
      requestId: `r05-h-${seeded.op.id}`,
    };
    const first = await correctTorcovkaRailsTaken(payload);
    await prismaA.productionOperation.update({
      where: { id: seeded.op.id },
      data: { isPaid: true, paidAt: new Date("2026-09-02T00:00:00.000Z") },
    });
    const replay = await correctTorcovkaRailsTaken(payload);
    expect(replay.replayed).toBe(true);
    expect(replay.correctionId).toBe(first.correctionId);
    await expect(
      correctTorcovkaRailsTaken({
        ...payload,
        expectedOldRailsTaken: 7,
        newRailsTaken: 6,
        requestId: `r05-h-new-${seeded.op.id}`,
        reason: "new after paid",
      }),
    ).rejects.toThrow("Нельзя исправить — операция уже выплачена");

    const frozen = await seedOp(`h-fr-${Date.now()}`);
    const frozenPayload = {
      operationId: frozen.op.id,
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      reason: "then-frozen",
      requestId: `r05-hfr-${frozen.op.id}`,
    };
    await correctTorcovkaRailsTaken(frozenPayload);
    await prismaA.batch.update({
      where: { id: frozen.batch.id },
      data: { frozenAt: new Date("2026-09-02T00:00:00.000Z") },
    });
    const frozenReplay = await correctTorcovkaRailsTaken(frozenPayload);
    expect(frozenReplay.replayed).toBe(true);
    await expect(
      correctTorcovkaRailsTaken({
        ...frozenPayload,
        expectedOldRailsTaken: 7,
        newRailsTaken: 6,
        requestId: `r05-hfr-new-${frozen.op.id}`,
        reason: "new after freeze",
      }),
    ).rejects.toThrow("Нельзя исправить — себестоимость партии заморожена");
  });

  it("I: length guard rejects with no retained correction", async () => {
    const seeded = await seedOp(`i-${Date.now()}`, 20, 10, "1");
    const logsBefore = await prismaA.changeLog.count();
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        expectedOldRailsTaken: 20,
        newRailsTaken: 1,
        reason: "too far",
        requestId: `r05-i-${seeded.op.id}`,
      }),
    ).rejects.toThrow("Суммарная длина заготовок превышает длину взятых реек");
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(0);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    expect(lot.remainingQuantity).toBe(10);
    expect(op.railsTaken).toBe(20);
    expect(await prismaA.changeLog.count()).toBe(logsBefore);
  });

  it("J: failed command leaves no correction/RailLot/op/ChangeLog mutation", async () => {
    const seeded = await seedOp(`j-${Date.now()}`);
    const logsBefore = await prismaA.changeLog.count();
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        expectedOldRailsTaken: 9,
        newRailsTaken: 7,
        reason: "stale-window",
        requestId: `r05-j-${seeded.op.id}`,
      }),
    ).rejects.toThrow(STALE_CORRECTION);
    expect(await prismaA.productionOperationCorrection.count({ where: { operationId: seeded.op.id } })).toBe(0);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    expect(lot.remainingQuantity).toBe(10);
    expect(op.railsTaken).toBe(10);
    expect(await prismaA.changeLog.count()).toBe(logsBefore);
  });

  it("K: table starts empty; CHECKs enforced; no InventoryMovement writer", async () => {
    expect(await prismaA.productionOperationCorrection.count()).toBe(0);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    const base = {
      id: "corr-bad",
      requestId: "req-bad",
      operationId: "op-x",
      adminUserId: "admin-x",
      railLotId: "lot-x",
      batchId: "batch-x",
    };
    await expect(
      prismaA.$executeRaw`
        INSERT INTO "ProductionOperationCorrection"
          ("id","requestId","operationId","adminUserId","railLotId","batchId",
           "expectedOldRailsTaken","newRailsTaken","deltaReturned","reason")
        VALUES
          (${base.id}, ${base.requestId}, ${base.operationId}, ${base.adminUserId},
           ${base.railLotId}, ${base.batchId}, 10, 7, 2, 'delta mismatch')
      `,
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      prismaA.$executeRaw`
        INSERT INTO "ProductionOperationCorrection"
          ("id","requestId","operationId","adminUserId","railLotId","batchId",
           "expectedOldRailsTaken","newRailsTaken","deltaReturned","reason")
        VALUES
          ('corr-blank', 'req-blank', 'op-x', 'admin-x', 'lot-x', 'batch-x', 10, 7, 3, '   ')
      `,
    ).rejects.toSatisfy(isCheckViolation);
    await expect(
      prismaA.$executeRaw`
        INSERT INTO "ProductionOperationCorrection"
          ("id","requestId","operationId","adminUserId","railLotId","batchId",
           "expectedOldRailsTaken","newRailsTaken","deltaReturned","reason")
        VALUES
          ('corr-zero', 'req-zero', 'op-x', 'admin-x', 'lot-x', 'batch-x', 10, 0, 10, 'zero new')
      `,
    ).rejects.toSatisfy(isCheckViolation);
  });
});
