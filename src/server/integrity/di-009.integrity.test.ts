vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/server/session", () => ({
  requireAdmin: async () => {},
  requireTerminalEmployee: async () => {},
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { isReady } from "@/lib/detail-stock";
import { applyPrisadkaPick, applyUpakovkaPrepared, reverseUpakovkaOperation } from "@/server/internal/production-reversal";
import {
  ALREADY_CONDUCTED,
  INVENTORY_BOUNDARY,
  STALE_SNAPSHOT,
  prepareUpakovkaEdit,
} from "@/server/internal/inventory-integrity";
import { correctTorcovkaRailsTaken, deleteProductionOperation, updateProductionLineQuantity } from "@/server/production";
import { submitPrisadka, submitUpakovka } from "@/server/terminal";
import { conductInventory, getInventoryDocs, updateInventoryLineActual } from "@/server/warehouse";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const CONCURRENCY_TIMEOUT_MS = 20_000;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function prismaPgCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const rec = err as { code?: unknown; meta?: { code?: unknown } };
  if (typeof rec.code === "string") return rec.code;
  if (typeof rec.meta?.code === "string") return rec.meta.code;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let di009Req = 0;
function testReq(label: string): string {
  di009Req += 1;
  return `test:di009:${label}:${di009Req}`;
}

