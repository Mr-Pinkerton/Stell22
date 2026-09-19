/**
 * PSR-P2 Inventory SHADOW writer proofs.
 * UNIQUE(causationKind, causationId, effectKey) is used only as an injected
 * failure barrier in the atomic-rollback test, not as projection idempotency.
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
  requireTerminalEmployee: async () => {},
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import {
  INVENTORY_DUAL_ACTIVE_UNSUPPORTED,
  conductInventoryInTransaction,
} from "@/server/internal/inventory-conduct";
import { ALREADY_CONDUCTED, lockInventoryForUpdate } from "@/server/internal/inventory-integrity";
import {
  canonicalizeMovementTarget,
  compareEffectKey,
  effectKeyV1,
  targetHashV1,
  targetKeyV1,
} from "@/server/internal/inventory-movement-identity";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import { appendShadowInventoryMovements } from "@/server/internal/inventory-movement-shadow-gateway";
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
import {
  conductInventory,
  createInventoryDraft,
  updateInventoryLineActual,
} from "@/server/warehouse";
import {
  INTEGRITY_ADMIN_USER_ID,
  createIntegrityClients,
  ensureIntegritySchema,
  integrityDatabaseUrl,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
const BARRIER_TIMEOUT_MS = 20_000;
const ACTOR_USER_ID = "psr-p2-inventory-writer-actor";

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isRawUniqueViolation(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${err.stack ?? ""}` : String(err);
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  return (
    code === "P2002" ||
    code === "23505" ||
    /23505/.test(text) ||
    /already exists/i.test(text) ||
    /unique constraint/i.test(text)
  );
}

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BARRIER_TIMEOUT_MS) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`barrier: ${label}`);
}

describe.skipIf(!enabled)("PSR-P2 Inventory SHADOW writer", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];
  let prismaC: PrismaClient;

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
    prismaC = new PrismaClient({ datasourceUrl: integrityDatabaseUrl() });
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
    await prismaC?.$disconnect();
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

  async function seedBlank(quantity: number) {
    const material = await prismaA.material.create({
      data: { name: "Материал writer", sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    await prismaA.detail.create({
      data: {
        name: "Blank alias",
        materialId: material.id,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    const blank = await prismaA.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity,
      },
    });
    return { material, blank };
  }

  async function snapshotState() {
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

  it("SHADOW inactive: projection once and zero movements", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 7);
    await conductInventory(draft.id);
    const after = await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } });
    expect(after.quantity).toBe(7);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    const doc = await prismaA.inventory.findUniqueOrThrow({ where: { id: draft.id } });
    expect(doc.status).toBe("CONDUCTED");
    expect(doc.date).toBeInstanceOf(Date);
    const conductedLine = await prismaA.inventoryLine.findUniqueOrThrow({ where: { id: line!.id } });
    expect(conductedLine.deviation).toBe(-3);
  });

  it("BLANK 10→7 SHADOW ACTIVE: one ADJUSTMENT -3 with exact identity", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 7);
    await setShadowGate(true);
    const conducted = await conductInventory(draft.id);
    expect(conducted.status).toBe("CONDUCTED");
    expect((await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } })).quantity).toBe(7);

    const rows = await prismaA.inventoryMovement.findMany({ orderBy: { effectKey: "asc" } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.causationKind).toBe("INVENTORY");
    expect(row.causationId).toBe(draft.id);
    expect(row.kind).toBe("ADJUSTMENT");
    expect(row.stockDomain).toBe("BLANK");
    expect(row.quantityDelta).toBe(-3);
    expect(row.authority).toBe("SHADOW");
    expect(row.epochId).toBeNull();
    expect(row.actorKind).toBe("USER");
    expect(row.userId).toBe(INTEGRITY_ADMIN_USER_ID);
    expect(row.employeeId).toBeNull();
    expect(row.systemActorKey).toBeNull();
    expect(row.reason).toBeNull();
    expect(row.materialId).toBe(blank.materialId);
    expect(row.detailType).toBe("POLKA");
    expect(row.sort).toBe("SORT1");

    const target = {
      stockDomain: "BLANK" as const,
      materialId: blank.materialId,
      lengthM: blank.lengthM,
      detailType: blank.detailType,
      sort: blank.sort,
    };
    const canonical = canonicalizeMovementTarget(target);
    expect(row.effectKey).toBe(effectKeyV1("adjust", canonical.targetHashV1));
    expect(row.effectKey).toBe(`imfx1:adjust:${targetHashV1(targetKeyV1(target))}`);
    expect(row.targetSnapshot).toEqual({
      v: 1,
      d: "BLANK",
      materialId: blank.materialId,
      lengthM: "1.8000",
      detailType: "POLKA",
      sort: "SORT1",
    });
    expect(row.causationSnapshot).toEqual({
      v: 1,
      d: "INVENTORY",
      inventoryId: draft.id,
      action: "CONDUCT",
    });
    const persisted = await prismaA.inventory.findUniqueOrThrow({ where: { id: draft.id } });
    expect(utcNaiveTimestampString(row.effectiveAt)).toBe(utcNaiveTimestampString(persisted.date));
    expect(row.recordedAt).toBeInstanceOf(Date);
  });

  it("non-UTC session: Inventory.date and movement effectiveAt stay the same UTC-naive instant", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 7);
    await setShadowGate(true);
    await setCostFlowActive(false);
    const actor = userMovementActorFromAdmin(sessionState.admin);

    await prismaA.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/New_York'`);
      const tz = await tx.$queryRaw<Array<{ tz: string }>>`
        SELECT current_setting('TimeZone') AS tz
      `;
      expect(tz[0]?.tz).toBe("America/New_York");
      expect(tz[0]?.tz).not.toMatch(/^UTC$/i);
      await conductInventoryInTransaction(tx, { docId: draft.id, actor });
    }, txOpts);

    const naive = await prismaA.$queryRaw<Array<{ inventoryDate: string; effectiveAt: string }>>`
      SELECT
        to_char(i."date", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "inventoryDate",
        to_char(m."effectiveAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "effectiveAt"
      FROM "Inventory" i
      JOIN "InventoryMovement" m ON m."causationId" = i.id
      WHERE i.id = ${draft.id}
    `;
    expect(naive).toHaveLength(1);
    expect(naive[0]!.inventoryDate).toBe(naive[0]!.effectiveAt);

    const inventory = await prismaA.inventory.findUniqueOrThrow({ where: { id: draft.id } });
    const movement = await prismaA.inventoryMovement.findFirstOrThrow({
      where: { causationId: draft.id },
    });
    expect(naive[0]!.inventoryDate).toBe(utcNaiveTimestampString(inventory.date));
    expect(naive[0]!.effectiveAt).toBe(utcNaiveTimestampString(movement.effectiveAt));
    expect(inventory.status).toBe("CONDUCTED");
    expect(inventory.date.toISOString()).toBe(movement.effectiveAt.toISOString());
    expect(inventory.date.getTime()).toBe(movement.effectiveAt.getTime());
    expect(movement.quantityDelta).toBe(-3);
    expect(movement.kind).toBe("ADJUSTMENT");
    expect(movement.authority).toBe("SHADOW");
    expect(movement.causationKind).toBe("INVENTORY");
    expect(movement.causationId).toBe(draft.id);
    expect(movement.actorKind).toBe("USER");
    expect(movement.userId).toBe(INTEGRITY_ADMIN_USER_ID);
    expect((await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } })).quantity).toBe(7);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });

  it("BLANK 10→13 SHADOW ACTIVE is ADJUSTMENT +3 not RECEIPT", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 13);
    await setShadowGate(true);
    await conductInventory(draft.id);
    const row = await prismaA.inventoryMovement.findFirstOrThrow();
    expect(row.kind).toBe("ADJUSTMENT");
    expect(row.quantityDelta).toBe(3);
    expect((await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } })).quantity).toBe(13);
  });

  it("zero-delta SHADOW ACTIVE inserts no quantityDelta=0 movement", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    await setShadowGate(true);
    await conductInventory(draft.id);
    expect((await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } })).quantity).toBe(10);
    expect(await prismaA.inventory.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({
      status: "CONDUCTED",
    });
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("DETAIL multi-effect: two ADJUSTMENT movements, not netted by line deviation", async () => {
    const material = await prismaA.material.create({
      data: { name: "M-det", sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const detail = await prismaA.detail.create({
      data: {
        name: "Shelf",
        materialId: material.id,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    await prismaA.detailStock.createMany({
      data: [
        { detailId: detail.id, torcevayaDone: true, ploskostDone: false, quantity: 4 },
        { detailId: detail.id, torcevayaDone: true, ploskostDone: true, quantity: 3 },
        { detailId: detail.id, torcevayaDone: false, ploskostDone: false, quantity: 2 },
      ],
    });
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "DETAIL" && l.refId === detail.id);
    expect(line?.accountedQty).toBe(7);
    expect(line?.actualQty).toBe(7);
    await setShadowGate(true);
    await conductInventory(draft.id);

    const buckets = await prismaA.detailStock.findMany({ where: { detailId: detail.id } });
    const qty = (t: boolean, p: boolean) =>
      buckets.find((r) => r.torcevayaDone === t && r.ploskostDone === p)?.quantity ?? 0;
    expect(qty(true, false)).toBe(7);
    expect(qty(true, true)).toBe(0);
    expect(qty(false, false)).toBe(2);

    const doc = await prismaA.inventory.findUniqueOrThrow({ where: { id: draft.id } });
    const rows = await prismaA.inventoryMovement.findMany({ orderBy: { effectKey: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.kind === "ADJUSTMENT")).toBe(true);
    expect(rows.every((r) => r.causationKind === "INVENTORY" && r.causationId === draft.id)).toBe(true);
    expect(rows.every((r) => r.stockDomain === "DETAIL")).toBe(true);
    const deltas = rows.map((r) => r.quantityDelta).sort((a, b) => a - b);
    expect(deltas).toEqual([-3, 3]);
    expect(rows.reduce((sum, r) => sum + r.quantityDelta, 0)).toBe(0);
    expect(rows[0]!.effectKey).not.toBe(rows[1]!.effectKey);
    const keys = rows.map((r) => r.effectKey);
    expect([...keys].sort(compareEffectKey)).toEqual(keys);
    expect(rows[0]!.effectiveAt.getTime()).toBe(rows[1]!.effectiveAt.getTime());
    expect(utcNaiveTimestampString(rows[0]!.effectiveAt)).toBe(utcNaiveTimestampString(doc.date));
    for (const row of rows) {
      const target = {
        stockDomain: "DETAIL" as const,
        detailId: row.detailId!,
        torcevayaDone: row.torcevayaDone!,
        ploskostDone: row.ploskostDone!,
      };
      expect(row.effectKey).toBe(
        effectKeyV1("adjust", canonicalizeMovementTarget(target).targetHashV1),
      );
    }
  });

  it("covers BLANK, DETAIL, PRODUCT, NOMENCLATURE targets and never RAIL_LOT", async () => {
    const { blank, material } = await seedBlank(10);
    const detail = await prismaA.detail.create({
      data: {
        name: "Ready detail",
        materialId: material.id,
        detailNumber: 2,
        lengthM: new Prisma.Decimal("0.7360"),
        detailType: "KANAVKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    await prismaA.detailStock.create({
      data: { detailId: detail.id, torcevayaDone: true, ploskostDone: false, quantity: 4 },
    });
    const nom = await prismaA.nomenclatureItem.create({
      data: { name: "Саморез", type: "FASTENER", unitPrice: 10 },
    });
    await prismaA.nomenclatureStock.create({ data: { nomenclatureId: nom.id, quantity: 8 } });
    const product = await prismaA.product.create({
      data: {
        name: "Стеллаж",
        materialId: material.id,
        skuOzon: "OZ-WRITER",
        skuWb: "WB-WRITER",
        sort: "SORT1",
      },
    });
    await prismaA.productStock.create({ data: { productId: product.id, quantity: 2 } });

    const draft = await createInventoryDraft(false);
    const blankLine = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    const detailLine = draft.lines.find((l) => l.refType === "DETAIL" && l.refId === detail.id);
    const productLine = draft.lines.find((l) => l.refType === "PRODUCT" && l.refId === product.id);
    const nomLine = draft.lines.find((l) => l.refType === "NOMENCLATURE" && l.refId === nom.id);
    await updateInventoryLineActual(blankLine!.id, 7);
    await updateInventoryLineActual(detailLine!.id, 5);
    await updateInventoryLineActual(productLine!.id, 1);
    await updateInventoryLineActual(nomLine!.id, 6);
    await setShadowGate(true);
    await conductInventory(draft.id);

    const rows = await prismaA.inventoryMovement.findMany({ orderBy: { effectKey: "asc" } });
    const domains = new Set(rows.map((r) => r.stockDomain));
    expect(domains.has("BLANK")).toBe(true);
    expect(domains.has("DETAIL")).toBe(true);
    expect(domains.has("PRODUCT")).toBe(true);
    expect(domains.has("NOMENCLATURE")).toBe(true);
    expect(domains.has("RAIL_LOT")).toBe(false);
    expect(rows.find((r) => r.stockDomain === "BLANK")?.targetSnapshot).toMatchObject({
      v: 1,
      d: "BLANK",
      lengthM: "1.8000",
    });
    expect(rows.find((r) => r.stockDomain === "PRODUCT")?.targetSnapshot).toEqual({
      v: 1,
      d: "PRODUCT",
      productId: product.id,
    });
    expect(rows.find((r) => r.stockDomain === "DETAIL")?.targetSnapshot).toEqual({
      v: 1,
      d: "DETAIL",
      detailId: detail.id,
      torcevayaDone: true,
      ploskostDone: false,
    });
    expect(rows.find((r) => r.stockDomain === "NOMENCLATURE")?.targetSnapshot).toEqual({
      v: 1,
      d: "NOMENCLATURE",
      nomenclatureId: nom.id,
    });
    expect(rows.find((r) => r.stockDomain === "NOMENCLATURE")?.quantityDelta).toBe(-2);
    expect(rows.find((r) => r.stockDomain === "BLANK")?.materialId).toBe(blank.materialId);
    expect(rows.find((r) => r.stockDomain === "PRODUCT")?.productId).toBe(product.id);
    expect(rows.find((r) => r.stockDomain === "DETAIL")?.detailId).toBe(detail.id);
    expect(rows.find((r) => r.stockDomain === "NOMENCLATURE")?.nomenclatureId).toBe(nom.id);
  });

  it("atomic rollback: UNIQUE barrier after projection rolls back Inventory", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 7);
    const target = {
      stockDomain: "BLANK" as const,
      materialId: blank.materialId,
      lengthM: blank.lengthM,
      detailType: blank.detailType,
      sort: blank.sort,
    };
    await prismaA.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, true);
      await appendShadowInventoryMovements(tx, {
        effectiveAt: new Date("2026-01-01T00:00:00.000Z"),
        actor: userMovementActorFromAdmin(sessionState.admin),
        causation: {
          causationKind: "INVENTORY",
          causationId: draft.id,
          causationSnapshot: { v: 1, d: "INVENTORY", inventoryId: draft.id, action: "CONDUCT" },
        },
        effects: [{ role: "adjust", kind: "ADJUSTMENT", quantityDelta: -1, target }],
      });
    }, txOpts);
    const before = await snapshotState();

    await expect(conductInventory(draft.id)).rejects.toSatisfy(isRawUniqueViolation);

    const after = await snapshotState();
    expect(after.inventories[0]?.status).toBe("DRAFT");
    expect(after.blanks.find((row) => row.id === blank.id)?.quantity).toBe(10);
    expect(after.lines.find((row) => row.id === line!.id)?.deviation).toBe(0);
    expect(after.movements).toBe(1);
    expect(after.logs.filter((row) => {
      const rec = row.newValues as Record<string, unknown> | null;
      return row.entity === "Inventory" && rec?.status === "CONDUCTED";
    })).toHaveLength(0);
    expect(before.inventories[0]?.status).toBe("DRAFT");
  });

  it("second conduct is ALREADY_CONDUCTED and does not add movements", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 7);
    await setShadowGate(true);
    await conductInventory(draft.id);
    const first = await snapshotState();
    await expect(conductInventory(draft.id)).rejects.toThrow(ALREADY_CONDUCTED);
    const second = await snapshotState();
    expect(second.blanks.map((row) => row.quantity)).toEqual(first.blanks.map((row) => row.quantity));
    expect(second.movements).toBe(first.movements);
    expect(second.movements).toBe(1);
    const keys = (await prismaA.inventoryMovement.findMany()).map((r) => r.effectKey);
    expect(keys).toEqual((await prismaA.inventoryMovement.findMany()).map((r) => r.effectKey));
    const conductLogs = second.logs.filter((row) => {
      const rec = row.newValues as Record<string, unknown> | null;
      return row.entity === "Inventory" && rec?.status === "CONDUCTED";
    });
    expect(conductLogs).toHaveLength(1);
  });

  it("concurrent same DRAFT: one success, one ALREADY_CONDUCTED, movements once", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 9);
    await setShadowGate(true);
    const settled = await Promise.allSettled([conductInventory(draft.id), conductInventory(draft.id)]);
    const fulfilled = settled.filter((row) => row.status === "fulfilled");
    const rejected = settled.filter((row) => row.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(errorMessage((rejected[0] as PromiseRejectedResult).reason)).toBe(ALREADY_CONDUCTED);
    expect((await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } })).quantity).toBe(9);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    const doc = await prismaA.inventory.findUniqueOrThrow({ where: { id: draft.id } });
    expect(doc.status).toBe("CONDUCTED");
  });

  it("dual-active still fails closed before mutation", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 7);
    await setShadowGate(true);
    await setCostFlowActive(true);
    const before = await snapshotState();
    await expect(conductInventory(draft.id)).rejects.toThrow(INVENTORY_DUAL_ACTIVE_UNSUPPORTED);
    expect(await snapshotState()).toEqual(before);
    expect(before.inventories[0]?.status).toBe("DRAFT");
  });

  it("malformed SHADOW gate fails before Inventory mutation", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 7);
    await prismaA.setting.upsert({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
      create: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value: { version: 99, active: true } },
      update: { value: { version: 99, active: true } },
    });
    const before = await snapshotState();
    await expect(conductInventory(draft.id)).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
    expect(await snapshotState()).toEqual(before);
  });

  it("movement actor is the retained authenticated USER", async () => {
    await prismaA.user.upsert({
      where: { id: ACTOR_USER_ID },
      create: {
        id: ACTOR_USER_ID,
        email: "inventory-writer@test.local",
        passwordHash: "integrity",
        name: "Инвентаризатор",
        role: "ADMIN",
      },
      update: { name: "Инвентаризатор" },
    });
    sessionState.admin = {
      id: ACTOR_USER_ID,
      name: "Инвентаризатор",
      email: "inventory-writer@test.local",
      role: "ADMIN",
    };
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 8);
    await setShadowGate(true);
    await conductInventory(draft.id);
    const movement = await prismaA.inventoryMovement.findFirstOrThrow();
    expect(movement.actorKind).toBe("USER");
    expect(movement.userId).toBe(ACTOR_USER_ID);
    expect(movement.actorDisplaySnapshot).toBe("Инвентаризатор");
    expect(movement.employeeId).toBeNull();
    expect(movement.systemActorKey).toBeNull();
    const header = await prismaA.changeLog.findFirstOrThrow({
      where: { entity: "Inventory", entityId: draft.id },
      orderBy: { changedAt: "desc" },
    });
    expect(header.userId).toBe(ACTOR_USER_ID);
  });

  it("P2-05 OFF→ON: gate ON cannot commit while conduct holds SHARED", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 7);
    await setCostFlowActive(false);

    const hold = { release: () => {}, ready: false };
    const holding = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      await lockInventoryForUpdate(tx, draft.id);
      hold.ready = true;
      await holding;
    }, txOpts);

    await waitUntil(() => hold.ready, "inventory row held");
    const conduct = conductInventory(draft.id);
    await waitUntil(async () => (await advisoryCounts()).sharedGranted >= 1, "SHARED granted");

    let gateFinished = false;
    const gateOn = prismaC
      .$transaction(async (tx) => {
        await setInventoryMovementShadowWriteGate(tx, true);
        gateFinished = true;
        return true;
      }, txOpts)
      .catch((err) => err as Error);

    await waitUntil(async () => (await advisoryCounts()).exclusiveWaiting >= 1, "EXCLUSIVE waiting");
    expect(gateFinished).toBe(false);
    expect((await prismaA.inventory.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe("DRAFT");
    expect((await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } })).quantity).toBe(10);

    hold.release();
    await holder;
    await conduct;
    await gateOn;
    expect(gateFinished).toBe(true);
    expect((await prismaA.inventory.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      "CONDUCTED",
    );
    expect((await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } })).quantity).toBe(7);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    const gate = await prismaA.setting.findUniqueOrThrow({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
    });
    expect(gate.value).toMatchObject({ version: 1, active: true });
  });

  it("P2-05 ON→OFF: gate OFF cannot commit while writer conduct holds SHARED", async () => {
    const { blank } = await seedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK" && l.refId === blank.id);
    await updateInventoryLineActual(line!.id, 7);
    await setShadowGate(true);
    await setCostFlowActive(false);

    const hold = { release: () => {}, ready: false };
    const holding = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      await lockInventoryForUpdate(tx, draft.id);
      hold.ready = true;
      await holding;
    }, txOpts);

    await waitUntil(() => hold.ready, "inventory row held");
    const conduct = conductInventory(draft.id);
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
    expect(await prismaA.inventoryMovement.count()).toBe(0);

    hold.release();
    await holder;
    await conduct;
    await gateOff;
    expect(gateFinished).toBe(true);
    expect((await prismaA.inventory.findUniqueOrThrow({ where: { id: draft.id } })).status).toBe(
      "CONDUCTED",
    );
    expect((await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } })).quantity).toBe(7);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    const gate = await prismaA.setting.findUniqueOrThrow({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
    });
    expect(gate.value).toMatchObject({ version: 1, active: false });
  });
});
