vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/session", () => ({ requireAdmin: async () => {} }));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { createCashFlow } from "@/server/finance";
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

describe.skipIf(!enabled)("DI-001 integrity", () => {
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

  it("updateBatch purchaseCost of batch A recomputes Deal.total and C of both batches", async () => {
    const a = await seedBatch(`A-${Date.now()}`, 90_000);
    const b = await seedBatch(`B-${Date.now()}`, 30_000);
    const deal = await prismaA.deal.create({
      data: {
        name: "Deal AB",
        status: "OPEN",
        total: 0,
        items: { create: [{ batchId: a.batch.id }, { batchId: b.batch.id }] },
      },
    });
    const account = await prismaA.account.create({
      data: { name: "Confirmed", confirmed: true, openingBalance: 0, balance: 0 },
    });
    await createCashFlow({
      date: "2026-03-01",
      amount: 160_000,
      flowType: "EXPENSE",
      accountName: account.name,
      counterpartyName: null,
      description: "deal expense",
      articleName: null,
      dealId: deal.id,
      dealName: deal.name,
    });

    await updateBatch(a.batch.id, batchForm(a.batch, 120_000));

    const [aAfter, bAfter, dealAfter] = await Promise.all([
      prismaA.batch.findUniqueOrThrow({ where: { id: a.batch.id } }),
      prismaA.batch.findUniqueOrThrow({ where: { id: b.batch.id } }),
      prismaA.deal.findUniqueOrThrow({ where: { id: deal.id } }),
    ]);
    expect(num(aAfter.totalCost)).toBe(128_000);
    expect(num(bAfter.totalCost)).toBe(32_000);
    expect(num(dealAfter.total)).toBe(160_000);
  });

  it("updateBatch with no deals sets totalCost = purchaseCost", async () => {
    const seeded = await seedBatch(`solo-${Date.now()}`, 10_000);
    await updateBatch(seeded.batch.id, batchForm(seeded.batch, 12_000));
    const after = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    expect(num(after.totalCost)).toBe(12_000);
    expect(num(after.purchaseCost)).toBe(12_000);
  });

  it("rejects purchaseCost/price changes when batch.frozenAt is set", async () => {
    const seeded = await seedBatch(`frozen-${Date.now()}`, 10_000);
    await prismaA.batch.update({
      where: { id: seeded.batch.id },
      data: { frozenAt: new Date("2026-09-01T00:00:00.000Z") },
    });
    await expect(updateBatch(seeded.batch.id, batchForm(seeded.batch, 11_000))).rejects.toThrow(
      /заморожен/i,
    );
  });

  it("two concurrent EXPENSE CashFlows on one Deal both land in Deal.total and Batch.totalCost", async () => {
    const seeded = await seedBatch(`cf-${Date.now()}`, 15_000);
    const deal = await prismaA.deal.create({
      data: {
        name: "Deal CF",
        status: "OPEN",
        total: 15_000,
        items: { create: [{ batchId: seeded.batch.id }] },
      },
    });
    const account = await prismaA.account.create({
      data: { name: "CF acc", confirmed: true, openingBalance: 0, balance: 0 },
    });

    await Promise.all([
      createCashFlow({
        date: "2026-03-01",
        amount: 10_000,
        flowType: "EXPENSE",
        accountName: account.name,
        counterpartyName: null,
        description: "a",
        articleName: null,
        dealId: deal.id,
        dealName: deal.name,
      }),
      createCashFlow({
        date: "2026-03-01",
        amount: 20_000,
        flowType: "EXPENSE",
        accountName: account.name,
        counterpartyName: null,
        description: "b",
        articleName: null,
        dealId: deal.id,
        dealName: deal.name,
      }),
    ]);

    const dealAfter = await prismaA.deal.findUniqueOrThrow({ where: { id: deal.id } });
    const batchAfter = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    expect(num(dealAfter.total)).toBe(30_000);
    expect(num(batchAfter.totalCost)).toBe(30_000);
    expect(await prismaA.cashFlow.count({ where: { dealId: deal.id } })).toBe(2);
  });
});
