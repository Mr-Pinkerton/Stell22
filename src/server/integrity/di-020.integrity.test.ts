vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/server/session", () => ({
  requireAdmin: async () => {},
  requireTerminalEmployee: async () => {},
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { writeOffBatchRemainder } from "@/server/purchases";
import { correctTorcovkaRailsTaken, deleteProductionOperation } from "@/server/production";
import { submitTorcovka } from "@/server/terminal";
import { archiveBatchIfDepleted } from "@/server/internal/cost";
import { lockBatches, lockRailLots } from "@/server/internal/finance-operations";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityCostFreeze,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const CONCURRENCY_TIMEOUT_MS = 20_000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

describe.skipIf(!enabled)("DI-020 TORCOVKA input safety", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityCostFreeze(prismaA);
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
  });

  async function seedWorld(opts: {
    suffix: string;
    lotLengthM: string;
    lotQty: number;
    remaining: number;
    closed?: boolean;
    frozen?: boolean;
  }) {
    const material = await prismaA.material.create({
      data: {
        name: `mat-${opts.suffix}`,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
      },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${opts.suffix}`,
        pin: "1234",
        rateTorcovkaSort1: 10,
        rateTorcovkaSort2: 10,
      },
    });
    const batch = await prismaA.batch.create({
      data: {
        name: `batch-${opts.suffix}`,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 10_000,
        totalCost: 10_000,
        priceSort1: 30_000,
        priceSort2: 20_000,
        purchaseDate: new Date("2026-01-15T00:00:00.000Z"),
        status: opts.closed ? "ARCHIVED" : "IN_WORK",
        closedAt: opts.closed ? new Date("2026-09-01T00:00:00.000Z") : null,
        frozenAt: opts.frozen ? new Date("2026-09-01T00:00:00.000Z") : null,
      },
    });
    const lot = await prismaA.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: new Prisma.Decimal(opts.lotLengthM),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: opts.lotQty,
        remainingQuantity: opts.remaining,
      },
    });
    return { material, emp, batch, lot };
  }

  async function seedExistingOp(opts: {
    suffix: string;
    railsTaken: number;
    remaining: number;
    blankQty: number;
    blankLengthM: string;
    lotLengthM: string;
    closed?: boolean;
    frozen?: boolean;
    paid?: boolean;
  }) {
    const world = await seedWorld({
      suffix: opts.suffix,
      lotLengthM: opts.lotLengthM,
      lotQty: opts.railsTaken + opts.remaining,
      remaining: opts.remaining,
      closed: opts.closed,
      frozen: opts.frozen,
    });
    const op = await prismaA.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId: world.emp.id,
        batchId: world.batch.id,
        railLotId: world.lot.id,
        railsTaken: opts.railsTaken,
        workDate: new Date("2026-09-01T00:00:00.000Z"),
        isPaid: opts.paid ?? false,
        paidAt: opts.paid ? new Date("2026-09-02T00:00:00.000Z") : null,
        torcovkaSubmitAckBand: "HIGH_WASTE",
        torcovkaSubmitWasteReason: "KNOTS",
        lines: {
          create: [
            {
              quantity: opts.blankQty,
              blankLengthM: new Prisma.Decimal(opts.blankLengthM),
              blankType: "POLKA",
              blankSort: "SORT1",
              blankMaterialId: world.material.id,
            },
          ],
        },
      },
    });
    const stock = await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal(opts.blankLengthM),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: opts.blankQty,
      },
    });
    return { ...world, op, stock };
  }

  it("1: waste 10% no ack → CREATED, submit fields null", async () => {
    const w = await seedWorld({
      suffix: `s1-${Date.now()}`,
      lotLengthM: "2",
      lotQty: 20,
      remaining: 20,
    });
    const result = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: `s1-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 5,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: 9 }],
    });
    expect(result).toEqual({ status: "CREATED" });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: w.lot.id },
    });
    expect(op.torcovkaSubmitAckBand).toBeNull();
    expect(op.torcovkaSubmitWasteReason).toBeNull();
    expect(op.torcovkaSubmitWasteNote).toBeNull();
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } });
    expect(lot.remainingQuantity).toBe(15);
  });

  it("2: waste 30% no ack → ACK_REQUIRED, no Op, remaining unchanged", async () => {
    const w = await seedWorld({
      suffix: `s2-${Date.now()}`,
      lotLengthM: "2",
      lotQty: 20,
      remaining: 20,
    });
    const result = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: `s2-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 5,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: 7 }],
    });
    expect(result.status).toBe("ACK_REQUIRED");
    if (result.status !== "ACK_REQUIRED") return;
    expect(result.band).toBe("SUSPICIOUS");
    expect(result.takenM).toBe("10.0000");
    expect(result.producedM).toBe("7.0000");
    expect(result.wastePct).toBe("30.00");
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(0);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } });
    expect(lot.remainingQuantity).toBe(20);
    expect(await prismaA.blankStock.count({ where: { materialId: w.material.id } })).toBe(0);
    expect(await prismaA.changeLog.count({ where: { entity: "ProductionOperation" } })).toBe(0);
  });

  it("3: waste 30% + SUSPICIOUS echo → CREATED, ack band persisted", async () => {
    const w = await seedWorld({
      suffix: `s3-${Date.now()}`,
      lotLengthM: "2",
      lotQty: 20,
      remaining: 20,
    });
    const requestId = `s3-${Date.now()}`;
    const first = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: requestId,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 5,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: 7 }],
    });
    expect(first.status).toBe("ACK_REQUIRED");
    if (first.status !== "ACK_REQUIRED") return;
    const created = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: requestId,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 5,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: 7 }],
      plausibilityAck: {
        kind: "SUSPICIOUS",
        railsTaken: first.railsTaken,
        takenM: first.takenM,
        producedM: first.producedM,
        wastePct: first.wastePct,
      },
    });
    expect(created).toEqual({ status: "CREATED" });
    const ops = await prismaA.productionOperation.findMany({
      where: { railLotId: w.lot.id },
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].clientRequestId).toBe(requestId);
    expect(ops[0].torcovkaSubmitAckBand).toBe("SUSPICIOUS");
    expect(ops[0].torcovkaSubmitWasteReason).toBeNull();
  });

  it("4: waste 73% no ack → ACK_REQUIRED EXTREME; SUSPICIOUS retry throws, still no Op", async () => {
    const w = await seedWorld({
      suffix: `s4-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = {
      employeeId: w.emp.id,
      clientRequestId: `s4-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 27 }],
    };
    const first = await submitTorcovka(input);
    expect(first.status).toBe("ACK_REQUIRED");
    if (first.status !== "ACK_REQUIRED") return;
    expect(first.band).toBe("EXTREME");
    await expect(
      submitTorcovka({
        ...input,
        plausibilityAck: {
          kind: "SUSPICIOUS",
          railsTaken: first.railsTaken,
          takenM: first.takenM,
          producedM: first.producedM,
          wastePct: first.wastePct,
        },
      }),
    ).rejects.toThrow();
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(0);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } });
    expect(lot.remainingQuantity).toBe(20);
  });

  it("5: waste 73% + HIGH_WASTE KNOTS echo → CREATED, reason persisted", async () => {
    const w = await seedWorld({
      suffix: `s5-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const requestId = `s5-${Date.now()}`;
    const first = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: requestId,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: 27 }],
    });
    expect(first.status).toBe("ACK_REQUIRED");
    if (first.status !== "ACK_REQUIRED") return;
    const created = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: requestId,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: 27 }],
      plausibilityAck: {
        kind: "HIGH_WASTE",
        railsTaken: first.railsTaken,
        takenM: first.takenM,
        producedM: first.producedM,
        wastePct: first.wastePct,
        reason: "KNOTS",
      },
    });
    expect(created).toEqual({ status: "CREATED" });
    const ops = await prismaA.productionOperation.findMany({
      where: { railLotId: w.lot.id },
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].clientRequestId).toBe(requestId);
    expect(ops[0].torcovkaSubmitAckBand).toBe("HIGH_WASTE");
    expect(ops[0].torcovkaSubmitWasteReason).toBe("KNOTS");
  });

  it("6: confirmed:true / mismatched echo do not create Op", async () => {
    const w = await seedWorld({
      suffix: `s6-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = {
      employeeId: w.emp.id,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 27 }],
    };
    const first = await submitTorcovka({ ...input, clientRequestId: `s6-a-${Date.now()}` });
    expect(first.status).toBe("ACK_REQUIRED");
    await expect(
      submitTorcovka({
        ...input,
        clientRequestId: `s6-b-${Date.now()}`,
        plausibilityAck: { confirmed: true } as never,
      }),
    ).rejects.toThrow();
    if (first.status === "ACK_REQUIRED") {
      await expect(
        submitTorcovka({
          ...input,
          clientRequestId: `s6-c-${Date.now()}`,
          plausibilityAck: {
            kind: "HIGH_WASTE",
            railsTaken: first.railsTaken,
            takenM: "100.0001",
            producedM: first.producedM,
            wastePct: first.wastePct,
            reason: "KNOTS",
          },
        }),
      ).rejects.toThrow();
    }
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(0);
  });

  it("7: correction 20 → 4 returns rails, blanks and submit ack fields unchanged", async () => {
    const seeded = await seedExistingOp({
      suffix: `c7-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
    });
    await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      newRailsTaken: 4,
      reason: "ошиблись количеством",
    });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const stock = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: seeded.material.id },
    });
    const line = await prismaA.operationDetailLine.findFirstOrThrow({
      where: { operationId: seeded.op.id },
    });
    expect(op.railsTaken).toBe(4);
    expect(lot.remainingQuantity).toBe(26);
    expect(stock.quantity).toBe(4);
    expect(line.quantity).toBe(4);
    expect(op.torcovkaSubmitAckBand).toBe("HIGH_WASTE");
    expect(op.torcovkaSubmitWasteReason).toBe("KNOTS");
  });

  it("8: correction that breaks INV-008 is rejected with no writes", async () => {
    const seeded = await seedExistingOp({
      suffix: `c8-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 10,
      blankLengthM: "1",
      lotLengthM: "1",
    });
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        newRailsTaken: 4,
        reason: "too far",
      }),
    ).rejects.toThrow("Суммарная длина заготовок превышает длину взятых реек");
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    expect(op.railsTaken).toBe(20);
    expect(lot.remainingQuantity).toBe(10);
    expect(op.torcovkaSubmitAckBand).toBe("HIGH_WASTE");
  });

  it("9: paid + not frozen: correction allowed, Payment unchanged", async () => {
    const seeded = await seedExistingOp({
      suffix: `c9-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
      paid: true,
    });
    const payment = await prismaA.payment.create({
      data: {
        employeeId: seeded.emp.id,
        amount: 40,
        items: { create: [{ operationId: seeded.op.id }] },
      },
    });
    await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      newRailsTaken: 4,
      reason: "paid ok",
    });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const pay = await prismaA.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(op.isPaid).toBe(true);
    expect(op.railsTaken).toBe(4);
    expect(Number(pay.amount)).toBe(40);
    expect(op.torcovkaSubmitAckBand).toBe("HIGH_WASTE");
  });

  it("10: frozen batch: correction rejected, FINAL unchanged", async () => {
    const seeded = await seedExistingOp({
      suffix: `c10-${Date.now()}`,
      railsTaken: 20,
      remaining: 0,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
      closed: true,
      frozen: true,
    });
    const final = await prismaA.batchCost.create({
      data: {
        batchId: seeded.batch.id,
        status: "FINAL",
        volumeSort1: 1,
        volumeSort2: 0,
        costSort1: 10_000,
        costSort2: 0,
        pricePerM3Sort1: 10_000,
        pricePerM3Sort2: 0,
      },
    });
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        newRailsTaken: 4,
        reason: "frozen",
      }),
    ).rejects.toThrow("Нельзя исправить — себестоимость партии заморожена");
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const cost = await prismaA.batchCost.findUniqueOrThrow({ where: { id: final.id } });
    expect(op.railsTaken).toBe(20);
    expect(lot.remainingQuantity).toBe(0);
    expect(cost.status).toBe("FINAL");
    expect(Number(cost.costSort1)).toBe(10_000);
  });

  it("11: reopen after depletion and after write-off", async () => {
    const depleted = await seedExistingOp({
      suffix: `c11d-${Date.now()}`,
      railsTaken: 20,
      remaining: 0,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
      closed: true,
    });
    await correctTorcovkaRailsTaken({
      operationId: depleted.op.id,
      newRailsTaken: 4,
      reason: "reopen depletion",
    });
    const dBatch = await prismaA.batch.findUniqueOrThrow({ where: { id: depleted.batch.id } });
    expect(dBatch.status).toBe("IN_WORK");
    expect(dBatch.closedAt).toBeNull();

    const written = await seedExistingOp({
      suffix: `c11w-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
    });
    await writeOffBatchRemainder(written.batch.id);
    const archived = await prismaA.batch.findUniqueOrThrow({ where: { id: written.batch.id } });
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.closedAt).not.toBeNull();
    await correctTorcovkaRailsTaken({
      operationId: written.op.id,
      newRailsTaken: 4,
      reason: "reopen write-off",
    });
    const reopened = await prismaA.batch.findUniqueOrThrow({ where: { id: written.batch.id } });
    expect(reopened.status).toBe("IN_WORK");
    expect(reopened.closedAt).toBeNull();
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: written.lot.id } });
    expect(lot.remainingQuantity).toBe(16);
  });

  it("12: delete TORCOVKA does not return rails", async () => {
    const seeded = await seedExistingOp({
      suffix: `c12-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
    });
    await deleteProductionOperation(seeded.op.id);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    expect(lot.remainingQuantity).toBe(10);
    expect(await prismaA.productionOperation.findUnique({ where: { id: seeded.op.id } })).toBeNull();
  });

  it("13a: correction || submit same RailLot: remaining >= 0, railsTaken authoritative, no partial", async () => {
    const seeded = await seedExistingOp({
      suffix: `c13s-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
    });
    const remainingStart = 10;
    const submitTake = 5;
    const oldRails = 20;
    const newRails = 4;
    const delta = oldRails - newRails;

    const settled = await withTimeout(
      Promise.allSettled([
        correctTorcovkaRailsTaken({
          operationId: seeded.op.id,
          newRailsTaken: newRails,
          reason: "race submit",
        }),
        submitTorcovka({
          employeeId: seeded.emp.id,
          clientRequestId: `c13s-${Date.now()}`,
          batchId: seeded.batch.id,
          railLotId: seeded.lot.id,
          railsTaken: submitTake,
          picks: [{ lengthM: 1, sort: "SORT1", quantity: 18 }],
        }),
      ]),
      "correction || submit",
    );
    expect(settled).toHaveLength(2);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);

    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const extraOps = await prismaA.productionOperation.count({
      where: { railLotId: seeded.lot.id, id: { not: seeded.op.id } },
    });
    const batch = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });

    expect(lot.remainingQuantity).toBeGreaterThanOrEqual(0);
    expect([oldRails, newRails]).toContain(op.railsTaken);
    const correctionApplied = op.railsTaken === newRails;
    const submitApplied = extraOps === 1;
    expect(extraOps).toBeLessThanOrEqual(1);
    expect(lot.remainingQuantity).toBe(
      remainingStart + (correctionApplied ? delta : 0) - (submitApplied ? submitTake : 0),
    );
    if (lot.remainingQuantity > 0) {
      expect(batch.status).toBe("IN_WORK");
      expect(batch.closedAt).toBeNull();
    } else {
      expect(batch.status).toBe("ARCHIVED");
      expect(batch.closedAt).not.toBeNull();
    }
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
  });

  it("13b: correction || writeOff same Batch: remaining >= 0, reopen/archive consistent, no partial", async () => {
    const seeded = await seedExistingOp({
      suffix: `c13w-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
    });
    const remainingStart = 10;
    const oldRails = 20;
    const newRails = 4;
    const delta = oldRails - newRails;

    const settled = await withTimeout(
      Promise.allSettled([
        correctTorcovkaRailsTaken({
          operationId: seeded.op.id,
          newRailsTaken: newRails,
          reason: "race write-off",
        }),
        writeOffBatchRemainder(seeded.batch.id),
      ]),
      "correction || writeOff",
    );
    expect(settled).toHaveLength(2);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);

    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const batch = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    const logs = await prismaA.changeLog.findMany({
      where: { entity: "Batch", entityId: seeded.batch.id },
    });
    const writeOffApplied = logs.some((log) => {
      const nv = log.newValues as Record<string, unknown> | null;
      return Boolean(nv && "writeOff" in nv);
    });

    expect(lot.remainingQuantity).toBeGreaterThanOrEqual(0);
    expect([oldRails, newRails]).toContain(op.railsTaken);
    const correctionApplied = op.railsTaken === newRails;
    if (correctionApplied && writeOffApplied) {
      expect([0, delta]).toContain(lot.remainingQuantity);
    } else if (correctionApplied) {
      expect(lot.remainingQuantity).toBe(remainingStart + delta);
    } else if (writeOffApplied) {
      expect(lot.remainingQuantity).toBe(0);
    } else {
      expect(lot.remainingQuantity).toBe(remainingStart);
    }
    if (lot.remainingQuantity > 0) {
      expect(batch.status).toBe("IN_WORK");
      expect(batch.closedAt).toBeNull();
    } else {
      expect(batch.status).toBe("ARCHIVED");
      expect(batch.closedAt).not.toBeNull();
    }
  });

  it("13c: archive depleted precheck waits Batch; other lot restored; must refuse archive", async () => {
    const suffix = `c13c-${Date.now()}`;
    const world = await seedWorld({
      suffix,
      lotLengthM: "4",
      lotQty: 2,
      remaining: 1,
    });
    const lotA = world.lot;
    const lotB = await prismaA.railLot.create({
      data: {
        batchId: world.batch.id,
        lengthM: new Prisma.Decimal("4"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: 20,
        remainingQuantity: 0,
      },
    });
    await prismaA.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId: world.emp.id,
        batchId: world.batch.id,
        railLotId: lotB.id,
        railsTaken: 20,
        workDate: new Date("2026-09-01T00:00:00.000Z"),
        lines: {
          create: [
            {
              quantity: 4,
              blankLengthM: new Prisma.Decimal("1"),
              blankType: "POLKA",
              blankSort: "SORT1",
              blankMaterialId: world.material.id,
            },
          ],
        },
      },
    });

    const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
    const holder = prismaA.$transaction(async (tx) => {
      await lockRailLots(tx, [lotB.id]);
      await lockBatches(tx, [world.batch.id]);
      await delay(300);
      await tx.railLot.update({
        where: { id: lotB.id },
        data: { remainingQuantity: { increment: 16 } },
      });
    }, txOpts);

    await delay(80);

    const archiver = prismaB.$transaction(async (tx) => {
      await lockRailLots(tx, [lotA.id]);
      await tx.railLot.update({
        where: { id: lotA.id },
        data: { remainingQuantity: 0 },
      });
      return archiveBatchIfDepleted(tx, world.batch.id);
    }, txOpts);

    const [, archived] = await withTimeout(Promise.all([holder, archiver]), "13c archive recheck");
    expect(archived).toBe(false);

    const lots = await prismaA.railLot.findMany({ where: { batchId: world.batch.id } });
    const remaining = lots.reduce((s, l) => s + l.remainingQuantity, 0);
    const batch = await prismaA.batch.findUniqueOrThrow({ where: { id: world.batch.id } });
    expect(remaining).toBeGreaterThan(0);
    expect(batch.status).toBe("IN_WORK");
    expect(batch.closedAt).toBeNull();
  });

  it("13d: correction LotB || submit last rail LotA: remaining vs status; both fulfilled", async () => {
    const suffix = `c13d-${Date.now()}`;
    const world = await seedWorld({
      suffix,
      lotLengthM: "4",
      lotQty: 2,
      remaining: 1,
    });
    const lotA = world.lot;
    const lotB = await prismaA.railLot.create({
      data: {
        batchId: world.batch.id,
        lengthM: new Prisma.Decimal("4"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: 20,
        remainingQuantity: 0,
      },
    });
    const opB = await prismaA.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId: world.emp.id,
        batchId: world.batch.id,
        railLotId: lotB.id,
        railsTaken: 20,
        workDate: new Date("2026-09-01T00:00:00.000Z"),
        lines: {
          create: [
            {
              quantity: 4,
              blankLengthM: new Prisma.Decimal("1"),
              blankType: "POLKA",
              blankSort: "SORT1",
              blankMaterialId: world.material.id,
            },
          ],
        },
      },
    });
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 4,
      },
    });

    const settled = await withTimeout(
      Promise.allSettled([
        correctTorcovkaRailsTaken({
          operationId: opB.id,
          newRailsTaken: 4,
          reason: "different-lot race",
        }),
        submitTorcovka({
          employeeId: world.emp.id,
          clientRequestId: `c13d-${Date.now()}`,
          batchId: world.batch.id,
          railLotId: lotA.id,
          railsTaken: 1,
          picks: [{ lengthM: 1, sort: "SORT1", quantity: 4 }],
        }),
      ]),
      "correction LotB || submit LotA",
    );
    expect(settled).toHaveLength(2);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);

    const lots = await prismaA.railLot.findMany({ where: { batchId: world.batch.id } });
    const remaining = lots.reduce((s, l) => s + l.remainingQuantity, 0);
    const batch = await prismaA.batch.findUniqueOrThrow({ where: { id: world.batch.id } });
    if (remaining > 0) {
      expect(batch.status).toBe("IN_WORK");
      expect(batch.closedAt).toBeNull();
    } else {
      expect(batch.status).toBe("ARCHIVED");
      expect(batch.closedAt).not.toBeNull();
    }
  });
});
