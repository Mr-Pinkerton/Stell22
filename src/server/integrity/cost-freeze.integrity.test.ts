vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/session", () => ({ requireAdmin: async () => {} }));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { D, distributeBatchCost, sectionAreaM2 } from "@/lib/cost";
import { operationEarning } from "@/lib/payroll";
import { prismaUniqueDiscriminator } from "@/lib/prisma-unique-conflict";
import { maybeFreezeBatch, recalcBatchCosts } from "@/server/internal/cost";
import { syncBatchTotalCostInternal } from "@/server/internal/finance-operations";
import { markEmployeePaid } from "@/server/payroll";
import { deleteProductionOperation, updateProductionLineQuantity } from "@/server/production";
import { updateBatch } from "@/server/purchases";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityCostFreeze,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

const QTY_A = 5;
const QTY_B = 8;
const RATE_S1 = 10;
const TOTAL_COST = 100_000;
const PRICE_S1 = 30_000;
const PRICE_S2 = 20_000;
const SECTION_W = 40;
const SECTION_H = 20;
const BLANK_LEN = 2;

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function expectedTorcovkaAmount(qty: number): number {
  return operationEarning({
    type: "TORCOVKA",
    rates: {
      hourly: 0,
      torcovkaSort1: RATE_S1,
      torcovkaSort2: RATE_S1,
      prisadkaTorcev: 0,
      prisadkaPlosk: 0,
      upakovka: 0,
    },
    hours: 0,
    productQty: 0,
    lines: [{ quantity: qty, sort: "SORT1" }],
  }).amount;
}

function finalAgreesWithTotalCost(
  costs: { costSort1: Prisma.Decimal; costSort2: Prisma.Decimal }[],
  totalCost: Prisma.Decimal,
) {
  expect(costs).toHaveLength(1);
  const sum = D(num(costs[0].costSort1)).plus(D(num(costs[0].costSort2)));
  expect(sum.toFixed(2)).toBe(D(num(totalCost)).toFixed(2));
}

function expectedSnapshotFromQty(qty: number, totalCost: number) {
  return distributeBatchCost({
    totalCost,
    priceSort1: PRICE_S1,
    priceSort2: PRICE_S2,
    sectionAreaM2: sectionAreaM2(SECTION_W, SECTION_H),
    producedLengthSort1: qty * BLANK_LEN,
    producedLengthSort2: 0,
  });
}

function expectFinalMatchesCommittedQty(
  finals: {
    volumeSort1: Prisma.Decimal;
    volumeSort2: Prisma.Decimal;
    costSort1: Prisma.Decimal;
    costSort2: Prisma.Decimal;
  }[],
  qty: number,
  totalCost: Prisma.Decimal | number,
) {
  expect(finals).toHaveLength(1);
  const expected = expectedSnapshotFromQty(qty, num(totalCost));
  expect(D(num(finals[0].volumeSort1)).toFixed(6)).toBe(expected.volumeSort1.toFixed(6));
  expect(D(num(finals[0].volumeSort2)).toFixed(6)).toBe(expected.volumeSort2.toFixed(6));
  expect(D(num(finals[0].costSort1)).toFixed(2)).toBe(expected.costSort1.toFixed(2));
  expect(D(num(finals[0].costSort2)).toFixed(2)).toBe(expected.costSort2.toFixed(2));
}

