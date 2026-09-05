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
import {
  ALREADY_CONDUCTED,
  DRAFT_ALREADY_EXISTS,
  STALE_SNAPSHOT,
  isDraftUniqueViolation,
} from "@/server/internal/inventory-integrity";
import {
  conductInventory,
  createInventoryDraft,
  deleteInventoryDraft,
  updateInventoryLineActual,
} from "@/server/warehouse";
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isRawP2002(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const rec = err as { code?: unknown; message?: unknown };
  if (rec.code === "P2002") return true;
  return String(rec.message ?? "").includes("Unique constraint failed");
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

describe.skipIf(!enabled)("DI-016 inventory draft uniqueness", () => {
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

  async function seedProduct(qty: number, suffix: string) {
    const mat = await prismaA.material.create({
      data: { name: `m-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const p = await prismaA.product.create({
      data: {
        name: `p-${suffix}`,
        materialId: mat.id,
        skuOzon: `OZ-${suffix}`,
        skuWb: `WB-${suffix}`,
        sort: "SORT1",
      },
    });
    await prismaA.productStock.create({ data: { productId: p.id, quantity: qty } });
    return p;
  }

  async function stockFingerprint() {
    const [product, detail, blank, nom, rail, ops] = await Promise.all([
      prismaA.productStock.findMany({ orderBy: { id: "asc" } }),
      prismaA.detailStock.findMany({ orderBy: { id: "asc" } }),
      prismaA.blankStock.findMany({ orderBy: { id: "asc" } }),
      prismaA.nomenclatureStock.findMany({ orderBy: { id: "asc" } }),
      prismaA.railLot.findMany({ orderBy: { id: "asc" } }),
      prismaA.productionOperation.findMany({ orderBy: { id: "asc" } }),
    ]);
    return JSON.stringify({ product, detail, blank, nom, rail, ops });
  }

  async function orphanLineCount(): Promise<number> {
    const rows = await prismaA.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*)::bigint AS n
      FROM "InventoryLine" l
      LEFT JOIN "Inventory" i ON i.id = l."inventoryId"
      WHERE i.id IS NULL
    `;
    return Number(rows[0]?.n ?? 0);
  }

  it("1 sequential second DRAFT rejected with domain message", async () => {
    await seedProduct(10, "t1");
    await createInventoryDraft(false);
    await expect(createInventoryDraft(false)).rejects.toThrow(DRAFT_ALREADY_EXISTS);
    expect(await prismaA.inventory.count({ where: { status: "DRAFT" } })).toBe(1);
  });

  it("2 concurrent create || create → exactly one DRAFT", async () => {
    await seedProduct(10, "t2");
    const results = await Promise.allSettled([createInventoryDraft(false), createInventoryDraft(false)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(errorMessage((rejected[0] as PromiseRejectedResult).reason)).toBe(DRAFT_ALREADY_EXISTS);
    expect(isRawP2002((rejected[0] as PromiseRejectedResult).reason)).toBe(false);
    expect(await prismaA.inventory.count({ where: { status: "DRAFT" } })).toBe(1);
    expect(await orphanLineCount()).toBe(0);
  });

  it("3 P2002 translation is narrow (Inventory/status only)", async () => {
    await seedProduct(10, "t3");
    await createInventoryDraft(false);
    try {
      await prismaA.inventory.create({ data: { date: new Date(), status: "DRAFT" } });
      throw new Error("expected P2002");
    } catch (e) {
      expect(e).toMatchObject({ code: "P2002" });
      const meta = (e as { meta?: { modelName?: unknown; target?: unknown } }).meta;
      expect(meta?.modelName).toBe("Inventory");
      expect(Array.isArray(meta?.target) && meta.target.includes("status")).toBe(true);
      expect(isDraftUniqueViolation(e)).toBe(true);
    }

    const mat = await prismaA.material.create({
      data: { name: "m-sku", sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    await prismaA.product.create({
      data: {
        name: "sku-a",
        materialId: mat.id,
        skuOzon: "OZ-DUP",
        skuWb: "WB-A3",
        sort: "SORT1",
      },
    });
    try {
      await prismaA.product.create({
        data: {
          name: "sku-b",
          materialId: mat.id,
          skuOzon: "OZ-DUP",
          skuWb: "WB-B3",
          sort: "SORT1",
        },
      });
      throw new Error("expected P2002");
    } catch (e) {
      expect(e).toMatchObject({ code: "P2002" });
      expect(isDraftUniqueViolation(e)).toBe(false);
    }
  });

  it("4 multiple CONDUCTED allowed", async () => {
    await seedProduct(5, "t4");
    for (let i = 0; i < 3; i++) {
      const draft = await createInventoryDraft(false);
      await conductInventory(draft.id);
    }
    expect(await prismaA.inventory.count({ where: { status: "CONDUCTED" } })).toBe(3);
    expect(await prismaA.inventory.count({ where: { status: "DRAFT" } })).toBe(0);
    const next = await createInventoryDraft(false);
    expect(next.status).toBe("DRAFT");
  });

  it("5 delete DRAFT removes Inventory and all InventoryLine", async () => {
    await seedProduct(7, "t5");
    const draft = await createInventoryDraft(false);
    expect(draft.lines.length).toBeGreaterThan(0);
    const n = draft.lines.length;
    await deleteInventoryDraft(draft.id);
    expect(await prismaA.inventory.count()).toBe(0);
    expect(await prismaA.inventoryLine.count()).toBe(0);
    const logs = await prismaA.changeLog.findMany({
      where: { entity: "Inventory", entityId: draft.id },
      orderBy: { changedAt: "asc" },
    });
    const deletion = logs.find((l) => l.newValues == null);
    expect(deletion).toBeTruthy();
    const old = asRecord(deletion?.oldValues);
    expect(old.status).toBe("DRAFT");
    expect(old.lines).toBe(n);
    expect(old.action).toBe("delete");
  });

  it("6 delete DRAFT changes no stock tables", async () => {
    await seedProduct(4, "t6");
    const draft = await createInventoryDraft(false);
    const before = await stockFingerprint();
    await deleteInventoryDraft(draft.id);
    expect(await stockFingerprint()).toBe(before);
    expect(
      await prismaA.changeLog.count({ where: { entity: "InventoryLine" } }),
    ).toBe(0);
  });

  it("7 delete CONDUCTED rejected, zero writes", async () => {
    const p = await seedProduct(8, "t7");
    const draft = await createInventoryDraft(false);
    await conductInventory(draft.id);
    const beforeStock = await stockFingerprint();
    const beforeInv = await prismaA.inventory.findUniqueOrThrow({
      where: { id: draft.id },
      include: { lines: true },
    });
    const logCount = await prismaA.changeLog.count();
    await expect(deleteInventoryDraft(draft.id)).rejects.toThrow(ALREADY_CONDUCTED);
    const after = await prismaA.inventory.findUniqueOrThrow({
      where: { id: draft.id },
      include: { lines: true },
    });
    expect(after.status).toBe("CONDUCTED");
    expect(after.lines.length).toBe(beforeInv.lines.length);
    expect(await stockFingerprint()).toBe(beforeStock);
    expect(await prismaA.changeLog.count()).toBe(logCount);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: p.id } })).quantity).toBe(8);
  });

  it("8 delete || conduct — one valid serialization, no partial stock write", async () => {
    const p = await seedProduct(100, "t8");
    const draft = await createInventoryDraft(false);
    await updateInventoryLineActual(draft.lines[0].id, 95);
    const before = await prismaA.productStock.findUniqueOrThrow({ where: { productId: p.id } });
    expect(before.quantity).toBe(100);

    const results = await Promise.allSettled([
      withTimeout(conductInventory(draft.id), "conduct-8"),
      withTimeout(deleteInventoryDraft(draft.id), "delete-8"),
    ]);
    const conduct = results[0];
    const del = results[1];
    expect(results.every((r) => errorMessage(r.status === "rejected" ? r.reason : "") !== `QueryTimeout: conduct-8 exceeded ${CONCURRENCY_TIMEOUT_MS}ms`)).toBe(true);

    const remaining = await prismaA.inventory.findUnique({ where: { id: draft.id } });
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: p.id } });

    if (conduct.status === "fulfilled") {
      expect(errorMessage((del as PromiseRejectedResult).reason)).toBe(ALREADY_CONDUCTED);
      expect(remaining?.status).toBe("CONDUCTED");
      expect(stock.quantity).toBe(95);
    } else {
      expect(errorMessage(conduct.reason)).toBe("Инвентаризация не найдена");
      expect(del.status).toBe("fulfilled");
      expect(remaining).toBeNull();
      expect(stock.quantity).toBe(100);
    }
    expect(await orphanLineCount()).toBe(0);
  });

  it("9 delete || updateActual — no orphan InventoryLine", async () => {
    await seedProduct(50, "t9");
    const draft = await createInventoryDraft(false);
    const lineId = draft.lines[0].id;

    const results = await Promise.allSettled([
      withTimeout(updateInventoryLineActual(lineId, 40), "update-9"),
      withTimeout(deleteInventoryDraft(draft.id), "delete-9"),
    ]);
    const upd = results[0];
    const del = results[1];
    for (const r of results) {
      if (r.status === "rejected") {
        expect(errorMessage(r.reason)).not.toMatch(/QueryTimeout/);
      }
    }
    expect(del.status).toBe("fulfilled");
    expect(await prismaA.inventory.findUnique({ where: { id: draft.id } })).toBeNull();
    expect(await prismaA.inventoryLine.count({ where: { inventoryId: draft.id } })).toBe(0);
    expect(await orphanLineCount()).toBe(0);
    if (upd.status === "rejected") {
      const msg = errorMessage(upd.reason);
      expect(["Строка не найдена", "Инвентаризация не найдена"]).toContain(msg);
    }
  });

  it("10 delete || create — DRAFT <= 1, no raw P2002, create need not succeed", async () => {
    await seedProduct(12, "t10");
    const old = await createInventoryDraft(false);

    const results = await Promise.allSettled([
      withTimeout(deleteInventoryDraft(old.id), "delete-10"),
      withTimeout(createInventoryDraft(false), "create-10"),
    ]);
    const del = results[0];
    const created = results[1];

    expect(del.status).not.toBe("rejected");
    expect(await prismaA.inventory.count({ where: { status: "DRAFT" } })).toBeLessThanOrEqual(1);
    expect(await orphanLineCount()).toBe(0);

    if (created.status === "rejected") {
      expect(errorMessage(created.reason)).toBe(DRAFT_ALREADY_EXISTS);
      expect(isRawP2002(created.reason)).toBe(false);
    } else {
      expect(created.value.id).not.toBe(old.id);
      expect(created.value.status).toBe("DRAFT");
    }
  });

  it("11 stale DRAFT recovery: delete then fresh accountedQty", async () => {
    const p = await seedProduct(100, "t11");
    const stale = await createInventoryDraft(false);
    expect(stale.lines[0].accountedQty).toBe(100);
    await prismaA.productStock.update({ where: { productId: p.id }, data: { quantity: 80 } });
    await expect(conductInventory(stale.id)).rejects.toThrow(STALE_SNAPSHOT);
    await deleteInventoryDraft(stale.id);
    const fresh = await createInventoryDraft(false);
    expect(fresh.lines[0].accountedQty).toBe(80);
    const conducted = await conductInventory(fresh.id);
    expect(conducted.status).toBe("CONDUCTED");
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: p.id } })).quantity).toBe(80);
  });

  it("12 no rebase: stale accountedQty stays after rejected conduct", async () => {
    const p = await seedProduct(100, "t12");
    const stale = await createInventoryDraft(false);
    await prismaA.productStock.update({ where: { productId: p.id }, data: { quantity: 70 } });
    await expect(conductInventory(stale.id)).rejects.toThrow(STALE_SNAPSHOT);
    await updateInventoryLineActual(stale.lines[0].id, 70);
    const stored = await prismaA.inventoryLine.findUniqueOrThrow({ where: { id: stale.lines[0].id } });
    expect(stored.accountedQty).toBe(100);
    expect(stored.actualQty).toBe(70);
    await expect(conductInventory(stale.id)).rejects.toThrow(STALE_SNAPSHOT);
    expect((await prismaA.inventory.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("DRAFT");
  });
});
