import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  integritySupplyShadowOff,
  resetIntegrityFinance,
} from "./harness";
import {
  applyOzonSupplyCancellation,
  applySupplyDeduction,
  findOzonSupplyKeysByExternalIds,
  lockSuppliesInOrder,
} from "@/server/internal/supply-deduct";
import { isOzonCancelledInThisSync } from "@/server/internal/supply-accounting-cycle";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const shadowOff = integritySupplyShadowOff();

function isCheckViolation(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return code === "P2004" || code === "23514" || /23514/.test(text) || /check constraint/i.test(text);
}

async function seedProduct(
  db: ReturnType<typeof createIntegrityClients>["prismaA"],
  suffix: string,
) {
  const material = await db.material.create({
    data: { name: `r04-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
  });
  const product = await db.product.create({
    data: {
      name: `GP-${suffix}`,
      materialId: material.id,
      skuOzon: `OZ-${suffix}`,
      skuWb: `WB-${suffix}`,
      sort: "SORT1",
    },
  });
  return { material, product };
}

describe.skipIf(!enabled)("PSR-P2 R-04 Supply stock-accounting cycle", () => {
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

  it("cutover defaults and backfill semantics; no InventoryMovement rows", async () => {
    const { product } = await seedProduct(prismaA, `cut-${Date.now()}`);
    const never = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "cut-0",
        sku: product.skuOzon,
        productId: product.id,
        quantity: 10,
        status: "PENDING",
        deductedQty: 0,
        shortfallQty: 0,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    expect(never.stockAccountingGeneration).toBe(0);
    expect(never.stockAccountingOpen).toBe(false);

    const success = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "cut-ok",
        sku: `${product.skuOzon}-ok`,
        productId: product.id,
        quantity: 10,
        status: "SHIPPED",
        deductedQty: 10,
        shortfallQty: 0,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const partial = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "cut-part",
        sku: `${product.skuOzon}-part`,
        productId: product.id,
        quantity: 10,
        status: "SHIPPED",
        deductedQty: 3,
        shortfallQty: 7,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const fullShort = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "cut-short",
        sku: `${product.skuOzon}-short`,
        productId: product.id,
        quantity: 10,
        status: "SHIPPED",
        deductedQty: 0,
        shortfallQty: 10,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    await prismaA.$executeRaw`
      UPDATE "Supply"
      SET "stockAccountingGeneration" = 1, "stockAccountingOpen" = true
      WHERE "deductedQty" > 0 OR "shortfallQty" > 0
    `;

    const afterOk = await prismaA.supply.findUniqueOrThrow({ where: { id: success.id } });
    const afterPart = await prismaA.supply.findUniqueOrThrow({ where: { id: partial.id } });
    const afterShort = await prismaA.supply.findUniqueOrThrow({ where: { id: fullShort.id } });
    const afterNever = await prismaA.supply.findUniqueOrThrow({ where: { id: never.id } });
    expect(afterOk.stockAccountingGeneration).toBe(1);
    expect(afterOk.stockAccountingOpen).toBe(true);
    expect(afterPart.stockAccountingGeneration).toBe(1);
    expect(afterPart.stockAccountingOpen).toBe(true);
    expect(afterShort.stockAccountingGeneration).toBe(1);
    expect(afterShort.stockAccountingOpen).toBe(true);
    expect(afterNever.stockAccountingGeneration).toBe(0);
    expect(afterNever.stockAccountingOpen).toBe(false);

    const im = await prismaA.inventoryMovement.count();
    expect(im).toBe(0);

    const checks = await prismaA.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conname IN (
        'Supply_stockAccountingGeneration_nonnegative',
        'Supply_stockAccountingOpen_generation'
      )
    `;
    expect(checks.map((c) => c.conname).sort()).toEqual([
      "Supply_stockAccountingGeneration_nonnegative",
      "Supply_stockAccountingOpen_generation",
    ]);

    await expect(
      prismaA.$executeRaw`
        UPDATE "Supply"
        SET "stockAccountingOpen" = true, "stockAccountingGeneration" = 0
        WHERE id = ${never.id}
      `,
    ).rejects.toSatisfy(isCheckViolation);
  });

  it("A full shortfall: open Δ=0 cycle, duplicate no-op, Ozon cancel closes, next SHIPPED is gen 2", async () => {
    const { product } = await seedProduct(prismaA, `a-${Date.now()}`);
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 0 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-a",
        sku: product.skuOzon,
        productId: product.id,
        quantity: 10,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: "OZON",
        externalId: "ext-a",
        sku: product.skuOzon,
        targetQty: 10,
        productId: product.id,
        shadow: shadowOff,
      }),
    );
    let s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-a" } });
    expect(s.deductedQty).toBe(0);
    expect(s.shortfallQty).toBe(10);
    expect(s.stockAccountingGeneration).toBe(1);
    expect(s.stockAccountingOpen).toBe(true);
    const stockAfterFirst = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: product.id },
    });
    expect(stockAfterFirst.quantity).toBe(0);

    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: "OZON",
        externalId: "ext-a",
        sku: product.skuOzon,
        targetQty: 10,
        productId: product.id,
        shadow: shadowOff,
      }),
    );
    s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-a" } });
    expect(s.stockAccountingGeneration).toBe(1);
    expect(s.deductedQty).toBe(0);
    expect(s.shortfallQty).toBe(10);

    await prismaA.$transaction((tx) =>
      applyOzonSupplyCancellation(tx, {
        marketplace: "OZON",
        externalId: "ext-a",
        sku: product.skuOzon,
      }, { shadow: shadowOff }),
    );
    s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-a" } });
    expect(s.stockAccountingGeneration).toBe(1);
    expect(s.stockAccountingOpen).toBe(false);
    expect(s.deductedQty).toBe(0);
    expect(s.shortfallQty).toBe(0);
    expect(s.status).toBe("PENDING");
    const stockAfterCancel = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: product.id },
    });
    expect(stockAfterCancel.quantity).toBe(0);

    await prismaA.productStock.update({
      where: { productId: product.id },
      data: { quantity: 10 },
    });
    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: "OZON",
        externalId: "ext-a",
        sku: product.skuOzon,
        targetQty: 10,
        productId: product.id,
        shadow: shadowOff,
      }),
    );
    s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-a" } });
    expect(s.stockAccountingGeneration).toBe(2);
    expect(s.stockAccountingOpen).toBe(true);
    expect(s.deductedQty).toBe(10);
    expect(s.shortfallQty).toBe(0);
  });

  it("B partial shortfall: one-shot, cancel restores 3, next SHIPPED is gen 2", async () => {
    const { product } = await seedProduct(prismaA, `b-${Date.now()}`);
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 3 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-b",
        sku: product.skuOzon,
        productId: product.id,
        quantity: 10,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: "OZON",
        externalId: "ext-b",
        sku: product.skuOzon,
        targetQty: 10,
        productId: product.id,
        shadow: shadowOff,
      }),
    );
    let s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-b" } });
    expect(s).toMatchObject({
      deductedQty: 3,
      shortfallQty: 7,
      stockAccountingGeneration: 1,
      stockAccountingOpen: true,
    });

    await prismaA.productStock.update({
      where: { productId: product.id },
      data: { quantity: 50 },
    });
    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: "OZON",
        externalId: "ext-b",
        sku: product.skuOzon,
        targetQty: 10,
        productId: product.id,
        shadow: shadowOff,
      }),
    );
    s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-b" } });
    expect(s.deductedQty).toBe(3);
    expect(s.shortfallQty).toBe(7);
    expect(s.stockAccountingGeneration).toBe(1);
    const stockAfterRetry = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: product.id },
    });
    expect(stockAfterRetry.quantity).toBe(50);

    await prismaA.$transaction((tx) =>
      applyOzonSupplyCancellation(tx, {
        marketplace: "OZON",
        externalId: "ext-b",
        sku: product.skuOzon,
      }, { shadow: shadowOff }),
    );
    s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-b" } });
    expect(s.stockAccountingGeneration).toBe(1);
    expect(s.stockAccountingOpen).toBe(false);
    expect(s.deductedQty).toBe(0);
    expect(s.shortfallQty).toBe(0);
    const stockRestored = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: product.id },
    });
    expect(stockRestored.quantity).toBe(53);

    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: "OZON",
        externalId: "ext-b",
        sku: product.skuOzon,
        targetQty: 10,
        productId: product.id,
        shadow: shadowOff,
      }),
    );
    s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-b" } });
    expect(s.stockAccountingGeneration).toBe(2);
    expect(s.stockAccountingOpen).toBe(true);
  });

  it("C full success: duplicate SHIPPED no-op, cancel restores, duplicate cancel no-op, next gen 2", async () => {
    const { product } = await seedProduct(prismaA, `c-${Date.now()}`);
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 20 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-c",
        sku: product.skuOzon,
        productId: product.id,
        quantity: 10,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });

    const deduct = () =>
      prismaA.$transaction((tx) =>
        applySupplyDeduction(tx, {
          marketplace: "OZON",
          externalId: "ext-c",
          sku: product.skuOzon,
          targetQty: 10,
          productId: product.id,
          shadow: shadowOff,
        }),
      );
    await deduct();
    await deduct();
    let s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-c" } });
    expect(s.deductedQty).toBe(10);
    expect(s.stockAccountingGeneration).toBe(1);
    const stockOnce = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: product.id },
    });
    expect(stockOnce.quantity).toBe(10);

    const cancel = () =>
      prismaA.$transaction((tx) =>
        applyOzonSupplyCancellation(tx, {
          marketplace: "OZON",
          externalId: "ext-c",
          sku: product.skuOzon,
        }, { shadow: shadowOff }),
      );
    const first = await cancel();
    const second = await cancel();
    expect(first.restored).toBe(10);
    expect(first.closed).toBe(true);
    expect(first.generation).toBe(1);
    expect(second.restored).toBe(0);
    expect(second.closed).toBe(false);
    s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-c" } });
    expect(s.stockAccountingOpen).toBe(false);
    expect(s.stockAccountingGeneration).toBe(1);
    const stockRestored = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: product.id },
    });
    expect(stockRestored.quantity).toBe(20);

    await deduct();
    s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-c" } });
    expect(s.stockAccountingGeneration).toBe(2);
    expect(s.deductedQty).toBe(10);
  });

  it("D quantity increase stays in generation 1", async () => {
    const { product } = await seedProduct(prismaA, `d-${Date.now()}`);
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 50 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-d",
        sku: product.skuOzon,
        productId: product.id,
        quantity: 10,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: "OZON",
        externalId: "ext-d",
        sku: product.skuOzon,
        targetQty: 10,
        productId: product.id,
        shadow: shadowOff,
      }),
    );
    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: "OZON",
        externalId: "ext-d",
        sku: product.skuOzon,
        targetQty: 12,
        productId: product.id,
        shadow: shadowOff,
      }),
    );
    const s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-d" } });
    expect(s.stockAccountingGeneration).toBe(1);
    expect(s.stockAccountingOpen).toBe(true);
    expect(s.deductedQty).toBe(12);
    expect(s.shortfallQty).toBe(0);
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    expect(stock.quantity).toBe(38);
  });

  it("E concurrent duplicate deduction stays one generation", async () => {
    const { product } = await seedProduct(prismaA, `e-${Date.now()}`);
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-e",
        sku: product.skuOzon,
        productId: product.id,
        quantity: 8,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const run = (db: typeof prismaA) =>
      db.$transaction((tx) =>
        applySupplyDeduction(tx, {
          marketplace: "OZON",
          externalId: "ext-e",
          sku: product.skuOzon,
          targetQty: 8,
          productId: product.id,
          shadow: shadowOff,
        }),
      );
    await Promise.all([run(prismaA), run(prismaB)]);
    const s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-e" } });
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    expect(stock.quantity).toBe(2);
    expect(s.deductedQty).toBe(8);
    expect(s.stockAccountingGeneration).toBe(1);
    expect(s.stockAccountingOpen).toBe(true);
  });

  it("F concurrent cancel/deduct serializes physical stock mutation without double deduct/restore", async () => {
    // Proven: Supply FOR UPDATE serializes ProductStock mutation. No double
    // deduct, no over-restore, no negative stock.
    //
    // Legal serialized outcomes:
    // A. Deduct first, cancel later: closed cycle, watermarks 0, stock restored to 10, gen 1.
    // B. Deduct wins the lock and cancel is a no-op because no cycle was open yet:
    //    open cycle, deductedQty 10, stock 0, gen 1. Cancellation is not
    //    "logically lost" as a cycle-identity failure: a stale/out-of-order
    //    SHIPPED observation may temporarily leave an open cycle after an
    //    earlier cancellation observation. The persistent Ozon cancellation
    //    poll is responsible for later closing that same generation.
    // Same-sync cancel-wins is a different invariant (test G).
    const { product } = await seedProduct(prismaA, `f-${Date.now()}`);
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-f",
        sku: product.skuOzon,
        productId: product.id,
        quantity: 10,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const key = { marketplace: "OZON", externalId: "ext-f", sku: product.skuOzon };
    await Promise.all([
      prismaA.$transaction((tx) =>
        applySupplyDeduction(tx, { ...key, targetQty: 10, productId: product.id, shadow: shadowOff }),
      ),
      prismaB.$transaction(async (tx) => {
        await lockSuppliesInOrder(tx, [key]);
        return applyOzonSupplyCancellation(tx, key, { shadow: shadowOff });
      }),
    ]);
    const s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-f" } });
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    const deductedLike =
      s.stockAccountingOpen &&
      s.deductedQty === 10 &&
      s.shortfallQty === 0 &&
      stock.quantity === 0 &&
      s.stockAccountingGeneration === 1;
    const cancelledLike =
      !s.stockAccountingOpen &&
      s.deductedQty === 0 &&
      s.shortfallQty === 0 &&
      stock.quantity === 10 &&
      s.stockAccountingGeneration === 1;
    expect(deductedLike || cancelledLike).toBe(true);
    expect([0, 10]).toContain(stock.quantity);
  });

  it("G same-sync SHIPPED + cancelled ID: cancellation wins; no deduction/new cycle", async () => {
    const { product } = await seedProduct(prismaA, `g-${Date.now()}`);
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-g",
        sku: product.skuOzon,
        productId: product.id,
        quantity: 10,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const cancelled = new Set(["ext-g"]);
    expect(isOzonCancelledInThisSync("OZON", "ext-g", cancelled)).toBe(true);

    await prismaA.$transaction(async (tx) => {
      const deductKeys = isOzonCancelledInThisSync("OZON", "ext-g", cancelled)
        ? []
        : [{ marketplace: "OZON", externalId: "ext-g", sku: product.skuOzon }];
      const cancelRows = await findOzonSupplyKeysByExternalIds(tx, ["ext-g"]);
      await lockSuppliesInOrder(tx, [...deductKeys, ...cancelRows]);
      for (const key of deductKeys) {
        await applySupplyDeduction(tx, {
          ...key,
          targetQty: 10,
          productId: product.id,
          shadow: shadowOff,
        });
      }
      for (const key of cancelRows) {
        await applyOzonSupplyCancellation(tx, key, { shadow: shadowOff });
      }
    });

    const s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-g" } });
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    expect(s.stockAccountingGeneration).toBe(0);
    expect(s.stockAccountingOpen).toBe(false);
    expect(s.deductedQty).toBe(0);
    expect(stock.quantity).toBe(10);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("WB has no cancellation helper usage requirement: open cycle stays open", async () => {
    const { product } = await seedProduct(prismaA, `wb-${Date.now()}`);
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await prismaA.supply.create({
      data: {
        marketplace: "WB",
        externalId: "ext-wb",
        sku: product.skuWb,
        productId: product.id,
        quantity: 4,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: "WB",
        externalId: "ext-wb",
        sku: product.skuWb,
        targetQty: 4,
        productId: product.id,
        shadow: shadowOff,
      }),
    );
    const s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-wb" } });
    expect(s.stockAccountingGeneration).toBe(1);
    expect(s.stockAccountingOpen).toBe(true);
    expect(s.deductedQty).toBe(4);
  });
});
