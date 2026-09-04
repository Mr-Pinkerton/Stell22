vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/session", () => ({ requireAdmin: async () => {} }));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  assignCashFlow,
  convertCashFlowToTransfer,
  createCashFlow,
  createDeal,
  deleteCashFlow,
  updateDeal,
} from "@/server/finance";
import { updateBatch } from "@/server/purchases";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityFinance,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

function num(value: Prisma.Decimal | number): number {
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!enabled)("P1 review concurrency", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityFinance(prismaA);
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
  });

  async function seedBatch(name: string, purchaseCost: number) {
    const material = await prismaA.material.create({
      data: { name: `mat-${name}-${Date.now()}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const batch = await prismaA.batch.create({
      data: {
        name,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost,
        totalCost: purchaseCost,
        priceSort1: 0,
        priceSort2: 0,
        purchaseDate: new Date("2026-01-15T00:00:00.000Z"),
        note: null,
      },
    });
    return { material, batch };
  }

  function batchForm(
    batch: {
      name: string;
      materialId: string;
      purchaseCost: Prisma.Decimal;
      priceSort1: Prisma.Decimal;
      priceSort2: Prisma.Decimal;
    },
    purchaseCost: number,
  ) {
    return {
      name: batch.name,
      materialId: batch.materialId,
      purchaseDate: "2026-01-15",
      sectionWidthMm: 40,
      sectionHeightMm: 20,
      purchaseCost,
      priceSort1: num(batch.priceSort1),
      priceSort2: num(batch.priceSort2),
      note: "",
      rails: [],
    };
  }

  it("assign same CF concurrently D1 || D2: exactly one deal owns the CF and totals match", async () => {
    const a = await seedBatch(`asg-a-${Date.now()}`, 10_000);
    const b = await seedBatch(`asg-b-${Date.now()}`, 20_000);
    const d1 = await prismaA.deal.create({
      data: {
        name: "D1",
        status: "OPEN",
        total: 10_000,
        items: { create: [{ batchId: a.batch.id }] },
      },
    });
    const d2 = await prismaA.deal.create({
      data: {
        name: "D2",
        status: "OPEN",
        total: 20_000,
        items: { create: [{ batchId: b.batch.id }] },
      },
    });
    const account = await prismaA.account.create({
      data: { name: "Asg", confirmed: true, openingBalance: 0, balance: 0 },
    });
    const cf = await createCashFlow({
      date: "2026-03-01",
      amount: 50_000,
      flowType: "EXPENSE",
      accountName: account.name,
      counterpartyName: null,
      description: "assign race",
      articleName: null,
      dealId: null,
      dealName: null,
    });

    await Promise.all([
      assignCashFlow(cf.id, { dealId: d1.id }),
      assignCashFlow(cf.id, { dealId: d2.id }),
    ]);

    const after = await prismaA.cashFlow.findUniqueOrThrow({ where: { id: cf.id } });
    expect([d1.id, d2.id]).toContain(after.dealId);
    const onD1 = await prismaA.cashFlow.count({ where: { dealId: d1.id } });
    const onD2 = await prismaA.cashFlow.count({ where: { dealId: d2.id } });
    expect(onD1 + onD2).toBe(1);

    const [d1After, d2After, aAfter, bAfter] = await Promise.all([
      prismaA.deal.findUniqueOrThrow({ where: { id: d1.id } }),
      prismaA.deal.findUniqueOrThrow({ where: { id: d2.id } }),
      prismaA.batch.findUniqueOrThrow({ where: { id: a.batch.id } }),
      prismaA.batch.findUniqueOrThrow({ where: { id: b.batch.id } }),
    ]);
    if (after.dealId === d1.id) {
      expect(onD1).toBe(1);
      expect(num(d1After.total)).toBe(50_000);
      expect(num(aAfter.totalCost)).toBe(50_000);
      expect(num(d2After.total)).toBe(20_000);
      expect(num(bAfter.totalCost)).toBe(20_000);
    } else {
      expect(onD2).toBe(1);
      expect(num(d2After.total)).toBe(50_000);
      expect(num(bAfter.totalCost)).toBe(50_000);
      expect(num(d1After.total)).toBe(10_000);
      expect(num(aAfter.totalCost)).toBe(10_000);
    }
  });

  it("delete ordinary CF || convert-to-transfer: no orphan transfer leg", async () => {
    const account = await prismaA.account.create({
      data: { name: "From", confirmed: true, openingBalance: 0, balance: 0 },
    });
    const other = await prismaA.account.create({
      data: { name: "To", confirmed: true, openingBalance: 0, balance: 0 },
    });
    const cf = await createCashFlow({
      date: "2026-03-01",
      amount: 7_000,
      flowType: "EXPENSE",
      accountName: account.name,
      counterpartyName: null,
      description: "del-vs-convert",
      articleName: null,
      dealId: null,
      dealName: null,
    });

    await Promise.allSettled([
      deleteCashFlow(cf.id),
      convertCashFlowToTransfer(cf.id, other.id),
    ]);

    const remaining = await prismaA.cashFlow.findMany();
    if (remaining.length === 0) {
      expect(remaining).toHaveLength(0);
      return;
    }
    if (remaining.length === 1) {
      expect(remaining[0].id).toBe(cf.id);
      expect(remaining[0].isTransfer).toBe(false);
      expect(remaining[0].transferId).toBeNull();
      return;
    }
    expect(remaining).toHaveLength(2);
    expect(remaining.every((row) => row.isTransfer && row.transferId)).toBe(true);
    expect(remaining[0].transferId).toBe(remaining[1].transferId);
    expect(remaining.some((row) => row.id === cf.id)).toBe(true);
    expect(new Set(remaining.map((row) => row.accountId))).toEqual(
      new Set([account.id, other.id]),
    );
  });

  it("freeze || updateBatch money: frozen batch keeps original money", async () => {
    // Synthetic Batch FOR UPDATE + frozenAt write — P1 write-after-freeze only.
    // Not proof of production maybeFreezeBatch. Real freeze races: cost-freeze.integrity.test.ts.
    const seeded = await seedBatch(`fz-${Date.now()}`, 10_000);
    let updateError: unknown;
    const freeze = prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Batch" WHERE id = ${seeded.batch.id} FOR UPDATE`;
      await tx.batch.update({
        where: { id: seeded.batch.id },
        data: { frozenAt: new Date("2026-09-04T00:00:00.000Z") },
      });
      await delay(250);
    });
    const update = (async () => {
      await delay(50);
      try {
        await updateBatch(seeded.batch.id, batchForm(seeded.batch, 11_000));
      } catch (err) {
        updateError = err;
      }
    })();
    await Promise.all([freeze, update]);

    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    expect(after.frozenAt).not.toBeNull();
    expect(num(after.purchaseCost)).toBe(10_000);
    expect(num(after.priceSort1)).toBe(0);
    expect(num(after.priceSort2)).toBe(0);
    expect(String(updateError)).toMatch(/заморожен/i);
  });

  it("createDeal membership || updateBatch purchaseCost: Deal/Batch totals match current P", async () => {
    const seeded = await seedBatch(`mem-${Date.now()}`, 10_000);

    await Promise.allSettled([
      createDeal({ name: `deal-${seeded.batch.name}`, batchNames: [seeded.batch.name] }),
      updateBatch(seeded.batch.id, batchForm(seeded.batch, 20_000)),
    ]);

    const batch = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    expect([10_000, 20_000]).toContain(num(batch.purchaseCost));
    const items = await prismaA.dealItem.findMany({ where: { batchId: batch.id } });
    if (items.length === 0) {
      expect(num(batch.totalCost)).toBe(num(batch.purchaseCost));
      return;
    }
    expect(items).toHaveLength(1);
    const deal = await prismaA.deal.findUniqueOrThrow({ where: { id: items[0].dealId } });
    expect(num(deal.total)).toBe(num(batch.purchaseCost));
    expect(num(batch.totalCost)).toBe(num(batch.purchaseCost));
  });

  it("updateDeal || updateDeal: membership is one complete set, not a mix", async () => {
    const a = await seedBatch(`uda-${Date.now()}`, 4_000);
    const b = await seedBatch(`udb-${Date.now()}`, 6_000);
    const c = await seedBatch(`udc-${Date.now()}`, 8_000);
    const deal = await prismaA.deal.create({
      data: {
        name: "UD race",
        status: "OPEN",
        total: 4_000,
        items: { create: [{ batchId: a.batch.id }] },
      },
    });

    await Promise.all([
      updateDeal(deal.id, { name: deal.name, batchNames: [b.batch.name] }),
      updateDeal(deal.id, { name: deal.name, batchNames: [c.batch.name] }),
    ]);

    const items = await prismaA.dealItem.findMany({ where: { dealId: deal.id } });
    expect(items).toHaveLength(1);
    const winnerBatchId = items[0].batchId;
    expect(winnerBatchId).toBeTruthy();
    expect([b.batch.id, c.batch.id]).toContain(winnerBatchId);

    const dealAfter = await prismaA.deal.findUniqueOrThrow({ where: { id: deal.id } });
    const winner = await prismaA.batch.findUniqueOrThrow({ where: { id: winnerBatchId! } });
    expect(num(dealAfter.total)).toBe(num(winner.purchaseCost));
    expect(num(winner.totalCost)).toBe(num(winner.purchaseCost));

    const loserId = winnerBatchId === b.batch.id ? c.batch.id : b.batch.id;
    const loser = await prismaA.batch.findUniqueOrThrow({ where: { id: loserId } });
    expect(num(loser.totalCost)).toBe(num(loser.purchaseCost));
    const start = await prismaA.batch.findUniqueOrThrow({ where: { id: a.batch.id } });
    expect(num(start.totalCost)).toBe(num(start.purchaseCost));
  });
});
