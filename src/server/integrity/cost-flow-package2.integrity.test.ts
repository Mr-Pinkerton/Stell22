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
import { D } from "@/lib/cost";
import { allocatePersistenceShares, consumeRailValue, q6 } from "@/lib/cost-foundation";
import { assignCanonicalTorcovkaLineIds } from "@/lib/torcovka-cost";
import {
  COST_FLOW_DRIVER_AFTER_CONSUMPTION,
  COST_FLOW_POOL_UNINITIALIZED,
  COST_FLOW_VERSION_MISMATCH,
} from "@/server/internal/cost-flow-raw";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import { INVENTORY_BOUNDARY } from "@/server/internal/inventory-integrity";
import { TORCOVKA_GENERIC_DELETE_BLOCKED } from "@/lib/torcovka-delete-policy";
import {
  correctTorcovkaRailsTaken,
  deleteProductionOperation,
  updateProductionLineQuantity,
} from "@/server/production";
import { createBatch, updateBatch, writeOffBatchRemainder } from "@/server/purchases";
import { submitTorcovka } from "@/server/terminal";
import { createCashFlow } from "@/server/finance";
import { conductInventory } from "@/server/warehouse";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const CONCURRENCY_TIMEOUT_MS = 20_000;

function d(value: Prisma.Decimal | string | number | null | undefined) {
  if (value == null) return null;
  return D(typeof value === "object" ? value.toString() : value);
}

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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(!enabled)("Package 2 raw wood / TORCOVKA cost flow", () => {
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

  async function setCostFlowActive(active: boolean) {
    await prismaA.setting.upsert({
      where: { key: PRODUCTION_COST_FLOW_KEY },
      create: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active } },
      update: { value: { version: 1, active } },
    });
  }

  async function seedWorld(opts?: {
    remaining?: number;
    lotLengthM?: string;
    remainingValue?: string;
    rate1?: number;
    rate2?: number;
  }) {
    const remaining = opts?.remaining ?? 10;
    const suffix = `p2-${seq}-${Date.now()}`;
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        rateTorcovkaSort1: opts?.rate1 ?? 12,
        rateTorcovkaSort2: opts?.rate2 ?? 8,
      },
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
    const remainingValue = opts?.remainingValue ?? "10000";
    const lot = await prismaA.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: new Prisma.Decimal(opts?.lotLengthM ?? "2"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: remaining,
        remainingQuantity: remaining,
        initialValue: new Prisma.Decimal(remainingValue),
        remainingValue: new Prisma.Decimal(remainingValue),
      },
    });
    return { material, emp, batch, lot, suffix };
  }

  function torcInput(
    world: Awaited<ReturnType<typeof seedWorld>>,
    railsTaken: number,
    picks: { lengthM: number; sort: "SORT1" | "SORT2"; quantity: number }[],
    requestId: string,
  ) {
    return {
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken,
      picks,
      clientRequestId: requestId,
    };
  }

  /** 2m rail, 1.8m output → 10% waste, NORMAL band (no approval). */
  function normalPicks(
    railsTaken: number,
    extra: { lengthM: number; sort: "SORT1" | "SORT2"; quantity: number }[] = [
      { lengthM: 1.8, sort: "SORT1", quantity: railsTaken },
    ],
  ) {
    return extra;
  }

  async function createdTorcovka(
    world: Awaited<ReturnType<typeof seedWorld>>,
    railsTaken: number,
    picks: { lengthM: number; sort: "SORT1" | "SORT2"; quantity: number }[],
    requestId: string,
  ) {
    const input = torcInput(world, railsTaken, picks, requestId);
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
    return result;
  }

  async function blankOf(
    materialId: string,
    lengthM: number,
    sort: "SORT1" | "SORT2" = "SORT1",
  ) {
    return prismaA.blankStock.findUnique({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId,
          lengthM,
          detailType: "POLKA",
          sort,
        },
      },
    });
  }

  it("1 inactive TORCOVKA: quantity moves, money stays NULL / version 0", async () => {
    const world = await seedWorld();
    await prismaA.railLot.update({
      where: { id: world.lot.id },
      data: { initialValue: null, remainingValue: null },
    });
    const result = await createdTorcovka(
      world,
      1,
      normalPicks(1),
      `inactive-${world.suffix}`,
    );
    expect(result.status).toBe("CREATED");
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: true },
    });
    const blank = await blankOf(world.material.id, 1.8);
    expect(lot.remainingQuantity).toBe(9);
    expect(lot.remainingValue).toBeNull();
    expect(lot.initialValue).toBeNull();
    expect(op.consumedRawValue).toBeNull();
    expect(op.pieceLaborCost).toBeNull();
    expect(op.lines[0]?.receiptMaterialValue).toBeNull();
    expect(op.lines[0]?.receiptLaborValue).toBeNull();
    expect(op.lines[0]?.pieceLaborCost).toBeNull();
    expect(op.lines[0]?.outputCostVersion).toBeNull();
    expect(blank?.quantity).toBe(1);
    expect(blank?.costVersion).toBe(0);
    expect(blank?.materialValue).toBeNull();
    expect(blank?.laborValue).toBeNull();
    expect(blank?.totalValue).toBeNull();
    expect(await prismaA.costEvent.count()).toBe(0);
  });

  it("2 active simple TORCOVKA: raw, material, piece labor, snapshots", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    const lotBefore = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    await createdTorcovka(world, 1, normalPicks(1), `simple-${world.suffix}`);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: true },
    });
    const blank = await blankOf(world.material.id, 1.8);
    const consumed = d(op.consumedRawValue)!;
    const labor = d(op.pieceLaborCost)!;
    expect(lot.remainingQuantity).toBe(9);
    expect(d(lotBefore.remainingValue)!.equals(d(lot.remainingValue)!.plus(consumed))).toBe(true);
    expect(consumed.equals(d(blank?.materialValue)!)).toBe(true);
    expect(labor.equals(D(12))).toBe(true);
    expect(labor.equals(d(blank?.laborValue)!)).toBe(true);
    expect(d(blank?.totalValue)!.equals(d(blank?.materialValue)!.plus(d(blank?.laborValue)!))).toBe(true);
    expect(blank?.costVersion).toBe(2);
    expect(d(op.lines[0]?.receiptMaterialValue)!.equals(consumed)).toBe(true);
    expect(d(op.lines[0]?.pieceLaborCost)!.equals(labor)).toBe(true);
    expect(op.lines[0]?.outputCostVersion).toBe(2);
    expect(op.rateTorcovkaSort1Snapshot).not.toBeNull();
  });

  it("3 kerf: full consumedRawValue reaches produced blanks", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(world, 1, [{ lengthM: 1.8, sort: "SORT1", quantity: 1 }], `kerf-${world.suffix}`);
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: true },
    });
    const blank = await blankOf(world.material.id, 1.8);
    const lineMat = op.lines.reduce((s, l) => s.plus(d(l.receiptMaterialValue)!), D(0));
    expect(lineMat.equals(d(op.consumedRawValue)!)).toBe(true);
    expect(d(blank?.materialValue)!.equals(d(op.consumedRawValue)!)).toBe(true);
  });

  it("4 mixed SORT1/SORT2 piece labor matches DI-015 snapshots", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(
      world,
      1,
      [
        { lengthM: 0.9, sort: "SORT1", quantity: 1 },
        { lengthM: 0.9, sort: "SORT2", quantity: 1 },
      ],
      `mix-${world.suffix}`,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    expect(d(op.pieceLaborCost)!.equals(D(12 + 8))).toBe(true);
    const s1 = op.lines.find((l) => l.blankSort === "SORT1");
    const s2 = op.lines.find((l) => l.blankSort === "SORT2");
    expect(d(s1?.pieceLaborCost)!.equals(D(12))).toBe(true);
    expect(d(s2?.pieceLaborCost)!.equals(D(8))).toBe(true);
  });

  it("5 same BlankStock target: one pool version increment, lines reconcile", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(
      world,
      1,
      [
        { lengthM: 0.9, sort: "SORT1", quantity: 1 },
        { lengthM: 0.9, sort: "SORT1", quantity: 1 },
      ],
      `same-${world.suffix}`,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: true },
    });
    const blank = await blankOf(world.material.id, 0.9);
    expect(blank?.quantity).toBe(2);
    expect(blank?.costVersion).toBe(2);
    expect(op.lines.every((l) => l.outputCostVersion === 2)).toBe(true);
    const lineMat = op.lines.reduce((s, l) => s.plus(d(l.receiptMaterialValue)!), D(0));
    const lineLab = op.lines.reduce((s, l) => s.plus(d(l.receiptLaborValue)!), D(0));
    expect(lineMat.equals(d(blank?.materialValue)!)).toBe(true);
    expect(lineLab.equals(d(blank?.laborValue)!)).toBe(true);
    expect(d(blank?.totalValue)!.equals(d(blank?.materialValue)!.plus(d(blank?.laborValue)!))).toBe(true);
  });

  it("6 idempotent replay does not move money twice", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    const input = torcInput(world, 1, normalPicks(1), `idemp-${world.suffix}`);
    expect((await submitTorcovka(input)).status).toBe("CREATED");
    const afterFirst = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect((await submitTorcovka(input)).status).toBe("CREATED");
    const afterSecond = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(afterSecond.remainingQuantity).toBe(afterFirst.remainingQuantity);
    expect(d(afterSecond.remainingValue)!.equals(d(afterFirst.remainingValue)!)).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { railLotId: world.lot.id } })).toBe(1);
  });

  it("7 last-rail consume writes exact remainingValue residual to 0", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld({ remaining: 1, remainingValue: "1.000001" });
    await createdTorcovka(world, 1, normalPicks(1), `last-${world.suffix}`);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { railLotId: world.lot.id } });
    expect(lot.remainingQuantity).toBe(0);
    expect(d(lot.remainingValue)!.equals(D(0))).toBe(true);
    expect(d(op.consumedRawValue)!.equals(D("1.000001"))).toBe(true);
  });

  it("8 concurrent same RailLot: no overdraw / no double value / COMP-001", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld({ remaining: 3, remainingValue: "3" });
    const p1 = submitTorcovka(
      torcInput(world, 2, normalPicks(2), `c1-${world.suffix}`),
    );
    const p2 = submitTorcovka(
      torcInput(world, 2, normalPicks(2), `c2-${world.suffix}`),
    );
    const results = await Promise.race([
      Promise.allSettled([p1, p2]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`QueryTimeout: concurrent TORCOVKA ${CONCURRENCY_TIMEOUT_MS}ms`)), CONCURRENCY_TIMEOUT_MS),
      ),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toBe(1);
    expect(failed).toHaveLength(1);
    expect(errorMessage((failed[0] as PromiseRejectedResult).reason)).toMatch(/Недостаточно реек/);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lot.remainingQuantity).toBe(1);
    expect(d(lot.remainingValue)!.gte(0)).toBe(true);
    const ops = await prismaA.productionOperation.findMany({ where: { railLotId: world.lot.id } });
    expect(ops).toHaveLength(1);
    const consumed = ops.reduce((s, o) => s.plus(d(o.consumedRawValue)!), D(0));
    expect(d(lot.remainingValue)!.plus(consumed).equals(D(3))).toBe(true);
    const blank = await blankOf(world.material.id, 1.8);
    expect(d(blank?.totalValue)!.equals(d(blank?.materialValue)!.plus(d(blank?.laborValue)!))).toBe(true);
  });

  it("9 active pool version0 fail closed; physical quantities unchanged", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: 1.8,
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 4,
      },
    });
    const lotBefore = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    await expect(
      submitTorcovka(torcInput(world, 1, normalPicks(1), `v0-${world.suffix}`)),
    ).rejects.toThrow(COST_FLOW_POOL_UNINITIALIZED);
    const lotAfter = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const blank = await blankOf(world.material.id, 1.8);
    expect(lotAfter.remainingQuantity).toBe(lotBefore.remainingQuantity);
    expect(d(lotAfter.remainingValue)!.equals(d(lotBefore.remainingValue)!)).toBe(true);
    expect(blank?.quantity).toBe(4);
    expect(blank?.costVersion).toBe(0);
    expect(await prismaA.productionOperation.count({ where: { railLotId: world.lot.id } })).toBe(0);
  });

  it("10 generic TORCOVKA delete is rejected before reverse (INC-001 containment)", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    const lotBefore = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    await createdTorcovka(world, 1, normalPicks(1), `rev-${world.suffix}`);
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: true },
    });
    const lotAfterTorc = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lotAfterTorc.remainingQuantity).toBe(lotBefore.remainingQuantity - 1);
    const blankBefore = await blankOf(world.material.id, 1.8);
    const eventsBefore = await prismaA.costEvent.count({
      where: { type: "TORCOVKA_ZERO_OUTPUT", batchId: world.batch.id },
    });
    await expect(deleteProductionOperation(op.id)).rejects.toThrow(TORCOVKA_GENERIC_DELETE_BLOCKED);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const blank = await blankOf(world.material.id, 1.8);
    expect(lot.remainingQuantity).toBe(lotAfterTorc.remainingQuantity);
    expect(d(lot.remainingValue)!.equals(d(lotAfterTorc.remainingValue)!)).toBe(true);
    expect(blank?.quantity).toBe(blankBefore?.quantity);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(1);
    expect(
      await prismaA.costEvent.count({
        where: { type: "TORCOVKA_ZERO_OUTPUT", batchId: world.batch.id },
      }),
    ).toBe(eventsBefore);
  });

  it("11 reversal after pool mutation is blocked atomically", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(world, 1, normalPicks(1), `mut-${world.suffix}`);
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { railLotId: world.lot.id } });
    const lotMid = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    await prismaA.blankStock.updateMany({
      where: { materialId: world.material.id, lengthM: 1.8, detailType: "POLKA", sort: "SORT1" },
      data: { costVersion: { increment: 1 } },
    });
    await expect(deleteProductionOperation(op.id)).rejects.toThrow(TORCOVKA_GENERIC_DELETE_BLOCKED);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(1);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lot.remainingQuantity).toBe(lotMid.remainingQuantity);
    expect(d(lot.remainingValue)!.equals(d(lotMid.remainingValue)!)).toBe(true);
  });

  it("12 pre-cutover op reversal while active is blocked", async () => {
    const world = await seedWorld();
    await prismaA.railLot.update({
      where: { id: world.lot.id },
      data: { initialValue: null, remainingValue: null },
    });
    await createdTorcovka(world, 1, normalPicks(1), `pre-${world.suffix}`);
    await setCostFlowActive(true);
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { railLotId: world.lot.id } });
    const lotMid = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    await expect(deleteProductionOperation(op.id)).rejects.toThrow(TORCOVKA_GENERIC_DELETE_BLOCKED);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(1);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lot.remainingQuantity).toBe(lotMid.remainingQuantity);
  });

  it("13 RAW_WRITEOFF: remaining raw → one component-safe CostEvent", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld({ remainingValue: "1234.567890" });
    const before = d((await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } })).remainingValue)!;
    await writeOffBatchRemainder(world.batch.id);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const events = await prismaA.costEvent.findMany({ where: { batchId: world.batch.id, type: "RAW_WRITEOFF" } });
    expect(lot.remainingQuantity).toBe(0);
    expect(d(lot.remainingValue)!.equals(D(0))).toBe(true);
    expect(events).toHaveLength(1);
    expect(d(events[0]?.materialValue)!.equals(before)).toBe(true);
    expect(d(events[0]?.laborValue)!.equals(D(0))).toBe(true);
    expect(d(events[0]?.nomenclatureValue)!.equals(D(0))).toBe(true);
    expect(d(events[0]?.totalValue)!.equals(before)).toBe(true);
  });

  it("14 late positive ΔC: remaining share revalues raw, consumed share → PURCHASE_VARIANCE", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld({ remaining: 10, remainingValue: "10000" });
    await createdTorcovka(world, 3, normalPicks(3), `dpos-${world.suffix}`);
    const lotMid = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const remBefore = d(lotMid.remainingValue)!;
    await updateBatch(world.batch.id, {
      name: world.batch.name,
      materialId: world.material.id,
      purchaseDate: "2026-01-15",
      sectionWidthMm: 40,
      sectionHeightMm: 20,
      purchaseCost: 11_000,
      priceSort1: 30_000,
      priceSort2: 20_000,
      note: "",
      rails: [],
    });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const events = await prismaA.costEvent.findMany({
      where: { batchId: world.batch.id, type: "PURCHASE_VARIANCE" },
    });
    const deltaC = D(1000);
    const deltaRemaining = q6(deltaC.times(remBefore).div(10_000));
    const deltaVariance = q6(deltaC.minus(deltaRemaining));
    expect(d(lot.remainingValue)!.equals(remBefore.plus(deltaRemaining))).toBe(true);
    expect(d(lot.remainingValue)!.isNeg()).toBe(false);
    expect(events).toHaveLength(1);
    expect(d(events[0]?.materialValue)!.equals(deltaVariance)).toBe(true);
    expect(deltaRemaining.plus(d(events[0]?.materialValue)!).equals(deltaC)).toBe(true);
  });

  it("15 late negative ΔC: conservation and no negative lot", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld({ remaining: 10, remainingValue: "10000" });
    await createdTorcovka(world, 3, normalPicks(3), `dneg-${world.suffix}`);
    const remBefore = d((await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } })).remainingValue)!;
    await updateBatch(world.batch.id, {
      name: world.batch.name,
      materialId: world.material.id,
      purchaseDate: "2026-01-15",
      sectionWidthMm: 40,
      sectionHeightMm: 20,
      purchaseCost: 9_000,
      priceSort1: 30_000,
      priceSort2: 20_000,
      note: "",
      rails: [],
    });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const events = await prismaA.costEvent.findMany({
      where: { batchId: world.batch.id, type: "PURCHASE_VARIANCE" },
    });
    const deltaC = D(-1000);
    const deltaRemaining = q6(deltaC.times(remBefore).div(10_000));
    const adj = d(lot.remainingValue)!.minus(remBefore);
    expect(d(lot.remainingValue)!.isNeg()).toBe(false);
    expect(adj.plus(d(events[0]?.materialValue)!).equals(deltaC)).toBe(true);
    expect(deltaRemaining.equals(adj)).toBe(true);
  });

  it("16 inactive ΔC: no monetary fields/events touched", async () => {
    const world = await seedWorld();
    await prismaA.railLot.update({
      where: { id: world.lot.id },
      data: { initialValue: null, remainingValue: null },
    });
    await updateBatch(world.batch.id, {
      name: world.batch.name,
      materialId: world.material.id,
      purchaseDate: "2026-01-15",
      sectionWidthMm: 40,
      sectionHeightMm: 20,
      purchaseCost: 12_000,
      priceSort1: 30_000,
      priceSort2: 20_000,
      note: "",
      rails: [],
    });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lot.initialValue).toBeNull();
    expect(lot.remainingValue).toBeNull();
    expect(await prismaA.costEvent.count()).toBe(0);
  });

  it("17 new Batch while active: Σ RailLot.initialValue = totalCost", async () => {
    await setCostFlowActive(true);
    const material = await prismaA.material.create({
      data: { name: `mat-new-${seq}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const row = await createBatch({
      name: `new-batch-${seq}-${Date.now()}`,
      materialId: material.id,
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
        {
          mode: "package",
          lengthM: 2,
          railType: "POLKA",
          sort: "SORT2",
          quantity: 4,
        },
      ],
    });
    const lots = await prismaA.railLot.findMany({ where: { batchId: row.id } });
    const sum = lots.reduce((s, l) => s.plus(d(l.initialValue)!), D(0));
    expect(sum.equals(D(10_000))).toBe(true);
    expect(lots.every((l) => d(l.remainingValue)!.equals(d(l.initialValue)!))).toBe(true);
    expect(await prismaA.costEvent.count()).toBe(0);
  });

  it("allocation-driver edit after consumption fails closed", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(world, 1, normalPicks(1), `drv-${world.suffix}`);
    await expect(
      updateBatch(world.batch.id, {
        name: world.batch.name,
        materialId: world.material.id,
        purchaseDate: "2026-01-15",
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 10_000,
        priceSort1: 40_000,
        priceSort2: 20_000,
        note: "",
        rails: [],
      }),
    ).rejects.toThrow(COST_FLOW_DRIVER_AFTER_CONSUMPTION);
  });

  async function coveringZeroDeviationInventory(args: {
    materialId: string;
    lengthM: string;
    detailType?: "POLKA";
    sort?: "SORT1" | "SORT2";
    accountedQty: number;
    suffix: string;
  }) {
    const detail = await prismaA.detail.create({
      data: {
        name: `det-${args.suffix}`,
        materialId: args.materialId,
        detailNumber: 1,
        lengthM: new Prisma.Decimal(args.lengthM),
        detailType: args.detailType ?? "POLKA",
        sort: args.sort ?? "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    await delay(30);
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: detail.id,
              accountedQty: args.accountedQty,
              actualQty: args.accountedQty,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(doc.id);
    return { detail, doc };
  }

  it("inventory-boundary blocks active TORCOVKA delete with zero stock/money/event mutation", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(world, 1, normalPicks(1), `invdel-${world.suffix}`);
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: true },
    });
    await coveringZeroDeviationInventory({
      materialId: world.material.id,
      lengthM: "1.8000",
      accountedQty: 1,
      suffix: `invdel-${world.suffix}`,
    });
    const lotBefore = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const blankBefore = await blankOf(world.material.id, 1.8);
    const eventsBefore = await prismaA.costEvent.count();
    await expect(deleteProductionOperation(op.id)).rejects.toThrow(TORCOVKA_GENERIC_DELETE_BLOCKED);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(1);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const blank = await blankOf(world.material.id, 1.8);
    expect(lot.remainingQuantity).toBe(lotBefore.remainingQuantity);
    expect(d(lot.remainingValue)!.equals(d(lotBefore.remainingValue)!)).toBe(true);
    expect(blank?.quantity).toBe(blankBefore?.quantity);
    expect(d(blank?.materialValue)!.equals(d(blankBefore?.materialValue)!)).toBe(true);
    expect(d(blank?.laborValue)!.equals(d(blankBefore?.laborValue)!)).toBe(true);
    expect(blank?.costVersion).toBe(blankBefore?.costVersion);
    expect(await prismaA.costEvent.count()).toBe(eventsBefore);
  });

  it("inventory-boundary blocks active TORCOVKA line quantity correction", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(
      world,
      1,
      [{ lengthM: 0.6, sort: "SORT1", quantity: 2 }],
      `invline-${world.suffix}`,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    await coveringZeroDeviationInventory({
      materialId: world.material.id,
      lengthM: "0.6000",
      accountedQty: 2,
      suffix: `invline-${world.suffix}`,
    });
    const blankBefore = await blankOf(world.material.id, 0.6);
    await expect(updateProductionLineQuantity(op.id, 0, 1)).rejects.toThrow(INVENTORY_BOUNDARY);
    const blank = await blankOf(world.material.id, 0.6);
    const opAfter = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    expect(opAfter.lines[0]?.quantity).toBe(2);
    expect(blank?.quantity).toBe(blankBefore?.quantity);
    expect(d(blank?.materialValue)!.equals(d(blankBefore?.materialValue)!)).toBe(true);
    expect(blank?.costVersion).toBe(blankBefore?.costVersion);
  });

  it("concurrent different RailLots to the same absent BlankStock both succeed", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld({ remaining: 10, remainingValue: "10000" });
    const lot2 = await prismaA.railLot.create({
      data: {
        batchId: world.batch.id,
        lengthM: new Prisma.Decimal("2"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: 10,
        remainingQuantity: 10,
        initialValue: new Prisma.Decimal("8000"),
        remainingValue: new Prisma.Decimal("8000"),
      },
    });
    const p1 = submitTorcovka(torcInput(world, 1, normalPicks(1), `lotA-${world.suffix}`));
    const p2 = submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: lot2.id,
      railsTaken: 1,
      picks: normalPicks(1),
      clientRequestId: `lotB-${world.suffix}`,
    });
    const results = await Promise.race([
      Promise.allSettled([p1, p2]),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`QueryTimeout: different-lot TORCOVKA ${CONCURRENCY_TIMEOUT_MS}ms`)),
          CONCURRENCY_TIMEOUT_MS,
        ),
      ),
    ]);
    const failed = results.filter((r) => r.status === "rejected");
    expect(failed).toHaveLength(0);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const row of failed) {
      expect(prismaPgCode((row as PromiseRejectedResult).reason)).not.toBe("P2002");
    }
    const ops = await prismaA.productionOperation.findMany({
      where: { batchId: world.batch.id, type: "TORCOVKA" },
      include: { lines: true },
    });
    expect(ops).toHaveLength(2);
    const blank = await blankOf(world.material.id, 1.8);
    const receiptQty = ops.reduce((s, o) => s + o.lines.reduce((n, l) => n + l.quantity, 0), 0);
    const receiptMat = ops.reduce(
      (s, o) => s.plus(o.lines.reduce((n, l) => n.plus(d(l.receiptMaterialValue)!), D(0))),
      D(0),
    );
    const receiptLab = ops.reduce(
      (s, o) => s.plus(o.lines.reduce((n, l) => n.plus(d(l.receiptLaborValue)!), D(0))),
      D(0),
    );
    expect(blank?.quantity).toBe(receiptQty);
    expect(d(blank?.materialValue)!.equals(receiptMat)).toBe(true);
    expect(d(blank?.laborValue)!.equals(receiptLab)).toBe(true);
    expect(d(blank?.totalValue)!.equals(d(blank?.materialValue)!.plus(d(blank?.laborValue)!))).toBe(true);
    const lot1 = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const lot2After = await prismaA.railLot.findUniqueOrThrow({ where: { id: lot2.id } });
    expect(lot1.remainingQuantity).toBe(9);
    expect(lot2After.remainingQuantity).toBe(9);
    const consumed1 = d(ops.find((o) => o.railLotId === world.lot.id)?.consumedRawValue)!;
    const consumed2 = d(ops.find((o) => o.railLotId === lot2.id)?.consumedRawValue)!;
    expect(d(lot1.remainingValue)!.plus(consumed1).equals(D("10000"))).toBe(true);
    expect(d(lot2After.remainingValue)!.plus(consumed2).equals(D("8000"))).toBe(true);
  });

  it("active railsTaken correction 10 → 7 is exact and conserves lot/blank", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld({ remaining: 10, remainingValue: "10000.000001" });
    await createdTorcovka(
      world,
      10,
      [{ lengthM: 1.8, sort: "SORT1", quantity: 7 }],
      `rt-${world.suffix}`,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: true },
    });
    const lotAfterTorc = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const blankAfterTorc = await blankOf(world.material.id, 1.8);
    const oldConsumed = d(op.consumedRawValue)!;
    const oldLabor = d(op.pieceLaborCost)!;
    const split = consumeRailValue({
      remainingQuantity: 10,
      remainingValue: oldConsumed,
      railsTaken: 7,
    });
    await correctTorcovkaRailsTaken({
      operationId: op.id,
      newRailsTaken: 7,
      reason: "over-entered rails",
    });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const opAfter = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    const blank = await blankOf(world.material.id, 1.8);
    expect(opAfter.railsTaken).toBe(7);
    expect(d(opAfter.consumedRawValue)!.equals(split.consumedRawValue)).toBe(true);
    expect(d(opAfter.consumedRawValue)!.plus(split.newRemainingValue).equals(oldConsumed)).toBe(true);
    expect(lot.remainingQuantity).toBe(lotAfterTorc.remainingQuantity + 3);
    expect(d(lot.remainingValue)!.equals(d(lotAfterTorc.remainingValue)!.plus(split.newRemainingValue))).toBe(true);
    expect(blank?.quantity).toBe(blankAfterTorc?.quantity);
    expect(d(blank?.laborValue)!.equals(d(blankAfterTorc?.laborValue)!)).toBe(true);
    expect(d(opAfter.pieceLaborCost)!.equals(oldLabor)).toBe(true);
    expect(d(blankAfterTorc?.materialValue)!.minus(d(blank?.materialValue)!).equals(split.newRemainingValue)).toBe(
      true,
    );
    expect(d(blank?.totalValue)!.equals(d(blank?.materialValue)!.plus(d(blank?.laborValue)!))).toBe(true);
    expect(blank?.costVersion).toBe((blankAfterTorc?.costVersion ?? 0) + 1);
    expect(opAfter.lines.every((l) => l.outputCostVersion === blank?.costVersion)).toBe(true);
    expect(await prismaA.costEvent.count({ where: { batchId: world.batch.id } })).toBe(0);
  });

  it("active railsTaken correction is blocked after later pool mutation", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(
      world,
      3,
      [{ lengthM: 1.8, sort: "SORT1", quantity: 2 }],
      `rtmut-${world.suffix}`,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { railLotId: world.lot.id } });
    await prismaA.blankStock.updateMany({
      where: { materialId: world.material.id, lengthM: 1.8, detailType: "POLKA", sort: "SORT1" },
      data: { costVersion: { increment: 1 } },
    });
    const lotMid = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    await expect(
      correctTorcovkaRailsTaken({ operationId: op.id, newRailsTaken: 2, reason: "blocked" }),
    ).rejects.toThrow(COST_FLOW_VERSION_MISMATCH);
    expect((await prismaA.productionOperation.findUniqueOrThrow({ where: { id: op.id } })).railsTaken).toBe(3);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lot.remainingQuantity).toBe(lotMid.remainingQuantity);
  });

  it("inventory-boundary blocks active railsTaken correction", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(
      world,
      3,
      [{ lengthM: 1.8, sort: "SORT1", quantity: 2 }],
      `rtinv-${world.suffix}`,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { railLotId: world.lot.id } });
    await coveringZeroDeviationInventory({
      materialId: world.material.id,
      lengthM: "1.8000",
      accountedQty: 2,
      suffix: `rtinv-${world.suffix}`,
    });
    const lotMid = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    await expect(
      correctTorcovkaRailsTaken({ operationId: op.id, newRailsTaken: 2, reason: "boundary" }),
    ).rejects.toThrow(INVENTORY_BOUNDARY);
    expect((await prismaA.productionOperation.findUniqueOrThrow({ where: { id: op.id } })).railsTaken).toBe(3);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lot.remainingQuantity).toBe(lotMid.remainingQuantity);
  });

  it("frozen batch blocks active railsTaken correction", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(
      world,
      3,
      [{ lengthM: 1.8, sort: "SORT1", quantity: 2 }],
      `rtfr-${world.suffix}`,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { railLotId: world.lot.id } });
    await prismaA.batch.update({
      where: { id: world.batch.id },
      data: { frozenAt: new Date("2026-09-01T00:00:00.000Z") },
    });
    const lotMid = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    await expect(
      correctTorcovkaRailsTaken({ operationId: op.id, newRailsTaken: 2, reason: "frozen" }),
    ).rejects.toThrow(/заморожена/);
    expect((await prismaA.productionOperation.findUniqueOrThrow({ where: { id: op.id } })).railsTaken).toBe(3);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lot.remainingQuantity).toBe(lotMid.remainingQuantity);
  });

  it("active line quantity reduce / increase / over-length", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(
      world,
      1,
      [{ lengthM: 0.6, sort: "SORT1", quantity: 3 }],
      `lq-${world.suffix}`,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const lotAfterTorc = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    const consumed = d(op.consumedRawValue)!;
    await updateProductionLineQuantity(op.id, 0, 1);
    const reduced = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    const blankReduced = await blankOf(world.material.id, 0.6);
    expect(reduced.lines[0]?.quantity).toBe(1);
    expect(d(reduced.consumedRawValue)!.equals(consumed)).toBe(true);
    const lotReduced = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lotReduced.remainingQuantity).toBe(lotAfterTorc.remainingQuantity);
    expect(d(lotReduced.remainingValue)!.equals(d(lotAfterTorc.remainingValue)!)).toBe(true);
    expect(d(blankReduced?.materialValue)!.equals(consumed)).toBe(true);
    expect(await prismaA.costEvent.count({ where: { batchId: world.batch.id } })).toBe(0);

    await updateProductionLineQuantity(op.id, 0, 3);
    const increased = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    expect(increased.lines[0]?.quantity).toBe(3);
    expect(d(increased.consumedRawValue)!.equals(consumed)).toBe(true);

    await expect(updateProductionLineQuantity(op.id, 0, 4)).rejects.toThrow(
      /превышает длину взятых реек/,
    );
    expect(
      (await prismaA.productionOperation.findUniqueOrThrow({ where: { id: op.id }, include: { lines: true } }))
        .lines[0]?.quantity,
    ).toBe(3);
  });

  it("active line quantity same-pool duplicate lines keep exact component conservation", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(
      world,
      1,
      [
        { lengthM: 0.4, sort: "SORT1", quantity: 2 },
        { lengthM: 0.4, sort: "SORT1", quantity: 2 },
      ],
      `lqdup-${world.suffix}`,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    expect(op.lines).toHaveLength(1);
    expect(op.lines[0]?.quantity).toBe(4);
    const consumed = d(op.consumedRawValue)!;
    const oldLabor = d(op.pieceLaborCost)!;
    await updateProductionLineQuantity(op.id, 0, 5);
    const after = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const blank = await blankOf(world.material.id, 0.4);
    const lineMat = after.lines.reduce((s, l) => s.plus(d(l.receiptMaterialValue)!), D(0));
    const lineLab = after.lines.reduce((s, l) => s.plus(d(l.receiptLaborValue)!), D(0));
    expect(d(after.consumedRawValue)!.equals(consumed)).toBe(true);
    expect(lineMat.equals(consumed)).toBe(true);
    expect(lineLab.equals(d(after.pieceLaborCost)!)).toBe(true);
    expect(d(blank?.materialValue)!.equals(consumed)).toBe(true);
    expect(d(blank?.laborValue)!.equals(d(after.pieceLaborCost)!)).toBe(true);
    expect(blank?.quantity).toBe(5);
    expect(after.lines.every((l) => l.outputCostVersion === blank?.costVersion)).toBe(true);
    expect(d(after.pieceLaborCost)!.equals(oldLabor.plus(D(12)))).toBe(true);
  });

  it("active line quantity redistributes material and DI-015 labor across mixed sorts and same-pool lines", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(
      world,
      1,
      [
        { lengthM: 0.5, sort: "SORT1", quantity: 1 },
        { lengthM: 0.5, sort: "SORT2", quantity: 1 },
        { lengthM: 0.4, sort: "SORT1", quantity: 1 },
      ],
      `lqmix-${world.suffix}`,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const s2Index = op.lines.findIndex((l) => l.blankSort === "SORT2");
    expect(s2Index).toBeGreaterThanOrEqual(0);
    const consumed = d(op.consumedRawValue)!;
    const lotBefore = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    await updateProductionLineQuantity(op.id, s2Index, 2);
    const after = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(d(after.consumedRawValue)!.equals(consumed)).toBe(true);
    expect(lot.remainingQuantity).toBe(lotBefore.remainingQuantity);
    expect(d(lot.remainingValue)!.equals(d(lotBefore.remainingValue)!)).toBe(true);
    const lineMat = after.lines.reduce((s, l) => s.plus(d(l.receiptMaterialValue)!), D(0));
    const lineLab = after.lines.reduce((s, l) => s.plus(d(l.receiptLaborValue)!), D(0));
    expect(lineMat.equals(consumed)).toBe(true);
    expect(d(after.pieceLaborCost)!.equals(D(12 + 16 + 12))).toBe(true);
    expect(lineLab.equals(d(after.pieceLaborCost)!)).toBe(true);
    const s1 = after.lines.filter((l) => l.blankSort === "SORT1");
    const s2 = after.lines.filter((l) => l.blankSort === "SORT2");
    expect(s2[0]?.quantity).toBe(2);
    expect(d(s2[0]?.pieceLaborCost)!.equals(D(16))).toBe(true);
    expect(s1.every((l) => d(l.pieceLaborCost)!.equals(D(12)))).toBe(true);
    const blankS1a = await blankOf(world.material.id, 0.5, "SORT1");
    const blankS2 = await blankOf(world.material.id, 0.5, "SORT2");
    const blankS1b = await blankOf(world.material.id, 0.4, "SORT1");
    expect(d(blankS1a?.totalValue)!.equals(d(blankS1a?.materialValue)!.plus(d(blankS1a?.laborValue)!))).toBe(true);
    expect(d(blankS2?.totalValue)!.equals(d(blankS2?.materialValue)!.plus(d(blankS2?.laborValue)!))).toBe(true);
    expect(d(blankS1b?.totalValue)!.equals(d(blankS1b?.materialValue)!.plus(d(blankS1b?.laborValue)!))).toBe(true);
    expect(after.lines.filter((l) => l.blankLengthM?.equals(new Prisma.Decimal("0.5")) && l.blankSort === "SORT1")
      .every((l) => l.outputCostVersion === blankS1a?.costVersion)).toBe(true);
  });

  it("active line quantity is blocked on pool version mismatch", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    await createdTorcovka(
      world,
      1,
      [{ lengthM: 0.6, sort: "SORT1", quantity: 2 }],
      `lqver-${world.suffix}`,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { railLotId: world.lot.id } });
    await prismaA.blankStock.updateMany({
      where: { materialId: world.material.id, lengthM: 0.6, detailType: "POLKA", sort: "SORT1" },
      data: { costVersion: { increment: 1 } },
    });
    await expect(updateProductionLineQuantity(op.id, 0, 1)).rejects.toThrow(COST_FLOW_VERSION_MISMATCH);
    expect(
      (await prismaA.productionOperation.findUniqueOrThrow({ where: { id: op.id }, include: { lines: true } }))
        .lines[0]?.quantity,
    ).toBe(2);
  });

  it("Deal skipLateDeltaC applies only to the edited unconsumed batch; sibling keeps late ΔC", async () => {
    await setCostFlowActive(true);
    const worldA = await seedWorld({ remaining: 10, remainingValue: "10000" });
    const worldB = await seedWorld({ remaining: 10, remainingValue: "10000" });
    await prismaA.batch.update({
      where: { id: worldB.batch.id },
      data: { materialId: worldA.material.id, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    await prismaA.railLot.update({
      where: { id: worldB.lot.id },
      data: { remainingValue: new Prisma.Decimal("10000"), initialValue: new Prisma.Decimal("10000") },
    });
    const deal = await prismaA.deal.create({
      data: {
        name: `deal-${worldA.suffix}`,
        status: "OPEN",
        total: 20_000,
        items: { create: [{ batchId: worldA.batch.id }, { batchId: worldB.batch.id }] },
      },
    });
    const account = await prismaA.account.create({
      data: { name: `acc-${worldA.suffix}`, confirmed: true, openingBalance: 0, balance: 0 },
    });
    await createCashFlow({
      date: "2026-03-01",
      amount: 24_000,
      flowType: "EXPENSE",
      accountName: account.name,
      counterpartyName: null,
      description: "deal extra",
      articleName: null,
      dealId: deal.id,
      dealName: deal.name,
    });
    await createdTorcovka(worldB, 3, normalPicks(3), `sib-${worldB.suffix}`);
    const bBefore = await prismaA.batch.findUniqueOrThrow({ where: { id: worldB.batch.id } });
    const lotBBefore = await prismaA.railLot.findUniqueOrThrow({ where: { id: worldB.lot.id } });
    const remB = d(lotBBefore.remainingValue)!;
    await updateBatch(worldA.batch.id, {
      name: worldA.batch.name,
      materialId: worldA.material.id,
      purchaseDate: "2026-01-15",
      sectionWidthMm: 40,
      sectionHeightMm: 20,
      purchaseCost: 12_000,
      priceSort1: 40_000,
      priceSort2: 20_000,
      note: "",
      rails: [],
    });
    const aAfter = await prismaA.batch.findUniqueOrThrow({ where: { id: worldA.batch.id } });
    const bAfter = await prismaA.batch.findUniqueOrThrow({ where: { id: worldB.batch.id } });
    const lotA = await prismaA.railLot.findUniqueOrThrow({ where: { id: worldA.lot.id } });
    const lotB = await prismaA.railLot.findUniqueOrThrow({ where: { id: worldB.lot.id } });
    expect(d(lotA.remainingValue)!.equals(d(lotA.initialValue)!)).toBe(true);
    expect(d(lotA.initialValue)!.equals(D(aAfter.totalCost.toString()))).toBe(true);
    const deltaC = D(bAfter.totalCost.toString()).minus(D(bBefore.totalCost.toString()));
    expect(deltaC.isZero()).toBe(false);
    const events = await prismaA.costEvent.findMany({
      where: { batchId: worldB.batch.id, type: "PURCHASE_VARIANCE" },
    });
    expect(events).toHaveLength(1);
    const adj = d(lotB.remainingValue)!.minus(remB);
    expect(adj.isZero()).toBe(false);
    expect(d(lotB.remainingValue)!.isNeg()).toBe(false);
    expect(adj.plus(d(events[0]?.materialValue)!).minus(deltaC).abs().lte("0.01")).toBe(true);
    expect(await prismaA.costEvent.count({ where: { batchId: worldA.batch.id, type: "PURCHASE_VARIANCE" } })).toBe(0);
  });

  it("pick-order permutation does not change spec material allocation", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld();
    const picks = [
      { lengthM: 0.9, sort: "SORT2" as const, quantity: 1 },
      { lengthM: 0.9, sort: "SORT1" as const, quantity: 1 },
    ];
    await createdTorcovka(world, 1, picks, `perm-${world.suffix}`);
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: true },
    });
    const consumed = d(op.consumedRawValue)!;
    const allocPicks = picks.map((p) => ({
      materialId: world.material.id,
      lengthM: p.lengthM,
      detailType: "POLKA",
      sort: p.sort,
      quantity: p.quantity,
    }));
    const reversed = [...allocPicks].reverse();
    const ids = assignCanonicalTorcovkaLineIds(allocPicks);
    const idsRev = assignCanonicalTorcovkaLineIds(reversed);
    const metres = picks.map((p) => D(p.lengthM).times(p.quantity));
    const alloc = allocatePersistenceShares({
      total: consumed,
      items: picks.map((_, i) => ({ id: ids[i]!, shareBase: metres[i]! })),
    });
    const allocRev = allocatePersistenceShares({
      total: consumed,
      items: reversed.map((p, i) => ({
        id: idsRev[i]!,
        shareBase: D(p.lengthM).times(p.quantity),
      })),
    });
    const bySpec = (rows: { id: string; value: ReturnType<typeof D> }[], source: typeof allocPicks) => {
      const map = new Map<string, ReturnType<typeof D>>();
      for (let i = 0; i < source.length; i++) {
        const key = `${source[i]!.sort}|${source[i]!.lengthM}`;
        map.set(key, (map.get(key) ?? D(0)).plus(rows.find((r) => r.id === (source === allocPicks ? ids[i] : idsRev[i]))!.value));
      }
      return map;
    };
    const a = bySpec(alloc, allocPicks);
    const b = bySpec(allocRev, reversed);
    expect(a.get("SORT1|0.9")!.equals(b.get("SORT1|0.9")!)).toBe(true);
    expect(a.get("SORT2|0.9")!.equals(b.get("SORT2|0.9")!)).toBe(true);
    const s1 = op.lines.find((l) => l.blankSort === "SORT1");
    const s2 = op.lines.find((l) => l.blankSort === "SORT2");
    expect(d(s1?.receiptMaterialValue)!.equals(a.get("SORT1|0.9")!)).toBe(true);
    expect(d(s2?.receiptMaterialValue)!.equals(a.get("SORT2|0.9")!)).toBe(true);
  });

  it("T8 near-equal picks merge before active cost-flow writes", async () => {
    await setCostFlowActive(true);
    const world = await seedWorld({ remaining: 10, lotLengthM: "2" });
    await createdTorcovka(
      world,
      2,
      [
        { lengthM: 0.736, sort: "SORT1", quantity: 2 },
        { lengthM: 0.7359999999999, sort: "SORT1", quantity: 3 },
      ],
      `p2025-t8-${world.suffix}`,
    );
    const blanks = await prismaA.blankStock.findMany({
      where: { materialId: world.material.id },
    });
    expect(blanks).toHaveLength(1);
    expect(blanks[0]!.quantity).toBe(5);
    expect(blanks[0]!.lengthM.toFixed(4)).toBe("0.7360");
    expect(blanks[0]!.materialValue).not.toBeNull();
    expect(blanks[0]!.laborValue).not.toBeNull();
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: world.lot.id },
      include: { lines: true },
    });
    expect(op.lines).toHaveLength(1);
    expect(op.lines[0]!.quantity).toBe(5);
    expect(op.lines[0]!.blankLengthM!.toFixed(4)).toBe("0.7360");
  });
});
