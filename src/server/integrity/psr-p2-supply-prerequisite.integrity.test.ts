import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { COST_FLOW_QTY_ONLY_WRITER } from "@/server/internal/cost-flow-pools";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import {
  applyOzonSupplyCancellation,
  applySupplyDeduction,
  runSupplySyncAccounting,
  SUPPLY_CANCEL_PRODUCT_BINDING_REQUIRED,
} from "@/server/internal/supply-deduct";
import type { IncomingSupply } from "@/server/internal/supply-lock-plan";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  integrityDatabaseUrl,
  resetIntegrityFinance,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
const holdOpts = { maxWait: 30_000, timeout: 30_000 } as const;
const BARRIER_TIMEOUT_MS = 25_000;

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BARRIER_TIMEOUT_MS) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`barrier: ${label}`);
}

describe.skipIf(!enabled)("PSR-P2 Supply writer prerequisite", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];
  let prismaC: PrismaClient;

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
    prismaC = new PrismaClient({ datasourceUrl: integrityDatabaseUrl() });
  });

  beforeEach(async () => {
    await resetIntegrityFinance(prismaA);
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
    await prismaC?.$disconnect();
  });

  async function seedProduct(suffix: string, skuOzon: string, skuWb: string) {
    const material = await prismaA.material.create({
      data: { name: `pre-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const product = await prismaA.product.create({
      data: {
        name: `GP-${suffix}`,
        materialId: material.id,
        skuOzon,
        skuWb,
        sort: "SORT1",
      },
    });
    return product;
  }

  function incomingSupply(
    marketplace: string,
    externalId: string,
    sku: string,
    status: string,
    quantity: number,
  ): IncomingSupply {
    return {
      marketplace,
      externalId,
      sku,
      status,
      quantity,
      number: null,
      warehouseName: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      acceptedAt: null,
    };
  }

  async function setCostFlowActive(active: boolean) {
    await prismaA.setting.upsert({
      where: { key: PRODUCTION_COST_FLOW_KEY },
      create: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active } },
      update: { value: { version: 1, active } },
    });
  }

  async function lockWaiters(blockerPid: number, relation: "ProductStock" | "Supply") {
    const activity = await prismaC.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM pg_stat_activity a
      WHERE a.datname = current_database()
        AND a.wait_event_type = 'Lock'
        AND a.pid <> ${blockerPid}
    `;
    const locks = await prismaC.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
      WHERE NOT l.granted
        AND l.pid <> ${blockerPid}
        AND c.relname = ${relation}
        AND l.pid IN (
          SELECT a.pid
          FROM pg_stat_activity a
          WHERE a.datname = current_database()
            AND a.wait_event_type = 'Lock'
            AND a.pid <> ${blockerPid}
        )
    `;
    const xid = await prismaC.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM pg_locks l
      WHERE NOT l.granted
        AND l.pid <> ${blockerPid}
        AND l.locktype = 'transactionid'
        AND l.pid IN (
          SELECT a.pid
          FROM pg_stat_activity a
          WHERE a.datname = current_database()
            AND a.wait_event_type = 'Lock'
            AND a.pid <> ${blockerPid}
        )
    `;
    return {
      activity: activity[0]?.n ?? 0,
      locks: (locks[0]?.n ?? 0) + (xid[0]?.n ?? 0),
    };
  }

  it("null-product positive restore is fail-closed with unchanged watermarks", async () => {
    const product = await seedProduct(`null-${Date.now()}`, "OZ-NULL", "WB-NULL");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 20 } });
    const supply = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "null-bind",
        sku: "OZ-NULL",
        productId: null,
        quantity: 5,
        status: "SHIPPED",
        deductedQty: 5,
        shortfallQty: 1,
        stockAccountingGeneration: 2,
        stockAccountingOpen: true,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const beforeLogs = await prismaA.changeLog.count();
    await expect(
      prismaA.$transaction(async (tx) => {
        await applyOzonSupplyCancellation(tx, {
          marketplace: "OZON",
          externalId: "null-bind",
          sku: "OZ-NULL",
        });
        await tx.changeLog.create({
          data: {
            entity: "Supply",
            entityId: "OZON:null-bind:OZ-NULL",
            newValues: { event: "gp_restore_cancelled" },
          },
        });
      }, txOpts),
    ).rejects.toThrow(SUPPLY_CANCEL_PRODUCT_BINDING_REQUIRED);

    const after = await prismaA.supply.findUniqueOrThrow({ where: { id: supply.id } });
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    expect(after.deductedQty).toBe(5);
    expect(after.shortfallQty).toBe(1);
    expect(after.status).toBe("SHIPPED");
    expect(after.stockAccountingOpen).toBe(true);
    expect(after.stockAccountingGeneration).toBe(2);
    expect(after.productId).toBeNull();
    expect(stock.quantity).toBe(20);
    expect(await prismaA.changeLog.count()).toBe(beforeLogs);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("zero-restore null-product cancellation closes without ProductStock mutation", async () => {
    const product = await seedProduct(`zero-${Date.now()}`, "OZ-ZERO", "WB-ZERO");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 7 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "zero-restore",
        sku: "OZ-ZERO",
        productId: null,
        quantity: 4,
        status: "SHIPPED",
        deductedQty: 0,
        shortfallQty: 4,
        stockAccountingGeneration: 1,
        stockAccountingOpen: true,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const result = await prismaA.$transaction((tx) =>
      applyOzonSupplyCancellation(tx, {
        marketplace: "OZON",
        externalId: "zero-restore",
        sku: "OZ-ZERO",
      }),
    );
    expect(result).toEqual({ restored: 0, closed: true, generation: 1 });
    const after = await prismaA.supply.findFirstOrThrow({ where: { externalId: "zero-restore" } });
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    expect(after.deductedQty).toBe(0);
    expect(after.shortfallQty).toBe(0);
    expect(after.status).toBe("PENDING");
    expect(after.stockAccountingOpen).toBe(false);
    expect(after.stockAccountingGeneration).toBe(1);
    expect(after.productId).toBeNull();
    expect(stock.quantity).toBe(7);
  });

  it("same-sync Ozon cancellation still wins over deduction", async () => {
    const product = await seedProduct(`win-${Date.now()}`, "OZ-WIN", "WB-WIN");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-win",
        sku: "OZ-WIN",
        productId: product.id,
        quantity: 10,
        status: "SHIPPED",
        deductedQty: 0,
        shortfallQty: 0,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await prismaA.$transaction((tx) =>
      runSupplySyncAccounting(tx, {
        supplies: [incomingSupply("OZON", "ext-win", "OZ-WIN", "SHIPPED", 10)],
        ozonCancelledExternalIds: ["ext-win"],
        productIdFor: () => product.id,
      }),
    );
    const s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-win" } });
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    expect(s.stockAccountingOpen).toBe(false);
    expect(s.deductedQty).toBe(0);
    expect(s.shortfallQty).toBe(0);
    expect(stock.quantity).toBe(10);
  });

  it("INACTIVE deduction and restore remain quantity-only", async () => {
    const product = await seedProduct(`inact-${Date.now()}`, "OZ-IN", "WB-IN");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await prismaA.$transaction((tx) =>
      runSupplySyncAccounting(tx, {
        supplies: [incomingSupply("OZON", "ext-in", "OZ-IN", "SHIPPED", 4)],
        ozonCancelledExternalIds: [],
        productIdFor: () => product.id,
      }),
    );
    let s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-in" } });
    let stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    expect(s.deductedQty).toBe(4);
    expect(stock.quantity).toBe(6);
    expect(stock.costVersion).toBe(0);
    await prismaA.$transaction((tx) =>
      applyOzonSupplyCancellation(tx, {
        marketplace: "OZON",
        externalId: "ext-in",
        sku: "OZ-IN",
      }),
    );
    s = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-in" } });
    stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    expect(s.stockAccountingOpen).toBe(false);
    expect(s.status).toBe("PENDING");
    expect(stock.quantity).toBe(10);
    expect(stock.costVersion).toBe(0);
  });

  it("ACTIVE positive deduction and restore remain fail-closed; full shortfall still accounts", async () => {
    const product = await seedProduct(`act-${Date.now()}`, "OZ-ACT", "WB-ACT");
    await prismaA.productStock.create({
      data: {
        productId: product.id,
        quantity: 9,
        materialValue: new Prisma.Decimal("1"),
        laborValue: new Prisma.Decimal("1"),
        nomenclatureValue: new Prisma.Decimal("1"),
        totalValue: new Prisma.Decimal("3"),
        costVersion: 1,
      },
    });
    await setCostFlowActive(true);
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-act",
        sku: "OZ-ACT",
        productId: product.id,
        quantity: 3,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await expect(
      prismaA.$transaction((tx) =>
        applySupplyDeduction(tx, {
          marketplace: "OZON",
          externalId: "ext-act",
          sku: "OZ-ACT",
          targetQty: 3,
          productId: product.id,
        }),
      ),
    ).rejects.toThrow(COST_FLOW_QTY_ONLY_WRITER);

    const afterFail = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-act" } });
    expect(afterFail.deductedQty).toBe(0);
    expect(afterFail.stockAccountingOpen).toBe(false);
    const stockAfterFail = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: product.id },
    });
    expect(stockAfterFail.quantity).toBe(9);
    expect(stockAfterFail.costVersion).toBe(1);

    const empty = await seedProduct(`act-empty-${Date.now()}`, "OZ-ACT-E", "WB-ACT-E");
    await prismaA.productStock.create({
      data: {
        productId: empty.id,
        quantity: 0,
        materialValue: new Prisma.Decimal("0"),
        laborValue: new Prisma.Decimal("0"),
        nomenclatureValue: new Prisma.Decimal("0"),
        totalValue: new Prisma.Decimal("0"),
        costVersion: 1,
      },
    });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "ext-act-short",
        sku: "OZ-ACT-E",
        productId: empty.id,
        quantity: 3,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await prismaA.$transaction((tx) =>
      applySupplyDeduction(tx, {
        marketplace: "OZON",
        externalId: "ext-act-short",
        sku: "OZ-ACT-E",
        targetQty: 3,
        productId: empty.id,
      }),
    );
    const shorted = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-act-short" } });
    expect(shorted.deductedQty).toBe(0);
    expect(shorted.shortfallQty).toBe(3);
    expect(shorted.stockAccountingOpen).toBe(true);
    const emptyStock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: empty.id } });
    expect(emptyStock.quantity).toBe(0);
    expect(emptyStock.costVersion).toBe(1);

    await prismaA.supply.update({
      where: { id: afterFail.id },
      data: { deductedQty: 2, shortfallQty: 0, stockAccountingOpen: true, stockAccountingGeneration: 1 },
    });
    await expect(
      prismaA.$transaction((tx) =>
        applyOzonSupplyCancellation(tx, {
          marketplace: "OZON",
          externalId: "ext-act",
          sku: "OZ-ACT",
        }),
      ),
    ).rejects.toThrow(COST_FLOW_QTY_ONLY_WRITER);
    const afterRestoreFail = await prismaA.supply.findFirstOrThrow({ where: { externalId: "ext-act" } });
    expect(afterRestoreFail.deductedQty).toBe(2);
    expect(afterRestoreFail.stockAccountingOpen).toBe(true);
    const stockUnchanged = await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } });
    expect(stockUnchanged.quantity).toBe(9);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it(
    "reversed-order overlapping ProductStock syncs lock P1 then P2 without deadlock",
    { timeout: 40_000 },
    async () => {
      const stamp = Date.now();
      const p1 = await seedProduct(`p1-${stamp}`, "OZ-P1", "WB-P1");
      const p2 = await seedProduct(`p2-${stamp}`, "OZ-P2", "WB-P2");
      await prismaA.productStock.create({ data: { productId: p1.id, quantity: 100 } });
      await prismaA.productStock.create({ data: { productId: p2.id, quantity: 100 } });
      const productIdFor = (marketplace: string, sku: string) => {
        if (marketplace === "OZON" && sku === "OZ-P1") return p1.id;
        if (marketplace === "OZON" && sku === "OZ-P2") return p2.id;
        return null;
      };

      let blockerPid = 0;
      let holding = false;
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const overlap = { activity: 0, locks: 0 };

      const blocker = prismaC.$transaction(async (tx) => {
        const pidRows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        blockerPid = Number(pidRows[0]?.pid);
        await tx.$queryRaw`
          SELECT id FROM "ProductStock" WHERE "productId" = ${p1.id} FOR UPDATE
        `;
        holding = true;
        await released;
      }, holdOpts);

      await waitUntil(() => holding && blockerPid > 0, "blocker holds P1");

      const run = (
        client: typeof prismaA,
        supplies: IncomingSupply[],
      ) =>
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '8s'`);
          await tx.$executeRawUnsafe(`SET LOCAL deadlock_timeout = '200ms'`);
          return runSupplySyncAccounting(tx, {
            supplies,
            ozonCancelledExternalIds: [],
            productIdFor,
          });
        }, txOpts);

      const t1 = run(prismaA, [
        incomingSupply("OZON", `t1-b-${stamp}`, "OZ-P2", "SHIPPED", 3),
        incomingSupply("OZON", `t1-a-${stamp}`, "OZ-P1", "SHIPPED", 3),
      ]);
      const t2 = run(prismaB, [
        incomingSupply("OZON", `t2-a-${stamp}`, "OZ-P1", "SHIPPED", 3),
        incomingSupply("OZON", `t2-b-${stamp}`, "OZ-P2", "SHIPPED", 3),
      ]);

      await waitUntil(async () => {
        const seen = await lockWaiters(blockerPid, "ProductStock");
        if (seen.activity >= 2 && seen.locks >= 2) {
          overlap.activity = seen.activity;
          overlap.locks = seen.locks;
          return true;
        }
        return false;
      }, "two concurrent waiters on P1");
      release();

      const [r1, r2] = await Promise.all([t1, t2]);
      await blocker;
      expect(r1.deductedTotal).toBe(6);
      expect(r2.deductedTotal).toBe(6);
      expect(overlap.activity).toBeGreaterThanOrEqual(2);
      expect(overlap.locks).toBeGreaterThanOrEqual(2);

      const stock1 = await prismaA.productStock.findUniqueOrThrow({ where: { productId: p1.id } });
      const stock2 = await prismaA.productStock.findUniqueOrThrow({ where: { productId: p2.id } });
      expect(stock1.quantity).toBe(94);
      expect(stock2.quantity).toBe(94);
      const supplies = await prismaA.supply.findMany({
        where: { externalId: { in: [`t1-a-${stamp}`, `t1-b-${stamp}`, `t2-a-${stamp}`, `t2-b-${stamp}`] } },
        orderBy: { externalId: "asc" },
      });
      expect(supplies).toHaveLength(4);
      for (const row of supplies) {
        expect(row.deductedQty).toBe(3);
        expect(row.shortfallQty).toBe(0);
        expect(row.stockAccountingGeneration).toBe(1);
        expect(row.stockAccountingOpen).toBe(true);
      }
      expect(await prismaA.inventoryMovement.count()).toBe(0);
    },
  );

  it(
    "reversed incoming Supply upserts wait on canonical first key, not provider order",
    { timeout: 40_000 },
    async () => {
      const stamp = Date.now();
      const oz = await seedProduct(`up-oz-${stamp}`, "OZ-UP", "WB-UP-O");
      const wb = await seedProduct(`up-wb-${stamp}`, "OZ-UP-W", "WB-UP");
      await prismaA.supply.create({
        data: {
          marketplace: "OZON",
          externalId: "up-ozon",
          sku: "OZ-UP",
          productId: oz.id,
          quantity: 1,
          status: "PENDING",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      });
      await prismaA.supply.create({
        data: {
          marketplace: "WB",
          externalId: "up-wb",
          sku: "WB-UP",
          productId: wb.id,
          quantity: 1,
          status: "PENDING",
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
        },
      });

      let blockerPid = 0;
      let holding = false;
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const overlap = { activity: 0, locks: 0 };
      const blocker = prismaC.$transaction(async (tx) => {
        const pidRows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        blockerPid = Number(pidRows[0]?.pid);
        await tx.$queryRaw`
          SELECT id FROM "Supply"
          WHERE marketplace = 'OZON' AND "externalId" = 'up-ozon' AND sku = 'OZ-UP'
          FOR UPDATE
        `;
        holding = true;
        await released;
      }, holdOpts);
      await waitUntil(() => holding && blockerPid > 0, "blocker holds OZON supply");

      const productIdFor = (marketplace: string, sku: string) => {
        if (marketplace === "OZON" && sku === "OZ-UP") return oz.id;
        if (marketplace === "WB" && sku === "WB-UP") return wb.id;
        return null;
      };
      const run = (client: typeof prismaA, supplies: IncomingSupply[]) =>
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '8s'`);
          await tx.$executeRawUnsafe(`SET LOCAL deadlock_timeout = '200ms'`);
          return runSupplySyncAccounting(tx, {
            supplies,
            ozonCancelledExternalIds: [],
            productIdFor,
          });
        }, txOpts);

      const t1 = run(prismaA, [
        incomingSupply("WB", "up-wb", "WB-UP", "PENDING", 4),
        incomingSupply("OZON", "up-ozon", "OZ-UP", "PENDING", 5),
      ]);
      const t2 = run(prismaB, [
        incomingSupply("OZON", "up-ozon", "OZ-UP", "PENDING", 7),
        incomingSupply("WB", "up-wb", "WB-UP", "PENDING", 8),
      ]);

      await waitUntil(async () => {
        const seen = await lockWaiters(blockerPid, "Supply");
        if (seen.activity >= 2 && seen.locks >= 2) {
          overlap.activity = seen.activity;
          overlap.locks = seen.locks;
          return true;
        }
        return false;
      }, "two concurrent waiters on canonical first Supply");
      release();
      await Promise.all([t1, t2, blocker]);
      expect(overlap.activity).toBeGreaterThanOrEqual(2);
      expect(overlap.locks).toBeGreaterThanOrEqual(2);
      const ozon = await prismaA.supply.findFirstOrThrow({ where: { externalId: "up-ozon" } });
      const wbRow = await prismaA.supply.findFirstOrThrow({ where: { externalId: "up-wb" } });
      expect(ozon.status).toBe("PENDING");
      expect(wbRow.status).toBe("PENDING");
      expect([5, 7]).toContain(ozon.quantity);
      expect([4, 8]).toContain(wbRow.quantity);
    },
  );
});