describe.skipIf(!enabled)("cost-freeze integrity (DI-005/006/018/019/BD-3)", () => {
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

  async function seedMaterial(name: string, w = SECTION_W, h = SECTION_H) {
    return prismaA.material.create({
      data: { name, sectionWidthMm: w, sectionHeightMm: h },
    });
  }

  async function seedEmployee(fullName: string) {
    return prismaA.employee.create({
      data: {
        fullName,
        pin: "1234",
        hourlyRate: 0,
        rateTorcovkaSort1: RATE_S1,
        rateTorcovkaSort2: RATE_S1,
        ratePrisadkaTorcev: 0,
        ratePrisadkaPloskt: 0,
        rateUpakovka: 0,
      },
    });
  }

  async function seedBatch(opts: {
    name: string;
    materialId: string;
    closed?: boolean;
    frozen?: boolean;
    purchaseCost?: number;
    totalCost?: number;
    priceSort1?: number;
    sectionW?: number;
    sectionH?: number;
  }) {
    return prismaA.batch.create({
      data: {
        name: opts.name,
        materialId: opts.materialId,
        sectionWidthMm: opts.sectionW ?? SECTION_W,
        sectionHeightMm: opts.sectionH ?? SECTION_H,
        purchaseCost: opts.purchaseCost ?? TOTAL_COST,
        totalCost: opts.totalCost ?? opts.purchaseCost ?? TOTAL_COST,
        priceSort1: opts.priceSort1 ?? PRICE_S1,
        priceSort2: PRICE_S2,
        purchaseDate: new Date("2026-01-15T00:00:00.000Z"),
        note: null,
        status: opts.closed ? "ARCHIVED" : "IN_WORK",
        closedAt: opts.closed ? new Date("2026-09-01T00:00:00.000Z") : null,
        frozenAt: opts.frozen ? new Date("2026-09-01T00:00:00.000Z") : null,
      },
    });
  }

  async function seedTorcovka(opts: {
    employeeId: string;
    batchId: string;
    qty: number;
    paid?: boolean;
  }) {
    const op = await prismaA.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId: opts.employeeId,
        clientRequestId: `test:cost-freeze:${opts.batchId}:${opts.qty}:${opts.paid ? "p" : "u"}:${Date.now()}-${Math.random().toString(36).slice(2)}`,
        workDate: new Date("2026-09-01T00:00:00.000Z"),
        batchId: opts.batchId,
        isPaid: opts.paid ?? false,
        paidAt: opts.paid ? new Date("2026-09-02T00:00:00.000Z") : null,
        lines: {
          create: {
            quantity: opts.qty,
            blankLengthM: BLANK_LEN,
            blankType: "POLKA",
            blankSort: "SORT1",
            blankMaterialId: (await prismaA.batch.findUniqueOrThrow({ where: { id: opts.batchId } }))
              .materialId,
          },
        },
      },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    return op;
  }

  async function seedBlankStock(materialId: string, qty: number) {
    return prismaA.blankStock.create({
      data: {
        materialId,
        lengthM: BLANK_LEN,
        detailType: "POLKA",
        sort: "SORT1",
        quantity: qty,
      },
    });
  }

  function batchForm(
    batch: {
      name: string;
      materialId: string;
      purchaseCost: Prisma.Decimal;
      priceSort1: Prisma.Decimal;
      priceSort2: Prisma.Decimal;
      note: string | null;
    },
    over: Partial<{
      materialId: string;
      purchaseCost: number;
      priceSort1: number;
      note: string;
    }> = {},
  ) {
    return {
      name: batch.name,
      materialId: over.materialId ?? batch.materialId,
      purchaseDate: "2026-01-15",
      sectionWidthMm: SECTION_W,
      sectionHeightMm: SECTION_H,
      purchaseCost: over.purchaseCost ?? num(batch.purchaseCost),
      priceSort1: over.priceSort1 ?? num(batch.priceSort1),
      priceSort2: num(batch.priceSort2),
      note: over.note ?? batch.note ?? "",
      rails: [],
    };
  }

  async function seedReadyToFreeze(suffix: string, opts?: { paid?: boolean; qty?: number }) {
    const material = await seedMaterial(`mat-${suffix}`);
    const batch = await seedBatch({
      name: `batch-${suffix}`,
      materialId: material.id,
      closed: true,
    });
    const emp = await seedEmployee(`emp-${suffix}`);
    const op = await seedTorcovka({
      employeeId: emp.id,
      batchId: batch.id,
      qty: opts?.qty ?? QTY_A,
      paid: opts?.paid ?? true,
    });
    return { material, batch, emp, op };
  }

  it("1 maybeFreezeBatch || syncBatchTotalCostInternal: FINAL agrees with totalCost", async () => {
    const { batch } = await seedReadyToFreeze(`t1-${Date.now()}`);
    await prismaA.batch.update({
      where: { id: batch.id },
      data: { purchaseCost: 10_000, totalCost: 10_000 },
    });
    const account = await prismaA.account.create({
      data: { name: `acc-t1-${Date.now()}`, confirmed: true, openingBalance: 0, balance: 0 },
    });
    const deal = await prismaA.deal.create({
      data: {
        name: `deal-t1-${Date.now()}`,
        status: "OPEN",
        total: 10_000,
        items: { create: [{ batchId: batch.id }] },
      },
    });
    await prismaA.cashFlow.create({
      data: {
        date: new Date("2026-03-01T00:00:00.000Z"),
        amount: 15_000,
        flowType: "EXPENSE",
        accountId: account.id,
        dealId: deal.id,
        description: "delivery extra",
      },
    });

    const sync = prismaB.$transaction(async (tx) => {
      await syncBatchTotalCostInternal(batch.id, tx);
      await delay(250);
    });
    const freeze = (async () => {
      await delay(50);
      await prismaA.$transaction(async (tx) => {
        await maybeFreezeBatch(tx, batch.id);
      });
    })();
    await Promise.all([sync, freeze]);

    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: batch.id } });
    const finals = await prismaA.batchCost.findMany({
      where: { batchId: batch.id, status: "FINAL" },
    });
    expect(after.frozenAt).not.toBeNull();
    finalAgreesWithTotalCost(finals, after.totalCost);
    expect(await prismaA.batchCost.count({ where: { batchId: batch.id, status: "FINAL" } })).toBe(1);
  });

  it("2 maybeFreezeBatch || updateBatch price: no frozen row with new price and old FINAL", async () => {
    const seeded = await seedReadyToFreeze(`t2-${Date.now()}`);
    let updateError: unknown;
    const freeze = prismaA.$transaction(async (tx) => {
      await maybeFreezeBatch(tx, seeded.batch.id);
      await delay(250);
    });
    const update = (async () => {
      await delay(50);
      try {
        await updateBatch(seeded.batch.id, batchForm(seeded.batch, { priceSort1: PRICE_S1 + 1_000 }));
      } catch (err) {
        updateError = err;
      }
    })();
    await Promise.all([freeze, update]);

    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    const finals = await prismaA.batchCost.findMany({
      where: { batchId: seeded.batch.id, status: "FINAL" },
    });
    expect(after.frozenAt).not.toBeNull();
    expect(finals).toHaveLength(1);
    if (updateError) {
      expect(String(updateError)).toMatch(/заморожен/i);
      expect(num(after.priceSort1)).toBe(PRICE_S1);
    } else {
      expect(num(after.priceSort1)).toBe(PRICE_S1 + 1_000);
    }
  });

  it("3 recalcBatchCosts || freeze: frozenAt, one FINAL, zero PRELIMINARY", async () => {
    const { batch } = await seedReadyToFreeze(`t3-${Date.now()}`);
    await Promise.all([
      recalcBatchCosts({ batchId: batch.id }),
      prismaA.$transaction(async (tx) => {
        await maybeFreezeBatch(tx, batch.id);
      }),
    ]);
    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.frozenAt).not.toBeNull();
    expect(await prismaA.batchCost.count({ where: { batchId: batch.id, status: "FINAL" } })).toBe(1);
    expect(
      await prismaA.batchCost.count({ where: { batchId: batch.id, status: "PRELIMINARY" } }),
    ).toBe(0);
  });

  it("4 recalc || recalc same unfrozen batch: at most one PRELIMINARY", async () => {
    const material = await seedMaterial(`mat-t4-${Date.now()}`);
    const batch = await seedBatch({
      name: `batch-t4-${Date.now()}`,
      materialId: material.id,
      closed: false,
    });
    const emp = await seedEmployee(`emp-t4-${Date.now()}`);
    await seedTorcovka({ employeeId: emp.id, batchId: batch.id, qty: QTY_A, paid: false });

    await Promise.all([
      recalcBatchCosts({ batchId: batch.id }),
      recalcBatchCosts({ batchId: batch.id }),
    ]);

    expect(
      await prismaA.batchCost.count({ where: { batchId: batch.id, status: "PRELIMINARY" } }),
    ).toBe(1);
    expect(await prismaA.batchCost.count({ where: { batchId: batch.id, status: "FINAL" } })).toBe(0);
  });

  it("5 two markEmployeePaid last TORCOVKA: two Payments, frozen, one FINAL", async () => {
    const material = await seedMaterial(`mat-t5-${Date.now()}`);
    const batch = await seedBatch({
      name: `batch-t5-${Date.now()}`,
      materialId: material.id,
      closed: true,
    });
    const empA = await seedEmployee(`emp-t5a-${Date.now()}`);
    const empB = await seedEmployee(`emp-t5b-${Date.now()}`);
    await seedTorcovka({ employeeId: empA.id, batchId: batch.id, qty: QTY_A, paid: false });
    await seedTorcovka({ employeeId: empB.id, batchId: batch.id, qty: QTY_A, paid: false });

    await Promise.all([markEmployeePaid(empA.id), markEmployeePaid(empB.id)]);

    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.frozenAt).not.toBeNull();
    expect(await prismaA.payment.count()).toBe(2);
    expect(
      await prismaA.productionOperation.count({
        where: { batchId: batch.id, type: "TORCOVKA", isPaid: false },
      }),
    ).toBe(0);
    expect(await prismaA.batchCost.count({ where: { batchId: batch.id, status: "FINAL" } })).toBe(1);
  });

  it("6a payroll wins Op lock: Payment.amount matches qty A, later edit rejected", async () => {
    const seeded = await seedReadyToFreeze(`t6a-${Date.now()}`, { paid: false, qty: QTY_A });
    await seedBlankStock(seeded.material.id, QTY_A);

    let editError: unknown;
    const payroll = markEmployeePaid(seeded.emp.id);
    const edit = (async () => {
      await delay(80);
      try {
        await updateProductionLineQuantity(seeded.op.id, 0, QTY_B);
      } catch (err) {
        editError = err;
      }
    })();
    await Promise.all([payroll, edit]);

    const payment = await prismaA.payment.findFirstOrThrow({
      where: { employeeId: seeded.emp.id },
      include: { items: true },
    });
    const line = await prismaA.operationDetailLine.findFirstOrThrow({
      where: { operationId: seeded.op.id },
    });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    expect(op.isPaid).toBe(true);
    expect(line.quantity).toBe(QTY_A);
    expect(num(payment.amount)).toBe(expectedTorcovkaAmount(QTY_A));
    expect(payment.items.map((i) => i.operationId)).toEqual([seeded.op.id]);
    expect(String(editError)).toMatch(/уже выплачена/i);
    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    const finals = await prismaA.batchCost.findMany({
      where: { batchId: seeded.batch.id, status: "FINAL" },
    });
    expectFinalMatchesCommittedQty(finals, QTY_A, after.totalCost);
  });

  it("6b edit wins before payroll Op lock: Payment.amount matches qty B", async () => {
    const seeded = await seedReadyToFreeze(`t6b-${Date.now()}`, { paid: false, qty: QTY_A });
    await seedBlankStock(seeded.material.id, QTY_A);

    const orig = prisma.$transaction.bind(prisma);
    let firstTx = true;
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation((...args: unknown[]) => {
      if (firstTx) {
        firstTx = false;
        return delay(150).then(() => orig(...(args as Parameters<typeof orig>)));
      }
      return orig(...(args as Parameters<typeof orig>));
    });

    try {
      const payroll = markEmployeePaid(seeded.emp.id);
      await delay(30);
      await updateProductionLineQuantity(seeded.op.id, 0, QTY_B);
      await payroll;
    } finally {
      spy.mockRestore();
    }

    const payment = await prismaA.payment.findFirstOrThrow({
      where: { employeeId: seeded.emp.id },
      include: { items: true },
    });
    const line = await prismaA.operationDetailLine.findFirstOrThrow({
      where: { operationId: seeded.op.id },
    });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    expect(op.isPaid).toBe(true);
    expect(line.quantity).toBe(QTY_B);
    expect(num(payment.amount)).toBe(expectedTorcovkaAmount(QTY_B));
    expect(payment.items.map((i) => i.operationId)).toEqual([seeded.op.id]);
    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    const finals = await prismaA.batchCost.findMany({
      where: { batchId: seeded.batch.id, status: "FINAL" },
    });
    expectFinalMatchesCommittedQty(finals, QTY_B, after.totalCost);
  });

  it("7a payroll wins: Payment exists, op remains paid, delete rejected, stock unchanged, batch frozen", async () => {
    const seeded = await seedReadyToFreeze(`t7a-${Date.now()}`, { paid: false, qty: QTY_A });
    await seedBlankStock(seeded.material.id, QTY_A);

    let deleteError: unknown;
    const payroll = markEmployeePaid(seeded.emp.id);
    const del = (async () => {
      await delay(80);
      try {
        await deleteProductionOperation(seeded.op.id);
      } catch (err) {
        deleteError = err;
      }
    })();
    await Promise.all([payroll, del]);

    const op = await prismaA.productionOperation.findUnique({ where: { id: seeded.op.id } });
    const stock = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: seeded.material.id },
    });
    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    expect(op).not.toBeNull();
    expect(op?.isPaid).toBe(true);
    expect(stock.quantity).toBe(QTY_A);
    expect(await prismaA.payment.count({ where: { employeeId: seeded.emp.id } })).toBe(1);
    expect(String(deleteError)).toMatch(/уже выплачена/i);
    expect(after.frozenAt).not.toBeNull();
  });

  it("7b delete wins Op lock: last unpaid TORCOVKA removed, no Payment B, freeze FINAL from remaining A", async () => {
    const suffix = `t7b-${Date.now()}`;
    const material = await seedMaterial(`mat-${suffix}`);
    const batch = await seedBatch({
      name: `batch-${suffix}`,
      materialId: material.id,
      closed: true,
    });
    const empA = await seedEmployee(`emp-a-${suffix}`);
    const empB = await seedEmployee(`emp-b-${suffix}`);
    const opA = await seedTorcovka({
      employeeId: empA.id,
      batchId: batch.id,
      qty: QTY_A,
      paid: true,
    });
    const opB = await seedTorcovka({
      employeeId: empB.id,
      batchId: batch.id,
      qty: QTY_B,
      paid: false,
    });
    await seedBlankStock(material.id, QTY_A + QTY_B);

    const orig = prisma.$transaction.bind(prisma);
    let firstTx = true;
    let resolveEntered!: () => void;
    const entered = new Promise<void>((r) => {
      resolveEntered = r;
    });
    let releaseTx!: () => void;
    const gate = new Promise<void>((r) => {
      releaseTx = r;
    });
    const spy = vi.spyOn(prisma, "$transaction").mockImplementation((...args: unknown[]) => {
      if (firstTx) {
        firstTx = false;
        resolveEntered();
        return gate.then(() => orig(...(args as Parameters<typeof orig>)));
      }
      return orig(...(args as Parameters<typeof orig>));
    });

    let payrollError: unknown;
    try {
      const payrollP = markEmployeePaid(empB.id).catch((err) => {
        payrollError = err;
      });
      await entered;
      await deleteProductionOperation(opB.id);
      releaseTx();
      await payrollP;
    } finally {
      spy.mockRestore();
    }

    expect(await prismaA.productionOperation.findUnique({ where: { id: opB.id } })).toBeNull();
    expect(await prismaA.productionOperation.findUnique({ where: { id: opA.id } })).not.toBeNull();
    expect(await prismaA.payment.count({ where: { employeeId: empB.id } })).toBe(0);
    expect(String(payrollError)).toMatch(/уже выплачены|невыплаченных/i);
    const stock = await prismaA.blankStock.findFirstOrThrow({ where: { materialId: material.id } });
    expect(stock.quantity).toBe(QTY_A);
    expect(
      await prismaA.productionOperation.count({
        where: { batchId: batch.id, type: "TORCOVKA", isPaid: false },
      }),
    ).toBe(0);
    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.frozenAt).not.toBeNull();
    const finals = await prismaA.batchCost.findMany({
      where: { batchId: batch.id, status: "FINAL" },
    });
    expectFinalMatchesCommittedQty(finals, QTY_A, after.totalCost);
  });

  it("8 updateBatch section on frozen batch is rejected", async () => {
    const { batch, material } = await seedReadyToFreeze(`t8-${Date.now()}`);
    await prismaA.$transaction(async (tx) => {
      await maybeFreezeBatch(tx, batch.id);
    });
    await prismaA.material.update({
      where: { id: material.id },
      data: { sectionWidthMm: 50, sectionHeightMm: 25 },
    });
    await expect(updateBatch(batch.id, batchForm(batch))).rejects.toThrow(/заморожен/i);
    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(num(after.sectionWidthMm)).toBe(SECTION_W);
    expect(num(after.sectionHeightMm)).toBe(SECTION_H);
  });

  it("9 frozen Batch materialId A→B same section mm is rejected", async () => {
    const { batch } = await seedReadyToFreeze(`t9-${Date.now()}`);
    await prismaA.$transaction(async (tx) => {
      await maybeFreezeBatch(tx, batch.id);
    });
    const other = await seedMaterial(`mat-t9b-${Date.now()}`, SECTION_W, SECTION_H);
    await expect(
      updateBatch(batch.id, batchForm(batch, { materialId: other.id })),
    ).rejects.toThrow(/заморожен/i);
    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: batch.id } });
    expect(after.materialId).toBe(batch.materialId);
  });

  it("partial UNIQUE FINAL: second FINAL for the same batch is P2002", async () => {
    const { batch } = await seedReadyToFreeze(`uniq-${Date.now()}`);
    await prismaA.batchCost.create({
      data: {
        batchId: batch.id,
        status: "FINAL",
        volumeSort1: 1,
        volumeSort2: 0,
        costSort1: 1,
        costSort2: 0,
        pricePerM3Sort1: 1,
        pricePerM3Sort2: 0,
      },
    });
    try {
      await prismaA.batchCost.create({
        data: {
          batchId: batch.id,
          status: "FINAL",
          volumeSort1: 2,
          volumeSort2: 0,
          costSort1: 2,
          costSort2: 0,
          pricePerM3Sort1: 2,
          pricePerM3Sort2: 0,
        },
      });
      throw new Error("expected P2002");
    } catch (e) {
      expect(e).toMatchObject({ code: "P2002" });
      expect(prismaUniqueDiscriminator(e)).toMatch(/BatchCost_batchId_final_key|BatchCost/i);
    }
  });
});
