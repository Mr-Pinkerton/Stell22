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
import { Prisma } from "@prisma/client";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import {
  PURCHASE_REQUEST_ID_REUSE,
  PURCHASE_REPLAY_TARGET_MISSING,
} from "@/server/internal/purchase-command-identity";
import {
  createBatch,
  createSimplePurchase,
  writeOffBatchRemainder,
  type BatchFormValues,
} from "@/server/purchases";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const CONCURRENCY_TIMEOUT_MS = 20_000;

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

describe.skipIf(!enabled)("PSR-P2 raw receipt / write-off identities", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA } = createIntegrityClients());
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
    await prismaA?.$disconnect();
  });

  async function setCostFlowActive(active: boolean) {
    await prismaA.setting.upsert({
      where: { key: PRODUCTION_COST_FLOW_KEY },
      create: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active } },
      update: { value: { version: 1, active } },
    });
  }

  async function seedMaterial(suffix: string) {
    return prismaA.material.create({
      data: { name: `raw-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
  }

  function batchValues(suffix: string, materialId: string): BatchFormValues {
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
      rails: [
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

  it("createBatch same requestId: one Batch, one command, one RailLot set, one ChangeLog", async () => {
    const suffix = `cb-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const requestId = `raw:cb:${suffix}`;
    const first = await createBatch(values, requestId);
    const logs = await prismaA.changeLog.count({ where: { entity: "Batch", entityId: first.id } });
    const second = await createBatch(values, requestId);
    expect(second.id).toBe(first.id);
    expect(await prismaA.batch.count({ where: { name: values.name } })).toBe(1);
    expect(await prismaA.batchCreationCommand.count({ where: { requestId } })).toBe(1);
    expect(await prismaA.railLot.count({ where: { batchId: first.id } })).toBe(1);
    expect(await prismaA.changeLog.count({ where: { entity: "Batch", entityId: first.id } })).toBe(logs);
    expect(logs).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("createBatch concurrent identical requestId: one physical creation, waiter replays", async () => {
    const suffix = `cbc-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const requestId = `raw:cbc:${suffix}`;
    const settled = await withTimeout(
      Promise.allSettled([createBatch(values, requestId), createBatch(values, requestId)]),
      "createBatch concurrent",
    );
    const ok = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof createBatch>>
    >[];
    expect(ok).toHaveLength(2);
    expect(ok[0]!.value.id).toBe(ok[1]!.value.id);
    expect(await prismaA.batch.count({ where: { name: values.name } })).toBe(1);
    expect(await prismaA.batchCreationCommand.count({ where: { requestId } })).toBe(1);
    expect(await prismaA.changeLog.count({ where: { entity: "Batch", entityId: ok[0]!.value.id } })).toBe(1);
  });

  it("createBatch same requestId different payload or admin is PURCHASE_REQUEST_ID_REUSE", async () => {
    const suffix = `cbm-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const requestId = `raw:cbm:${suffix}`;
    const first = await createBatch(values, requestId);
    await expect(createBatch({ ...values, note: "other" }, requestId)).rejects.toThrow(
      PURCHASE_REQUEST_ID_REUSE,
    );
    adminState.current = { ...adminState.current, id: "other-admin" };
    await expect(createBatch(values, requestId)).rejects.toThrow(PURCHASE_REQUEST_ID_REUSE);
    expect(await prismaA.batch.count({ where: { id: first.id } })).toBe(1);
    expect(await prismaA.railLot.count({ where: { batchId: first.id } })).toBe(1);
  });

  it("createBatch replay succeeds after the original unique name now exists", async () => {
    const suffix = `cbn-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const requestId = `raw:cbn:${suffix}`;
    const first = await createBatch(values, requestId);
    expect(await prismaA.batch.findUnique({ where: { name: values.name } })).not.toBeNull();
    const replay = await createBatch(values, requestId);
    expect(replay.id).toBe(first.id);
    expect(await prismaA.batch.count()).toBe(1);
  });

  it("createBatch replay fails closed when retained Batch is missing", async () => {
    const suffix = `cbx-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const requestId = `raw:cbx:${suffix}`;
    const first = await createBatch(values, requestId);
    await prismaA.railLot.deleteMany({ where: { batchId: first.id } });
    await prismaA.batch.delete({ where: { id: first.id } });
    await expect(createBatch(values, requestId)).rejects.toThrow(PURCHASE_REPLAY_TARGET_MISSING);
    expect(await prismaA.batch.count()).toBe(0);
    expect(await prismaA.batchCreationCommand.count({ where: { requestId } })).toBe(1);
  });

  it("writeOff same requestId: one physical write-off, replay is silent", async () => {
    const suffix = `wo-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const created = await createBatch(values, `raw:wo-c:${suffix}`);
    const requestId = `raw:wo:${suffix}`;
    await writeOffBatchRemainder(created.id, requestId);
    const afterFirst = await prismaA.railLot.findMany({ where: { batchId: created.id } });
    expect(afterFirst.every((lot) => lot.remainingQuantity === 0)).toBe(true);
    expect(await prismaA.batchRemainderWriteOff.count({ where: { requestId } })).toBe(1);
    const logs = await prismaA.changeLog.count({ where: { entity: "Batch", entityId: created.id } });
    await writeOffBatchRemainder(created.id, requestId);
    expect(await prismaA.batchRemainderWriteOff.count({ where: { batchId: created.id } })).toBe(1);
    expect(await prismaA.changeLog.count({ where: { entity: "Batch", entityId: created.id } })).toBe(logs);
    const afterReplay = await prismaA.railLot.findMany({ where: { batchId: created.id } });
    expect(afterReplay.map((l) => l.remainingQuantity)).toEqual(afterFirst.map((l) => l.remainingQuantity));
  });

  it("writeOff concurrent identical requestId: one command and one ChangeLog", async () => {
    const suffix = `woc-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `raw:woc-c:${suffix}`);
    const requestId = `raw:woc:${suffix}`;
    const settled = await withTimeout(
      Promise.allSettled([
        writeOffBatchRemainder(created.id, requestId),
        writeOffBatchRemainder(created.id, requestId),
      ]),
      "writeOff concurrent",
    );
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    expect(await prismaA.batchRemainderWriteOff.count({ where: { requestId } })).toBe(1);
    const writeOffLogs = (
      await prismaA.changeLog.findMany({ where: { entity: "Batch", entityId: created.id } })
    ).filter((row) => {
      const next = row.newValues as { writeOff?: unknown } | null;
      return next?.writeOff === "отход";
    });
    expect(writeOffLogs).toHaveLength(1);
    const lots = await prismaA.railLot.findMany({ where: { batchId: created.id } });
    expect(lots.every((lot) => lot.remainingQuantity === 0)).toBe(true);
  });

  it("different new write-off request while remainder is zero fails and writes no command", async () => {
    const suffix = `woz-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `raw:woz-c:${suffix}`);
    await writeOffBatchRemainder(created.id, `raw:woz-a:${suffix}`);
    await expect(writeOffBatchRemainder(created.id, `raw:woz-b:${suffix}`)).rejects.toThrow(
      "Остаток уже нулевой",
    );
    expect(await prismaA.batchRemainderWriteOff.count({ where: { batchId: created.id } })).toBe(1);
  });

  it("write-off reopen: retry A is silent; request B writes a second lifecycle", async () => {
    const suffix = `wor-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `raw:wor-c:${suffix}`);
    const lot = await prismaA.railLot.findFirstOrThrow({ where: { batchId: created.id } });
    const requestA = `raw:wor-a:${suffix}`;
    await writeOffBatchRemainder(created.id, requestA);
    await prismaA.railLot.update({
      where: { id: lot.id },
      data: { remainingQuantity: 4 },
    });
    await prismaA.batch.update({
      where: { id: created.id },
      data: { status: "IN_WORK", closedAt: null },
    });
    await writeOffBatchRemainder(created.id, requestA);
    const afterRetry = await prismaA.railLot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(afterRetry.remainingQuantity).toBe(4);
    expect(await prismaA.batchRemainderWriteOff.count({ where: { batchId: created.id } })).toBe(1);
    await writeOffBatchRemainder(created.id, `raw:wor-b:${suffix}`);
    const afterB = await prismaA.railLot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(afterB.remainingQuantity).toBe(0);
    const commands = await prismaA.batchRemainderWriteOff.findMany({
      where: { batchId: created.id },
      orderBy: { recordedAt: "asc" },
    });
    expect(commands).toHaveLength(2);
    const firstEffects = commands[0]!.effectSnapshot as { effects: Array<{ quantityBefore: number }> };
    const secondEffects = commands[1]!.effectSnapshot as { effects: Array<{ quantityBefore: number }> };
    expect(firstEffects.effects[0]?.quantityBefore).toBe(6);
    expect(secondEffects.effects[0]?.quantityBefore).toBe(4);
    expect(commands[0]!.totalQuantity).toBe(6);
    expect(commands[1]!.totalQuantity).toBe(4);
  });

  it("simple purchase same requestId: one receipt, one command, one ChangeLog", async () => {
    const suffix = `sp-${Date.now()}`;
    const item = await prismaA.nomenclatureItem.create({
      data: { name: `nom-${suffix}`, type: "FASTENER", unitPrice: 12 },
    });
    const values = {
      nomenclatureId: item.id,
      quantity: 4,
      unitPrice: 12,
      purchaseDate: "2026-01-20" as string | null,
    };
    const requestId = `raw:sp:${suffix}`;
    await createSimplePurchase(values, requestId);
    await createSimplePurchase(values, requestId);
    expect(await prismaA.simplePurchase.count({ where: { nomenclatureId: item.id } })).toBe(1);
    expect(await prismaA.simplePurchaseCreationCommand.count({ where: { requestId } })).toBe(1);
    const stock = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: item.id },
    });
    expect(stock.quantity).toBe(4);
    expect(await prismaA.changeLog.count({ where: { entity: "SimplePurchase" } })).toBe(1);
  });

  it("simple purchase concurrent identical requestId converges", async () => {
    const suffix = `spc-${Date.now()}`;
    const item = await prismaA.nomenclatureItem.create({
      data: { name: `nom-${suffix}`, type: "FASTENER", unitPrice: 12 },
    });
    const values = {
      nomenclatureId: item.id,
      quantity: 3,
      unitPrice: 10,
      purchaseDate: null as string | null,
    };
    const requestId = `raw:spc:${suffix}`;
    const settled = await withTimeout(
      Promise.allSettled([
        createSimplePurchase(values, requestId),
        createSimplePurchase(values, requestId),
      ]),
      "simple purchase concurrent",
    );
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    expect(await prismaA.simplePurchase.count()).toBe(1);
    expect(await prismaA.simplePurchaseCreationCommand.count({ where: { requestId } })).toBe(1);
    const stock = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: item.id },
    });
    expect(stock.quantity).toBe(3);
    expect(await prismaA.changeLog.count({ where: { entity: "SimplePurchase" } })).toBe(1);
  });

  it("simple purchase mismatch payload/admin is PURCHASE_REQUEST_ID_REUSE", async () => {
    const suffix = `spm-${Date.now()}`;
    const item = await prismaA.nomenclatureItem.create({
      data: { name: `nom-${suffix}`, type: "FASTENER", unitPrice: 12 },
    });
    const values = {
      nomenclatureId: item.id,
      quantity: 2,
      unitPrice: 8,
      purchaseDate: null as string | null,
    };
    const requestId = `raw:spm:${suffix}`;
    await createSimplePurchase(values, requestId);
    await expect(createSimplePurchase({ ...values, quantity: 9 }, requestId)).rejects.toThrow(
      PURCHASE_REQUEST_ID_REUSE,
    );
    adminState.current = { ...adminState.current, id: "other-admin" };
    await expect(createSimplePurchase(values, requestId)).rejects.toThrow(PURCHASE_REQUEST_ID_REUSE);
    const stock = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: item.id },
    });
    expect(stock.quantity).toBe(2);
  });

  it("simple purchase replay after unrelated stock change does not add another receipt", async () => {
    const suffix = `spr-${Date.now()}`;
    const item = await prismaA.nomenclatureItem.create({
      data: { name: `nom-${suffix}`, type: "FASTENER", unitPrice: 12 },
    });
    const values = {
      nomenclatureId: item.id,
      quantity: 2,
      unitPrice: 8,
      purchaseDate: null as string | null,
    };
    const requestId = `raw:spr:${suffix}`;
    await createSimplePurchase(values, requestId);
    await prismaA.nomenclatureStock.update({
      where: { nomenclatureId: item.id },
      data: { quantity: { increment: 7 } },
    });
    await createSimplePurchase(values, requestId);
    const stock = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: item.id },
    });
    expect(stock.quantity).toBe(9);
    expect(await prismaA.simplePurchase.count()).toBe(1);
  });

  it("ACTIVE createBatch initializes lots once; replay does not re-initialize", async () => {
    await setCostFlowActive(true);
    const suffix = `cfa-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const values = batchValues(suffix, material.id);
    const requestId = `raw:cfa:${suffix}`;
    const first = await createBatch(values, requestId);
    const lots1 = await prismaA.railLot.findMany({ where: { batchId: first.id } });
    expect(lots1.every((lot) => lot.initialValue != null)).toBe(true);
    const firstValue = lots1[0]!.initialValue;
    await createBatch(values, requestId);
    const lots2 = await prismaA.railLot.findMany({ where: { batchId: first.id } });
    expect(lots2).toHaveLength(1);
    expect(lots2[0]!.initialValue?.toString()).toBe(firstValue?.toString());
    expect(await prismaA.costEvent.count()).toBe(0);
  });

  it("ACTIVE write-off applies value consumption once; replay does not duplicate", async () => {
    await setCostFlowActive(true);
    const suffix = `cfw-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `raw:cfw-c:${suffix}`);
    const requestId = `raw:cfw:${suffix}`;
    await writeOffBatchRemainder(created.id, requestId);
    const events = await prismaA.costEvent.count();
    await writeOffBatchRemainder(created.id, requestId);
    expect(await prismaA.costEvent.count()).toBe(events);
    expect(await prismaA.batchRemainderWriteOff.count({ where: { requestId } })).toBe(1);
  });

  it("ACTIVE simple purchase receipts once; replay does not duplicate qty/value", async () => {
    await setCostFlowActive(true);
    const suffix = `cfs-${Date.now()}`;
    const item = await prismaA.nomenclatureItem.create({
      data: { name: `nom-${suffix}`, type: "FASTENER", unitPrice: 12 },
    });
    const values = {
      nomenclatureId: item.id,
      quantity: 4,
      unitPrice: 12,
      purchaseDate: "2026-01-20" as string | null,
    };
    const requestId = `raw:cfs:${suffix}`;
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
    expect(await prismaA.simplePurchase.count()).toBe(1);
  });

  it("package emits zero InventoryMovement rows", async () => {
    const suffix = `im-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const created = await createBatch(batchValues(suffix, material.id), `raw:im-c:${suffix}`);
    await writeOffBatchRemainder(created.id, `raw:im-w:${suffix}`);
    const item = await prismaA.nomenclatureItem.create({
      data: { name: `nom-${suffix}`, type: "FASTENER", unitPrice: 5 },
    });
    await createSimplePurchase(
      { nomenclatureId: item.id, quantity: 1, unitPrice: 5, purchaseDate: null },
      `raw:im-s:${suffix}`,
    );
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect(new Prisma.Decimal(1).toNumber()).toBe(1);
  });
});
