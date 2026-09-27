/**
 * C2: a torcovka commit stays acknowledged when cost recalc or page refresh fails.
 * C1 replay and conflict behaviour stays in place.
 */
const revalidatePath = vi.hoisted(() => vi.fn());
const enqueueRecalcBatchCosts = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));

const sessionState = vi.hoisted(() => ({
  employee: { id: "", fullName: "" },
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => ({
    id: "integrity-admin",
    name: "Admin",
    email: "admin@test.local",
    role: "ADMIN",
  }),
  requireTerminalEmployee: async (expected?: string) => {
    if (!sessionState.employee.id) {
      throw new Error("Нет активной сессии терминала. Войдите по PIN.");
    }
    if (expected && expected !== sessionState.employee.id) {
      throw new Error("Несовпадение сотрудника сессии.");
    }
    return { id: sessionState.employee.id, fullName: sessionState.employee.fullName };
  },
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { TERMINAL_REQUEST_ALREADY_RECORDED, setApprovalGateAfterEnsureForTests } from "@/server/internal/terminal-request-identity";
import { setInventoryMovementShadowWriteGate } from "@/server/internal/inventory-movement-shadow-write";
import { planProductionShadowMovements } from "@/server/internal/production-movement-plan";
import { submitTorcovka } from "@/server/terminal";
import { createIntegrityClients, ensureIntegritySchema, resetIntegrityInventory } from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;

describe.skipIf(!enabled)("torcovka post-commit acknowledgement", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityInventory(prismaA);
    sessionState.employee = { id: "", fullName: "" };
    enqueueRecalcBatchCosts.mockReset();
    enqueueRecalcBatchCosts.mockResolvedValue(undefined);
    revalidatePath.mockReset();
    revalidatePath.mockImplementation(() => undefined);
    setApprovalGateAfterEnsureForTests(null);
    await prismaA.systemLog.deleteMany({ where: { source: "Терминал" } });
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
  });

  async function setShadowGate(active: boolean) {
    await prismaA.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, active);
    }, txOpts);
  }

  async function seed(suffix: string, remaining = 10) {
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        rateTorcovkaSort1: 10,
        rateTorcovkaSort2: 10,
        hourlyRate: 100,
      },
    });
    sessionState.employee = { id: emp.id, fullName: emp.fullName };
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const batch = await prismaA.batch.create({
      data: {
        name: `batch-${suffix}`,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 10_000,
        totalCost: 10_000,
        priceSort1: 30_000,
        priceSort2: 20_000,
        purchaseDate: new Date("2026-01-15T00:00:00.000Z"),
        status: "IN_WORK",
      },
    });
    const lot = await prismaA.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: new Prisma.Decimal("2"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: remaining,
        remainingQuantity: remaining,
      },
    });
    return { emp, batch, lot };
  }

  function input(
    world: Awaited<ReturnType<typeof seed>>,
    clientRequestId: string,
    railsTaken: number,
    quantity: number,
  ) {
    return {
      employeeId: world.emp.id,
      clientRequestId,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken,
      picks: [{ lengthM: 2, sort: "SORT1" as const, quantity }],
    };
  }

  async function savedEffects(lotId: string) {
    const ops = await prismaA.productionOperation.findMany({
      where: { railLotId: lotId },
      include: { lines: true, nomenclatureLines: true },
    });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: lotId } });
    const blanks = await prismaA.blankStock.findMany();
    const movements = await prismaA.inventoryMovement.count();
    return { ops, remaining: lot.remainingQuantity, blanks, movements };
  }

  it("saves and recalculates without a maintenance flag", async () => {
    await setShadowGate(true);
    const world = await seed(`ok-${Date.now()}`);
    const requestId = `ok-${Date.now()}`;
    await expect(submitTorcovka(input(world, requestId, 1, 1))).resolves.toEqual({ status: "CREATED" });
    expect(enqueueRecalcBatchCosts).toHaveBeenCalledOnce();
    expect(enqueueRecalcBatchCosts).toHaveBeenCalledWith(world.batch.id);
    const saved = await savedEffects(world.lot.id);
    expect(saved.ops).toHaveLength(1);
    expect(saved.remaining).toBe(9);
    expect(saved.blanks).toHaveLength(1);
    expect(saved.blanks[0]?.quantity).toBe(1);
    const plan = planProductionShadowMovements({ kind: "TORCOVKA", operation: saved.ops[0]! });
    expect(saved.movements).toBe(plan.effects.length);
  });

  it("keeps the saved operation when cost recalc throws", async () => {
    await setShadowGate(true);
    const world = await seed(`cost-${Date.now()}`);
    const requestId = `cost-${Date.now()}`;
    enqueueRecalcBatchCosts.mockRejectedValueOnce(new Error("recalc down"));
    const result = await submitTorcovka(input(world, requestId, 1, 1));
    expect(result).toEqual({ status: "CREATED", costRecalc: "FAILED" });
    expect(JSON.stringify(result)).not.toContain("recalc down");
    expect(JSON.stringify(result)).not.toContain("Ошибка внесения");
    const saved = await savedEffects(world.lot.id);
    expect(saved.ops).toHaveLength(1);
    expect(saved.remaining).toBe(9);
    expect(saved.blanks[0]?.quantity).toBe(1);
    const plan = planProductionShadowMovements({ kind: "TORCOVKA", operation: saved.ops[0]! });
    expect(saved.movements).toBe(plan.effects.length);
    const log = await prismaA.systemLog.findFirstOrThrow({
      where: { source: "Терминал", message: "Торцовка сохранена, пересчёт себестоимости не завершён" },
    });
    expect(log.details).toMatchObject({ clientRequestId: requestId, batchId: world.batch.id, kind: "cost-recalc" });

    enqueueRecalcBatchCosts.mockResolvedValue(undefined);
    await expect(submitTorcovka(input(world, requestId, 1, 1))).resolves.toEqual({ status: "CREATED" });
    expect(enqueueRecalcBatchCosts).toHaveBeenCalledOnce();
    expect(await prismaA.productionOperation.count({ where: { clientRequestId: requestId } })).toBe(1);
    expect((await savedEffects(world.lot.id)).remaining).toBe(9);

    await expect(submitTorcovka(input(world, requestId, 2, 2))).rejects.toThrow(
      TERMINAL_REQUEST_ALREADY_RECORDED,
    );
    expect(await prismaA.productionOperation.count({ where: { clientRequestId: requestId } })).toBe(1);
    expect((await savedEffects(world.lot.id)).movements).toBe(plan.effects.length);
  });

  it("keeps the saved operation when page refresh throws", async () => {
    await setShadowGate(true);
    const world = await seed(`page-${Date.now()}`);
    const requestId = `page-${Date.now()}`;
    revalidatePath.mockImplementation(() => {
      throw new Error("revalidate down");
    });
    const result = await submitTorcovka(input(world, requestId, 1, 1));
    expect(result).toEqual({ status: "CREATED", pageRefresh: "FAILED" });
    expect(JSON.stringify(result)).not.toContain("revalidate down");
    expect(enqueueRecalcBatchCosts).toHaveBeenCalledOnce();
    expect(await prismaA.productionOperation.count()).toBe(1);
    const log = await prismaA.systemLog.findFirstOrThrow({
      where: { source: "Терминал", message: "Торцовка сохранена, обновление страниц не завершено" },
    });
    expect(log.details).toMatchObject({ kind: "page-refresh", clientRequestId: requestId });
  });

  it("does not create an operation when the transaction fails before commit", async () => {
    await setShadowGate(true);
    const world = await seed(`pre-${Date.now()}`, 2);
    await expect(submitTorcovka(input(world, `pre-${Date.now()}`, 3, 3))).rejects.toThrow(
      "Недостаточно реек в пакете",
    );
    expect(enqueueRecalcBatchCosts).not.toHaveBeenCalled();
    expect(await prismaA.productionOperation.count()).toBe(0);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } })).remainingQuantity).toBe(2);
  });

  it("lets one of two identical requests win without a second stock effect", async () => {
    await setShadowGate(true);
    const world = await seed(`race-${Date.now()}`);
    const requestId = `race-${Date.now()}`;
    const settled = await Promise.allSettled([
      submitTorcovka(input(world, requestId, 1, 1)),
      submitTorcovka(input(world, requestId, 1, 1)),
    ]);
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    for (const row of settled) {
      if (row.status === "fulfilled") expect(row.value.status).toBe("CREATED");
    }
    const saved = await savedEffects(world.lot.id);
    expect(saved.ops).toHaveLength(1);
    expect(saved.remaining).toBe(9);
    const plan = planProductionShadowMovements({ kind: "TORCOVKA", operation: saved.ops[0]! });
    expect(saved.movements).toBe(plan.effects.length);
    expect(enqueueRecalcBatchCosts).toHaveBeenCalledOnce();
  });

  it("acknowledges a confirmed high-waste save even when recalc fails", async () => {
    await setShadowGate(true);
    const world = await seed(`hi-${Date.now()}`, 20);
    await prismaA.railLot.update({
      where: { id: world.lot.id },
      data: { lengthM: new Prisma.Decimal("10"), quantity: 20, remainingQuantity: 20 },
    });
    const requestId = `hi-${Date.now()}`;
    const extreme = {
      employeeId: world.emp.id,
      clientRequestId: requestId,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 27 }],
    };
    const first = await submitTorcovka(extreme);
    expect(first.status).toBe("APPROVAL_REQUIRED");
    expect(enqueueRecalcBatchCosts).not.toHaveBeenCalled();
    const note = await prismaA.notification.findFirstOrThrow({
      where: { key: { startsWith: `event:torcovka-approval:${requestId}:` } },
    });
    const code = note.message.match(/Код подтверждения: (\d{4})/)?.[1];
    expect(code).toBeTruthy();
    enqueueRecalcBatchCosts.mockRejectedValueOnce(new Error("recalc down"));
    await expect(submitTorcovka({ ...extreme, approvalCode: code })).resolves.toEqual({
      status: "CREATED",
      costRecalc: "FAILED",
    });
    expect(await prismaA.productionOperation.count({ where: { clientRequestId: requestId } })).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } })).remainingQuantity).toBe(10);
  });

  it("does not let a page refresh failure hide a composition conflict in the approval gate", async () => {
    await setShadowGate(true);
    const world = await seed(`gate-${Date.now()}`, 20);
    await prismaA.railLot.update({
      where: { id: world.lot.id },
      data: { lengthM: new Prisma.Decimal("10"), quantity: 20, remainingQuantity: 20 },
    });
    const requestId = `gate-${Date.now()}`;
    const extreme = {
      employeeId: world.emp.id,
      clientRequestId: requestId,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 27 }],
    };
    const other = {
      employeeId: world.emp.id,
      clientRequestId: requestId,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 1,
      picks: [{ lengthM: 9, sort: "SORT1" as const, quantity: 1 }],
    };
    revalidatePath.mockImplementation(() => {
      throw new Error("revalidate down");
    });
    setApprovalGateAfterEnsureForTests(async () => {
      setApprovalGateAfterEnsureForTests(null);
      await expect(submitTorcovka(other)).resolves.toMatchObject({ status: "CREATED" });
    });
    await expect(submitTorcovka(extreme)).rejects.toThrow(TERMINAL_REQUEST_ALREADY_RECORDED);
    const ops = await prismaA.productionOperation.findMany({ where: { clientRequestId: requestId } });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.railsTaken).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } })).remainingQuantity).toBe(19);
  });
});
