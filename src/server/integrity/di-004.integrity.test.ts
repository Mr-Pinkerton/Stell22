import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityFinance,
} from "./harness";
import { applySupplyDeduction } from "@/server/internal/supply-deduct";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

describe.skipIf(!enabled)("DI-004 integrity", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityFinance(prismaA);
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
  });

  it("two overlapping applySupplyDeduction on same supply deduct once and never go negative", async () => {
    const material = await prismaA.material.create({
      data: { name: `di004-${Date.now()}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const product = await prismaA.product.create({
      data: {
        name: "GP",
        materialId: material.id,
        skuOzon: "OZ-DI004",
        skuWb: "WB-DI004",
        sort: "SORT1",
      },
    });
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    const supply = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-8",
        sku: "OZ-DI004",
        productId: product.id,
        quantity: 8,
        status: "SHIPPED",
        deductedQty: 0,
        shortfallQty: 0,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    const run = (db: typeof prismaA) =>
      db.$transaction((tx) =>
        applySupplyDeduction(tx, {
          marketplace: supply.marketplace,
          externalId: supply.externalId,
          sku: supply.sku,
          targetQty: 8,
          productId: product.id,
        }),
      );

    await Promise.all([run(prismaA), run(prismaB)]);

    const ps = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    const s = await prismaA.supply.findUniqueOrThrow({ where: { id: supply.id } });
    expect(ps.quantity).toBe(2);
    expect(s.deductedQty).toBe(8);
    expect(s.shortfallQty).toBe(0);
  });

  it("one TX with stock 3 and target 8 deducts 3 and records shortfall 5", async () => {
    const material = await prismaA.material.create({
      data: { name: `di004-short-${Date.now()}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const product = await prismaA.product.create({
      data: {
        name: "GP2",
        materialId: material.id,
        skuOzon: "OZ-DI004-S",
        skuWb: "WB-DI004-S",
        sort: "SORT1",
      },
    });
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 3 } });
    const supply = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-short",
        sku: "OZ-DI004-S",
        productId: product.id,
        quantity: 8,
        status: "SHIPPED",
        deductedQty: 0,
        shortfallQty: 0,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: supply.marketplace,
        externalId: supply.externalId,
        sku: supply.sku,
        targetQty: 8,
        productId: product.id,
      }),
    );

    const ps = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    const s = await prismaA.supply.findUniqueOrThrow({ where: { id: supply.id } });
    expect(ps.quantity).toBe(0);
    expect(s.deductedQty).toBe(3);
    expect(s.shortfallQty).toBe(5);
  });

  it("rebinds zero-counter Supply from archived A to live B; cancel restore uses B", async () => {
    const material = await prismaA.material.create({
      data: { name: `di004-rebind-${Date.now()}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const archived = await prismaA.product.create({
      data: {
        name: "Archived A",
        materialId: material.id,
        skuOzon: "OZ-REBIND",
        skuWb: "WB-REBIND-A",
        sort: "SORT1",
        status: "ARCHIVED",
      },
    });
    const live = await prismaA.product.create({
      data: {
        name: "Live B",
        materialId: material.id,
        skuOzon: "OZ-REBIND",
        skuWb: "WB-REBIND-B",
        sort: "SORT1",
        status: "ACTIVE",
      },
    });
    await prismaA.productStock.create({ data: { productId: archived.id, quantity: 10 } });
    await prismaA.productStock.create({ data: { productId: live.id, quantity: 10 } });
    const supply = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-rebind",
        sku: "OZ-REBIND",
        productId: archived.id,
        quantity: 3,
        status: "SHIPPED",
        deductedQty: 0,
        shortfallQty: 0,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: supply.marketplace,
        externalId: supply.externalId,
        sku: supply.sku,
        targetQty: 3,
        productId: live.id,
      }),
    );

    const afterDeduct = await prismaA.supply.findUniqueOrThrow({ where: { id: supply.id } });
    const stockA = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: archived.id },
    });
    const stockB = await prismaA.productStock.findUniqueOrThrow({ where: { productId: live.id } });
    expect(afterDeduct.productId).toBe(live.id);
    expect(stockA.quantity).toBe(10);
    expect(stockB.quantity).toBe(7);
    expect(afterDeduct.deductedQty).toBe(3);

    await prismaA.$transaction(async (tx) => {
      const row = await tx.supply.findUniqueOrThrow({ where: { id: supply.id } });
      if (row.productId && row.deductedQty > 0) {
        await tx.$queryRaw`
          SELECT id FROM "ProductStock" WHERE "productId" = ${row.productId} FOR UPDATE
        `;
        await tx.productStock.update({
          where: { productId: row.productId },
          data: { quantity: { increment: row.deductedQty } },
        });
        await tx.supply.update({
          where: { id: row.id },
          data: { deductedQty: 0, shortfallQty: 0, status: "PENDING" },
        });
      }
    });

    const restoredA = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: archived.id },
    });
    const restoredB = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: live.id },
    });
    expect(restoredA.quantity).toBe(10);
    expect(restoredB.quantity).toBe(10);
  });
});