describe.skipIf(!enabled)("DI-009 inventory integrity", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityInventory(prismaA);
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
  });

  async function material(suffix: string) {
    return prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
  }

  async function employee(suffix: string) {
    return prismaA.employee.create({
      data: { fullName: `emp-${suffix}`, pin: "1234", rateUpakovka: 10 },
    });
  }

  async function product(materialId: string, suffix: string, name = "Изделие") {
    return prismaA.product.create({
      data: {
        name,
        materialId,
        skuOzon: `OZ-${suffix}`,
        skuWb: `WB-${suffix}`,
        sort: "SORT1",
      },
    });
  }

  async function detail(
    materialId: string,
    suffix: string,
    flags: { torcev: boolean; plosk: boolean },
  ) {
    return prismaA.detail.create({
      data: {
        name: `det-${suffix}`,
        materialId,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: flags.torcev,
        prisadkaPloskost: flags.plosk,
      },
    });
  }

  async function readySum(detailId: string): Promise<number> {
    const d = await prismaA.detail.findUniqueOrThrow({ where: { id: detailId } });
    const rows = await prismaA.detailStock.findMany({ where: { detailId } });
    return rows
      .filter((r) => isReady(d, r.torcevayaDone, r.ploskostDone))
      .reduce((s, r) => s + r.quantity, 0);
  }

  async function wipSum(detailId: string): Promise<number> {
    const d = await prismaA.detail.findUniqueOrThrow({ where: { id: detailId } });
    const rows = await prismaA.detailStock.findMany({ where: { detailId } });
    return rows
      .filter((r) => !isReady(d, r.torcevayaDone, r.ploskostDone))
      .reduce((s, r) => s + r.quantity, 0);
  }

  it("1 happy SET 100→95", async () => {
    const mat = await material("t1");
    const p = await product(mat.id, "t1");
    await prismaA.productStock.create({ data: { productId: p.id, quantity: 100 } });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date("2026-01-01T00:00:00.000Z"),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: p.id,
              accountedQty: 100,
              actualQty: 95,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
      include: { lines: true },
    });

    const before = Date.now();
    const result = await conductInventory(doc.id);
    const after = await prismaA.inventory.findUniqueOrThrow({
      where: { id: doc.id },
      include: { lines: true },
    });
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: p.id } });

    expect(result.status).toBe("CONDUCTED");
    expect(after.status).toBe("CONDUCTED");
    expect(stock.quantity).toBe(95);
    expect(after.lines[0]?.deviation).toBe(-5);
    expect(Number(after.lines[0]?.deviationSum)).toBe(0);
    expect(after.date.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(after.date.getTime()).not.toBe(new Date("2026-01-01T00:00:00.000Z").getTime());
    expect(after.createdAt.getTime()).toBeLessThan(after.date.getTime() + 2000);
  });

  it("2 stale snapshot reject, zero writes", async () => {
    const mat = await material("t2");
    const p = await product(mat.id, "t2");
    await prismaA.productStock.create({ data: { productId: p.id, quantity: 100 } });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date("2026-01-01T00:00:00.000Z"),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: p.id,
              accountedQty: 100,
              actualQty: 95,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
      include: { lines: true },
    });
    await prismaA.productStock.update({ where: { productId: p.id }, data: { quantity: 80 } });

    await expect(conductInventory(doc.id)).rejects.toThrow(STALE_SNAPSHOT);

    const after = await prismaA.inventory.findUniqueOrThrow({
      where: { id: doc.id },
      include: { lines: true },
    });
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: p.id } });
    expect(stock.quantity).toBe(80);
    expect(after.status).toBe("DRAFT");
    expect(after.lines[0]?.actualQty).toBe(95);
    expect(after.lines[0]?.deviation).toBe(0);
    expect(Number(after.lines[0]?.deviationSum)).toBe(0);
    const headers = await prismaA.changeLog.findMany({
      where: { entity: "Inventory", entityId: doc.id },
    });
    expect(headers.filter((h) => asRecord(h.newValues).status === "CONDUCTED")).toHaveLength(0);
  });

  it("3 one stale among many aborts whole doc", async () => {
    const mat = await material("t3");
    const p1 = await product(mat.id, "t3a", "A");
    const p2 = await product(mat.id, "t3b", "B");
    await prismaA.productStock.create({ data: { productId: p1.id, quantity: 10 } });
    await prismaA.productStock.create({ data: { productId: p2.id, quantity: 20 } });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: p1.id,
              accountedQty: 10,
              actualQty: 9,
              deviation: 0,
              deviationSum: 0,
            },
            {
              refType: "PRODUCT",
              refId: p2.id,
              accountedQty: 20,
              actualQty: 18,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await prismaA.productStock.update({ where: { productId: p2.id }, data: { quantity: 19 } });

    await expect(conductInventory(doc.id)).rejects.toThrow(STALE_SNAPSHOT);

    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: p1.id } })).quantity).toBe(
      10,
    );
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: p2.id } })).quantity).toBe(
      19,
    );
    const after = await prismaA.inventory.findUniqueOrThrow({
      where: { id: doc.id },
      include: { lines: true },
    });
    expect(after.status).toBe("DRAFT");
    expect(after.lines.every((l) => l.deviation === 0)).toBe(true);
  });

  it("4 double conduct exactly one success", async () => {
    const mat = await material("t4");
    const p = await product(mat.id, "t4");
    await prismaA.productStock.create({ data: { productId: p.id, quantity: 10 } });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: p.id,
              accountedQty: 10,
              actualQty: 7,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });

    const results = await Promise.allSettled([conductInventory(doc.id), conductInventory(doc.id)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(errorMessage((failed[0] as PromiseRejectedResult).reason)).toBe(ALREADY_CONDUCTED);

    const after = await prismaA.inventory.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.status).toBe("CONDUCTED");
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: p.id } })).quantity).toBe(
      7,
    );
    const headers = await prismaA.changeLog.findMany({
      where: { entity: "Inventory", entityId: doc.id },
    });
    expect(headers.filter((h) => asRecord(h.newValues).status === "CONDUCTED")).toHaveLength(1);
  });

  it("5 historical deviationSum frozen", async () => {
    const item = await prismaA.nomenclatureItem.create({
      data: { name: "Саморез", type: "FASTENER", unitPrice: new Prisma.Decimal(10) },
    });
    await prismaA.nomenclatureStock.create({ data: { nomenclatureId: item.id, quantity: 20 } });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "NOMENCLATURE",
              refId: item.id,
              accountedQty: 20,
              actualQty: 15,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(doc.id);
    const stored = await prismaA.inventoryLine.findFirstOrThrow({ where: { inventoryId: doc.id } });
    expect(Number(stored.deviationSum)).toBe(-50);

    await prismaA.nomenclatureItem.update({
      where: { id: item.id },
      data: { unitPrice: new Prisma.Decimal(999) },
    });
    const docs = await getInventoryDocs();
    const history = docs.find((d) => d.id === doc.id);
    expect(history?.lines[0]?.deviation).toBe(-5);
    expect(history?.lines[0]?.deviationSum).toBe(-50);
  });

  it("6 reverse with no later inventory ALLOW", async () => {
    const mat = await material("t6");
    const emp = await employee("t6");
    const d = await detail(mat.id, "t6", { torcev: true, plosk: true });
    const p = await product(mat.id, "t6");
    await prismaA.productDetail.create({ data: { productId: p.id, detailId: d.id, quantity: 1 } });
    await prismaA.detailStock.create({
      data: { detailId: d.id, torcevayaDone: true, ploskostDone: true, quantity: 5 },
    });
    await submitUpakovka({
      employeeId: emp.id,
      clientRequestId: testReq("u371"),
      picks: [{ productId: p.id, quantity: 2 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "UPAKOVKA" } });

    await deleteProductionOperation(op.id);

    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(0);
    expect((await prismaA.productStock.findUnique({ where: { productId: p.id } }))?.quantity ?? 0).toBe(
      0,
    );
    expect(await readySum(d.id)).toBe(5);
  });

  it("7 reverse across covering inventory BLOCK, zero writes", async () => {
    const mat = await material("t7");
    const emp = await employee("t7");
    const d = await detail(mat.id, "t7", { torcev: true, plosk: true });
    const p = await product(mat.id, "t7");
    await prismaA.productDetail.create({ data: { productId: p.id, detailId: d.id, quantity: 1 } });
    await prismaA.detailStock.create({
      data: { detailId: d.id, torcevayaDone: true, ploskostDone: true, quantity: 20 },
    });
    await submitUpakovka({
      employeeId: emp.id,
      clientRequestId: testReq("u392"),
      picks: [{ productId: p.id, quantity: 20 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "UPAKOVKA" } });
    await delay(30);

    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: p.id,
              accountedQty: 20,
              actualQty: 15,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(doc.id);

    await expect(deleteProductionOperation(op.id)).rejects.toThrow(INVENTORY_BOUNDARY);

    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(1);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: p.id } })).quantity).toBe(
      15,
    );
    expect(await readySum(d.id)).toBe(0);
  });

  it("8 inventory other ref → ALLOW", async () => {
    const mat = await material("t8");
    const emp = await employee("t8");
    const d = await detail(mat.id, "t8", { torcev: true, plosk: true });
    const pA = await product(mat.id, "t8a", "A");
    const pB = await product(mat.id, "t8b", "B");
    await prismaA.productDetail.create({ data: { productId: pA.id, detailId: d.id, quantity: 1 } });
    await prismaA.detailStock.create({
      data: { detailId: d.id, torcevayaDone: true, ploskostDone: true, quantity: 3 },
    });
    await prismaA.productStock.create({ data: { productId: pB.id, quantity: 4 } });
    await submitUpakovka({
      employeeId: emp.id,
      clientRequestId: testReq("u436"),
      picks: [{ productId: pA.id, quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "UPAKOVKA", productId: pA.id },
    });
    await delay(30);
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: pB.id,
              accountedQty: 4,
              actualQty: 4,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(doc.id);

    await deleteProductionOperation(op.id);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(0);
    expect((await prismaA.productStock.findUnique({ where: { productId: pA.id } }))?.quantity ?? 0).toBe(
      0,
    );
  });

  it("9 operation after inventory → ALLOW reverse", async () => {
    const mat = await material("t9");
    const emp = await employee("t9");
    const d = await detail(mat.id, "t9", { torcev: true, plosk: true });
    const p = await product(mat.id, "t9");
    await prismaA.productDetail.create({ data: { productId: p.id, detailId: d.id, quantity: 1 } });
    await prismaA.productStock.create({ data: { productId: p.id, quantity: 0 } });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: p.id,
              accountedQty: 0,
              actualQty: 0,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(doc.id);
    await prismaA.detailStock.create({
      data: { detailId: d.id, torcevayaDone: true, ploskostDone: true, quantity: 2 },
    });
    await submitUpakovka({
      employeeId: emp.id,
      clientRequestId: testReq("u497"),
      picks: [{ productId: p.id, quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "UPAKOVKA" } });

    await deleteProductionOperation(op.id);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(0);
  });

  it("10 RailLot correction unaffected; TORCOVKA delete ALLOW if blank spec not inventoried", async () => {
    const mat = await material("t10");
    const emp = await employee("t10");
    const p = await product(mat.id, "t10");
    await prismaA.productStock.create({ data: { productId: p.id, quantity: 3 } });
    const batch = await prismaA.batch.create({
      data: {
        name: "batch-t10",
        materialId: mat.id,
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
        lengthM: new Prisma.Decimal("3.0000"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: 10,
        remainingQuantity: 5,
      },
    });
    const op = await prismaA.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId: emp.id,
        clientRequestId: testReq("t534"),
        batchId: batch.id,
        railLotId: lot.id,
        railsTaken: 2,
        workDate: new Date(),
        lines: {
          create: [
            {
              quantity: 2,
              blankLengthM: new Prisma.Decimal("0.6000"),
              blankType: "POLKA",
              blankSort: "SORT1",
              blankMaterialId: mat.id,
            },
          ],
        },
      },
    });
    await prismaA.blankStock.create({
      data: {
        materialId: mat.id,
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
      },
    });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: p.id,
              accountedQty: 3,
              actualQty: 3,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(doc.id);
    const productQtyBefore = (
      await prismaA.productStock.findUniqueOrThrow({ where: { productId: p.id } })
    ).quantity;

    await correctTorcovkaRailsTaken({
      operationId: op.id,
      newRailsTaken: 1,
      reason: "фактически взяли меньше",
    });
    const lotAfter = await prismaA.railLot.findUniqueOrThrow({ where: { id: lot.id } });
    expect(lotAfter.remainingQuantity).toBe(6);
    expect(
      (await prismaA.productStock.findUniqueOrThrow({ where: { productId: p.id } })).quantity,
    ).toBe(productQtyBefore);

    await deleteProductionOperation(op.id);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(0);
    const blank = await prismaA.blankStock.findFirst({
      where: { materialId: mat.id, detailType: "POLKA", sort: "SORT1" },
    });
    expect(blank?.quantity ?? 0).toBe(0);
  });

  it("11 ChangeLog before/after/delta exact", async () => {
    const mat = await material("t11");
    const p = await product(mat.id, "t11");
    await prismaA.productStock.create({ data: { productId: p.id, quantity: 100 } });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: p.id,
              accountedQty: 100,
              actualQty: 95,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
      include: { lines: true },
    });
    const lineId = doc.lines[0]!.id;
    await conductInventory(doc.id);

    const log = await prismaA.changeLog.findFirstOrThrow({
      where: { entity: "InventoryLine", entityId: lineId },
    });
    const oldValues = asRecord(log.oldValues);
    const newValues = asRecord(log.newValues);
    expect(oldValues.before).toBe(100);
    expect(newValues.after).toBe(95);
    expect(newValues.delta).toBe(-5);
    expect(newValues.inventoryId).toBe(doc.id);
    expect(newValues.refType).toBe("PRODUCT");
    expect(newValues.refId).toBe(p.id);
  });

  it("12 missing DetailStock child + competing insert/upsert", async () => {
    const mat = await material("t12");
    const emp = await employee("t12");
    const d = await detail(mat.id, "t12", { torcev: true, plosk: false });
    await prismaA.blankStock.create({
      data: {
        materialId: mat.id,
        lengthM: d.lengthM,
        detailType: d.detailType,
        sort: d.sort,
        quantity: 5,
      },
    });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: d.id,
              accountedQty: 0,
              actualQty: 0,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });

    const conductP = withTimeout(conductInventory(doc.id), "conduct-12");
    const writerP = withTimeout(
      prismaB.$transaction(
        async (tx) => {
          const op = await tx.productionOperation.create({
            data: {
              type: "PRISADKA",
              employeeId: emp.id,
              clientRequestId: testReq("t681"),
              workDate: new Date(),
            },
          });
          await applyPrisadkaPick(tx, op.id, d.id, "torcev", 3);
        },
        { timeout: 20_000, maxWait: 20_000 },
      ),
      "writer-12",
    );
    const results = await Promise.allSettled([conductP, writerP]);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(prismaPgCode(r.reason)).not.toBe("40P01");
        expect(errorMessage(r.reason)).not.toMatch(/deadlock/i);
        expect(errorMessage(r.reason)).not.toMatch(/^QueryTimeout:/);
      }
    }

    const inv = await prismaA.inventory.findUniqueOrThrow({ where: { id: doc.id } });
    const ready = await readySum(d.id);
    const writerOk = results[1]?.status === "fulfilled";
    const conductOk = results[0]?.status === "fulfilled";
    if (conductOk && writerOk) {
      expect(inv.status).toBe("CONDUCTED");
      expect(ready).toBe(3);
    } else if (!conductOk && writerOk) {
      expect(errorMessage((results[0] as PromiseRejectedResult).reason)).toBe(STALE_SNAPSHOT);
      expect(inv.status).toBe("DRAFT");
      expect(ready).toBe(3);
    } else if (conductOk && !writerOk) {
      expect(inv.status).toBe("CONDUCTED");
      expect(ready).toBe(0);
    } else {
      throw new Error("both transactions failed");
    }
    expect(!(inv.status === "CONDUCTED" && ready === 0 && writerOk)).toBe(true);
  }, 25_000);

  it("13 conduct || submitUpakovka and conduct || submitPrisadka no deadlock", async () => {
    const allowed = new Set([
      STALE_SNAPSHOT,
      ALREADY_CONDUCTED,
      "Недостаточно готовых деталей для упаковки",
      "Недостаточно заготовок для упаковки",
      "Недостаточно крепежа на складе",
      "Недостаточно упаковки на складе",
      "Недостаточно доп. комплектующих на складе",
      "Недостаточно остатка деталей для присадки",
      "Недостаточно заготовок для присадки",
    ]);

    async function assertSettled(label: string, results: PromiseSettledResult<unknown>[]) {
      for (const r of results) {
        if (r.status === "rejected") {
          const code = prismaPgCode(r.reason);
          expect(code, `${label} pg ${code}`).not.toBe("40P01");
          expect(errorMessage(r.reason)).not.toMatch(/deadlock/i);
          expect(errorMessage(r.reason)).not.toMatch(/^QueryTimeout:/);
          expect(allowed.has(errorMessage(r.reason)), `${label}: ${errorMessage(r.reason)}`).toBe(
            true,
          );
        }
      }
      expect(results).toHaveLength(2);
    }

    const mat = await material("t13u");
    const emp = await employee("t13u");
    const d = await detail(mat.id, "t13u", { torcev: true, plosk: true });
    const p = await product(mat.id, "t13u");
    await prismaA.productDetail.create({ data: { productId: p.id, detailId: d.id, quantity: 1 } });
    await prismaA.detailStock.create({
      data: { detailId: d.id, torcevayaDone: true, ploskostDone: true, quantity: 10 },
    });
    const docU = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: p.id,
              accountedQty: 0,
              actualQty: 0,
              deviation: 0,
              deviationSum: 0,
            },
            {
              refType: "DETAIL",
              refId: d.id,
              accountedQty: 10,
              actualQty: 10,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    const packResults = await Promise.allSettled([
      withTimeout(conductInventory(docU.id), "conduct-upakovka"),
      withTimeout(
        submitUpakovka({
          employeeId: emp.id,
          clientRequestId: testReq("u784"),
          picks: [{ productId: p.id, quantity: 1 }],
        }),
        "submit-upakovka",
      ),
    ]);
    // Serialization: conduct-first SET 0/10 then pack → CONDUCTED P=1 D=9;
    // or pack-first then STALE → DRAFT P=1 D=9. Pack succeeds in this seed.
    await assertSettled("upakovka", packResults);
    const packOk = packResults[1]?.status === "fulfilled";
    const conductUOk = packResults[0]?.status === "fulfilled";
    expect(packOk, "pack should complete in this seed").toBe(true);
    expect(packOk || conductUOk).toBe(true);
    const invU = await prismaA.inventory.findUniqueOrThrow({ where: { id: docU.id } });
    const pQty = (await prismaA.productStock.findUnique({ where: { productId: p.id } }))?.quantity ?? 0;
    const dReady = await readySum(d.id);
    expect(pQty).toBe(1);
    expect(dReady).toBe(9);
    if (conductUOk) {
      expect(invU.status).toBe("CONDUCTED");
      expect(packResults[0]?.status).toBe("fulfilled");
    } else {
      expect(errorMessage((packResults[0] as PromiseRejectedResult).reason)).toBe(STALE_SNAPSHOT);
      expect(invU.status).toBe("DRAFT");
    }

    await resetIntegrityInventory(prismaA);
    const matP = await material("t13p");
    const empP = await employee("t13p");
    const dP = await detail(matP.id, "t13p", { torcev: true, plosk: true });
    await prismaA.blankStock.create({
      data: {
        materialId: matP.id,
        lengthM: dP.lengthM,
        detailType: dP.detailType,
        sort: dP.sort,
        quantity: 8,
      },
    });
    const docP = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: dP.id,
              accountedQty: 0,
              actualQty: 0,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    const prisadkaResults = await Promise.allSettled([
      withTimeout(conductInventory(docP.id), "conduct-prisadka"),
      withTimeout(
        submitPrisadka({
          employeeId: empP.id,
          clientRequestId: testReq("p842"),
          picks: [{ detailId: dP.id, kind: "torcev", quantity: 2 }],
        }),
        "submit-prisadka",
      ),
    ]);
    await assertSettled("prisadka", prisadkaResults);
    const conductPOk = prisadkaResults[0]?.status === "fulfilled";
    const prisadkaOk = prisadkaResults[1]?.status === "fulfilled";
    expect(prisadkaOk, "first T from blanks does not change ready; must complete").toBe(true);
    expect(conductPOk, "ready stays 0; STALE_SNAPSHOT is not a valid serialization here").toBe(
      true,
    );
    const invP = await prismaA.inventory.findUniqueOrThrow({ where: { id: docP.id } });
    expect(invP.status).toBe("CONDUCTED");
    expect(await readySum(dP.id)).toBe(0);
    expect(await wipSum(dP.id)).toBe(2);
    const blankP = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: matP.id, detailType: "POLKA", sort: "SORT1" },
    });
    expect(blankP.quantity).toBe(6);
  }, 25_000);

  it("14 WIP-only PRISADKA reverse + later DETAIL inventory ALLOW", async () => {
    const mat = await material("t14");
    const emp = await employee("t14");
    const d = await detail(mat.id, "t14", { torcev: true, plosk: true });
    await prismaA.blankStock.create({
      data: {
        materialId: mat.id,
        lengthM: d.lengthM,
        detailType: d.detailType,
        sort: d.sort,
        quantity: 4,
      },
    });
    await submitPrisadka({
      employeeId: emp.id,
      clientRequestId: testReq("p879"),
      picks: [{ detailId: d.id, kind: "torcev", quantity: 2 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "PRISADKA" } });
    expect(await wipSum(d.id)).toBe(2);
    expect(await readySum(d.id)).toBe(0);
    await delay(30);

    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: d.id,
              accountedQty: 0,
              actualQty: 0,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(doc.id);

    await deleteProductionOperation(op.id);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(0);
    expect(await wipSum(d.id)).toBe(0);
    const blank = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: mat.id, detailType: "POLKA", sort: "SORT1" },
    });
    expect(blank.quantity).toBe(4);
  });

  it("15 READY PRISADKA reverse + covering inventory BLOCK", async () => {
    const mat = await material("t15");
    const emp = await employee("t15");
    const d = await detail(mat.id, "t15", { torcev: true, plosk: true });
    await prismaA.detailStock.create({
      data: { detailId: d.id, torcevayaDone: true, ploskostDone: false, quantity: 5 },
    });
    await submitPrisadka({
      employeeId: emp.id,
      clientRequestId: testReq("p924"),
      picks: [{ detailId: d.id, kind: "plosk", quantity: 5 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "PRISADKA" } });
    expect(await readySum(d.id)).toBe(5);
    await delay(30);

    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: d.id,
              accountedQty: 5,
              actualQty: 5,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(doc.id);

    await expect(deleteProductionOperation(op.id)).rejects.toThrow(INVENTORY_BOUNDARY);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(1);
    expect(await readySum(d.id)).toBe(5);
    expect(await wipSum(d.id)).toBe(0);
  });

  it("16 updateInventoryLineActual || conductInventory", async () => {
    const mat = await material("t16");
    const p = await product(mat.id, "t16");
    await prismaA.productStock.create({ data: { productId: p.id, quantity: 100 } });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: p.id,
              accountedQty: 100,
              actualQty: 95,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
      include: { lines: true },
    });
    const lineId = doc.lines[0]!.id;

    const results = await Promise.allSettled([
      withTimeout(updateInventoryLineActual(lineId, 90), "update-actual-16"),
      withTimeout(conductInventory(doc.id), "conduct-16"),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(prismaPgCode(r.reason)).not.toBe("40P01");
        expect(errorMessage(r.reason)).not.toMatch(/deadlock/i);
        expect(errorMessage(r.reason)).not.toMatch(/^QueryTimeout:/);
      }
    }

    const inv = await prismaA.inventory.findUniqueOrThrow({
      where: { id: doc.id },
      include: { lines: true },
    });
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: p.id } });
    const line = inv.lines[0]!;
    const updateOk = results[0]?.status === "fulfilled";
    const conductOk = results[1]?.status === "fulfilled";

    if (conductOk) {
      expect(inv.status).toBe("CONDUCTED");
      expect(stock.quantity).toBe(line.actualQty);
      expect(line.deviation).toBe(line.actualQty - line.accountedQty);
      if (!updateOk) {
        expect(errorMessage((results[0] as PromiseRejectedResult).reason)).toBe(ALREADY_CONDUCTED);
        expect(line.actualQty).toBe(95);
        expect(stock.quantity).toBe(95);
        expect(line.deviation).toBe(-5);
      } else {
        expect(line.actualQty).toBe(90);
        expect(stock.quantity).toBe(90);
        expect(line.deviation).toBe(-10);
      }
    } else {
      throw new Error(`conduct failed: ${errorMessage((results[1] as PromiseRejectedResult).reason)}`);
    }
  }, 25_000);

  it("17A changed product composition boundary", async () => {
    const mat = await material("t17a");
    const emp = await employee("t17a");
    const dA = await detail(mat.id, "t17a-a", { torcev: true, plosk: true });
    const dB = await prismaA.detail.create({
      data: {
        name: "det-t17a-b",
        materialId: mat.id,
        detailNumber: 2,
        lengthM: new Prisma.Decimal("0.7000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    const p = await product(mat.id, "t17a");
    await prismaA.productDetail.create({ data: { productId: p.id, detailId: dA.id, quantity: 1 } });
    await prismaA.detailStock.create({
      data: { detailId: dA.id, torcevayaDone: true, ploskostDone: true, quantity: 5 },
    });
    await prismaA.detailStock.create({
      data: { detailId: dB.id, torcevayaDone: true, ploskostDone: true, quantity: 10 },
    });
    await submitUpakovka({
      employeeId: emp.id,
      clientRequestId: testReq("u-pack"),
      picks: [{ productId: p.id, quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "UPAKOVKA" } });
    await prismaA.productDetail.deleteMany({ where: { productId: p.id } });
    await prismaA.productDetail.create({ data: { productId: p.id, detailId: dB.id, quantity: 1 } });
    await delay(30);

    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: dB.id,
              accountedQty: 10,
              actualQty: 10,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(doc.id);

    const pBefore = (await prismaA.productStock.findUnique({ where: { productId: p.id } }))?.quantity ?? 0;
    const aBefore = await readySum(dA.id);
    const bBefore = await readySum(dB.id);
    expect(pBefore).toBe(1);
    expect(aBefore).toBe(4);
    expect(bBefore).toBe(10);

    await expect(updateProductionLineQuantity(op.id, 0, 2)).rejects.toThrow(INVENTORY_BOUNDARY);

    expect(await prismaA.productionOperation.findUniqueOrThrow({ where: { id: op.id } })).toMatchObject({
      productQty: 1,
    });
    expect((await prismaA.productStock.findUnique({ where: { productId: p.id } }))?.quantity ?? 0).toBe(1);
    expect(await readySum(dA.id)).toBe(4);
    expect(await readySum(dB.id)).toBe(10);
    expect(await prismaA.operationDetailLine.count({ where: { operationId: op.id } })).toBeGreaterThan(0);
  });

  it("17B changed BOM edit || conduct", async () => {
    const mat = await material("t17b");
    const emp = await employee("t17b");
    const dA = await detail(mat.id, "t17b-a", { torcev: true, plosk: true });
    const dB = await prismaA.detail.create({
      data: {
        name: "det-t17b-b",
        materialId: mat.id,
        detailNumber: 2,
        lengthM: new Prisma.Decimal("0.7000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    const p = await product(mat.id, "t17b");
    await prismaA.productDetail.create({ data: { productId: p.id, detailId: dA.id, quantity: 1 } });
    await prismaA.detailStock.create({
      data: { detailId: dA.id, torcevayaDone: true, ploskostDone: true, quantity: 5 },
    });
    await prismaA.detailStock.create({
      data: { detailId: dB.id, torcevayaDone: true, ploskostDone: true, quantity: 10 },
    });
    await submitUpakovka({
      employeeId: emp.id,
      clientRequestId: testReq("u-pack"),
      picks: [{ productId: p.id, quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "UPAKOVKA" } });
    await prismaA.productDetail.deleteMany({ where: { productId: p.id } });
    await prismaA.productDetail.create({ data: { productId: p.id, detailId: dB.id, quantity: 1 } });

    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: dB.id,
              accountedQty: 10,
              actualQty: 10,
              deviation: 0,
              deviationSum: 0,
            },
            {
              refType: "PRODUCT",
              refId: p.id,
              accountedQty: 1,
              actualQty: 1,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });

    const results = await Promise.allSettled([
      withTimeout(updateProductionLineQuantity(op.id, 0, 2), "edit-17b"),
      withTimeout(conductInventory(doc.id), "conduct-17b"),
    ]);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(prismaPgCode(r.reason)).not.toBe("40P01");
        expect(errorMessage(r.reason)).not.toMatch(/deadlock/i);
        expect(errorMessage(r.reason)).not.toMatch(/^QueryTimeout:/);
      }
    }
    const editOk = results[0]?.status === "fulfilled";
    const conductOk = results[1]?.status === "fulfilled";
    expect(editOk || conductOk, "at least one TX must complete").toBe(true);

    const inv = await prismaA.inventory.findUniqueOrThrow({ where: { id: doc.id } });
    const pQty = (await prismaA.productStock.findUnique({ where: { productId: p.id } }))?.quantity ?? 0;
    const bReady = await readySum(dB.id);
    const aReady = await readySum(dA.id);
    const opAfter = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: op.id } });

    if (editOk && conductOk) {
      // Conduct SET 1/10 then edit would BOUNDARY — both success means edit first then
      // conduct must have seen matching live. Edit 1→2: P=2, B=8, A=5. Live ≠ draft 1/10
      // so conduct cannot succeed after edit. Forbidden here.
      throw new Error("both edit and conduct succeeded — unexpected for this seed");
    }
    if (editOk && !conductOk) {
      expect(errorMessage((results[1] as PromiseRejectedResult).reason)).toBe(STALE_SNAPSHOT);
      expect(inv.status).toBe("DRAFT");
      expect(opAfter.productQty).toBe(2);
      expect(pQty).toBe(2);
      expect(bReady).toBe(8);
      expect(aReady).toBe(5);
    } else if (!editOk && conductOk) {
      expect(errorMessage((results[0] as PromiseRejectedResult).reason)).toBe(INVENTORY_BOUNDARY);
      expect(inv.status).toBe("CONDUCTED");
      expect(opAfter.productQty).toBe(1);
      expect(pQty).toBe(1);
      expect(bReady).toBe(10);
      expect(aReady).toBe(4);
    }
  }, 25_000);

  it("18 PRISADKA qty edit re-apply onto READY vs DETAIL inventory", async () => {
    const mat = await material("t18");
    const emp = await employee("t18");
    const d = await detail(mat.id, "t18", { torcev: true, plosk: true });
    await prismaA.blankStock.create({
      data: {
        materialId: mat.id,
        lengthM: d.lengthM,
        detailType: d.detailType,
        sort: d.sort,
        quantity: 10,
      },
    });
    await submitPrisadka({
      employeeId: emp.id,
      clientRequestId: testReq("p1204"),
      picks: [{ detailId: d.id, kind: "torcev", quantity: 2 }],
    });
    const tOp = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "PRISADKA" } });
    // Current partial (false,true) must coexist with T-WIP (true,false). Forward
    // applyPrisadkaPick would consume the T bucket and produce READY, so seed
    // the P-WIP row directly (same stock apply would see after a logical reverse).
    await prismaA.detailStock.create({
      data: { detailId: d.id, torcevayaDone: false, ploskostDone: true, quantity: 3 },
    });
    await prismaA.blankStock.updateMany({
      where: { materialId: mat.id, detailType: "POLKA", sort: "SORT1" },
      data: { quantity: { decrement: 3 } },
    });
    expect(await wipSum(d.id)).toBe(5);
    expect(await readySum(d.id)).toBe(0);
    await delay(30);

    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: d.id,
              accountedQty: 0,
              actualQty: 0,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(doc.id);

    const blankBefore = (
      await prismaA.blankStock.findFirstOrThrow({
        where: { materialId: mat.id, detailType: "POLKA", sort: "SORT1" },
      })
    ).quantity;
    const wipBefore = await wipSum(d.id);
    const readyBefore = await readySum(d.id);

    await expect(updateProductionLineQuantity(tOp.id, 0, 3)).rejects.toThrow(INVENTORY_BOUNDARY);

    expect(await prismaA.productionOperation.findUniqueOrThrow({ where: { id: tOp.id } })).toMatchObject({
      id: tOp.id,
    });
    const tLine = await prismaA.operationDetailLine.findFirstOrThrow({
      where: { operationId: tOp.id },
    });
    expect(tLine.quantity).toBe(2);
    expect(await readySum(d.id)).toBe(readyBefore);
    expect(await wipSum(d.id)).toBe(wipBefore);
    expect(
      (
        await prismaA.blankStock.findFirstOrThrow({
          where: { materialId: mat.id, detailType: "POLKA", sort: "SORT1" },
        })
      ).quantity,
    ).toBe(blankBefore);
  });

  it("19 prepared UPAKOVKA BOM snapshot ignores later catalog swap", async () => {
    const mat = await material("t19");
    const emp = await employee("t19");
    const dA = await detail(mat.id, "t19-a", { torcev: true, plosk: true });
    const dB = await prismaA.detail.create({
      data: {
        name: "det-t19-b",
        materialId: mat.id,
        detailNumber: 2,
        lengthM: new Prisma.Decimal("0.7000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    const dC = await prismaA.detail.create({
      data: {
        name: "det-t19-c",
        materialId: mat.id,
        detailNumber: 3,
        lengthM: new Prisma.Decimal("0.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    const p = await product(mat.id, "t19");
    await prismaA.productDetail.create({ data: { productId: p.id, detailId: dA.id, quantity: 1 } });
    await prismaA.detailStock.create({
      data: { detailId: dA.id, torcevayaDone: true, ploskostDone: true, quantity: 5 },
    });
    await prismaA.detailStock.create({
      data: { detailId: dB.id, torcevayaDone: true, ploskostDone: true, quantity: 10 },
    });
    await prismaA.detailStock.create({
      data: { detailId: dC.id, torcevayaDone: true, ploskostDone: true, quantity: 10 },
    });
    await submitUpakovka({
      employeeId: emp.id,
      clientRequestId: testReq("u-pack"),
      picks: [{ productId: p.id, quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "UPAKOVKA" } });
    await prismaA.productDetail.deleteMany({ where: { productId: p.id } });
    await prismaA.productDetail.create({ data: { productId: p.id, detailId: dB.id, quantity: 1 } });
    await delay(30);

    const docC = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: dC.id,
              accountedQty: 10,
              actualQty: 10,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(docC.id);

    const [detailLines, nomenclatureLines] = await Promise.all([
      prismaA.operationDetailLine.findMany({ where: { operationId: op.id } }),
      prismaA.operationNomenclatureLine.findMany({ where: { operationId: op.id } }),
    ]);

    await prismaA.$transaction(async (tx) => {
      const prepared = await prepareUpakovkaEdit(
        tx,
        op.createdAt,
        p.id,
        detailLines,
        nomenclatureLines,
      );
      expect(prepared.details.map((d) => d.detailId)).toEqual([dB.id]);

      await tx.productDetail.deleteMany({ where: { productId: p.id } });
      await tx.productDetail.create({ data: { productId: p.id, detailId: dC.id, quantity: 1 } });

      await reverseUpakovkaOperation(tx, p.id, 1, detailLines, nomenclatureLines, op.createdAt);
      await tx.operationDetailLine.deleteMany({ where: { operationId: op.id } });
      await tx.operationNomenclatureLine.deleteMany({ where: { operationId: op.id } });
      await applyUpakovkaPrepared(tx, op.id, 2, prepared);
      await tx.productionOperation.update({ where: { id: op.id }, data: { productQty: 2 } });
    });

    const linesAfter = await prismaA.operationDetailLine.findMany({ where: { operationId: op.id } });
    expect(linesAfter.map((l) => l.detailId).sort()).toEqual([dB.id]);
    expect(linesAfter.some((l) => l.detailId === dC.id)).toBe(false);
    expect(linesAfter.reduce((s, l) => s + l.quantity, 0)).toBe(2);
    expect(await readySum(dC.id)).toBe(10);
    expect(await readySum(dB.id)).toBe(8);
    expect(await readySum(dA.id)).toBe(5);
    expect((await prismaA.productStock.findUnique({ where: { productId: p.id } }))?.quantity).toBe(2);

    await prismaA.productDetail.deleteMany({ where: { productId: p.id } });
    await prismaA.productDetail.create({ data: { productId: p.id, detailId: dB.id, quantity: 1 } });
    const docB = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: dB.id,
              accountedQty: 8,
              actualQty: 8,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(docB.id);
    const [linesB, nomsB] = await Promise.all([
      prismaA.operationDetailLine.findMany({ where: { operationId: op.id } }),
      prismaA.operationNomenclatureLine.findMany({ where: { operationId: op.id } }),
    ]);
    await expect(
      prismaA.$transaction(async (tx) => {
        await prepareUpakovkaEdit(tx, op.createdAt, p.id, linesB, nomsB);
        await tx.productDetail.deleteMany({ where: { productId: p.id } });
        await tx.productDetail.create({ data: { productId: p.id, detailId: dC.id, quantity: 1 } });
        await reverseUpakovkaOperation(tx, p.id, 2, linesB, nomsB, op.createdAt);
      }),
    ).rejects.toThrow(INVENTORY_BOUNDARY);
    expect(await readySum(dC.id)).toBe(10);
    expect(await readySum(dB.id)).toBe(8);
    expect((await prismaA.productionOperation.findUniqueOrThrow({ where: { id: op.id } })).productQty).toBe(
      2,
    );
  });
});
