/**
 * ADMIN-CORRECTIONS-01 — правка пакетов партии и аннулирование терминальных
 * записей на одноразовой integrity-БД.
 */
import { Prisma } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/server/session", () => ({
  requireAdmin: async () => ({
    id: "integrity-admin",
    name: "Admin",
    email: "admin@test.local",
    role: "ADMIN",
  }),
  requireTerminalEmployee: async (expectedEmployeeId?: string) => ({
    id: expectedEmployeeId ?? "integrity-session-employee",
    fullName: "Integrity Employee",
  }),
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { newRequestId } from "@/lib/request-id";
import { productionCancelFingerprint } from "@/lib/production-operation-cancel";
import { CANCEL_DOWNSTREAM_BLOCKED, CANCEL_PAID_BLOCKED } from "@/lib/production-operation-cancel";
import { STALE_PACKAGE_EDIT, PACKAGE_QUANTITY_BELOW_CONSUMED } from "@/lib/batch-package-edit";
import { prisma } from "@/server/db";
import { getSalaryReport } from "@/server/payroll";
import { cancelProductionOperation, updateProductionLineQuantity } from "@/server/production";
import { getBatchPackageEditor, updateBatch, type BatchFormValues } from "@/server/purchases";
import { submitTorcovka } from "@/server/terminal";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import { editPhysicalQuantityByLineIndex } from "./physical-quantity-edit-call";
import { createIntegrityClients, ensureIntegritySchema, resetIntegrityInventory } from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

function cancelFingerprint(op: {
  id: string;
  type: string;
  isPaid: boolean;
  cancelledAt: Date | null;
  railsTaken: number | null;
  hours: { toString(): string } | null;
  productQty: number | null;
  lines: Array<{ id: string; quantity: number }>;
}): string {
  return productionCancelFingerprint({
    operationId: op.id,
    type: op.type,
    isPaid: op.isPaid,
    cancelledAt: op.cancelledAt ? op.cancelledAt.toISOString() : null,
    railsTaken: op.railsTaken,
    hours: op.hours == null ? null : op.hours.toString(),
    productQty: op.productQty,
    lines: op.lines.map((line) => ({ id: line.id, quantity: line.quantity })),
  });
}

