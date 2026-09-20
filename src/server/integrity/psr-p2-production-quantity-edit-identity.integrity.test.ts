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
import { CLIENT_REQUEST_ID_REQUIRED, newRequestId } from "@/lib/request-id";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import { INVENTORY_MOVEMENT_SHADOW_WRITE_KEY } from "@/server/internal/inventory-movement-shadow-write";
import {
  QUANTITY_EDIT_SHADOW_WRITER_NOT_READY,
  QUANTITY_EDIT_UPAKOVKA_COST_FLOW_NOT_READY,
  REQUEST_ID_REUSE,
  STALE_QUANTITY_EDIT,
  computeQuantityEditStateFingerprint,
} from "@/server/internal/production-quantity-edit";
import {
  editProductionOperationQuantity,
  updateProductionLineQuantity,
} from "@/server/production";
import { submitHours, submitPrisadka, submitTorcovka, submitUpakovka } from "@/server/terminal";
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

describe.skipIf(!enabled)("PSR-P2 Package 2 production quantity-edit identity", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];
  let seq = 0;

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
  });

  beforeEach(async () => {
    adminState.current = {
      id: "integrity-admin",
      name: "Admin",
      email: "admin@test.local",
      role: "ADMIN",
    };
    await resetIntegrityInventory(prismaA);
    seq += 1;
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
  });

  async function waitUntil(check: () => boolean | Promise<boolean>, label: string) {
    const start = Date.now();
    while (Date.now() - start < 8_000) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`barrier: ${label}`);
  }

  async function quantityChangeLogs(operationId: string) {
    const logs = await prismaA.changeLog.findMany({
      where: { entity: "ProductionOperation", entityId: operationId },
    });
    return logs.filter((log) => (log.newValues as { field?: string } | null)?.field === "Количество");
  }

  async function seedWorld(suffix: string) {
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        hourlyRate: 200,
        rateTorcovkaSort1: 12,
        ratePrisadkaTorcev: 9,
        rateUpakovka: 6,
      },
    });
    const batch = await prismaA.batch.create({
      data: {
        name: `batch-${suffix}`,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 1_000,
        totalCost: 1_000,
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
        quantity: 10,
        remainingQuantity: 10,
      },
    });
    const detail = await prismaA.detail.create({
      data: {
        name: `det-${suffix}`,
        materialId: material.id,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    const product = await prismaA.product.create({
      data: {
        name: `prod-${suffix}`,
        materialId: material.id,
        skuOzon: `OZ-${suffix}`,
        skuWb: `WB-${suffix}`,
        sort: "SORT1",
      },
    });
    await prismaA.productDetail.create({
      data: { productId: product.id, detailId: detail.id, quantity: 1 },
    });
    return { material, emp, batch, lot, detail, product };
  }

  async function loadOp(id: string) {
    return prismaA.productionOperation.findUniqueOrThrow({
      where: { id },
      include: {
        lines: { orderBy: { id: "asc" } },
        nomenclatureLines: { orderBy: { id: "asc" } },
      },
    });
  }

  function fingerprintFor(op: Awaited<ReturnType<typeof loadOp>>, lineId?: string | null) {
    const line = lineId ? op.lines.find((l) => l.id === lineId) : undefined;
    return computeQuantityEditStateFingerprint({
      operationId: op.id,
      operationType: op.type,
      productId: op.productId,
      productQty: op.productQty,
      line,
      lines: op.lines,
      nomenclatureLines: op.nomenclatureLines,
    });
  }

  async function editQty(input: {
    operationId: string;
    targetLineId?: string | null;
    expectedOldQuantity: number;
    newQuantity: number;
    requestId?: string;
    fingerprint?: string;
  }) {
    const op = await loadOp(input.operationId);
    return editProductionOperationQuantity({
      operationId: input.operationId,
      requestId: input.requestId ?? newRequestId(),
      targetLineId: input.targetLineId,
      expectedOldQuantity: input.expectedOldQuantity,
      newQuantity: input.newQuantity,
      expectedStateFingerprint: input.fingerprint ?? fingerprintFor(op, input.targetLineId),
    });
  }

  async function seedTorcovka(suffix: string, quantity = 2) {
    const world = await seedWorld(suffix);
    const railsTaken = quantity <= 1 ? 1 : 2;
    await submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken,
      clientRequestId: `test:qedit:tor:${suffix}`,
      picks: [{ lengthM: 1.8, sort: "SORT1", quantity }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "TORCOVKA", batchId: world.batch.id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    return { world, op, line: op.lines[0]! };
  }

  async function seedPrisadka(suffix: string, quantity = 2) {
    const world = await seedWorld(suffix);
    const railsTaken = quantity <= 1 ? 1 : 2;
    await submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken,
      clientRequestId: `test:qedit:pris-t:${suffix}`,
      picks: [{ lengthM: 1.8, sort: "SORT1", quantity }],
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `test:qedit:pris:${suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA", employeeId: world.emp.id },
      include: { lines: { orderBy: { id: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
    return { world, op, line: op.lines[0]! };
  }

  async function seedUpakovka(suffix: string, quantity = 1) {
    const world = await seedWorld(suffix);
    await submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 2,
      clientRequestId: `test:qedit:up-t:${suffix}`,
      picks: [{ lengthM: 1.8, sort: "SORT1", quantity: Math.max(quantity, 2) }],
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `test:qedit:up-p:${suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: Math.max(quantity, 2) }],
    });
    await submitUpakovka({
      employeeId: world.emp.id,
      clientRequestId: `test:qedit:up:${suffix}`,
      picks: [{ productId: world.product.id, quantity }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "UPAKOVKA", productId: world.product.id },
      include: { lines: { orderBy: { id: "asc" } }, nomenclatureLines: true },
    });
    return { world, op };
  }

  it("TORCOVKA successful stable-line-id edit retains actor, command, and ChangeLog userId", async () => {
    const { op, line } = await seedTorcovka(`t-ok-${seq}`);
    const blankBefore = await prismaA.blankStock.findFirstOrThrow();
    const result = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
    });
    expect(result.replayed).toBe(false);
    expect(result.noop).toBe(false);
    expect(result.quantityEditId).toBeTruthy();
    const row = await prismaA.productionOperationQuantityEdit.findUniqueOrThrow({
      where: { requestId: result.requestId },
    });
    expect(row.adminUserId).toBe("integrity-admin");
    expect(row.actorDisplaySnapshot).toBe("Admin");
    expect(row.operationType).toBe("TORCOVKA");
    expect(row.targetLineId).toBe(line.id);
    expect(row.expectedOldQuantity).toBe(2);
    expect(row.newQuantity).toBe(1);
    const log = await prismaA.changeLog.findFirstOrThrow({
      where: { entity: "ProductionOperation", entityId: op.id },
      orderBy: { changedAt: "desc" },
    });
    expect(log.userId).toBe("integrity-admin");
    const nv = log.newValues as Record<string, unknown>;
    expect(nv.quantityEditId).toBe(row.id);
    expect(nv.requestId).toBe(result.requestId);
    const afterLine = await prismaA.operationDetailLine.findUniqueOrThrow({ where: { id: line.id } });
    expect(afterLine.quantity).toBe(1);
    const blankAfter = await prismaA.blankStock.findUniqueOrThrow({ where: { id: blankBefore.id } });
    expect(blankAfter.quantity).toBe(blankBefore.quantity - 1);
    const effect = row.effectSnapshot as { physicalAdjustments: Array<{ quantityDelta: number; targetType: string }> };
    expect(effect.physicalAdjustments.every((a) => a.quantityDelta !== 0)).toBe(true);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("TORCOVKA expected-old and fingerprint mismatches fail with no mutation", async () => {
    const { op, line } = await seedTorcovka(`t-cas-${seq}`);
    const qtyBefore = (await loadOp(op.id)).lines[0]!.quantity;
    await expect(
      editQty({
        operationId: op.id,
        targetLineId: line.id,
        expectedOldQuantity: 99,
        newQuantity: 1,
      }),
    ).rejects.toThrow(STALE_QUANTITY_EDIT);
    await expect(
      editProductionOperationQuantity({
        operationId: op.id,
        requestId: newRequestId(),
        targetLineId: line.id,
        expectedOldQuantity: line.quantity,
        newQuantity: 1,
        expectedStateFingerprint: "qedit-state-v1:deadbeef",
      }),
    ).rejects.toThrow(STALE_QUANTITY_EDIT);
    expect((await loadOp(op.id)).lines[0]!.quantity).toBe(qtyBefore);
    expect(await prismaA.productionOperationQuantityEdit.count()).toBe(0);
    expect(await quantityChangeLogs(op.id)).toHaveLength(0);
  });

  it("TORCOVKA lineIndex reorder cannot retarget a stable line id", async () => {
    const { world, op, line: first } = await seedTorcovka(`t-idx-${seq}`, 1);
    await prismaA.productionOperation.update({
      where: { id: op.id },
      data: { railsTaken: 10 },
    });
    const second = await prismaA.operationDetailLine.create({
      data: {
        operationId: op.id,
        quantity: 1,
        blankLengthM: new Prisma.Decimal("1.6000"),
        blankType: "POLKA",
        blankSort: "SORT1",
        blankMaterialId: world.material.id,
      },
    });
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 1,
      },
    });
    await editQty({
      operationId: op.id,
      targetLineId: second.id,
      expectedOldQuantity: second.quantity,
      newQuantity: 2,
    });
    const after = await loadOp(op.id);
    expect(after.lines.find((l) => l.id === first.id)!.quantity).toBe(first.quantity);
    expect(after.lines.find((l) => l.id === second.id)!.quantity).toBe(2);
  });

  it("TORCOVKA sequential exact replay and concurrent same request apply once", async () => {
    const { op, line } = await seedTorcovka(`t-rp-${seq}`);
    const requestId = `qedit:tor:rp:${op.id}`;
    const fingerprint = fingerprintFor(await loadOp(op.id), line.id);
    const first = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
      requestId,
      fingerprint,
    });
    const logs = await quantityChangeLogs(op.id);
    const replay = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
      requestId,
      fingerprint,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.quantityEditId).toBe(first.quantityEditId);
    expect(await prismaA.productionOperationQuantityEdit.count({ where: { requestId } })).toBe(1);
    expect(await quantityChangeLogs(op.id)).toHaveLength(logs.length);
    expect((await loadOp(op.id)).lines.find((l) => l.id === line.id)!.quantity).toBe(1);

    const { op: op2, line: line2 } = await seedTorcovka(`t-cc-${seq}`);
    const concurrentId = `qedit:tor:cc:${op2.id}`;
    const concurrentFp = fingerprintFor(await loadOp(op2.id), line2.id);
    const settled = await withTimeout(
      Promise.allSettled([
        editQty({
          operationId: op2.id,
          targetLineId: line2.id,
          expectedOldQuantity: line2.quantity,
          newQuantity: 1,
          requestId: concurrentId,
          fingerprint: concurrentFp,
        }),
        editQty({
          operationId: op2.id,
          targetLineId: line2.id,
          expectedOldQuantity: line2.quantity,
          newQuantity: 1,
          requestId: concurrentId,
          fingerprint: concurrentFp,
        }),
      ]),
      "tor concurrent",
    );
    const ok = settled.filter((s) => s.status === "fulfilled") as PromiseFulfilledResult<
      Awaited<ReturnType<typeof editProductionOperationQuantity>>
    >[];
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(rejected, rejected.map((s) => String((s as PromiseRejectedResult).reason)).join(" | ")).toHaveLength(0);
    expect(ok).toHaveLength(2);
    expect(ok[0]!.value.quantityEditId).toBe(ok[1]!.value.quantityEditId);
    expect(await prismaA.productionOperationQuantityEdit.count({ where: { requestId: concurrentId } })).toBe(1);
    expect((await loadOp(op2.id)).lines[0]!.quantity).toBe(1);
  });

  it("TORCOVKA same request different payload fails; competing requestIds serialize", async () => {
    const { op, line } = await seedTorcovka(`t-reuse-${seq}`);
    const requestId = `qedit:tor:reuse:${op.id}`;
    await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
      requestId,
    });
    await expect(
      editQty({
        operationId: op.id,
        targetLineId: line.id,
        expectedOldQuantity: line.quantity,
        newQuantity: 3,
        requestId,
      }),
    ).rejects.toThrow(REQUEST_ID_REUSE);

    const { op: op2, line: line2 } = await seedTorcovka(`t-race-${seq}`);
    const fp = fingerprintFor(await loadOp(op2.id), line2.id);
    let started!: Promise<PromiseSettledResult<Awaited<ReturnType<typeof editProductionOperationQuantity>>>[]>;
    await prismaB.$transaction(
      async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ProductionOperation" WHERE id = ${op2.id} FOR UPDATE`;
      started = Promise.allSettled([
        editProductionOperationQuantity({
          operationId: op2.id,
          requestId: `qedit:tor:a:${op2.id}`,
          targetLineId: line2.id,
          expectedOldQuantity: line2.quantity,
          newQuantity: 1,
          expectedStateFingerprint: fp,
        }),
        editProductionOperationQuantity({
          operationId: op2.id,
          requestId: `qedit:tor:b:${op2.id}`,
          targetLineId: line2.id,
          expectedOldQuantity: line2.quantity,
          newQuantity: 1,
          expectedStateFingerprint: fp,
        }),
      ]);
      await waitUntil(async () => {
        const rows = await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND pid <> pg_backend_pid()
        `;
        return (rows[0]?.n ?? 0) >= 1;
      }, "tor competing lock wait");
      },
      { maxWait: 20_000, timeout: 20_000 },
    );
    const settled = await withTimeout(started, "tor competing");
    const ok = settled.filter((s) => s.status === "fulfilled");
    const stale = settled.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(stale).toHaveLength(1);
    expect(String(stale[0]!.reason)).toContain("STALE_QUANTITY_EDIT");
    expect(await prismaA.productionOperationQuantityEdit.count({ where: { operationId: op2.id } })).toBe(1);
  });

  it("PRISADKA successful edit retains replacement provenance and replay survives old line deletion", async () => {
    const { op, line } = await seedPrisadka(`p-ok-${seq}`);
    const destBefore = await prismaA.detailStock.findFirstOrThrow({
      where: { detailId: (await loadOp(op.id)).lines[0]!.detailId! },
    });
    const result = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
    });
    expect(await prismaA.operationDetailLine.count({ where: { id: line.id } })).toBe(0);
    const after = await loadOp(op.id);
    expect(after.lines.reduce((s, l) => s + l.quantity, 0)).toBe(1);
    const row = await prismaA.productionOperationQuantityEdit.findUniqueOrThrow({
      where: { requestId: result.requestId },
    });
    const effect = row.effectSnapshot as {
      before: { lineId: string };
      after: { lines: Array<{ lineId: string }> };
      physicalAdjustments: Array<{ quantityDelta: number }>;
    };
    expect(effect.before.lineId).toBe(line.id);
    expect(effect.after.lines.every((l) => l.lineId !== line.id)).toBe(true);
    expect(effect.physicalAdjustments.every((a) => a.quantityDelta !== 0)).toBe(true);
    const destAfter = await prismaA.detailStock.findUniqueOrThrow({ where: { id: destBefore.id } });
    expect(destAfter.quantity).toBe(destBefore.quantity - 1);
    const replay = await editProductionOperationQuantity({
      operationId: op.id,
      requestId: result.requestId,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
      expectedStateFingerprint: row.expectedStateFingerprint,
    });
    expect(replay.replayed).toBe(true);
    expect((await loadOp(op.id)).lines.reduce((s, l) => s + l.quantity, 0)).toBe(1);
    expect(await prismaA.productionOperationQuantityEdit.count({ where: { operationId: op.id } })).toBe(1);
  });

  it("PRISADKA stale quantity/fingerprint fail; concurrent same request applies once", async () => {
    const { op, line } = await seedPrisadka(`p-stale-${seq}`);
    await expect(
      editQty({
        operationId: op.id,
        targetLineId: line.id,
        expectedOldQuantity: 99,
        newQuantity: 1,
      }),
    ).rejects.toThrow(STALE_QUANTITY_EDIT);
    await expect(
      editProductionOperationQuantity({
        operationId: op.id,
        requestId: newRequestId(),
        targetLineId: line.id,
        expectedOldQuantity: line.quantity,
        newQuantity: 1,
        expectedStateFingerprint: "qedit-state-v1:nope",
      }),
    ).rejects.toThrow(STALE_QUANTITY_EDIT);
    expect(await prismaA.productionOperationQuantityEdit.count()).toBe(0);

    const { op: op2, line: line2 } = await seedPrisadka(`p-cc-${seq}`);
    const requestId = `qedit:pris:cc:${op2.id}`;
    const fp = fingerprintFor(await loadOp(op2.id), line2.id);
    const settled = await withTimeout(
      Promise.allSettled([
        editQty({
          operationId: op2.id,
          targetLineId: line2.id,
          expectedOldQuantity: line2.quantity,
          newQuantity: 1,
          requestId,
          fingerprint: fp,
        }),
        editQty({
          operationId: op2.id,
          targetLineId: line2.id,
          expectedOldQuantity: line2.quantity,
          newQuantity: 1,
          requestId,
          fingerprint: fp,
        }),
      ]),
      "pris concurrent",
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(2);
    expect(await prismaA.productionOperationQuantityEdit.count({ where: { requestId } })).toBe(1);
  });

  it("UPAKOVKA INACTIVE successful operation-target edit retains before/after and replay", async () => {
    const { world, op } = await seedUpakovka(`u-ok-${seq}`, 1);
    await prismaA.detailStock.updateMany({
      where: { detailId: world.detail.id, torcevayaDone: true, ploskostDone: false },
      data: { quantity: { increment: 2 } },
    });
    const productBefore = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: world.product.id },
    });
    const result = await editQty({
      operationId: op.id,
      targetLineId: null,
      expectedOldQuantity: op.productQty ?? 1,
      newQuantity: 2,
    });
    expect(result.replayed).toBe(false);
    const after = await loadOp(op.id);
    expect(after.productQty).toBe(2);
    const row = await prismaA.productionOperationQuantityEdit.findUniqueOrThrow({
      where: { requestId: result.requestId },
    });
    expect(row.targetLineId).toBeNull();
    const effect = row.effectSnapshot as {
      before: { productQty: number };
      after: { productQty: number };
      physicalAdjustments: Array<{ targetType: string; quantityDelta: number }>;
    };
    expect(effect.before.productQty).toBe(1);
    expect(effect.after.productQty).toBe(2);
    expect(effect.physicalAdjustments.some((a) => a.targetType === "PRODUCT" && a.quantityDelta === 1)).toBe(
      true,
    );
    const productAfter = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: world.product.id },
    });
    expect(productAfter.quantity).toBe(productBefore.quantity + 1);
    const replay = await editProductionOperationQuantity({
      operationId: op.id,
      requestId: result.requestId,
      targetLineId: null,
      expectedOldQuantity: op.productQty ?? 1,
      newQuantity: 2,
      expectedStateFingerprint: row.expectedStateFingerprint,
    });
    expect(replay.replayed).toBe(true);
    expect((await loadOp(op.id)).productQty).toBe(2);
  });

  it("UPAKOVKA INACTIVE stale productQty/fingerprint fail; concurrent same request applies once", async () => {
    const { world, op } = await seedUpakovka(`u-stale-${seq}`, 1);
    await prismaA.detailStock.updateMany({
      where: { detailId: world.detail.id },
      data: { quantity: { increment: 2 } },
    });
    await expect(
      editQty({
        operationId: op.id,
        targetLineId: null,
        expectedOldQuantity: 99,
        newQuantity: 2,
      }),
    ).rejects.toThrow(STALE_QUANTITY_EDIT);
    await expect(
      editProductionOperationQuantity({
        operationId: op.id,
        requestId: newRequestId(),
        targetLineId: null,
        expectedOldQuantity: op.productQty ?? 1,
        newQuantity: 2,
        expectedStateFingerprint: "qedit-state-v1:nope",
      }),
    ).rejects.toThrow(STALE_QUANTITY_EDIT);

    const { world: world2, op: op2 } = await seedUpakovka(`u-cc-${seq}`, 1);
    await prismaA.detailStock.updateMany({
      where: { detailId: world2.detail.id },
      data: { quantity: { increment: 2 } },
    });
    const requestId = `qedit:up:cc:${op2.id}`;
    const fp = fingerprintFor(await loadOp(op2.id));
    const settled = await withTimeout(
      Promise.allSettled([
        editQty({
          operationId: op2.id,
          targetLineId: null,
          expectedOldQuantity: op2.productQty ?? 1,
          newQuantity: 2,
          requestId,
          fingerprint: fp,
        }),
        editQty({
          operationId: op2.id,
          targetLineId: null,
          expectedOldQuantity: op2.productQty ?? 1,
          newQuantity: 2,
          requestId,
          fingerprint: fp,
        }),
      ]),
      "upak concurrent",
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(2);
    expect(await prismaA.productionOperationQuantityEdit.count({ where: { requestId } })).toBe(1);
  });

  it("UPAKOVKA ACTIVE fail-closed before physical mutation", async () => {
    const { world, op } = await seedUpakovka(`u-act-${seq}`, 1);
    await prismaA.setting.upsert({
      where: { key: PRODUCTION_COST_FLOW_KEY },
      create: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active: true } },
      update: { value: { version: 1, active: true } },
    });
    const before = await loadOp(op.id);
    const productBefore = await prismaA.productStock.findUnique({ where: { productId: world.product.id } });
    await expect(
      editQty({
        operationId: op.id,
        targetLineId: null,
        expectedOldQuantity: op.productQty ?? 1,
        newQuantity: 2,
      }),
    ).rejects.toThrow(QUANTITY_EDIT_UPAKOVKA_COST_FLOW_NOT_READY);
    expect(await prismaA.productionOperationQuantityEdit.count()).toBe(0);
    expect(await quantityChangeLogs(op.id)).toHaveLength(0);
    expect((await loadOp(op.id)).productQty).toBe(before.productQty);
    expect(await prismaA.productStock.findUnique({ where: { productId: world.product.id } })).toEqual(
      productBefore,
    );
  });

  it("SHADOW ACTIVE fail-closed for A/B/C before mutation", async () => {
    const { op, line } = await seedTorcovka(`sh-${seq}`);
    await prismaA.setting.upsert({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
      create: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value: { version: 1, active: true } },
      update: { value: { version: 1, active: true } },
    });
    await expect(
      editQty({
        operationId: op.id,
        targetLineId: line.id,
        expectedOldQuantity: line.quantity,
        newQuantity: 1,
      }),
    ).rejects.toThrow(QUANTITY_EDIT_SHADOW_WRITER_NOT_READY);
    expect(await prismaA.productionOperationQuantityEdit.count()).toBe(0);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect(await quantityChangeLogs(op.id)).toHaveLength(0);
    expect((await loadOp(op.id)).lines[0]!.quantity).toBe(line.quantity);
  });

  it("HOURS remains editable without ProductionOperationQuantityEdit or physical requestId", async () => {
    const world = await seedWorld(`h-${seq}`);
    await submitHours(world.emp.id, 2, `test:qedit:hours:${seq}`);
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "HOURS" } });
    const updated = await updateProductionLineQuantity(op.id, 0, 3);
    expect(updated.quantity).toBe(3);
    expect(await prismaA.productionOperationQuantityEdit.count()).toBe(0);
  });

  it("rejects blank requestId; actor mismatch is REQUEST_ID_REUSE; no FK; empty table; no money; no IM writer", async () => {
    const { op, line } = await seedTorcovka(`g-${seq}`);
    await expect(
      editProductionOperationQuantity({
        operationId: op.id,
        requestId: "   ",
        targetLineId: line.id,
        expectedOldQuantity: line.quantity,
        newQuantity: 1,
        expectedStateFingerprint: fingerprintFor(await loadOp(op.id), line.id),
      }),
    ).rejects.toThrow(CLIENT_REQUEST_ID_REQUIRED);

    const requestId = `qedit:actor:${op.id}`;
    await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
      requestId,
    });
    adminState.current = { ...adminState.current, id: "other-admin", name: "Other" };
    await prismaA.user.upsert({
      where: { id: "other-admin" },
      create: {
        id: "other-admin",
        email: "other@test.local",
        passwordHash: "x",
        name: "Other",
        role: "ADMIN",
      },
      update: {},
    });
    await expect(
      editQty({
        operationId: op.id,
        targetLineId: line.id,
        expectedOldQuantity: line.quantity,
        newQuantity: 1,
        requestId,
      }),
    ).rejects.toThrow(REQUEST_ID_REUSE);

    const fks = await prismaA.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM information_schema.table_constraints
      WHERE table_name = 'ProductionOperationQuantityEdit'
        AND constraint_type = 'FOREIGN KEY'
    `;
    expect(fks[0]?.n ?? -1).toBe(0);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    const row = await prismaA.productionOperationQuantityEdit.findFirstOrThrow();
    const effect = JSON.stringify(row.effectSnapshot);
    const request = JSON.stringify(row.requestSnapshot);
    expect(effect).not.toMatch(/amount|money|cost|price|value/i);
    expect(request).not.toMatch(/amount|money|cost|price|value/i);
  });

  it("no-op does not retain a command or ChangeLog", async () => {
    const { op, line } = await seedTorcovka(`noop-${seq}`);
    const result = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: line.quantity,
    });
    expect(result.noop).toBe(true);
    expect(result.quantityEditId).toBeNull();
    expect(await prismaA.productionOperationQuantityEdit.count()).toBe(0);
    expect(await quantityChangeLogs(op.id)).toHaveLength(0);
  });
});
