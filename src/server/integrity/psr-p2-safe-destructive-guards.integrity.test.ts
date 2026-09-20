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

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  BATCH_NONZERO_REMAINING_DELETE_BLOCKED,
  DETAIL_NONZERO_STOCK_DELETE_BLOCKED,
} from "@/lib/destructive-delete-guards";
import {
  PRISADKA_PHYSICAL_DELETE_BLOCKED,
  TORCOVKA_GENERIC_DELETE_BLOCKED,
  UPAKOVKA_PHYSICAL_DELETE_BLOCKED,
} from "@/lib/production-physical-delete-policy";
import { COST_FLOW_DELETE_BATCH } from "@/server/internal/cost-flow-raw";
import { COST_FLOW_QTY_ONLY_WRITER } from "@/server/internal/cost-flow-pools";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import { deleteDetail } from "@/server/nomenclature";
import { deleteProductionOperation } from "@/server/production";
import { deleteBatch } from "@/server/purchases";
import { submitHours, submitPrisadka, submitTorcovka, submitUpakovka } from "@/server/terminal";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const BARRIER_TIMEOUT_MS = 8_000;
const CONCURRENCY_TIMEOUT_MS = 20_000;

describe.skipIf(!enabled)("PSR-P2 Package 1 safe destructive guards", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];
  let seq = 0;

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityInventory(prismaA);
    seq += 1;
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
  });

  async function setCostFlowActive(active: boolean) {
    await prismaA.setting.upsert({
      where: { key: PRODUCTION_COST_FLOW_KEY },
      create: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active } },
      update: { value: { version: 1, active } },
    });
  }

  async function waitUntil(check: () => boolean | Promise<boolean>, label: string) {
    const start = Date.now();
    while (Date.now() - start < BARRIER_TIMEOUT_MS) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`barrier: ${label}`);
  }

  async function waitForLockWaiter(blockerPid: number, label: string) {
    await waitUntil(async () => {
      const rows = await prismaA.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.wait_event_type = 'Lock'
          AND a.pid <> ${blockerPid}
      `;
      return (rows[0]?.n ?? 0) >= 1;
    }, label);
  }

  async function seedEmployee(suffix: string) {
    return prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        hourlyRate: 200,
        rateTorcovkaSort1: 12,
        ratePrisadkaTorcev: 9,
        rateUpakovka: 6,
      },
    });
  }

  async function seedMaterial(suffix: string) {
    return prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
  }

  async function seedBatch(suffix: string, materialId: string, remaining: number) {
    const batch = await prismaA.batch.create({
      data: {
        name: `batch-${suffix}`,
        materialId,
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
        quantity: Math.max(remaining, 1),
        remainingQuantity: remaining,
      },
    });
    return { batch, lot };
  }

  async function seedDetail(suffix: string, materialId: string) {
    return prismaA.detail.create({
      data: {
        name: `det-${suffix}`,
        materialId,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
  }

  async function seedPhysicalChain(suffix: string) {
    const material = await seedMaterial(suffix);
    const emp = await seedEmployee(suffix);
    const { batch, lot } = await seedBatch(suffix, material.id, 10);
    const detail = await seedDetail(suffix, material.id);
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

  it("TORCOVKA delete rejects before mutation", async () => {
    const suffix = `torc-${seq}`;
    const world = await seedPhysicalChain(suffix);
    await submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 1,
      clientRequestId: `test:p1:torc:${suffix}`,
      picks: [{ lengthM: 1.8, sort: "SORT1", quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "TORCOVKA" } });
    const lotBefore = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    await expect(deleteProductionOperation(op.id)).rejects.toThrow(TORCOVKA_GENERIC_DELETE_BLOCKED);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } })).remainingQuantity).toBe(
      lotBefore.remainingQuantity,
    );
  });

  it("PRISADKA delete rejects and leaves stock and provenance unchanged", async () => {
    const suffix = `pris-${seq}`;
    const world = await seedPhysicalChain(suffix);
    await submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 1,
      clientRequestId: `test:p1:pris-t:${suffix}`,
      picks: [{ lengthM: 1.8, sort: "SORT1", quantity: 1 }],
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `test:p1:pris:${suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: true },
    });
    const blanksBefore = await prismaA.blankStock.findMany();
    const detailsBefore = await prismaA.detailStock.findMany({ where: { detailId: world.detail.id } });
    await expect(deleteProductionOperation(op.id)).rejects.toThrow(PRISADKA_PHYSICAL_DELETE_BLOCKED);
    const after = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    expect(after.lines).toHaveLength(op.lines.length);
    expect(await prismaA.blankStock.findMany()).toEqual(blanksBefore);
    expect(await prismaA.detailStock.findMany({ where: { detailId: world.detail.id } })).toEqual(
      detailsBefore,
    );
  });

  it("UPAKOVKA delete rejects and leaves stock and provenance unchanged", async () => {
    const suffix = `upak-${seq}`;
    const world = await seedPhysicalChain(suffix);
    await submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 1,
      clientRequestId: `test:p1:up-t:${suffix}`,
      picks: [{ lengthM: 1.8, sort: "SORT1", quantity: 1 }],
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `test:p1:up-p:${suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    await submitUpakovka({
      employeeId: world.emp.id,
      clientRequestId: `test:p1:up:${suffix}`,
      picks: [{ productId: world.product.id, quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "UPAKOVKA" },
      include: { lines: true, nomenclatureLines: true },
    });
    const productBefore = await prismaA.productStock.findUnique({ where: { productId: world.product.id } });
    const detailsBefore = await prismaA.detailStock.findMany({ where: { detailId: world.detail.id } });
    await expect(deleteProductionOperation(op.id)).rejects.toThrow(UPAKOVKA_PHYSICAL_DELETE_BLOCKED);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(1);
    expect(await prismaA.productStock.findUnique({ where: { productId: world.product.id } })).toEqual(
      productBefore,
    );
    expect(await prismaA.detailStock.findMany({ where: { detailId: world.detail.id } })).toEqual(
      detailsBefore,
    );
    expect(
      (
        await prismaA.productionOperation.findUniqueOrThrow({
          where: { id: op.id },
          include: { lines: true },
        })
      ).lines,
    ).toHaveLength(op.lines.length);
  });

  it("HOURS delete remains allowed", async () => {
    const suffix = `hours-${seq}`;
    const emp = await seedEmployee(suffix);
    await submitHours(emp.id, 2, `test:p1:hours:${suffix}`);
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "HOURS" } });
    await deleteProductionOperation(op.id);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(0);
  });

  it("deleteBatch rejects positive remaining", async () => {
    const suffix = `gpos-${seq}`;
    const material = await seedMaterial(suffix);
    const { batch } = await seedBatch(suffix, material.id, 3);
    await expect(deleteBatch(batch.id)).rejects.toThrow(BATCH_NONZERO_REMAINING_DELETE_BLOCKED);
    expect(await prismaA.batch.count({ where: { id: batch.id } })).toBe(1);
  });

  it("deleteBatch rejects injected negative remaining", async () => {
    const suffix = `gneg-${seq}`;
    const material = await seedMaterial(suffix);
    const { batch, lot } = await seedBatch(suffix, material.id, 0);
    await prismaA.$executeRaw`
      UPDATE "RailLot" SET "remainingQuantity" = -2 WHERE id = ${lot.id}
    `;
    await expect(deleteBatch(batch.id)).rejects.toThrow(BATCH_NONZERO_REMAINING_DELETE_BLOCKED);
    expect(await prismaA.batch.count({ where: { id: batch.id } })).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: lot.id } })).remainingQuantity).toBe(-2);
  });

  it("deleteBatch allows every remainingQuantity === 0 when no ops/deals", async () => {
    const suffix = `gzero-${seq}`;
    const material = await seedMaterial(suffix);
    const { batch, lot } = await seedBatch(suffix, material.id, 0);
    await deleteBatch(batch.id);
    expect(await prismaA.batch.findUnique({ where: { id: batch.id } })).toBeNull();
    expect(await prismaA.railLot.findUnique({ where: { id: lot.id } })).toBeNull();
  });

  it("deleteBatch rejects existing ProductionOperation even when remaining is 0", async () => {
    const suffix = `gop-${seq}`;
    const world = await seedPhysicalChain(suffix);
    await prismaA.railLot.update({
      where: { id: world.lot.id },
      data: { remainingQuantity: 0 },
    });
    await prismaA.productionOperation.create({
      data: {
        type: "HOURS",
        employeeId: world.emp.id,
        clientRequestId: `test:p1:gop:${suffix}`,
        workDate: new Date("2026-01-15T00:00:00.000Z"),
        hours: 1,
        hourlyRateSnapshot: 200,
        rateSnapshotVersion: 1,
        batchId: world.batch.id,
      },
    });
    await expect(deleteBatch(world.batch.id)).rejects.toThrow(/движения материала|сделке/);
    expect(await prismaA.batch.count({ where: { id: world.batch.id } })).toBe(1);
  });

  it("deleteBatch rejects existing DealItem even when remaining is 0", async () => {
    const suffix = `gdeal-${seq}`;
    const material = await seedMaterial(suffix);
    const { batch } = await seedBatch(suffix, material.id, 0);
    const deal = await prismaA.deal.create({ data: { name: `deal-${suffix}` } });
    await prismaA.dealItem.create({ data: { dealId: deal.id, batchId: batch.id } });
    await expect(deleteBatch(batch.id)).rejects.toThrow(/движения материала|сделке/);
    expect(await prismaA.batch.count({ where: { id: batch.id } })).toBe(1);
  });

  it("deleteBatch rejects ACTIVE cost flow", async () => {
    await setCostFlowActive(true);
    const suffix = `gact-${seq}`;
    const material = await seedMaterial(suffix);
    const { batch } = await seedBatch(suffix, material.id, 0);
    await expect(deleteBatch(batch.id)).rejects.toThrow(COST_FLOW_DELETE_BATCH);
    expect(await prismaA.batch.count({ where: { id: batch.id } })).toBe(1);
  });

  it("deleteBatch detects concurrent lot-set change and does not destroy nonzero remaining", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    const suffix = `gset-${seq}`;
    const material = await seedMaterial(suffix);
    const { batch, lot } = await seedBatch(suffix, material.id, 0);
    let blockerReady!: () => void;
    const blockerHeld = new Promise<void>((resolve) => {
      blockerReady = resolve;
    });
    const blocker = prismaB.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::int AS pid
        `;
        await tx.$queryRaw`
          SELECT id FROM "Batch" WHERE id = ${batch.id} FOR UPDATE
        `;
        blockerReady();
        await waitForLockWaiter(rows[0]!.pid, "deleteBatch waiting on Batch");
        await tx.railLot.create({
          data: {
            batchId: batch.id,
            lengthM: new Prisma.Decimal("2"),
            railType: "POLKA",
            sort: "SORT2",
            isPackage: false,
            quantity: 3,
            remainingQuantity: 3,
          },
        });
      },
      { timeout: CONCURRENCY_TIMEOUT_MS },
    );
    await blockerHeld;
    const started = deleteBatch(batch.id);
    await blocker;
    await expect(started).rejects.toThrow(BATCH_NONZERO_REMAINING_DELETE_BLOCKED);
    expect(await prismaA.batch.count({ where: { id: batch.id } })).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: lot.id } })).remainingQuantity).toBe(0);
    expect(await prismaA.railLot.count({ where: { batchId: batch.id } })).toBe(2);
  });

  it("deleteBatch concurrent remaining write cannot destroy a nonzero balance", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    const suffix = `gqty-${seq}`;
    const material = await seedMaterial(suffix);
    const { batch, lot } = await seedBatch(suffix, material.id, 0);
    let blockerReady!: () => void;
    const blockerHeld = new Promise<void>((resolve) => {
      blockerReady = resolve;
    });
    const blocker = prismaB.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::int AS pid
        `;
        await tx.$queryRaw`
          SELECT id FROM "RailLot" WHERE id = ${lot.id} FOR UPDATE
        `;
        blockerReady();
        await waitForLockWaiter(rows[0]!.pid, "deleteBatch waiting on RailLot");
        await tx.railLot.update({
          where: { id: lot.id },
          data: { remainingQuantity: 4 },
        });
      },
      { timeout: CONCURRENCY_TIMEOUT_MS },
    );
    await blockerHeld;
    const started = deleteBatch(batch.id);
    await blocker;
    await expect(started).rejects.toThrow(BATCH_NONZERO_REMAINING_DELETE_BLOCKED);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: lot.id } })).remainingQuantity).toBe(4);
    expect(await prismaA.batch.count({ where: { id: batch.id } })).toBe(1);
  });

  it("deleteDetail INACTIVE allows no stock rows", async () => {
    const suffix = `hnone-${seq}`;
    const material = await seedMaterial(suffix);
    const detail = await seedDetail(suffix, material.id);
    await deleteDetail(detail.id);
    expect(await prismaA.detail.findUnique({ where: { id: detail.id } })).toBeNull();
  });

  it("deleteDetail INACTIVE allows zero-quantity stock rows", async () => {
    const suffix = `hzero-${seq}`;
    const material = await seedMaterial(suffix);
    const detail = await seedDetail(suffix, material.id);
    await prismaA.detailStock.create({
      data: { detailId: detail.id, torcevayaDone: true, ploskostDone: false, quantity: 0 },
    });
    await deleteDetail(detail.id);
    expect(await prismaA.detail.findUnique({ where: { id: detail.id } })).toBeNull();
    expect(await prismaA.detailStock.count({ where: { detailId: detail.id } })).toBe(0);
  });

  it("deleteDetail INACTIVE rejects positive quantity", async () => {
    const suffix = `hpos-${seq}`;
    const material = await seedMaterial(suffix);
    const detail = await seedDetail(suffix, material.id);
    await prismaA.detailStock.create({
      data: { detailId: detail.id, torcevayaDone: true, ploskostDone: false, quantity: 3 },
    });
    await expect(deleteDetail(detail.id)).rejects.toThrow(DETAIL_NONZERO_STOCK_DELETE_BLOCKED);
    expect(await prismaA.detail.count({ where: { id: detail.id } })).toBe(1);
  });

  it("deleteDetail INACTIVE rejects injected negative quantity", async () => {
    const suffix = `hneg-${seq}`;
    const material = await seedMaterial(suffix);
    const detail = await seedDetail(suffix, material.id);
    const stock = await prismaA.detailStock.create({
      data: { detailId: detail.id, torcevayaDone: true, ploskostDone: false, quantity: 0 },
    });
    await prismaA.$executeRaw`
      UPDATE "DetailStock" SET quantity = -4 WHERE id = ${stock.id}
    `;
    await expect(deleteDetail(detail.id)).rejects.toThrow(DETAIL_NONZERO_STOCK_DELETE_BLOCKED);
    expect((await prismaA.detailStock.findUniqueOrThrow({ where: { id: stock.id } })).quantity).toBe(-4);
  });

  it("deleteDetail INACTIVE rejects ProductDetail usage", async () => {
    const suffix = `huse-${seq}`;
    const material = await seedMaterial(suffix);
    const detail = await seedDetail(suffix, material.id);
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
    await expect(deleteDetail(detail.id)).rejects.toThrow(/входит в изделие/);
    expect(await prismaA.detail.count({ where: { id: detail.id } })).toBe(1);
  });

  it("deleteDetail ACTIVE rejects a zero-quantity stock row", async () => {
    await setCostFlowActive(true);
    const suffix = `haz-${seq}`;
    const material = await seedMaterial(suffix);
    const detail = await seedDetail(suffix, material.id);
    await prismaA.detailStock.create({
      data: { detailId: detail.id, torcevayaDone: true, ploskostDone: false, quantity: 0 },
    });
    await expect(deleteDetail(detail.id)).rejects.toThrow(COST_FLOW_QTY_ONLY_WRITER);
    expect(await prismaA.detail.count({ where: { id: detail.id } })).toBe(1);
  });

  it("deleteDetail ACTIVE rejects a positive stock row", async () => {
    await setCostFlowActive(true);
    const suffix = `hap-${seq}`;
    const material = await seedMaterial(suffix);
    const detail = await seedDetail(suffix, material.id);
    await prismaA.detailStock.create({
      data: { detailId: detail.id, torcevayaDone: true, ploskostDone: false, quantity: 2 },
    });
    await expect(deleteDetail(detail.id)).rejects.toThrow(COST_FLOW_QTY_ONLY_WRITER);
    expect(await prismaA.detail.count({ where: { id: detail.id } })).toBe(1);
  });

  it("deleteDetail concurrent stock insert cannot hide a nonzero quantity", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    const suffix = `hconc-${seq}`;
    const material = await seedMaterial(suffix);
    const detail = await seedDetail(suffix, material.id);
    let blockerReady!: () => void;
    const blockerHeld = new Promise<void>((resolve) => {
      blockerReady = resolve;
    });
    const blocker = prismaB.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::int AS pid
        `;
        await tx.$queryRaw`
          SELECT id FROM "Detail" WHERE id = ${detail.id} FOR UPDATE
        `;
        blockerReady();
        await waitForLockWaiter(rows[0]!.pid, "deleteDetail waiting on Detail");
        await tx.detailStock.create({
          data: { detailId: detail.id, torcevayaDone: true, ploskostDone: false, quantity: 5 },
        });
      },
      { timeout: CONCURRENCY_TIMEOUT_MS },
    );
    await blockerHeld;
    const started = deleteDetail(detail.id);
    await blocker;
    await expect(started).rejects.toThrow(DETAIL_NONZERO_STOCK_DELETE_BLOCKED);
    expect(await prismaA.detail.count({ where: { id: detail.id } })).toBe(1);
    expect(
      (await prismaA.detailStock.findFirstOrThrow({ where: { detailId: detail.id } })).quantity,
    ).toBe(5);
  });

  it("deleteDetail concurrent ProductDetail attach cannot bypass the in-TX usage guard", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    const suffix = `hpd-${seq}`;
    const material = await seedMaterial(suffix);
    const detail = await seedDetail(suffix, material.id);
    const product = await prismaA.product.create({
      data: {
        name: `prod-${suffix}`,
        materialId: material.id,
        skuOzon: `OZ-${suffix}`,
        skuWb: `WB-${suffix}`,
        sort: "SORT1",
      },
    });
    let blockerReady!: () => void;
    const blockerHeld = new Promise<void>((resolve) => {
      blockerReady = resolve;
    });
    const blocker = prismaB.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::int AS pid
        `;
        await tx.$queryRaw`
          SELECT id FROM "Detail" WHERE id = ${detail.id} FOR UPDATE
        `;
        blockerReady();
        await waitForLockWaiter(rows[0]!.pid, "deleteDetail waiting on Detail for ProductDetail");
        await tx.productDetail.create({
          data: { productId: product.id, detailId: detail.id, quantity: 1 },
        });
      },
      { timeout: CONCURRENCY_TIMEOUT_MS },
    );
    await blockerHeld;
    const started = deleteDetail(detail.id);
    await blocker;
    await expect(started).rejects.toThrow(/входит в изделие/);
    expect(await prismaA.detail.count({ where: { id: detail.id } })).toBe(1);
    expect(await prismaA.productDetail.count({ where: { detailId: detail.id } })).toBe(1);
  });
});
