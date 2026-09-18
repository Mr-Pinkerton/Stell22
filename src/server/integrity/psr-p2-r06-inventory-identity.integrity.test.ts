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
  requireTerminalEmployee: async () => {},
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { D } from "@/lib/cost";
import { isReady } from "@/lib/detail-stock";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import {
  ALREADY_CONDUCTED,
  LEGACY_INVENTORY_DRAFT_RECREATE,
  STALE_SNAPSHOT,
} from "@/server/internal/inventory-integrity";
import {
  conductInventory,
  createInventoryDraft,
  deleteInventoryDraft,
  getInventoryDocs,
  updateInventoryLineActual,
} from "@/server/warehouse";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

describe.skipIf(!enabled)("PSR-P2 R-06 inventory physical identity", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA } = createIntegrityClients());
  });

  beforeEach(async () => {
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

  async function seedSharedBlank(qty: number, withWac = false) {
    const material = await prismaA.material.create({
      data: { name: "Материал M", sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const a = await prismaA.detail.create({
      data: {
        name: "Detail A",
        materialId: material.id,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("1.2000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    const b = await prismaA.detail.create({
      data: {
        name: "Detail B",
        materialId: material.id,
        detailNumber: 2,
        lengthM: new Prisma.Decimal("1.2000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    const blank = await prismaA.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: new Prisma.Decimal("1.2000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: qty,
        ...(withWac
          ? {
              materialValue: new Prisma.Decimal("1000"),
              laborValue: new Prisma.Decimal("100"),
              totalValue: new Prisma.Decimal("1100"),
              costVersion: 1,
            }
          : {}),
      },
    });
    return { material, a, b, blank };
  }

  async function seedTorcvReadyBuckets(args: { monetary: boolean }) {
    const material = await prismaA.material.create({
      data: { name: "M-ready", sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const detail = await prismaA.detail.create({
      data: {
        name: "Shelf-ready",
        materialId: material.id,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    const money = (materialValue: string, laborValue: string) =>
      args.monetary
        ? {
            materialValue: new Prisma.Decimal(materialValue),
            laborValue: new Prisma.Decimal(laborValue),
            totalValue: new Prisma.Decimal(D(materialValue).plus(laborValue).toFixed()),
            costVersion: 1,
          }
        : {};
    await prismaA.detailStock.createMany({
      data: [
        {
          detailId: detail.id,
          torcevayaDone: true,
          ploskostDone: false,
          quantity: 4,
          ...money("400", "40"),
        },
        {
          detailId: detail.id,
          torcevayaDone: true,
          ploskostDone: true,
          quantity: 3,
          ...money("300", "30"),
        },
        {
          detailId: detail.id,
          torcevayaDone: false,
          ploskostDone: false,
          quantity: 2,
          ...money("50", "10"),
        },
      ],
    });
    return { material, detail };
  }

  function bucketQty(
    rows: Array<{ torcevayaDone: boolean; ploskostDone: boolean; quantity: number }>,
    t: boolean,
    p: boolean,
  ): number {
    return rows.find((r) => r.torcevayaDone === t && r.ploskostDone === p)?.quantity ?? 0;
  }

  function readyMoneyTotals(
    detail: { prisadkaTorcevaya: boolean; prisadkaPloskost: boolean },
    rows: Array<{
      torcevayaDone: boolean;
      ploskostDone: boolean;
      quantity: number;
      materialValue: Prisma.Decimal | null;
      laborValue: Prisma.Decimal | null;
      totalValue: Prisma.Decimal | null;
    }>,
  ) {
    const ready = rows.filter((r) => isReady(detail, r.torcevayaDone, r.ploskostDone));
    return {
      qty: ready.reduce((s, r) => s + r.quantity, 0),
      material: ready.reduce((s, r) => s.plus(D(r.materialValue?.toString() ?? 0)), D(0)),
      labor: ready.reduce((s, r) => s.plus(D(r.laborValue?.toString() ?? 0)), D(0)),
      total: ready.reduce((s, r) => s.plus(D(r.totalValue?.toString() ?? 0)), D(0)),
    };
  }

  it("shared A/B draft is one BLANK line; inactive conduct 10→7 applies once", async () => {
    const { blank, a, b } = await seedSharedBlank(10);
    const draft = await createInventoryDraft(false);
    const blankLines = draft.lines.filter((l) => l.refType === "BLANK");
    const aliasDetail = draft.lines.filter(
      (l) => l.refType === "DETAIL" && (l.refId === a.id || l.refId === b.id),
    );
    expect(blankLines).toHaveLength(1);
    expect(aliasDetail).toHaveLength(0);
    expect(blankLines[0]?.refId).toBe(blank.id);
    expect(blankLines[0]?.accountedQty).toBe(10);
    expect(blankLines[0]?.actualQty).toBe(10);
    expect(blankLines[0]?.name).toContain("Материал M");
    expect(blankLines[0]?.name).toContain("полка");
    expect(blankLines[0]?.name).toContain("1 сорт");

    await updateInventoryLineActual(blankLines[0]!.id, 7);
    const conducted = await conductInventory(draft.id);
    const line = conducted.lines.find((l) => l.refType === "BLANK");
    expect(line?.deviation).toBe(-3);
    const after = await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } });
    expect(after.quantity).toBe(7);

    const logs = await prismaA.changeLog.findMany({
      where: { entity: "InventoryLine", entityId: blankLines[0]!.id },
    });
    const conductLog = logs.find((row) => {
      const rec = row.newValues as Record<string, unknown> | null;
      return rec?.blankStockId === blank.id;
    });
    expect(conductLog).toBeTruthy();
    const rec = conductLog!.newValues as Record<string, unknown>;
    expect(rec.delta).toBe(-3);
    expect(rec.after).toBe(7);
    expect(rec.materialId).toBe(blank.materialId);
  });

  it("includeAllActive creates one zero BlankStock row and one BLANK line for shared spec", async () => {
    const material = await prismaA.material.create({
      data: { name: "M-zero", sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    await prismaA.detail.create({
      data: {
        name: "A0",
        materialId: material.id,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("1.2000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    await prismaA.detail.create({
      data: {
        name: "B0",
        materialId: material.id,
        detailNumber: 2,
        lengthM: new Prisma.Decimal("1.2000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    expect(await prismaA.blankStock.count()).toBe(0);
    const draft = await createInventoryDraft(true);
    const blanks = await prismaA.blankStock.findMany({
      where: {
        materialId: material.id,
        lengthM: new Prisma.Decimal("1.2000"),
        detailType: "POLKA",
        sort: "SORT1",
      },
    });
    expect(blanks).toHaveLength(1);
    expect(blanks[0]?.quantity).toBe(0);
    const blankLines = draft.lines.filter((l) => l.refType === "BLANK");
    expect(blankLines).toHaveLength(1);
    expect(blankLines[0]?.refId).toBe(blanks[0]!.id);
    expect(blankLines[0]?.accountedQty).toBe(0);
    expect(blankLines[0]?.actualQty).toBe(0);
    expect(draft.lines.filter((l) => l.refType === "DETAIL")).toHaveLength(0);
  });

  it("active cost-flow shared BLANK 10→7 consumes the pool once", async () => {
    await setCostFlowActive(true);
    const { blank, a, b } = await seedSharedBlank(10, true);
    const draft = await createInventoryDraft(false);
    const blankLine = draft.lines.find((l) => l.refType === "BLANK");
    expect(blankLine).toBeTruthy();
    expect(draft.lines.some((l) => l.refId === a.id || l.refId === b.id)).toBe(false);
    await updateInventoryLineActual(blankLine!.id, 7);
    await conductInventory(draft.id);
    const after = await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } });
    expect(after.quantity).toBe(7);
    const events = await prismaA.costEvent.findMany({ where: { inventoryId: draft.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("INVENTORY_LOSS");
    expect(events[0]?.stockId).toBe(blank.id);
  });

  it("DETAIL ready buckets: canon=actual, other ready=0, WIP unchanged", async () => {
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
    await updateInventoryLineActual(line!.id, 5);
    await conductInventory(draft.id);
    const rows = await prismaA.detailStock.findMany({ where: { detailId: detail.id } });
    const qty = (t: boolean, p: boolean) =>
      rows.find((r) => r.torcevayaDone === t && r.ploskostDone === p)?.quantity ?? 0;
    expect(qty(true, false)).toBe(5);
    expect(qty(true, true)).toBe(0);
    expect(qty(false, false)).toBe(2);
  });

  it("active DETAIL zero-deviation canonicalizes READY buckets without CostEvents", async () => {
    await setCostFlowActive(true);
    const { detail } = await seedTorcvReadyBuckets({ monetary: true });
    const before = await prismaA.detailStock.findMany({ where: { detailId: detail.id } });
    const beforeReady = readyMoneyTotals(detail, before);
    expect(beforeReady.qty).toBe(7);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "DETAIL" && l.refId === detail.id);
    expect(line?.accountedQty).toBe(7);
    expect(line?.actualQty).toBe(7);
    const conducted = await conductInventory(draft.id);
    expect(conducted.status).toBe("CONDUCTED");
    const rows = await prismaA.detailStock.findMany({ where: { detailId: detail.id } });
    expect(bucketQty(rows, true, false)).toBe(7);
    expect(bucketQty(rows, true, true)).toBe(0);
    expect(bucketQty(rows, false, false)).toBe(2);
    const afterReady = readyMoneyTotals(detail, rows);
    expect(afterReady.material.equals(beforeReady.material)).toBe(true);
    expect(afterReady.labor.equals(beforeReady.labor)).toBe(true);
    expect(afterReady.total.equals(beforeReady.total)).toBe(true);
    const wip = rows.find((r) => r.torcevayaDone === false && r.ploskostDone === false);
    expect(wip?.quantity).toBe(2);
    expect(D(wip?.materialValue?.toString() ?? 0).equals(D(50))).toBe(true);
    expect(D(wip?.laborValue?.toString() ?? 0).equals(D(10))).toBe(true);
    expect(await prismaA.costEvent.count({ where: { inventoryId: draft.id } })).toBe(0);
  });

  it("active DETAIL 7→5 matches effect-plan physical state with one INVENTORY_LOSS", async () => {
    await setCostFlowActive(true);
    const { detail } = await seedTorcvReadyBuckets({ monetary: true });
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "DETAIL" && l.refId === detail.id);
    expect(line?.accountedQty).toBe(7);
    await updateInventoryLineActual(line!.id, 5);
    await conductInventory(draft.id);
    const rows = await prismaA.detailStock.findMany({ where: { detailId: detail.id } });
    expect(bucketQty(rows, true, false)).toBe(5);
    expect(bucketQty(rows, true, true)).toBe(0);
    expect(bucketQty(rows, false, false)).toBe(2);
    const events = await prismaA.costEvent.findMany({ where: { inventoryId: draft.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("INVENTORY_LOSS");
    expect(events[0]?.inventoryLineId).toBe(line!.id);
  });

  it("inactive and active DETAIL multi-ready physical outcomes match for 0 and -2 deviation", async () => {
    async function conductPhysical(active: boolean, actualQty: number) {
      await resetIntegrityInventory(prismaA);
      if (active) await setCostFlowActive(true);
      const { detail } = await seedTorcvReadyBuckets({ monetary: active });
      const draft = await createInventoryDraft(false);
      const line = draft.lines.find((l) => l.refType === "DETAIL" && l.refId === detail.id);
      expect(line?.accountedQty).toBe(7);
      if (actualQty !== 7) await updateInventoryLineActual(line!.id, actualQty);
      await conductInventory(draft.id);
      const rows = await prismaA.detailStock.findMany({ where: { detailId: detail.id } });
      return {
        canon: bucketQty(rows, true, false),
        otherReady: bucketQty(rows, true, true),
        wip: bucketQty(rows, false, false),
      };
    }

    const inactiveZero = await conductPhysical(false, 7);
    const activeZero = await conductPhysical(true, 7);
    expect(activeZero).toEqual(inactiveZero);
    expect(inactiveZero).toEqual({ canon: 7, otherReady: 0, wip: 2 });

    const inactiveLoss = await conductPhysical(false, 5);
    const activeLoss = await conductPhysical(true, 5);
    expect(activeLoss).toEqual(inactiveLoss);
    expect(inactiveLoss).toEqual({ canon: 5, otherReady: 0, wip: 2 });
  });

  it("stale BLANK snapshot does not mutate or conduct", async () => {
    const { blank } = await seedSharedBlank(10);
    const draft = await createInventoryDraft(false);
    expect(draft.lines.find((l) => l.refType === "BLANK")).toBeTruthy();
    await prismaA.blankStock.update({ where: { id: blank.id }, data: { quantity: 8 } });
    await expect(conductInventory(draft.id)).rejects.toThrow(STALE_SNAPSHOT);
    const inv = await prismaA.inventory.findUniqueOrThrow({ where: { id: draft.id } });
    expect(inv.status).toBe("DRAFT");
    const after = await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } });
    expect(after.quantity).toBe(8);
    const logs = await prismaA.changeLog.findMany({
      where: { entity: "Inventory", entityId: draft.id },
    });
    expect(logs.some((row) => JSON.stringify(row.newValues).includes("CONDUCTED"))).toBe(false);
  });

  it("legacy no-prisadka DETAIL DRAFT fails closed and stays DRAFT", async () => {
    const { blank, a } = await seedSharedBlank(10);
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: a.id,
              accountedQty: 10,
              actualQty: 7,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await expect(conductInventory(doc.id)).rejects.toThrow(LEGACY_INVENTORY_DRAFT_RECREATE);
    const inv = await prismaA.inventory.findUniqueOrThrow({ where: { id: doc.id } });
    expect(inv.status).toBe("DRAFT");
    const after = await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } });
    expect(after.quantity).toBe(10);
    await deleteInventoryDraft(doc.id);
    expect(await prismaA.inventory.findUnique({ where: { id: doc.id } })).toBeNull();
    const next = await createInventoryDraft(false);
    expect(next.lines.filter((l) => l.refType === "BLANK")).toHaveLength(1);
  });

  it("legacy CONDUCTED no-prisadka DETAIL document remains readable", async () => {
    const { a } = await seedSharedBlank(10);
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "CONDUCTED",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: a.id,
              accountedQty: 10,
              actualQty: 7,
              deviation: -3,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    const docs = await getInventoryDocs();
    const found = docs.find((d) => d.id === doc.id);
    expect(found).toBeTruthy();
    expect(found?.status).toBe("CONDUCTED");
    expect(found?.lines[0]?.refType).toBe("DETAIL");
    expect(found?.lines[0]?.refId).toBe(a.id);
    expect(found?.lines[0]?.name).toBe("Detail A");
  });

  it("duplicate (inventoryId, refType, refId) is rejected", async () => {
    await expect(
      prismaA.inventory.create({
        data: {
          date: new Date(),
          status: "CONDUCTED",
          lines: {
            create: [
              {
                refType: "PRODUCT",
                refId: "same",
                accountedQty: 0,
                actualQty: 0,
                deviation: 0,
                deviationSum: 0,
              },
              {
                refType: "PRODUCT",
                refId: "same",
                accountedQty: 1,
                actualQty: 1,
                deviation: 0,
                deviationSum: 0,
              },
            ],
          },
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("second conduct after commit is ALREADY_CONDUCTED", async () => {
    const { blank } = await seedSharedBlank(10);
    const draft = await createInventoryDraft(false);
    const line = draft.lines.find((l) => l.refType === "BLANK");
    await updateInventoryLineActual(line!.id, 13);
    await conductInventory(draft.id);
    await expect(conductInventory(draft.id)).rejects.toThrow(ALREADY_CONDUCTED);
    const after = await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } });
    expect(after.quantity).toBe(13);
  });
});
