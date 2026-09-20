/**
 * PSR-P2 raw receipt / write-off SHADOW writers.
 * Trigger reject is integrity-only and keyed by actorDisplaySnapshot.
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));

const adminState = vi.hoisted(() => ({
  current: {
    id: "integrity-admin",
    name: "Admin",
    email: "admin@test.local",
    role: "ADMIN",
  },
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => ({ ...adminState.current }),
  requireTerminalEmployee: async (expectedEmployeeId?: string) => ({
    id: expectedEmployeeId ?? "integrity-session-employee",
    fullName: "Integrity Employee",
  }),
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import {
  PURCHASE_REQUEST_ID_REUSE,
  acquirePurchaseCommandRequestLock,
  type PurchaseCommandKind,
} from "@/server/internal/purchase-command-identity";
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
  batchCreateReceiptEffectKey,
  batchWriteOffEffectKey,
  simplePurchaseReceiptEffectKey,
} from "@/server/internal/raw-purchase-shadow-write";
import {
  createBatch,
  createSimplePurchase,
  writeOffBatchRemainder,
  type BatchFormValues,
} from "@/server/purchases";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  integrityDatabaseUrl,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
const BARRIER_TIMEOUT_MS = 25_000;
const REJECT_ACTOR = "INTEGRITY_REJECT_IM";
const CONCURRENCY_TIMEOUT_MS = 20_000;
const MONEY_LEAK = /purchaseCost|totalCost|priceSort1|priceSort2|unitPrice|initialValue|remainingValue/;

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BARRIER_TIMEOUT_MS) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`barrier: ${label}`);
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

describe.skipIf(!enabled)("PSR-P2 raw receipt / write-off SHADOW writers", () => {
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
    await prismaA.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS stell22_integrity_reject_im_insert ON "InventoryMovement"`,
    );
    await prismaA.$executeRawUnsafe(`
      CREATE TRIGGER stell22_integrity_reject_im_insert
      BEFORE INSERT ON "InventoryMovement"
      FOR EACH ROW EXECUTE FUNCTION stell22_integrity_reject_im_insert();
    `);
  });

  beforeEach(async () => {
    adminState.current = {
      id: "integrity-admin",
      name: "Admin",
      email: "admin@test.local",
      role: "ADMIN",
    };
    await resetIntegrityInventory(prismaA);
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

  async function setMalformedGate() {
    await prismaA.setting.upsert({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
      create: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value: { version: 99, active: true } },
      update: { value: { version: 99, active: true } },
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

  async function seedMaterial(suffix: string) {
    return prismaA.material.create({
      data: { name: `rawsh-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
  }

  function batchValues(
    suffix: string,
    materialId: string,
    extras?: { lots?: BatchFormValues["rails"] },
  ): BatchFormValues {
    return {
      name: `batch-${suffix}`,
      materialId,
      purchaseDate: "2026-01-15",
      sectionWidthMm: 40,
      sectionHeightMm: 20,
      purchaseCost: 10_000,
      priceSort1: 30_000,
      priceSort2: 20_000,
      note: "",
      rails: extras?.lots ?? [
        {
          mode: "package",
          lengthM: 2,
          railType: "POLKA",
          sort: "SORT1",
          quantity: 6,
        },
      ],
    };
  }

  async function seedNomenclature(suffix: string) {
    return prismaA.nomenclatureItem.create({
      data: { name: `nom-${suffix}`, type: "FASTENER", unitPrice: 12 },
    });
  }

  function assertNoMoney(value: unknown) {
    expect(JSON.stringify(value)).not.toMatch(MONEY_LEAK);
  }

  async function holdRequestLock(kind: PurchaseCommandKind, requestId: string) {
    const hold = { release: () => {}, ready: false };
    const holding = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      await acquirePurchaseCommandRequestLock(tx, kind, requestId);
      hold.ready = true;
      await holding;
    }, txOpts);
    await waitUntil(() => hold.ready, `${kind} request lock held`);
    return { hold, holder };
  }

  it("SHADOW missing/off: all three contours keep physical behavior and add zero movements", async () => {
    const suffix = `off-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `rawsh:off-c:${suffix}`);
    await writeOffBatchRemainder(created.id, `rawsh:off-w:${suffix}`);
    const item = await seedNomenclature(suffix);
    await createSimplePurchase(
      { nomenclatureId: item.id, quantity: 2, unitPrice: 5, purchaseDate: null },
      `rawsh:off-s:${suffix}`,
    );
    expect(await prismaA.batch.count({ where: { id: created.id } })).toBe(1);
    expect(await prismaA.batchCreationCommand.count()).toBe(1);
    expect(await prismaA.batchRemainderWriteOff.count()).toBe(1);
    expect(await prismaA.simplePurchase.count()).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("malformed SHADOW gate fails createBatch before request lock, mutation, command, ChangeLog", async () => {
    await setMalformedGate();
    const suffix = `bad-cb-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const logs = await prismaA.changeLog.count();
    await expect(
      createBatch(batchValues(suffix, material.id), `rawsh:bad-cb:${suffix}`),
    ).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
    expect(await prismaA.batch.count()).toBe(0);
    expect(await prismaA.railLot.count()).toBe(0);
    expect(await prismaA.batchCreationCommand.count()).toBe(0);
    expect(await prismaA.changeLog.count()).toBe(logs);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("malformed SHADOW gate fails write-off before request lock, mutation, command, ChangeLog", async () => {
    const suffix = `bad-wo-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `rawsh:bad-wo-c:${suffix}`);
    await setMalformedGate();
    const logs = await prismaA.changeLog.count();
    await expect(writeOffBatchRemainder(created.id, `rawsh:bad-wo:${suffix}`)).rejects.toBeInstanceOf(
      InventoryMovementShadowWriteConfigError,
    );
    const lots = await prismaA.railLot.findMany({ where: { batchId: created.id } });
    expect(lots.every((lot) => lot.remainingQuantity === 6)).toBe(true);
    expect(await prismaA.batchRemainderWriteOff.count()).toBe(0);
    expect(await prismaA.changeLog.count()).toBe(logs);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("malformed SHADOW gate fails SimplePurchase before request lock, mutation, command, ChangeLog", async () => {
    await setMalformedGate();
    const suffix = `bad-sp-${Date.now()}`;
    const item = await seedNomenclature(suffix);
    const logs = await prismaA.changeLog.count();
    await expect(
      createSimplePurchase(
        { nomenclatureId: item.id, quantity: 3, unitPrice: 8, purchaseDate: null },
        `rawsh:bad-sp:${suffix}`,
      ),
    ).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
    expect(await prismaA.simplePurchase.count()).toBe(0);
    expect(await prismaA.simplePurchaseCreationCommand.count()).toBe(0);
    expect(await prismaA.nomenclatureStock.count()).toBe(0);
    expect(await prismaA.changeLog.count()).toBe(logs);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("ACTIVE createBatch: sequential same request emits one receipt set; replay adds none", async () => {
    await setShadowGate(true);
    const suffix = `cb-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id, {
      lots: [
        { mode: "package", lengthM: 2, railType: "POLKA", sort: "SORT1", quantity: 6 },
        { mode: "package", lengthM: 3, railType: "KANAVKA", sort: "SORT2", quantity: 2 },
      ],
    });
    const requestId = `rawsh:cb:${suffix}`;
    const first = await createBatch(values, requestId);
    const lots = await prismaA.railLot.findMany({
      where: { batchId: first.id },
      orderBy: { id: "asc" },
    });
    expect(lots).toHaveLength(2);
    const movements = await prismaA.inventoryMovement.findMany({
      where: { causationKind: "BATCH" },
      orderBy: { effectKey: "asc" },
    });
    expect(movements).toHaveLength(2);
    expect(movements.every((row) => row.kind === "RECEIPT" && row.authority === "SHADOW")).toBe(true);
    expect(movements.map((row) => row.quantityDelta).sort((a, b) => a - b)).toEqual([2, 6]);
    expect(new Set(movements.map((row) => row.causationId))).toEqual(
      new Set([(await prismaA.batchCreationCommand.findUniqueOrThrow({ where: { requestId } })).id]),
    );
    for (const lot of lots) {
      expect(movements.some((row) => row.effectKey === batchCreateReceiptEffectKey(lot.id))).toBe(
        true,
      );
    }
    const command = await prismaA.batchCreationCommand.findUniqueOrThrow({ where: { requestId } });
    expect(movements[0]!.causationKind).toBe("BATCH");
    expect(movements[0]!.causationId).toBe(command.id);
    expect(movements[0]!.causationId).not.toBe(first.id);
    assertNoMoney(movements[0]!.causationSnapshot);
    assertNoMoney(movements[0]!.targetSnapshot);
    const snapshot = movements[0]!.causationSnapshot as { railLots: Array<{ railLotId: string }> };
    expect(snapshot.railLots.map((lot) => lot.railLotId)).toEqual(
      [...snapshot.railLots.map((lot) => lot.railLotId)].sort((a, b) => a.localeCompare(b)),
    );
    const logs = await prismaA.changeLog.count({ where: { entity: "Batch", entityId: first.id } });
    const replay = await createBatch(values, requestId);
    expect(replay.id).toBe(first.id);
    expect(await prismaA.inventoryMovement.count()).toBe(2);
    expect(await prismaA.batch.count({ where: { name: values.name } })).toBe(1);
    expect(await prismaA.changeLog.count({ where: { entity: "Batch", entityId: first.id } })).toBe(
      logs,
    );
  });

  it("ACTIVE createBatch concurrent same request converges on one movement set", async () => {
    await setShadowGate(true);
    const suffix = `cbc-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const requestId = `rawsh:cbc:${suffix}`;
    const settled = await withTimeout(
      Promise.allSettled([createBatch(values, requestId), createBatch(values, requestId)]),
      "createBatch concurrent",
    );
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    expect(await prismaA.batch.count({ where: { name: values.name } })).toBe(1);
    expect(await prismaA.batchCreationCommand.count({ where: { requestId } })).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });

  it("ACTIVE createBatch payload/admin mismatch is PURCHASE_REQUEST_ID_REUSE before movement", async () => {
    await setShadowGate(true);
    const suffix = `cbm-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const requestId = `rawsh:cbm:${suffix}`;
    await createBatch(values, requestId);
    await expect(createBatch({ ...values, note: "other" }, requestId)).rejects.toThrow(
      PURCHASE_REQUEST_ID_REUSE,
    );
    adminState.current = { ...adminState.current, id: "other-admin" };
    await expect(createBatch(values, requestId)).rejects.toThrow(PURCHASE_REQUEST_ID_REUSE);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    expect(await prismaA.batch.count()).toBe(1);
  });

  it("ACTIVE createBatch replay succeeds after the unique name now exists", async () => {
    await setShadowGate(true);
    const suffix = `cbn-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const requestId = `rawsh:cbn:${suffix}`;
    const first = await createBatch(values, requestId);
    const replay = await createBatch(values, requestId);
    expect(replay.id).toBe(first.id);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });

  it("ACTIVE write-off: retained negative set once; replay after zero adds none", async () => {
    await setShadowGate(true);
    const suffix = `wo-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `rawsh:wo-c:${suffix}`);
    const lot = await prismaA.railLot.findFirstOrThrow({ where: { batchId: created.id } });
    const requestId = `rawsh:wo:${suffix}`;
    await writeOffBatchRemainder(created.id, requestId);
    const command = await prismaA.batchRemainderWriteOff.findUniqueOrThrow({ where: { requestId } });
    const movements = await prismaA.inventoryMovement.findMany({
      where: { causationId: command.id },
    });
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      kind: "ADJUSTMENT",
      quantityDelta: -6,
      railLotId: lot.id,
      causationKind: "BATCH",
      effectKey: batchWriteOffEffectKey(lot.id),
    });
    assertNoMoney(movements[0]!.causationSnapshot);
    await writeOffBatchRemainder(created.id, requestId);
    expect(await prismaA.inventoryMovement.count({ where: { causationId: command.id } })).toBe(1);
    expect(await prismaA.batchRemainderWriteOff.count({ where: { batchId: created.id } })).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: lot.id } })).remainingQuantity).toBe(
      0,
    );
  });

  it("ACTIVE write-off concurrent same request converges on one movement set", async () => {
    await setShadowGate(true);
    const suffix = `woc-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `rawsh:woc-c:${suffix}`);
    const requestId = `rawsh:woc:${suffix}`;
    const settled = await withTimeout(
      Promise.allSettled([
        writeOffBatchRemainder(created.id, requestId),
        writeOffBatchRemainder(created.id, requestId),
      ]),
      "writeOff concurrent",
    );
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    expect(await prismaA.batchRemainderWriteOff.count({ where: { requestId } })).toBe(1);
    expect(
      await prismaA.inventoryMovement.count({
        where: {
          causationKind: "BATCH",
          causationId: (await prismaA.batchRemainderWriteOff.findUniqueOrThrow({ where: { requestId } }))
            .id,
        },
      }),
    ).toBe(1);
  });

  it("ACTIVE write-off different request while zero writes no command and no movement", async () => {
    await setShadowGate(true);
    const suffix = `woz-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `rawsh:woz-c:${suffix}`);
    await writeOffBatchRemainder(created.id, `rawsh:woz-a:${suffix}`);
    const movements = await prismaA.inventoryMovement.count({
      where: { kind: "ADJUSTMENT" },
    });
    await expect(writeOffBatchRemainder(created.id, `rawsh:woz-b:${suffix}`)).rejects.toThrow(
      "Остаток уже нулевой",
    );
    expect(await prismaA.batchRemainderWriteOff.count({ where: { batchId: created.id } })).toBe(1);
    expect(await prismaA.inventoryMovement.count({ where: { kind: "ADJUSTMENT" } })).toBe(movements);
  });

  it("ACTIVE write-off reopen: retry A is silent; request B uses same effectKey and different causationId", async () => {
    await setShadowGate(true);
    const suffix = `wor-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `rawsh:wor-c:${suffix}`);
    const lot = await prismaA.railLot.findFirstOrThrow({ where: { batchId: created.id } });
    const requestA = `rawsh:wor-a:${suffix}`;
    await writeOffBatchRemainder(created.id, requestA);
    const commandA = await prismaA.batchRemainderWriteOff.findUniqueOrThrow({
      where: { requestId: requestA },
    });
    await prismaA.railLot.update({ where: { id: lot.id }, data: { remainingQuantity: 4 } });
    await prismaA.batch.update({
      where: { id: created.id },
      data: { status: "IN_WORK", closedAt: null },
    });
    await writeOffBatchRemainder(created.id, requestA);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: lot.id } })).remainingQuantity).toBe(
      4,
    );
    expect(await prismaA.inventoryMovement.count({ where: { causationId: commandA.id } })).toBe(1);
    const requestB = `rawsh:wor-b:${suffix}`;
    await writeOffBatchRemainder(created.id, requestB);
    const commandB = await prismaA.batchRemainderWriteOff.findUniqueOrThrow({
      where: { requestId: requestB },
    });
    expect(commandB.id).not.toBe(commandA.id);
    const movementA = await prismaA.inventoryMovement.findFirstOrThrow({
      where: { causationId: commandA.id },
    });
    const movementB = await prismaA.inventoryMovement.findFirstOrThrow({
      where: { causationId: commandB.id },
    });
    expect(movementA.effectKey).toBe(movementB.effectKey);
    expect(movementA.effectKey).toBe(batchWriteOffEffectKey(lot.id));
    expect(movementA.causationId).not.toBe(movementB.causationId);
    expect(movementB.quantityDelta).toBe(-4);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: lot.id } })).remainingQuantity).toBe(
      0,
    );
  });

  it("ACTIVE SimplePurchase: sequential same request emits one receipt; replay adds none", async () => {
    await setShadowGate(true);
    const suffix = `sp-${Date.now()}`;
    const item = await seedNomenclature(suffix);
    const values = {
      nomenclatureId: item.id,
      quantity: 4,
      unitPrice: 12,
      purchaseDate: "2026-01-20" as string | null,
    };
    const requestId = `rawsh:sp:${suffix}`;
    await createSimplePurchase(values, requestId);
    const purchase = await prismaA.simplePurchase.findFirstOrThrow({
      where: { nomenclatureId: item.id },
    });
    const command = await prismaA.simplePurchaseCreationCommand.findUniqueOrThrow({
      where: { requestId },
    });
    const movement = await prismaA.inventoryMovement.findFirstOrThrow({
      where: { causationKind: "SIMPLE_PURCHASE" },
    });
    expect(movement.causationId).toBe(purchase.id);
    expect(movement.causationId).not.toBe(command.id);
    expect(movement.quantityDelta).toBe(4);
    expect(movement.kind).toBe("RECEIPT");
    expect(movement.effectKey).toBe(simplePurchaseReceiptEffectKey(item.id));
    assertNoMoney(movement.causationSnapshot);
    assertNoMoney(movement.targetSnapshot);
    await createSimplePurchase(values, requestId);
    expect(await prismaA.simplePurchase.count()).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    expect(
      (await prismaA.nomenclatureStock.findUniqueOrThrow({ where: { nomenclatureId: item.id } }))
        .quantity,
    ).toBe(4);
  });

  it("ACTIVE SimplePurchase concurrent same request converges on one movement", async () => {
    await setShadowGate(true);
    const suffix = `spc-${Date.now()}`;
    const item = await seedNomenclature(suffix);
    const values = {
      nomenclatureId: item.id,
      quantity: 3,
      unitPrice: 10,
      purchaseDate: null as string | null,
    };
    const requestId = `rawsh:spc:${suffix}`;
    const settled = await withTimeout(
      Promise.allSettled([
        createSimplePurchase(values, requestId),
        createSimplePurchase(values, requestId),
      ]),
      "simple purchase concurrent",
    );
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    expect(await prismaA.simplePurchase.count()).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });

  it("ACTIVE SimplePurchase mismatch is PURCHASE_REQUEST_ID_REUSE before movement", async () => {
    await setShadowGate(true);
    const suffix = `spm-${Date.now()}`;
    const item = await seedNomenclature(suffix);
    const values = {
      nomenclatureId: item.id,
      quantity: 2,
      unitPrice: 8,
      purchaseDate: null as string | null,
    };
    const requestId = `rawsh:spm:${suffix}`;
    await createSimplePurchase(values, requestId);
    await expect(createSimplePurchase({ ...values, quantity: 9 }, requestId)).rejects.toThrow(
      PURCHASE_REQUEST_ID_REUSE,
    );
    adminState.current = { ...adminState.current, id: "other-admin" };
    await expect(createSimplePurchase(values, requestId)).rejects.toThrow(PURCHASE_REQUEST_ID_REUSE);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    expect(
      (await prismaA.nomenclatureStock.findUniqueOrThrow({ where: { nomenclatureId: item.id } }))
        .quantity,
    ).toBe(2);
  });

  it("ACTIVE SimplePurchase replay after unrelated stock change does not add another receipt", async () => {
    await setShadowGate(true);
    const suffix = `spr-${Date.now()}`;
    const item = await seedNomenclature(suffix);
    const values = {
      nomenclatureId: item.id,
      quantity: 2,
      unitPrice: 8,
      purchaseDate: null as string | null,
    };
    const requestId = `rawsh:spr:${suffix}`;
    await createSimplePurchase(values, requestId);
    await prismaA.nomenclatureStock.update({
      where: { nomenclatureId: item.id },
      data: { quantity: { increment: 7 } },
    });
    await createSimplePurchase(values, requestId);
    expect(
      (await prismaA.nomenclatureStock.findUniqueOrThrow({ where: { nomenclatureId: item.id } }))
        .quantity,
    ).toBe(9);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });

  it("movement INSERT reject rolls back createBatch, lots, command, cost-flow init, and ChangeLog", async () => {
    await setShadowGate(true);
    await setCostFlowActive(true);
    adminState.current = { ...adminState.current, name: REJECT_ACTOR };
    const suffix = `rb-cb-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const logs = await prismaA.changeLog.count();
    await expect(
      createBatch(batchValues(suffix, material.id), `rawsh:rb-cb:${suffix}`),
    ).rejects.toThrow(/integrity reject InventoryMovement insert/);
    expect(await prismaA.batch.count()).toBe(0);
    expect(await prismaA.railLot.count()).toBe(0);
    expect(await prismaA.batchCreationCommand.count()).toBe(0);
    expect(await prismaA.changeLog.count()).toBe(logs);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("movement INSERT reject rolls back write-off stock, command, archive, and ChangeLog", async () => {
    const suffix = `rb-wo-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `rawsh:rb-wo-c:${suffix}`);
    await setShadowGate(true);
    adminState.current = { ...adminState.current, name: REJECT_ACTOR };
    const lotBefore = await prismaA.railLot.findFirstOrThrow({ where: { batchId: created.id } });
    const batchBefore = await prismaA.batch.findUniqueOrThrow({ where: { id: created.id } });
    const logs = await prismaA.changeLog.count();
    await expect(writeOffBatchRemainder(created.id, `rawsh:rb-wo:${suffix}`)).rejects.toThrow(
      /integrity reject InventoryMovement insert/,
    );
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: lotBefore.id } })).remainingQuantity).toBe(
      lotBefore.remainingQuantity,
    );
    const batchAfter = await prismaA.batch.findUniqueOrThrow({ where: { id: created.id } });
    expect(batchAfter.status).toBe(batchBefore.status);
    expect(batchAfter.closedAt).toEqual(batchBefore.closedAt);
    expect(await prismaA.batchRemainderWriteOff.count()).toBe(0);
    expect(await prismaA.changeLog.count()).toBe(logs);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("movement INSERT reject rolls back SimplePurchase, stock, command, and ChangeLog", async () => {
    await setShadowGate(true);
    await setCostFlowActive(true);
    adminState.current = { ...adminState.current, name: REJECT_ACTOR };
    const suffix = `rb-sp-${Date.now()}`;
    const item = await seedNomenclature(suffix);
    const logs = await prismaA.changeLog.count();
    await expect(
      createSimplePurchase(
        { nomenclatureId: item.id, quantity: 4, unitPrice: 12, purchaseDate: null },
        `rawsh:rb-sp:${suffix}`,
      ),
    ).rejects.toThrow(/integrity reject InventoryMovement insert/);
    expect(await prismaA.simplePurchase.count()).toBe(0);
    expect(await prismaA.simplePurchaseCreationCommand.count()).toBe(0);
    expect(await prismaA.nomenclatureStock.count()).toBe(0);
    expect(await prismaA.changeLog.count()).toBe(logs);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("gate-flip createBatch: SHARED before request lock; EXCLUSIVE waits; original ACTIVE value is used", async () => {
    await setShadowGate(true);
    const suffix = `flip-cb-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const requestId = `rawsh:flip-cb:${suffix}`;
    const { hold, holder } = await holdRequestLock("batch-create", requestId);
    const submit = createBatch(values, requestId);
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
    expect(await prismaA.batch.count({ where: { name: values.name } })).toBe(0);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    hold.release();
    await holder;
    await submit;
    await gateOff;
    expect(gateFinished).toBe(true);
    expect(await prismaA.batch.count({ where: { name: values.name } })).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    expect(
      (await prismaA.setting.findUniqueOrThrow({ where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY } }))
        .value,
    ).toMatchObject({ version: 1, active: false });
  });

  it("gate-flip write-off: SHARED before request lock; EXCLUSIVE waits; original ACTIVE value is used", async () => {
    const suffix = `flip-wo-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `rawsh:flip-wo-c:${suffix}`);
    await setShadowGate(true);
    const requestId = `rawsh:flip-wo:${suffix}`;
    const { hold, holder } = await holdRequestLock("batch-writeoff", requestId);
    const submit = writeOffBatchRemainder(created.id, requestId);
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
    expect(
      (await prismaA.railLot.findFirstOrThrow({ where: { batchId: created.id } })).remainingQuantity,
    ).toBe(6);
    hold.release();
    await holder;
    await submit;
    await gateOff;
    expect(gateFinished).toBe(true);
    expect(await prismaA.batchRemainderWriteOff.count({ where: { requestId } })).toBe(1);
    expect(await prismaA.inventoryMovement.count({ where: { kind: "ADJUSTMENT" } })).toBe(1);
  });

  it("gate-flip SimplePurchase: SHARED before request lock; EXCLUSIVE waits; original ACTIVE value is used", async () => {
    await setShadowGate(true);
    const suffix = `flip-sp-${Date.now()}`;
    const item = await seedNomenclature(suffix);
    const requestId = `rawsh:flip-sp:${suffix}`;
    const { hold, holder } = await holdRequestLock("simple-purchase", requestId);
    const submit = createSimplePurchase(
      { nomenclatureId: item.id, quantity: 2, unitPrice: 7, purchaseDate: null },
      requestId,
    );
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
    expect(await prismaA.simplePurchase.count()).toBe(0);
    hold.release();
    await holder;
    await submit;
    await gateOff;
    expect(gateFinished).toBe(true);
    expect(await prismaA.simplePurchase.count()).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });

  it("effectiveAt equals retained command recordedAt; movement recordedAt uses DB default", async () => {
    await setShadowGate(true);
    const suffix = `eat-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `rawsh:eat-c:${suffix}`);
    await writeOffBatchRemainder(created.id, `rawsh:eat-w:${suffix}`);
    const item = await seedNomenclature(suffix);
    await createSimplePurchase(
      { nomenclatureId: item.id, quantity: 1, unitPrice: 5, purchaseDate: null },
      `rawsh:eat-s:${suffix}`,
    );
    const batchCmd = await prismaA.batchCreationCommand.findFirstOrThrow();
    const writeOffCmd = await prismaA.batchRemainderWriteOff.findFirstOrThrow();
    const simpleCmd = await prismaA.simplePurchaseCreationCommand.findFirstOrThrow();
    const purchase = await prismaA.simplePurchase.findFirstOrThrow();
    const rows = await prismaA.$queryRaw<
      Array<{ label: string; recorded_utc: string; effective: string; recorded_default: string | null }>
    >`
      SELECT
        'batch' AS label,
        to_char((c."recordedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS recorded_utc,
        to_char(m."effectiveAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS effective,
        (
          SELECT column_default
          FROM information_schema.columns
          WHERE table_name = 'InventoryMovement' AND column_name = 'recordedAt'
        ) AS recorded_default
      FROM "BatchCreationCommand" c
      JOIN "InventoryMovement" m ON m."causationId" = c.id
      WHERE c.id = ${batchCmd.id}
      UNION ALL
      SELECT
        'writeoff',
        to_char((c."recordedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
        to_char(m."effectiveAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
        NULL
      FROM "BatchRemainderWriteOff" c
      JOIN "InventoryMovement" m ON m."causationId" = c.id
      WHERE c.id = ${writeOffCmd.id}
      UNION ALL
      SELECT
        'simple',
        to_char((c."recordedAt" AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
        to_char(m."effectiveAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS'),
        NULL
      FROM "SimplePurchaseCreationCommand" c
      JOIN "InventoryMovement" m ON m."causationId" = ${purchase.id}
      WHERE c.id = ${simpleCmd.id}
    `;
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.recorded_utc).toBe(row.effective);
    }
    expect((rows[0]?.recorded_default ?? "").toUpperCase()).toContain("CURRENT_TIMESTAMP");
    expect(utcNaiveTimestampString(batchCmd.recordedAt)).toBe(rows[0]?.effective);
  });

  it("SHADOW + cost-flow createBatch initializes money once and emits one receipt per lot", async () => {
    await setShadowGate(true);
    await setCostFlowActive(true);
    const suffix = `cf-cb-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const requestId = `rawsh:cf-cb:${suffix}`;
    const first = await createBatch(values, requestId);
    const lots1 = await prismaA.railLot.findMany({ where: { batchId: first.id } });
    expect(lots1.every((lot) => lot.initialValue != null)).toBe(true);
    const firstValue = lots1[0]!.initialValue;
    await createBatch(values, requestId);
    const lots2 = await prismaA.railLot.findMany({ where: { batchId: first.id } });
    expect(lots2[0]!.initialValue?.toString()).toBe(firstValue?.toString());
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });

  it("SHADOW + cost-flow write-off consumes value once and emits retained negatives once", async () => {
    await setShadowGate(true);
    await setCostFlowActive(true);
    const suffix = `cf-wo-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `rawsh:cf-wo-c:${suffix}`);
    const requestId = `rawsh:cf-wo:${suffix}`;
    await writeOffBatchRemainder(created.id, requestId);
    const events = await prismaA.costEvent.count();
    const writeOffMoves = await prismaA.inventoryMovement.count({ where: { kind: "ADJUSTMENT" } });
    await writeOffBatchRemainder(created.id, requestId);
    expect(await prismaA.costEvent.count()).toBe(events);
    expect(await prismaA.inventoryMovement.count({ where: { kind: "ADJUSTMENT" } })).toBe(
      writeOffMoves,
    );
  });

  it("SHADOW + cost-flow SimplePurchase receipts stock/value once and one NOMENCLATURE movement", async () => {
    await setShadowGate(true);
    await setCostFlowActive(true);
    const suffix = `cf-sp-${Date.now()}`;
    const item = await seedNomenclature(suffix);
    const values = {
      nomenclatureId: item.id,
      quantity: 4,
      unitPrice: 12,
      purchaseDate: "2026-01-20" as string | null,
    };
    const requestId = `rawsh:cf-sp:${suffix}`;
    await createSimplePurchase(values, requestId);
    const first = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: item.id },
    });
    await createSimplePurchase(values, requestId);
    const second = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: item.id },
    });
    expect(second.quantity).toBe(first.quantity);
    expect(second.nomenclatureValue?.toString()).toBe(first.nomenclatureValue?.toString());
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });
});
