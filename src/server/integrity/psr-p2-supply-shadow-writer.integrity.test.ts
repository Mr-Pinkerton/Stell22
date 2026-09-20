/**
 * PSR-P2 Supply SHADOW writer.
 * Trigger reject is integrity-only and keyed by actorDisplaySnapshot.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { COST_FLOW_QTY_ONLY_WRITER } from "@/server/internal/cost-flow-pools";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
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
import { persistMarketplaceSyncInTransaction } from "@/server/internal/marketplace-sync";
import {
  applyOzonSupplyCancellation,
  applySupplyDeduction,
  lockSuppliesInOrder,
  SUPPLY_CANCEL_PRODUCT_BINDING_REQUIRED,
} from "@/server/internal/supply-deduct";
import { SUPPLY_SHADOW_CONTEXT_REQUIRED } from "@/server/internal/supply-shadow-write";
import {
  supplyConsumeCausationSnapshotV1,
  supplyConsumeEffectKey,
  supplyRestoreCausationSnapshotV1,
  supplyRestoreEffectKey,
} from "@/server/internal/supply-shadow-write";
import type { NormalizedSale, NormalizedStock, NormalizedSupply } from "@/lib/marketplace-map";
import {
  createIntegrityClients,
  ensureIntegrityAdminUser,
  ensureIntegritySchema,
  INTEGRITY_ADMIN_USER_ID,
  integrityDatabaseUrl,
  resetIntegrityFinance,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
const BARRIER_TIMEOUT_MS = 25_000;
const REJECT_ACTOR = "INTEGRITY_REJECT_IM";

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BARRIER_TIMEOUT_MS) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`barrier: ${label}`);
}

describe.skipIf(!enabled)("PSR-P2 Supply SHADOW writer", () => {
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
    await resetIntegrityFinance(prismaA);
    await ensureIntegrityAdminUser(prismaA);
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

  const actor = userMovementActorFromAdmin({
    id: INTEGRITY_ADMIN_USER_ID,
    name: "Admin",
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

  async function seedProduct(suffix: string, skuOzon: string, skuWb = `WB-${suffix}`) {
    const material = await prismaA.material.create({
      data: { name: `supw-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    return prismaA.product.create({
      data: {
        name: `GP-${suffix}`,
        materialId: material.id,
        skuOzon,
        skuWb,
        sort: "SORT1",
      },
    });
  }

  function incoming(
    marketplace: "OZON" | "WB",
    externalId: string,
    sku: string,
    status: NormalizedSupply["status"],
    quantity: number,
  ): NormalizedSupply {
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

  function saleRow(externalId: string, sku: string): NormalizedSale {
    return {
      marketplace: "OZON",
      externalId,
      sku,
      quantity: 1,
      revenue: 1000,
      isReturn: false,
      date: new Date("2026-09-02T00:00:00.000Z"),
    };
  }

  function stockRow(marketplace: "OZON" | "WB", sku: string, quantity: number): NormalizedStock {
    return { marketplace, sku, quantity };
  }

  async function persist(input: {
    actor?: typeof actor;
    sales?: NormalizedSale[];
    supplies?: NormalizedSupply[];
    stocks?: NormalizedStock[];
    ozonCancelledExternalIds?: string[];
    products: Array<{ id: string; skuOzon: string; skuWb: string }>;
    stockReplace?: { wb: boolean; ozon: boolean };
    now?: Date;
  }) {
    const idByOzon = new Map(input.products.map((p) => [p.skuOzon, p.id]));
    const idByWb = new Map(input.products.map((p) => [p.skuWb, p.id]));
    return prismaA.$transaction(async (tx) => {
      return persistMarketplaceSyncInTransaction(tx, {
        actor: input.actor ?? actor,
        sales: input.sales ?? [],
        supplies: input.supplies ?? [],
        stocks: input.stocks ?? [],
        ozonCancelledExternalIds: input.ozonCancelledExternalIds ?? [],
        productIdFor: (marketplace, sku) =>
          (marketplace === "OZON" ? idByOzon.get(sku) : idByWb.get(sku)) ?? null,
        stockReplace: input.stockReplace ?? { wb: false, ozon: false },
        now: input.now ?? new Date("2026-09-19T12:00:00.000Z"),
        sources: { wb: "stub", ozon: "stub" },
      });
    }, txOpts);
  }

  it("SHADOW OFF deduction and positive Ozon restore emit zero movements", async () => {
    const product = await seedProduct(`off-${Date.now()}`, "OZ-OFF");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    const logsBefore = await prismaA.changeLog.count();
    await persist({
      products: [product],
      supplies: [incoming("OZON", "off-1", "OZ-OFF", "SHIPPED", 7)],
    });
    const afterDeduct = await prismaA.supply.findFirstOrThrow({
      where: { marketplace: "OZON", externalId: "off-1", sku: "OZ-OFF" },
    });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(3);
    expect(afterDeduct.deductedQty).toBe(7);
    expect(afterDeduct.shortfallQty).toBe(0);
    expect(afterDeduct.stockAccountingGeneration).toBe(1);
    expect(afterDeduct.stockAccountingOpen).toBe(true);
    expect(await prismaA.changeLog.count()).toBeGreaterThan(logsBefore);
    expect(await prismaA.inventoryMovement.count()).toBe(0);

    await persist({
      products: [product],
      ozonCancelledExternalIds: ["off-1"],
    });
    const afterRestore = await prismaA.supply.findUniqueOrThrow({ where: { id: afterDeduct.id } });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(10);
    expect(afterRestore.deductedQty).toBe(0);
    expect(afterRestore.shortfallQty).toBe(0);
    expect(afterRestore.stockAccountingOpen).toBe(false);
    expect(afterRestore.status).toBe("PENDING");
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("SHADOW ACTIVE consume writes exactly one PRODUCT CONSUMPTION for actual decrement", async () => {
    const product = await seedProduct(`c7-${Date.now()}`, "OZ-C7");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await setShadowGate(true);
    await persist({
      products: [product],
      supplies: [incoming("OZON", "c7", "OZ-C7", "SHIPPED", 7)],
    });
    const supply = await prismaA.supply.findFirstOrThrow({
      where: { marketplace: "OZON", externalId: "c7", sku: "OZ-C7" },
    });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(3);
    expect(supply.deductedQty).toBe(7);
    expect(supply.shortfallQty).toBe(0);
    expect(supply.stockAccountingGeneration).toBe(1);
    expect(supply.stockAccountingOpen).toBe(true);
    const movements = await prismaA.inventoryMovement.findMany();
    expect(movements).toHaveLength(1);
    const movement = movements[0]!;
    expect(movement.causationKind).toBe("SUPPLY");
    expect(movement.causationId).toBe(supply.id);
    expect(movement.stockDomain).toBe("PRODUCT");
    expect(movement.productId).toBe(product.id);
    expect(movement.kind).toBe("CONSUMPTION");
    expect(movement.quantityDelta).toBe(-7);
    expect(movement.authority).toBe("SHADOW");
    expect(movement.epochId).toBeNull();
    expect(movement.reason).toBeNull();
    expect(movement.reversalOfMovementId).toBeNull();
    expect(movement.actorKind).toBe("USER");
    expect(movement.userId).toBe(INTEGRITY_ADMIN_USER_ID);
    expect(movement.actorDisplaySnapshot).toBe("Admin");
    expect(movement.employeeId).toBeNull();
    expect(movement.systemActorKey).toBeNull();
    expect(movement.effectKey).toBe(supplyConsumeEffectKey(product.id, 1, 7));
    expect(movement.causationSnapshot).toEqual(
      supplyConsumeCausationSnapshotV1({
        supplyId: supply.id,
        marketplace: "OZON",
        externalId: "c7",
        sku: "OZ-C7",
        productId: product.id,
        stockAccountingGeneration: 1,
        processedQtyAfter: 7,
        deductedQtyAfter: 7,
        shortfallQtyAfter: 0,
        quantityDelta: -7,
      }),
    );
  });

  it("partial shortfall emits only the physical decrement and processed watermark w=target", async () => {
    const product = await seedProduct(`part-${Date.now()}`, "OZ-PART");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 6 } });
    await setShadowGate(true);
    await persist({
      products: [product],
      supplies: [incoming("OZON", "part", "OZ-PART", "SHIPPED", 10)],
    });
    const supply = await prismaA.supply.findFirstOrThrow({
      where: { marketplace: "OZON", externalId: "part", sku: "OZ-PART" },
    });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(0);
    expect(supply.deductedQty).toBe(6);
    expect(supply.shortfallQty).toBe(4);
    const movement = await prismaA.inventoryMovement.findFirstOrThrow();
    expect(movement.quantityDelta).toBe(-6);
    expect(movement.effectKey).toBe(supplyConsumeEffectKey(product.id, 1, 10));
    expect(movement.effectKey.endsWith("g=1:w=10")).toBe(true);
  });

  it("full shortfall and same-target retry emit zero movements", async () => {
    const product = await seedProduct(`full-${Date.now()}`, "OZ-FULL");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 0 } });
    await setShadowGate(true);
    await persist({
      products: [product],
      supplies: [incoming("OZON", "full", "OZ-FULL", "SHIPPED", 10)],
    });
    const supply = await prismaA.supply.findFirstOrThrow({
      where: { marketplace: "OZON", externalId: "full", sku: "OZ-FULL" },
    });
    expect(supply.deductedQty).toBe(0);
    expect(supply.shortfallQty).toBe(10);
    expect(supply.stockAccountingGeneration).toBe(1);
    expect(supply.stockAccountingOpen).toBe(true);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    await persist({
      products: [product],
      supplies: [incoming("OZON", "full", "OZ-FULL", "SHIPPED", 10)],
    });
    expect((await prismaA.supply.findUniqueOrThrow({ where: { id: supply.id } })).shortfallQty).toBe(10);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("same-generation quantity increase emits a second consume with a higher watermark", async () => {
    const product = await seedProduct(`inc-${Date.now()}`, "OZ-INC");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 6 } });
    await setShadowGate(true);
    await persist({
      products: [product],
      supplies: [incoming("OZON", "inc", "OZ-INC", "SHIPPED", 10)],
    });
    await prismaA.productStock.update({
      where: { productId: product.id },
      data: { quantity: 3 },
    });
    await persist({
      products: [product],
      supplies: [incoming("OZON", "inc", "OZ-INC", "SHIPPED", 15)],
    });
    const supply = await prismaA.supply.findFirstOrThrow({
      where: { marketplace: "OZON", externalId: "inc", sku: "OZ-INC" },
    });
    expect(supply.stockAccountingGeneration).toBe(1);
    expect(supply.deductedQty).toBe(9);
    expect(supply.shortfallQty).toBe(6);
    const movements = await prismaA.inventoryMovement.findMany({ orderBy: { recordedAt: "asc" } });
    expect(movements).toHaveLength(2);
    expect(movements[0]!.quantityDelta).toBe(-6);
    expect(movements[0]!.effectKey).toBe(supplyConsumeEffectKey(product.id, 1, 10));
    expect(movements[1]!.quantityDelta).toBe(-3);
    expect(movements[1]!.effectKey).toBe(supplyConsumeEffectKey(product.id, 1, 15));
  });

  it("consume OFF→ON retry does not backfill a movement", async () => {
    const product = await seedProduct(`nobf-${Date.now()}`, "OZ-NOBF");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await persist({
      products: [product],
      supplies: [incoming("OZON", "nobf", "OZ-NOBF", "SHIPPED", 7)],
    });
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    await setShadowGate(true);
    await persist({
      products: [product],
      supplies: [incoming("OZON", "nobf", "OZ-NOBF", "SHIPPED", 7)],
    });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(3);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("SHADOW ACTIVE restore writes one ADJUSTMENT for the closed-generation deducted qty", async () => {
    const product = await seedProduct(`rst-${Date.now()}`, "OZ-RST");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 2 } });
    const supply = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "rst",
        sku: "OZ-RST",
        productId: product.id,
        quantity: 10,
        status: "SHIPPED",
        deductedQty: 7,
        shortfallQty: 3,
        stockAccountingGeneration: 1,
        stockAccountingOpen: true,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await setShadowGate(true);
    await persist({
      products: [product],
      ozonCancelledExternalIds: ["rst"],
    });
    const after = await prismaA.supply.findUniqueOrThrow({ where: { id: supply.id } });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(9);
    expect(after.deductedQty).toBe(0);
    expect(after.shortfallQty).toBe(0);
    expect(after.stockAccountingOpen).toBe(false);
    expect(after.stockAccountingGeneration).toBe(1);
    expect(after.status).toBe("PENDING");
    const movement = await prismaA.inventoryMovement.findFirstOrThrow();
    expect(movement.kind).toBe("ADJUSTMENT");
    expect(movement.quantityDelta).toBe(7);
    expect(movement.effectKey).toBe(supplyRestoreEffectKey(product.id, 1, 7));
    expect(movement.causationKind).toBe("SUPPLY");
    expect(movement.causationId).toBe(supply.id);
    expect(movement.productId).toBe(product.id);
    expect(movement.actorKind).toBe("USER");
    expect(movement.userId).toBe(INTEGRITY_ADMIN_USER_ID);
    expect(movement.authority).toBe("SHADOW");
    expect(movement.epochId).toBeNull();
    expect(movement.reason).toBeNull();
    expect(movement.reversalOfMovementId).toBeNull();
    expect(movement.causationSnapshot).toEqual(
      supplyRestoreCausationSnapshotV1({
        supplyId: supply.id,
        marketplace: "OZON",
        externalId: "rst",
        sku: "OZ-RST",
        productId: product.id,
        stockAccountingGeneration: 1,
        deductedQtyBeforeClose: 7,
        shortfallQtyBeforeClose: 3,
        quantityDelta: 7,
      }),
    );
  });

  it("zero-restore cancellation closes the cycle without a movement", async () => {
    const product = await seedProduct(`zrst-${Date.now()}`, "OZ-ZRST");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 4 } });
    const supply = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "zrst",
        sku: "OZ-ZRST",
        productId: product.id,
        quantity: 8,
        status: "SHIPPED",
        deductedQty: 0,
        shortfallQty: 8,
        stockAccountingGeneration: 1,
        stockAccountingOpen: true,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await setShadowGate(true);
    await persist({
      products: [product],
      ozonCancelledExternalIds: ["zrst"],
    });
    const after = await prismaA.supply.findUniqueOrThrow({ where: { id: supply.id } });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(4);
    expect(after.stockAccountingOpen).toBe(false);
    expect(after.stockAccountingGeneration).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("pre-SHADOW consume then ACTIVE restore emits only the restore ADJUSTMENT", async () => {
    const product = await seedProduct(`pre-${Date.now()}`, "OZ-PRE");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await persist({
      products: [product],
      supplies: [incoming("OZON", "pre", "OZ-PRE", "SHIPPED", 5)],
    });
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    await setShadowGate(true);
    await persist({
      products: [product],
      ozonCancelledExternalIds: ["pre"],
    });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(10);
    const movements = await prismaA.inventoryMovement.findMany();
    expect(movements).toHaveLength(1);
    expect(movements[0]!.kind).toBe("ADJUSTMENT");
    expect(movements[0]!.quantityDelta).toBe(5);
    expect(movements[0]!.effectKey.startsWith("imfx1:restore:")).toBe(true);
  });

  it("cancellation OFF→ON duplicate does not backfill a restore movement", async () => {
    const product = await seedProduct(`crb-${Date.now()}`, "OZ-CRB");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 1 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "crb",
        sku: "OZ-CRB",
        productId: product.id,
        quantity: 4,
        status: "SHIPPED",
        deductedQty: 4,
        shortfallQty: 0,
        stockAccountingGeneration: 1,
        stockAccountingOpen: true,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await persist({
      products: [product],
      ozonCancelledExternalIds: ["crb"],
    });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(5);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    await setShadowGate(true);
    await persist({
      products: [product],
      ozonCancelledExternalIds: ["crb"],
    });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(5);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("same-sync cancellation wins: no consume, only actual restore", async () => {
    const product = await seedProduct(`win-${Date.now()}`, "OZ-WIN");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 2 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "win",
        sku: "OZ-WIN",
        productId: product.id,
        quantity: 6,
        status: "SHIPPED",
        deductedQty: 6,
        shortfallQty: 0,
        stockAccountingGeneration: 1,
        stockAccountingOpen: true,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await setShadowGate(true);
    await persist({
      products: [product],
      supplies: [incoming("OZON", "win", "OZ-WIN", "SHIPPED", 9)],
      ozonCancelledExternalIds: ["win"],
    });
    const supply = await prismaA.supply.findFirstOrThrow({
      where: { marketplace: "OZON", externalId: "win", sku: "OZ-WIN" },
    });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(8);
    expect(supply.stockAccountingOpen).toBe(false);
    expect(supply.deductedQty).toBe(0);
    const movements = await prismaA.inventoryMovement.findMany();
    expect(movements).toHaveLength(1);
    expect(movements[0]!.quantityDelta).toBe(6);
    expect(movements[0]!.kind).toBe("ADJUSTMENT");
    expect(movements[0]!.effectKey.startsWith("imfx1:restore:")).toBe(true);
  });

  it("null-product positive restore remains fail-closed before mutation", async () => {
    const product = await seedProduct(`nullp-${Date.now()}`, "OZ-NULLP");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 20 } });
    const supply = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "nullp",
        sku: "OZ-NULLP",
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
    await setShadowGate(true);
    const logsBefore = await prismaA.changeLog.count();
    await expect(
      persist({
        products: [product],
        ozonCancelledExternalIds: ["nullp"],
      }),
    ).rejects.toThrow(SUPPLY_CANCEL_PRODUCT_BINDING_REQUIRED);
    const after = await prismaA.supply.findUniqueOrThrow({ where: { id: supply.id } });
    expect(after.deductedQty).toBe(5);
    expect(after.shortfallQty).toBe(1);
    expect(after.stockAccountingOpen).toBe(true);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(20);
    expect(await prismaA.changeLog.count()).toBe(logsBefore);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("malformed SHADOW gate fails before Sale, Supply, ProductStock, MpStock, ChangeLog, movement", async () => {
    const product = await seedProduct(`bad-${Date.now()}`, "OZ-BAD");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await prismaA.sale.create({
      data: {
        marketplace: "OZON",
        externalId: "sale-bad",
        sku: "OZ-BAD",
        productId: product.id,
        quantity: 1,
        revenue: "100",
        isReturn: false,
        date: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await prismaA.mpStock.create({
      data: { marketplace: "OZON", sku: "OZ-BAD", quantity: 4, syncedAt: new Date("2026-09-01T00:00:00.000Z") },
    });
    const logsBefore = await prismaA.changeLog.count();
    await prismaA.setting.upsert({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
      create: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value: { version: 99, active: true } },
      update: { value: { version: 99, active: true } },
    });
    await expect(
      persist({
        products: [product],
        sales: [saleRow("sale-new", "OZ-BAD")],
        supplies: [incoming("OZON", "bad", "OZ-BAD", "SHIPPED", 7)],
        stocks: [stockRow("OZON", "OZ-BAD", 99)],
        stockReplace: { wb: false, ozon: true },
      }),
    ).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
    expect(await prismaA.sale.count()).toBe(1);
    expect(await prismaA.supply.count()).toBe(0);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(10);
    expect((await prismaA.mpStock.findFirstOrThrow()).quantity).toBe(4);
    expect(await prismaA.changeLog.count()).toBe(logsBefore);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("gate-flip: SHARED taken before Supply lock; EXCLUSIVE waits; persist then gate OFF", async () => {
    const product = await seedProduct(`flip-${Date.now()}`, "OZ-FLIP");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    const supply = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "flip",
        sku: "OZ-FLIP",
        productId: product.id,
        quantity: 4,
        status: "PENDING",
        deductedQty: 0,
        shortfallQty: 0,
        stockAccountingGeneration: 0,
        stockAccountingOpen: false,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await setShadowGate(true);
    const hold = { release: () => {}, ready: false };
    const holding = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      await lockSuppliesInOrder(tx, [{ marketplace: "OZON", externalId: "flip", sku: "OZ-FLIP" }]);
      hold.ready = true;
      await holding;
    }, txOpts);
    await waitUntil(() => hold.ready, "Supply held");
    const submit = persist({
      products: [product],
      supplies: [incoming("OZON", "flip", "OZ-FLIP", "SHIPPED", 7)],
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
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(10);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    hold.release();
    await holder;
    await submit;
    await gateOff;
    expect(gateFinished).toBe(true);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(3);
    expect((await prismaA.supply.findUniqueOrThrow({ where: { id: supply.id } })).deductedQty).toBe(7);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    const gate = await prismaA.setting.findUniqueOrThrow({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
    });
    expect(gate.value).toMatchObject({ version: 1, active: false });
  });

  it("movement-layer INSERT reject rolls back Sale, ProductStock, Supply watermarks, ChangeLog, movement", async () => {
    const product = await seedProduct(`rb-${Date.now()}`, "OZ-RB");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    const logsBefore = await prismaA.changeLog.count();
    await setShadowGate(true);
    await expect(
      persist({
        actor: userMovementActorFromAdmin({
          id: INTEGRITY_ADMIN_USER_ID,
          name: REJECT_ACTOR,
        }),
        products: [product],
        sales: [saleRow("sale-rb", "OZ-RB")],
        supplies: [incoming("OZON", "rb", "OZ-RB", "SHIPPED", 7)],
        stocks: [stockRow("OZON", "OZ-RB", 99)],
        stockReplace: { wb: false, ozon: true },
      }),
    ).rejects.toThrow(/integrity reject InventoryMovement insert/);
    expect(await prismaA.sale.count()).toBe(0);
    expect(await prismaA.supply.count()).toBe(0);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(10);
    expect(await prismaA.mpStock.count()).toBe(0);
    expect(await prismaA.changeLog.count()).toBe(logsBefore);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("movement-layer INSERT reject rolls back positive Ozon restore and cycle close", async () => {
    const product = await seedProduct(`rbr-${Date.now()}`, "OZ-RBR");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 2 } });
    const supply = await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "rbr",
        sku: "OZ-RBR",
        productId: product.id,
        quantity: 7,
        status: "SHIPPED",
        deductedQty: 7,
        shortfallQty: 1,
        stockAccountingGeneration: 1,
        stockAccountingOpen: true,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    const logsBefore = await prismaA.changeLog.count();
    await setShadowGate(true);
    await expect(
      persist({
        actor: userMovementActorFromAdmin({
          id: INTEGRITY_ADMIN_USER_ID,
          name: REJECT_ACTOR,
        }),
        products: [product],
        ozonCancelledExternalIds: ["rbr"],
      }),
    ).rejects.toThrow(/integrity reject InventoryMovement insert/);
    const after = await prismaA.supply.findUniqueOrThrow({ where: { id: supply.id } });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(2);
    expect(after.deductedQty).toBe(7);
    expect(after.shortfallQty).toBe(1);
    expect(after.stockAccountingOpen).toBe(true);
    expect(after.status).toBe("SHIPPED");
    expect(await prismaA.changeLog.count()).toBe(logsBefore);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("non-UTC session stores movement.effectiveAt as the UTC-naive physical occurrence", async () => {
    const product = await seedProduct(`tz-${Date.now()}`, "OZ-TZ");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await setShadowGate(true);
    const before = new Date();
    await prismaA.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/New_York'`);
      const tz = await tx.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`;
      expect(tz[0]?.tz).toBe("America/New_York");
      const idByOzon = new Map([[product.skuOzon, product.id]]);
      await persistMarketplaceSyncInTransaction(tx, {
        actor,
        sales: [],
        supplies: [incoming("OZON", "tz", "OZ-TZ", "SHIPPED", 4)],
        stocks: [],
        ozonCancelledExternalIds: [],
        productIdFor: (marketplace, sku) => (marketplace === "OZON" ? idByOzon.get(sku) ?? null : null),
        stockReplace: { wb: false, ozon: false },
        now: new Date("2026-01-01T00:00:00.000Z"),
        sources: { wb: "stub", ozon: "stub" },
      });
    }, txOpts);
    const after = new Date();
    const supply = await prismaA.supply.findFirstOrThrow({
      where: { marketplace: "OZON", externalId: "tz", sku: "OZ-TZ" },
    });
    const movement = await prismaA.inventoryMovement.findFirstOrThrow();
    const db = await prismaA.$queryRaw<Array<{ effective: string }>>`
      SELECT to_char(m."effectiveAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS effective
      FROM "InventoryMovement" m
      WHERE m.id = ${movement.id}
    `;
    const effective = db[0]!.effective;
    expect(effective >= utcNaiveTimestampString(before).slice(0, 23)).toBe(true);
    expect(effective <= utcNaiveTimestampString(after).slice(0, 23)).toBe(true);
    expect(effective.startsWith("2026-01-01")).toBe(false);
    expect(effective.startsWith("2026-09-01")).toBe(false);
    expect(supply.createdAt.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(movement.recordedAt).toBeInstanceOf(Date);
  });

  it("ACTIVE cost-flow positive deduct/restore fail closed; full shortfall still accounts with zero movements", async () => {
    await setCostFlowActive(true);
    await setShadowGate(true);
    const product = await seedProduct(`cf-${Date.now()}`, "OZ-CF");
    await prismaA.productStock.create({
      data: {
        productId: product.id,
        quantity: 10,
        materialValue: new Prisma.Decimal("0"),
        laborValue: new Prisma.Decimal("0"),
        nomenclatureValue: new Prisma.Decimal("0"),
        totalValue: new Prisma.Decimal("0"),
        costVersion: 1,
      },
    });
    await expect(
      persist({
        products: [product],
        supplies: [incoming("OZON", "cf", "OZ-CF", "SHIPPED", 4)],
      }),
    ).rejects.toThrow(COST_FLOW_QTY_ONLY_WRITER);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(10);

    await prismaA.productStock.update({
      where: { productId: product.id },
      data: { quantity: 0 },
    });
    await persist({
      products: [product],
      supplies: [incoming("OZON", "cfs", "OZ-CF", "SHIPPED", 3)],
    });
    const short = await prismaA.supply.findFirstOrThrow({
      where: { marketplace: "OZON", externalId: "cfs" },
    });
    expect(short.deductedQty).toBe(0);
    expect(short.shortfallQty).toBe(3);
    expect(short.stockAccountingOpen).toBe(true);
    expect(await prismaA.inventoryMovement.count()).toBe(0);

    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "cfr",
        sku: "OZ-CF",
        productId: product.id,
        quantity: 2,
        status: "SHIPPED",
        deductedQty: 2,
        shortfallQty: 0,
        stockAccountingGeneration: 1,
        stockAccountingOpen: true,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await expect(
      persist({
        products: [product],
        ozonCancelledExternalIds: ["cfr"],
      }),
    ).rejects.toThrow(COST_FLOW_QTY_ONLY_WRITER);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("does not emit a consume for PENDING upsert-only or WB cancellation", async () => {
    const product = await seedProduct(`pend-${Date.now()}`, "OZ-PEND", "WB-PEND");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 10 } });
    await setShadowGate(true);
    await persist({
      products: [product],
      supplies: [incoming("OZON", "pend", "OZ-PEND", "PENDING", 8)],
    });
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(10);
    expect(await prismaA.inventoryMovement.count()).toBe(0);

    await persist({
      products: [product],
      supplies: [incoming("WB", "wb1", "WB-PEND", "SHIPPED", 2)],
      ozonCancelledExternalIds: ["wb1"],
    });
    const wb = await prismaA.supply.findFirstOrThrow({
      where: { marketplace: "WB", externalId: "wb1" },
    });
    expect(wb.deductedQty).toBe(2);
    expect(wb.stockAccountingOpen).toBe(true);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    expect((await prismaA.inventoryMovement.findFirstOrThrow()).quantityDelta).toBe(-2);
  });

  it("omitted SHADOW context cannot silently mutate ProductStock", async () => {
    const product = await seedProduct(`omit-${Date.now()}`, "OZ-OMIT");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 5 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "omit",
        sku: "OZ-OMIT",
        productId: product.id,
        quantity: 3,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await setShadowGate(true);
    await expect(
      prismaA.$transaction(async (tx) => {
        await applySupplyDeduction(tx, {
          marketplace: "OZON",
          externalId: "omit",
          sku: "OZ-OMIT",
          targetQty: 3,
          productId: product.id,
        } as never);
      }, txOpts),
    ).rejects.toThrow(SUPPLY_SHADOW_CONTEXT_REQUIRED);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(5);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("explicit helper SHADOW OFF deducts physically with zero movements", async () => {
    const product = await seedProduct(`hoff-${Date.now()}`, "OZ-HOFF");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 5 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "hoff",
        sku: "OZ-HOFF",
        productId: product.id,
        quantity: 3,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await setShadowGate(true);
    await prismaA.$transaction(async (tx) => {
      await applySupplyDeduction(tx, {
        marketplace: "OZON",
        externalId: "hoff",
        sku: "OZ-HOFF",
        targetQty: 3,
        productId: product.id,
        shadow: { active: false, actor },
      });
    }, txOpts);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(2);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("explicit helper SHADOW ACTIVE deducts and writes the consume movement", async () => {
    const product = await seedProduct(`hon-${Date.now()}`, "OZ-HON");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 5 } });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: "hon",
        sku: "OZ-HON",
        productId: product.id,
        quantity: 3,
        status: "SHIPPED",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await setShadowGate(true);
    await prismaA.$transaction(async (tx) => {
      await applySupplyDeduction(tx, {
        marketplace: "OZON",
        externalId: "hon",
        sku: "OZ-HON",
        targetQty: 3,
        productId: product.id,
        shadow: { active: true, actor },
      });
    }, txOpts);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(2);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    expect((await prismaA.inventoryMovement.findFirstOrThrow()).quantityDelta).toBe(-3);
  });

  it("explicit helper restore OFF/ACTIVE and omitted context follow the same contract", async () => {
    const product = await seedProduct(`rsth-${Date.now()}`, "OZ-RSTH");
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 1 } });
    const key = { marketplace: "OZON" as const, externalId: "rsth", sku: "OZ-RSTH" };
    await prismaA.supply.create({
      data: {
        ...key,
        productId: product.id,
        quantity: 4,
        status: "SHIPPED",
        deductedQty: 4,
        shortfallQty: 0,
        stockAccountingGeneration: 1,
        stockAccountingOpen: true,
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      },
    });
    await setShadowGate(true);
    await expect(
      prismaA.$transaction(async (tx) => {
        await applyOzonSupplyCancellation(tx, key, {} as never);
      }, txOpts),
    ).rejects.toThrow(SUPPLY_SHADOW_CONTEXT_REQUIRED);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(0);

    await prismaA.$transaction(async (tx) => {
      await applyOzonSupplyCancellation(tx, key, { shadow: { active: false, actor } });
    }, txOpts);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(5);
    expect(await prismaA.inventoryMovement.count()).toBe(0);

    await prismaA.supply.update({
      where: { marketplace_externalId_sku: key },
      data: {
        deductedQty: 4,
        shortfallQty: 0,
        stockAccountingOpen: true,
        status: "SHIPPED",
      },
    });
    await prismaA.$transaction(async (tx) => {
      await applyOzonSupplyCancellation(tx, key, { shadow: { active: true, actor } });
    }, txOpts);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: product.id } })).quantity).toBe(9);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    expect((await prismaA.inventoryMovement.findFirstOrThrow()).quantityDelta).toBe(4);
  });
});