describe.skipIf(!enabled)("admin corrections", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let seq = 0;

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityInventory(prismaA);
    seq += 1;
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
  });

  async function seedWorld(opts?: { remaining?: number; money?: boolean }) {
    const remaining = opts?.remaining ?? 10;
    const suffix = `adm-${seq}-${Date.now()}`;
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: { fullName: `emp-${suffix}`, pin: "1234", hourlyRate: 100 },
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
        initialValue: opts?.money ? new Prisma.Decimal("10000") : null,
        remainingValue: opts?.money ? new Prisma.Decimal("10000") : null,
      },
    });
    return { material, emp, batch, lot, suffix };
  }

  async function formFor(
    batchId: string,
    mutate?: (values: BatchFormValues) => void,
  ): Promise<BatchFormValues> {
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    const editor = await getBatchPackageEditor(batchId);
    const values: BatchFormValues = {
      name: batch.name,
      materialId: batch.materialId,
      purchaseDate: "2026-10-01",
      sectionWidthMm: null,
      sectionHeightMm: null,
      purchaseCost: Number(batch.purchaseCost),
      priceSort1: Number(batch.priceSort1),
      priceSort2: Number(batch.priceSort2),
      note: batch.note ?? "",
      rails: editor.rails.map((rail) => ({
        id: rail.id,
        mode: rail.mode,
        lengthM: rail.lengthM,
        railType: rail.railType,
        sort: rail.sort,
        quantity: rail.quantity,
        rows: rail.rows,
        layers: rail.layers,
      })),
      editPackages: true,
      packageEditReason: "исправление пакетов",
      expectedPackageFingerprint: editor.fingerprint,
    };
    mutate?.(values);
    return values;
  }

  async function createdTorcovka(
    world: Awaited<ReturnType<typeof seedWorld>>,
    railsTaken: number,
    picks: { lengthM: number; sort: "SORT1" | "SORT2"; quantity: number }[] = [
      { lengthM: 1.8, sort: "SORT1", quantity: railsTaken },
    ],
  ) {
    const input = {
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken,
      picks,
      clientRequestId: newRequestId(),
    };
    let result = await submitTorcovka(input);
    if (result.status === "ACK_REQUIRED") {
      result = await submitTorcovka({
        ...input,
        plausibilityAck: {
          kind: "SUSPICIOUS",
          railsTaken: result.railsTaken,
          takenM: result.takenM,
          producedM: result.producedM,
          wastePct: result.wastePct,
        },
      });
    }
    expect(result.status).toBe("CREATED");
    return prisma.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: true },
    });
  }

  it("edits an untouched batch name, date, prices, note and package quantity", async () => {
    const world = await seedWorld();
    await updateBatch(
      world.batch.id,
      await formFor(world.batch.id, (values) => {
        values.name = `переименована-${world.suffix}`;
        values.note = "заметка";
        values.purchaseCost = 11_000;
        values.priceSort1 = 31_000;
        values.rails[0]!.quantity = 12;
      }),
      newRequestId(),
    );
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: world.batch.id } });
    const lot = await prisma.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(batch.name).toBe(`переименована-${world.suffix}`);
    expect(batch.note).toBe("заметка");
    expect(Number(batch.purchaseCost)).toBe(11_000);
    expect(Number(batch.priceSort1)).toBe(31_000);
    expect(lot.quantity).toBe(12);
    expect(lot.remainingQuantity).toBe(12);
  });

  it("keeps consumed rails when a started package quantity changes", async () => {
    const world = await seedWorld();
    await prismaA.railLot.update({
      where: { id: world.lot.id },
      data: { quantity: 10, remainingQuantity: 7 },
    });
    await updateBatch(
      world.batch.id,
      await formFor(world.batch.id, (values) => {
        values.rails[0]!.quantity = 9;
      }),
      newRequestId(),
    );
    const lot = await prisma.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lot.quantity).toBe(9);
    expect(lot.remainingQuantity).toBe(6);
  });

  it("rejects a quantity below what was already consumed", async () => {
    const world = await seedWorld();
    await prismaA.railLot.update({
      where: { id: world.lot.id },
      data: { quantity: 10, remainingQuantity: 4 },
    });
    await expect(
      updateBatch(
        world.batch.id,
        await formFor(world.batch.id, (values) => {
          values.rails[0]!.quantity = 5;
        }),
        newRequestId(),
      ),
    ).rejects.toThrow(PACKAGE_QUANTITY_BELOW_CONSUMED);
    const lot = await prisma.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lot.quantity).toBe(10);
    expect(lot.remainingQuantity).toBe(4);
  });

  it("edits an unpaid hours quantity and a torcovka line, then blocks the edit after cancel", async () => {
    const world = await seedWorld();
    const hours = await prismaA.productionOperation.create({
      data: {
        type: "HOURS",
        employeeId: world.emp.id,
        workDate: new Date("2026-10-02T00:00:00.000Z"),
        clientRequestId: newRequestId(),
        hours: new Prisma.Decimal(2),
        rateSnapshotVersion: 1,
        hourlyRateSnapshot: new Prisma.Decimal(100),
      },
    });
    await updateProductionLineQuantity(hours.id, 0, 3);
    const edited = await prisma.productionOperation.findUniqueOrThrow({ where: { id: hours.id } });
    expect(edited.hours?.toString()).toBe("3");

    const torc = await createdTorcovka(world, 1, [
      { lengthM: 0.9, sort: "SORT1", quantity: 2 },
    ]);
    await editPhysicalQuantityByLineIndex(prismaA, torc.id, 0, 1, newRequestId());
    const line = await prisma.operationDetailLine.findFirstOrThrow({ where: { operationId: torc.id } });
    expect(line.quantity).toBe(1);

    await cancelProductionOperation({
      operationId: hours.id,
      requestId: newRequestId(),
      reason: "ошибочные часы",
      expectedStateFingerprint: cancelFingerprint({ ...edited, lines: [] }),
    });
    await expect(updateProductionLineQuantity(hours.id, 0, 4)).rejects.toThrow(/аннулирована/);
  });

  it("cancels reversible torcovka and restores the rail lot without deleting the row", async () => {
    const world = await seedWorld();
    const op = await createdTorcovka(world, 4);
    await cancelProductionOperation({
      operationId: op.id,
      requestId: newRequestId(),
      reason: "ошибочная торцовка",
      expectedStateFingerprint: cancelFingerprint(op),
    });
    const lot = await prisma.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const kept = await prisma.productionOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(lot.remainingQuantity).toBe(10);
    expect(kept.cancelledAt).not.toBeNull();
    expect(kept.railsTaken).toBe(4);
  });

  it("rejects reversal when the produced blanks were already consumed", async () => {
    const world = await seedWorld();
    const op = await createdTorcovka(world, 2);
    await prismaA.blankStock.updateMany({ data: { quantity: 0 } });
    await expect(
      cancelProductionOperation({
        operationId: op.id,
        requestId: newRequestId(),
        reason: "поздно",
        expectedStateFingerprint: cancelFingerprint(op),
      }),
    ).rejects.toThrow(CANCEL_DOWNSTREAM_BLOCKED);
    const lot = await prisma.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const kept = await prisma.productionOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(lot.remainingQuantity).toBe(8);
    expect(kept.cancelledAt).toBeNull();
  });

  it("rejects cancellation of a paid operation", async () => {
    const world = await seedWorld();
    const op = await prismaA.productionOperation.create({
      data: {
        type: "HOURS",
        employeeId: world.emp.id,
        workDate: new Date("2026-10-02T00:00:00.000Z"),
        clientRequestId: newRequestId(),
        hours: new Prisma.Decimal(1),
        isPaid: true,
        rateSnapshotVersion: 1,
        hourlyRateSnapshot: new Prisma.Decimal(100),
      },
    });
    const loaded = await prisma.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    await expect(
      cancelProductionOperation({
        operationId: op.id,
        requestId: newRequestId(),
        reason: "нельзя",
        expectedStateFingerprint: cancelFingerprint(loaded),
      }),
    ).rejects.toThrow(CANCEL_PAID_BLOCKED);
    const after = await prisma.productionOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(after.cancelledAt).toBeNull();
  });

  it("replays the same cancel request without a second stock change", async () => {
    const world = await seedWorld();
    const op = await createdTorcovka(world, 1);
    const input = {
      operationId: op.id,
      requestId: newRequestId(),
      reason: "повтор",
      expectedStateFingerprint: cancelFingerprint(op),
    };
    const first = await cancelProductionOperation(input);
    const second = await cancelProductionOperation(input);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    const lot = await prisma.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lot.remainingQuantity).toBe(10);
    expect(await prisma.productionOperationCancellation.count({ where: { operationId: op.id } })).toBe(1);
  });

  it("rejects a package edit that lost the race on the fingerprint", async () => {
    const world = await seedWorld();
    const stale = await formFor(world.batch.id, (values) => {
      values.rails[0]!.quantity = 11;
    });
    const raced = await formFor(world.batch.id, (values) => {
      values.rails[0]!.quantity = 12;
    });
    const settled = await Promise.allSettled([
      updateBatch(world.batch.id, stale, newRequestId()),
      updateBatch(world.batch.id, raced, newRequestId()),
    ]);
    const ok = settled.filter((item) => item.status === "fulfilled");
    const failed = settled.filter((item) => item.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect((failed[0] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect((failed[0] as PromiseRejectedResult).reason.message).toContain(STALE_PACKAGE_EDIT.slice(0, 24));
    const lot = await prisma.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect([11, 12]).toContain(lot.quantity);
    expect(lot.remainingQuantity).toBe(lot.quantity);
  });

  it("keeps cancelled hours out of payroll and preserves the audit row", async () => {
    const world = await seedWorld();
    const op = await prismaA.productionOperation.create({
      data: {
        type: "HOURS",
        employeeId: world.emp.id,
        workDate: new Date("2026-10-02T00:00:00.000Z"),
        clientRequestId: newRequestId(),
        hours: new Prisma.Decimal(2),
        rateSnapshotVersion: 1,
        hourlyRateSnapshot: new Prisma.Decimal(100),
      },
    });
    const loaded = await prisma.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    const before = await getSalaryReport();
    expect(before.find((row) => row.id === `unpaid:${world.emp.id}`)?.total).toBe(200);
    await cancelProductionOperation({
      operationId: op.id,
      requestId: newRequestId(),
      reason: "не его смена",
      expectedStateFingerprint: cancelFingerprint(loaded),
    });
    const after = await getSalaryReport();
    expect(after.find((row) => row.id === `unpaid:${world.emp.id}`)).toBeUndefined();
    const kept = await prisma.productionOperation.findUniqueOrThrow({ where: { id: op.id } });
    const audit = await prisma.productionOperationCancellation.findUniqueOrThrow({
      where: { operationId: op.id },
    });
    const log = await prisma.changeLog.findFirst({
      where: { entity: "ProductionOperation", entityId: op.id },
    });
    const next = log?.newValues as { field?: string; oldValue?: string; reason?: string } | null;
    expect(kept.cancelledAt).not.toBeNull();
    expect(audit.reason).toBe("не его смена");
    expect(audit.adminUserId).toBe("integrity-admin");
    expect(next?.field).toBe("Аннулирование");
    expect(next?.oldValue).toBe("в учёте");
  });

  it("restores active cost-flow torcovka value without a loss event", async () => {
    await prismaA.setting.upsert({
      where: { key: PRODUCTION_COST_FLOW_KEY },
      create: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active: true } },
      update: { value: { version: 1, active: true } },
    });
    const world = await seedWorld({ money: true });
    const op = await createdTorcovka(world, 2);
    await cancelProductionOperation({
      operationId: op.id,
      requestId: newRequestId(),
      reason: "отмена потока",
      expectedStateFingerprint: cancelFingerprint(op),
    });
    const lot = await prisma.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const blanks = await prisma.blankStock.findMany();
    const loss = await prisma.costEvent.count({ where: { type: "TORCOVKA_ZERO_OUTPUT" } });
    expect(lot.remainingQuantity).toBe(10);
    expect(lot.remainingValue?.toString()).toBe("10000");
    expect(blanks.every((row) => row.quantity === 0)).toBe(true);
    expect(loss).toBe(0);
  });
});
