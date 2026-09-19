/**
 * PSR-P2 Inventory writer prerequisite proofs retained after the writer lands.
 *
 * Writer-specific movement proofs live in
 * `psr-p2-inventory-shadow-writer.integrity.test.ts`.
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));

const sessionState = vi.hoisted(() => ({
  admin: {
    id: "integrity-admin",
    name: "Admin",
    email: "admin@test.local",
    role: "ADMIN",
  },
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => sessionState.admin,
  requireTerminalEmployee: async (expectedEmployeeId?: string) => ({
    id: expectedEmployeeId ?? "integrity-session-employee",
    fullName: "Integrity Employee",
  }),
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import {
  INVENTORY_DUAL_ACTIVE_UNSUPPORTED,
} from "@/server/internal/inventory-conduct";
import {
  ALREADY_CONDUCTED,
  blankSpecSortKey,
  collectInventoryBlankLockSpecs,
  lockBlankSpecs,
} from "@/server/internal/inventory-integrity";
import { setInventoryMovementShadowWriteGate } from "@/server/internal/inventory-movement-shadow-write";
import {
  conductInventory,
  createInventoryDraft,
  updateInventoryLineActual,
} from "@/server/warehouse";
import {
  INTEGRITY_ADMIN_USER_ID,
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
const BARRIER_TIMEOUT_MS = 20_000;
const ACTOR_USER_ID = "psr-p2-inventory-actor-user";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BARRIER_TIMEOUT_MS) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`barrier: ${label}`);
}

describe.skipIf(!enabled)("PSR-P2 Inventory writer prerequisite", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
  });

  beforeEach(async () => {
    sessionState.admin = {
      id: INTEGRITY_ADMIN_USER_ID,
      name: "Admin",
      email: "admin@test.local",
      role: "ADMIN",
    };
    await resetIntegrityInventory(prismaA);
    await prismaA.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`);
  });

  afterAll(async () => {
    await prismaA?.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`).catch(() => {});
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
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

  async function seedBlankPool(args: {
    materialName: string;
    lengthM: string;
    quantity: number;
    detailNumber: number;
  }) {
    const material = await prismaA.material.create({
      data: { name: args.materialName, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    await prismaA.detail.create({
      data: {
        name: `${args.materialName} detail`,
        materialId: material.id,
        detailNumber: args.detailNumber,
        lengthM: new Prisma.Decimal(args.lengthM),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    const blank = await prismaA.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: new Prisma.Decimal(args.lengthM),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: args.quantity,
      },
    });
    return { material, blank };
  }

  async function seedTwoBlankPools() {
    const shortSeed = await seedBlankPool({
      materialName: "Материал A",
      lengthM: "1.2000",
      quantity: 10,
      detailNumber: 1,
    });
    const longSeed = await seedBlankPool({
      materialName: "Материал Z",
      lengthM: "1.8000",
      quantity: 4,
      detailNumber: 2,
    });
    return {
      materialA: shortSeed.material,
      materialZ: longSeed.material,
      short: shortSeed.blank,
      long: longSeed.blank,
    };
  }

  async function snapshotPhysical() {
    const [blanks, details, products, noms, inventories, lines, logs, movements] = await Promise.all([
      prismaA.blankStock.findMany({ orderBy: { id: "asc" } }),
      prismaA.detailStock.findMany({ orderBy: { id: "asc" } }),
      prismaA.productStock.findMany({ orderBy: { id: "asc" } }),
      prismaA.nomenclatureStock.findMany({ orderBy: { id: "asc" } }),
      prismaA.inventory.findMany({ orderBy: { id: "asc" } }),
      prismaA.inventoryLine.findMany({ orderBy: { id: "asc" } }),
      prismaA.changeLog.findMany({ orderBy: { id: "asc" } }),
      prismaA.inventoryMovement.count(),
    ]);
    return { blanks, details, products, noms, inventories, lines, logs, movements };
  }

  it("SHADOW inactive: existing Inventory conduct still applies projection once and writes 0 movements", async () => {
    const { short } = await seedTwoBlankPools();
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === short.id);
    expect(line).toBeTruthy();
    await updateInventoryLineActual(line!.id, 7);

    const conducted = await conductInventory(draft.id);
    expect(conducted.status).toBe("CONDUCTED");
    expect(conducted.lines.find((l) => l.id === line!.id)?.deviation).toBe(-3);

    const after = await prismaA.blankStock.findUniqueOrThrow({ where: { id: short.id } });
    expect(after.quantity).toBe(7);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    const header = await prismaA.changeLog.findFirst({
      where: { entity: "Inventory", entityId: draft.id },
      orderBy: { changedAt: "desc" },
    });
    const rec = header?.newValues as Record<string, unknown> | null;
    expect(rec?.status).toBe("CONDUCTED");
    expect(header?.userId).toBe(INTEGRITY_ADMIN_USER_ID);
  });

  it("SHADOW ACTIVE writes projection and SHADOW movements atomically", async () => {
    const { short } = await seedTwoBlankPools();
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === short.id);
    await updateInventoryLineActual(line!.id, 7);
    await setShadowGate(true);
    await setCostFlowActive(false);

    const conducted = await conductInventory(draft.id);
    expect(conducted.status).toBe("CONDUCTED");
    const after = await prismaA.blankStock.findUniqueOrThrow({ where: { id: short.id } });
    expect(after.quantity).toBe(7);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    const movement = await prismaA.inventoryMovement.findFirstOrThrow();
    expect(movement.causationKind).toBe("INVENTORY");
    expect(movement.causationId).toBe(draft.id);
    expect(movement.kind).toBe("ADJUSTMENT");
    expect(movement.quantityDelta).toBe(-3);
    expect(movement.authority).toBe("SHADOW");
  });

  it("dual-active fails closed with a distinct error before physical mutation", async () => {
    const { short } = await seedTwoBlankPools();
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === short.id);
    await updateInventoryLineActual(line!.id, 7);
    await setShadowGate(true);
    await setCostFlowActive(true);
    const before = await snapshotPhysical();

    await expect(conductInventory(draft.id)).rejects.toThrow(INVENTORY_DUAL_ACTIVE_UNSUPPORTED);

    const after = await snapshotPhysical();
    expect(after).toEqual(before);
    expect(after.inventories[0]?.status).toBe("DRAFT");
    expect(after.movements).toBe(0);
  });

  it("second conduct is ALREADY_CONDUCTED and does not apply projection twice", async () => {
    const { short } = await seedTwoBlankPools();
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === short.id);
    await updateInventoryLineActual(line!.id, 13);
    await conductInventory(draft.id);
    const afterFirst = await snapshotPhysical();

    await expect(conductInventory(draft.id)).rejects.toThrow(ALREADY_CONDUCTED);

    const afterSecond = await snapshotPhysical();
    expect(afterSecond.blanks.map((row) => ({ id: row.id, quantity: row.quantity }))).toEqual(
      afterFirst.blanks.map((row) => ({ id: row.id, quantity: row.quantity })),
    );
    expect(afterSecond.inventories).toHaveLength(1);
    expect(afterSecond.inventories[0]?.status).toBe("CONDUCTED");
    expect(afterSecond.movements).toBe(0);
    const conductLogs = afterSecond.logs.filter((row) => {
      if (row.entity !== "Inventory") return false;
      const rec = row.newValues as Record<string, unknown> | null;
      return rec?.status === "CONDUCTED";
    });
    expect(conductLogs).toHaveLength(1);
  });

  it("overlapping BlankStock lock plans from reversed line order do not deadlock", async () => {
    const { short, long } = await seedTwoBlankPools();
    const linesBA = [
      { refType: "BLANK", refId: long.id },
      { refType: "BLANK", refId: short.id },
    ];
    const linesAB = [
      { refType: "BLANK", refId: short.id },
      { refType: "BLANK", refId: long.id },
    ];
    const beforeQty = await prismaA.blankStock.findMany({
      select: { id: true, quantity: true },
      orderBy: { id: "asc" },
    });

    const started = { a: false, b: false };
    const lockTx = async (
      client: typeof prismaA,
      lines: Array<{ refType: string; refId: string }>,
      who: "a" | "b",
    ) => {
      return client.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '8s'`);
          await tx.$executeRawUnsafe(`SET LOCAL deadlock_timeout = '200ms'`);
          const specs = await collectInventoryBlankLockSpecs(tx, lines);
          started[who] = true;
          await waitUntil(() => started.a && started.b, "blank-lock overlap");
          await lockBlankSpecs(tx, specs);
          await new Promise((resolve) => setTimeout(resolve, 250));
          return specs.map(blankSpecSortKey);
        },
        txOpts,
      );
    };

    const settled = await Promise.allSettled([lockTx(prismaA, linesBA, "a"), lockTx(prismaB, linesAB, "b")]);
    expect(settled.map((row) => row.status)).toEqual(["fulfilled", "fulfilled"]);
    const plans = settled.map((row) => (row.status === "fulfilled" ? row.value : []));
    expect(plans[0]).toEqual(plans[1]);
    expect(plans[0]?.[0]).toContain(short.materialId);

    const afterQty = await prismaA.blankStock.findMany({
      select: { id: true, quantity: true },
      orderBy: { id: "asc" },
    });
    expect(afterQty).toEqual(beforeQty);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("P2-02 mixed BLANK + no-prisadka DETAIL alias reversed order does not deadlock", async () => {
    const { short, long, materialA, materialZ } = await seedTwoBlankPools();
    const aliasA = await prismaA.detail.findFirstOrThrow({ where: { materialId: materialA.id } });
    const aliasZ = await prismaA.detail.findFirstOrThrow({ where: { materialId: materialZ.id } });
    const linesBA = [
      { refType: "DETAIL", refId: aliasZ.id },
      { refType: "BLANK", refId: long.id },
      { refType: "BLANK", refId: short.id },
      { refType: "DETAIL", refId: aliasA.id },
    ];
    const linesAB = [
      { refType: "BLANK", refId: short.id },
      { refType: "DETAIL", refId: aliasA.id },
      { refType: "BLANK", refId: long.id },
      { refType: "DETAIL", refId: aliasZ.id },
    ];
    const started = { a: false, b: false };
    const lockTx = async (
      client: typeof prismaA,
      lines: Array<{ refType: string; refId: string }>,
      who: "a" | "b",
    ) => {
      return client.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '8s'`);
          await tx.$executeRawUnsafe(`SET LOCAL deadlock_timeout = '200ms'`);
          const specs = await collectInventoryBlankLockSpecs(tx, lines);
          started[who] = true;
          await waitUntil(() => started.a && started.b, "mixed blank-alias overlap");
          await lockBlankSpecs(tx, specs);
          await new Promise((resolve) => setTimeout(resolve, 250));
          return specs.map(blankSpecSortKey);
        },
        txOpts,
      );
    };
    const settled = await Promise.allSettled([lockTx(prismaA, linesBA, "a"), lockTx(prismaB, linesAB, "b")]);
    expect(settled.map((row) => row.status)).toEqual(["fulfilled", "fulfilled"]);
    const plans = settled.map((row) => (row.status === "fulfilled" ? row.value : []));
    expect(plans[0]).toEqual(plans[1]);
    expect(plans[0]).toHaveLength(2);
  });

  it("retains the authenticated User.id on the Inventory conduct ChangeLog", async () => {
    await prismaA.user.upsert({
      where: { id: ACTOR_USER_ID },
      create: {
        id: ACTOR_USER_ID,
        email: "inventory-actor@test.local",
        passwordHash: "integrity",
        name: "Инвентаризатор",
        role: "ADMIN",
      },
      update: { name: "Инвентаризатор" },
    });
    sessionState.admin = {
      id: ACTOR_USER_ID,
      name: "Инвентаризатор",
      email: "inventory-actor@test.local",
      role: "ADMIN",
    };

    const { short } = await seedTwoBlankPools();
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === short.id);
    await updateInventoryLineActual(line!.id, 8);
    await conductInventory(draft.id);

    const header = await prismaA.changeLog.findFirstOrThrow({
      where: { entity: "Inventory", entityId: draft.id },
      orderBy: { changedAt: "desc" },
    });
    expect(header.userId).toBe(ACTOR_USER_ID);
    expect(header.userId).not.toBe("Admin");
    const rec = header.newValues as Record<string, unknown>;
    expect(rec.status).toBe("CONDUCTED");
    expect(rec.actorKind).toBe("USER");
    expect(rec.actorDisplaySnapshot).toBe("Инвентаризатор");
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("concurrent second conduct of the same DRAFT leaves projection applied once", async () => {
    const { short } = await seedTwoBlankPools();
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === short.id);
    await updateInventoryLineActual(line!.id, 9);

    const settled = await Promise.allSettled([conductInventory(draft.id), conductInventory(draft.id)]);
    const fulfilled = settled.filter((row) => row.status === "fulfilled");
    const rejected = settled.filter((row) => row.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(errorMessage((rejected[0] as PromiseRejectedResult).reason)).toBe(ALREADY_CONDUCTED);

    const after = await prismaA.blankStock.findUniqueOrThrow({ where: { id: short.id } });
    expect(after.quantity).toBe(9);
    const doc = await prismaA.inventory.findUniqueOrThrow({ where: { id: draft.id } });
    expect(doc.status).toBe("CONDUCTED");
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });
});
