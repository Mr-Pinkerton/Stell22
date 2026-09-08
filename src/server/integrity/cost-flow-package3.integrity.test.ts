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
import { q6 } from "@/lib/cost-foundation";
import {
  COST_FLOW_POOL_UNINITIALIZED,
  COST_FLOW_PRE_CUTOVER_REVERSE,
  COST_FLOW_VERSION_MISMATCH,
} from "@/server/internal/cost-flow-raw";
import {
  COST_FLOW_EMPTY_SURPLUS_VALUATION,
  COST_FLOW_QTY_ONLY_WRITER,
} from "@/server/internal/cost-flow-downstream";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import { STALE_SNAPSHOT } from "@/server/internal/inventory-integrity";
import { applySupplyDeduction } from "@/server/internal/supply-deduct";
import { deleteDetail } from "@/server/nomenclature";
import { deleteProductionOperation, updateProductionLineQuantity } from "@/server/production";
import { createSimplePurchase } from "@/server/purchases";
import { submitPrisadka, submitTorcovka, submitUpakovka } from "@/server/terminal";
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
  return err instanceof Error ? err.message : String(err);
}

function isDeadlockError(err: unknown): boolean {
  const seen = new Set<unknown>();
  const stack: unknown[] = [err];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur == null || seen.has(cur)) continue;
    seen.add(cur);
    if (typeof cur === "string") {
      if (/deadlock detected/i.test(cur) || /40P01/i.test(cur)) return true;
      continue;
    }
    if (typeof cur !== "object") continue;
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown; meta?: unknown };
    const code = String(o.code ?? "");
    if (code === "40P01" || code === "P2034") return true;
    const msg = String(o.message ?? "");
    if (/deadlock detected/i.test(msg) || /40P01/i.test(msg)) return true;
    if (o.cause) stack.push(o.cause);
    if (o.meta) stack.push(o.meta);
  }
  return false;
}

function expectNoDeadlock(results: PromiseSettledResult<unknown>[]): void {
  for (const r of results) {
    if (r.status === "rejected" && isDeadlockError(r.reason)) {
      throw new Error(`deadlock-class rejection: ${errorMessage(r.reason)}`);
    }
  }
}

describe.skipIf(!enabled)("Package 3 downstream production cost flow", () => {
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

  async function seedChain() {
    const suffix = `p3-${seq}-${Date.now()}`;
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        rateTorcovkaSort1: 10,
        rateTorcovkaSort2: 8,
        ratePrisadkaTorcev: 5,
        ratePrisadkaPloskt: 4,
        rateUpakovka: 6,
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
    const lot = await prismaA.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: new Prisma.Decimal("2"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: 10,
        remainingQuantity: 10,
        initialValue: new Prisma.Decimal("10000"),
        remainingValue: new Prisma.Decimal("10000"),
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
    const fastener = await prismaA.nomenclatureItem.create({
      data: { name: `nom-${suffix}`, type: "FASTENER", unitPrice: 12 },
    });
    const product = await prismaA.product.create({
      data: {
        name: `prod-${suffix}`,
        materialId: material.id,
        skuOzon: `OZ-${suffix}`,
        skuWb: `WB-${suffix}`,
        sort: "SORT1",
        details: { create: [{ detailId: detail.id, quantity: 1 }] },
        fasteners: { create: [{ nomenclatureId: fastener.id, quantity: 2 }] },
      },
    });
    return { suffix, material, emp, batch, lot, detail, fastener, product };
  }

  async function createdTorcovka(world: Awaited<ReturnType<typeof seedChain>>, requestId: string) {
    const input = {
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 1,
      picks: [{ lengthM: 1.8, sort: "SORT1" as const, quantity: 1 }],
      clientRequestId: requestId,
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
    return result;
  }

  async function createBothPrisadkaDetail(world: Awaited<ReturnType<typeof seedChain>>, detailNumber: number) {
    return prismaA.detail.create({
      data: {
        name: `both-seq-${world.suffix}-${detailNumber}`,
        materialId: world.material.id,
        detailNumber,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
  }

  async function detailBucketQty(
    detailId: string,
    torcevayaDone: boolean,
    ploskostDone: boolean,
  ): Promise<number> {
    const row = await prismaA.detailStock.findUnique({
      where: {
        detailId_torcevayaDone_ploskostDone: { detailId, torcevayaDone, ploskostDone },
      },
    });
    return row?.quantity ?? 0;
  }

  async function blankQty(materialId: string): Promise<number> {
    const row = await prismaA.blankStock.findUnique({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId,
          lengthM: new Prisma.Decimal("1.8000"),
          detailType: "POLKA",
          sort: "SORT1",
        },
      },
    });
    return row?.quantity ?? 0;
  }

  async function chainTopology(detailId: string, materialId: string) {
    return {
      blank: await blankQty(materialId),
      tf: await detailBucketQty(detailId, true, false),
      ft: await detailBucketQty(detailId, false, true),
      tt: await detailBucketQty(detailId, true, true),
    };
  }

  it("inactive PRISADKA/UPAKOVKA/SimplePurchase/inventory: quantity only, no money", async () => {
    const world = await seedChain();
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 3,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `inact-pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    const ds = await prismaA.detailStock.findFirstOrThrow({ where: { detailId: world.detail.id } });
    expect(ds.quantity).toBe(1);
    expect(ds.costVersion).toBe(0);
    expect(ds.materialValue).toBeNull();
    expect(ds.laborValue).toBeNull();

    await createSimplePurchase({
      nomenclatureId: world.fastener.id,
      quantity: 4,
      unitPrice: 12,
      purchaseDate: "2026-01-20",
    });
    const nom = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: world.fastener.id },
    });
    expect(nom.quantity).toBe(4);
    expect(nom.costVersion).toBe(0);
    expect(nom.nomenclatureValue).toBeNull();

    await submitUpakovka({
      employeeId: world.emp.id,
      clientRequestId: `inact-up-${world.suffix}`,
      picks: [{ productId: world.product.id, quantity: 1 }],
    });
    const ps = await prismaA.productStock.findUniqueOrThrow({ where: { productId: world.product.id } });
    expect(ps.quantity).toBe(1);
    expect(ps.costVersion).toBe(0);
    expect(ps.totalValue).toBeNull();
    expect(await prismaA.costEvent.count()).toBe(0);
  });

  it("inactive TORCOVKA/PRISADKA/UPAKOVKA correction, reverse, deleteDetail, inventory: qty only", async () => {
    const world = await seedChain();
    await createdTorcovka(world, `inact-tor-${world.suffix}`);
    const blankAfterTorc = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: world.material.id, lengthM: new Prisma.Decimal("1.8000") },
    });
    expect(blankAfterTorc.quantity).toBe(1);
    expect(blankAfterTorc.costVersion).toBe(0);
    expect(blankAfterTorc.materialValue).toBeNull();

    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `inact-pr2-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    const pris = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    await prismaA.blankStock.updateMany({
      where: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
      },
      data: { quantity: { increment: 2 } },
    });
    await updateProductionLineQuantity(pris.id, 0, 2);
    const prisAfter = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: pris.id },
      include: { lines: true },
    });
    expect(prisAfter.lines.reduce((s, l) => s + l.quantity, 0)).toBe(2);
    expect(prisAfter.lines.every((l) => l.inputMaterialValue == null && l.outputCostVersion == null)).toBe(true);
    await deleteProductionOperation(pris.id);
    expect(await prismaA.productionOperation.count({ where: { id: pris.id } })).toBe(0);

    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `inact-pr3-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 2 }],
    });
    await createSimplePurchase({
      nomenclatureId: world.fastener.id,
      quantity: 8,
      unitPrice: 12,
      purchaseDate: "2026-01-20",
    });
    await submitUpakovka({
      employeeId: world.emp.id,
      clientRequestId: `inact-up2-${world.suffix}`,
      picks: [{ productId: world.product.id, quantity: 1 }],
    });
    const pack = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "UPAKOVKA" } });
    await updateProductionLineQuantity(pack.id, 0, 2);
    const packAfter = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: pack.id } });
    expect(packAfter.productQty).toBe(2);
    expect(packAfter.receiptMaterialValue).toBeNull();
    await deleteProductionOperation(pack.id);
    expect(await prismaA.productionOperation.count({ where: { id: pack.id } })).toBe(0);

    const orphan = await prismaA.detail.create({
      data: {
        name: `inact-del-${world.suffix}`,
        materialId: world.material.id,
        detailNumber: 20,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    await prismaA.detailStock.create({
      data: { detailId: orphan.id, torcevayaDone: true, ploskostDone: false, quantity: 3 },
    });
    await deleteDetail(orphan.id);
    expect(await prismaA.detail.findUnique({ where: { id: orphan.id } })).toBeNull();
    expect(await prismaA.detailStock.count({ where: { detailId: orphan.id } })).toBe(0);

    await prismaA.productStock.upsert({
      where: { productId: world.product.id },
      create: { productId: world.product.id, quantity: 5 },
      update: { quantity: 5 },
    });
    const inv = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: world.product.id,
              accountedQty: 5,
              actualQty: 4,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(inv.id);
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: world.product.id } });
    expect(stock.quantity).toBe(4);
    expect(stock.costVersion).toBe(0);
    expect(stock.totalValue).toBeNull();
    expect(await prismaA.costEvent.count()).toBe(0);
  });

  it("active PRISADKA conserves input+piece=output and fail-closes uninitialized source", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    await createdTorcovka(world, `tor-${world.suffix}`);
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: true },
    });
    const line = op.lines[0]!;
    expect(d(line.inputMaterialValue)!.plus(d(line.inputLaborValue)!).plus(d(line.pieceLaborCost)!).equals(
      d(line.receiptMaterialValue)!.plus(d(line.receiptLaborValue)!),
    )).toBe(true);
    expect(d(line.pieceLaborCost)!.equals(q6(5))).toBe(true);
    const dest = await prismaA.detailStock.findFirstOrThrow({
      where: { detailId: world.detail.id, torcevayaDone: true },
    });
    expect(dest.costVersion).toBeGreaterThan(0);
    expect(line.outputCostVersion).toBe(dest.costVersion);

    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT2",
        quantity: 2,
      },
    });
    const other = await prismaA.detail.create({
      data: {
        name: `det2-${world.suffix}`,
        materialId: world.material.id,
        detailNumber: 2,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT2",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    await expect(
      submitPrisadka({
        employeeId: world.emp.id,
        clientRequestId: `pr-uninit-${world.suffix}`,
        picks: [{ detailId: other.id, kind: "torcev", quantity: 1 }],
      }),
    ).rejects.toThrow(COST_FLOW_POOL_UNINITIALIZED);
  });

  it("active SimplePurchase receipts nomenclature WAC; v0 pool fail-closed", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    await createSimplePurchase({
      nomenclatureId: world.fastener.id,
      quantity: 4,
      unitPrice: 12,
      purchaseDate: "2026-01-20",
    });
    const nom = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: world.fastener.id },
    });
    expect(nom.quantity).toBe(4);
    expect(d(nom.nomenclatureValue)!.equals(q6(48))).toBe(true);
    expect(d(nom.totalValue)!.equals(q6(48))).toBe(true);
    expect(nom.costVersion).toBe(2);

    await prismaA.nomenclatureItem.create({
      data: { name: `v0-${world.suffix}`, type: "FASTENER", unitPrice: 3 },
    });
    const v0Item = await prismaA.nomenclatureItem.findFirstOrThrow({
      where: { name: `v0-${world.suffix}` },
    });
    await prismaA.nomenclatureStock.create({
      data: { nomenclatureId: v0Item.id, quantity: 1 },
    });
    await expect(
      createSimplePurchase({
        nomenclatureId: v0Item.id,
        quantity: 1,
        unitPrice: 3,
        purchaseDate: "2026-01-20",
      }),
    ).rejects.toThrow(/не инициализирован/);
  });

  it("end-to-end active value flow TORCOVKA→PRISADKA→purchase→UPAKOVKA", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    await createdTorcovka(world, `e2e-tor-${world.suffix}`);
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `e2e-pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    await createSimplePurchase({
      nomenclatureId: world.fastener.id,
      quantity: 10,
      unitPrice: 12,
      purchaseDate: "2026-01-20",
    });
    await submitUpakovka({
      employeeId: world.emp.id,
      clientRequestId: `e2e-up-${world.suffix}`,
      picks: [{ productId: world.product.id, quantity: 1 }],
    });
    const blank = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: world.material.id, lengthM: new Prisma.Decimal("1.8000") },
    });
    const detailStock = await prismaA.detailStock.findFirstOrThrow({
      where: { detailId: world.detail.id },
    });
    const product = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: world.product.id },
    });
    const torc = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "TORCOVKA" },
      include: { lines: true },
    });
    const pris = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
    });
    const pack = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "UPAKOVKA" },
      include: { lines: true, nomenclatureLines: true },
    });
    expect(blank.quantity).toBe(0);
    expect(detailStock.quantity).toBe(0);
    expect(product.quantity).toBe(1);
    expect(d(pack.receiptMaterialValue)!.equals(d(pack.lines[0]!.inputMaterialValue)!)).toBe(true);
    expect(
      d(pack.receiptLaborValue)!.equals(d(pack.lines[0]!.inputLaborValue)!.plus(d(pack.pieceLaborCost)!)),
    ).toBe(true);
    expect(d(pack.receiptNomenclatureValue)!.equals(d(pack.nomenclatureLines[0]!.consumedNomenclatureValue)!)).toBe(
      true,
    );
    expect(d(product.materialValue)!.equals(d(pack.receiptMaterialValue)!)).toBe(true);
    expect(d(product.laborValue)!.equals(d(pack.receiptLaborValue)!)).toBe(true);
    expect(d(product.nomenclatureValue)!.equals(d(pack.receiptNomenclatureValue)!)).toBe(true);
    expect(d(product.laborValue)!.equals(d(torc.lines[0]!.pieceLaborCost)!.plus(d(pris.pieceLaborCost)!).plus(d(pack.pieceLaborCost)!))).toBe(
      true,
    );
    expect(d(product.nomenclatureValue)!.equals(q6(24))).toBe(true);
  });

  it("exact PRISADKA and UPAKOVKA reverse restore inputs and block after output mutation", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    await createdTorcovka(world, `rev-tor-${world.suffix}`);
    const blankAfterTorc = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: world.material.id, lengthM: new Prisma.Decimal("1.8000") },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `rev-pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    const pris = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "PRISADKA" } });
    await deleteProductionOperation(pris.id);
    const blankRestored = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: world.material.id, lengthM: new Prisma.Decimal("1.8000") },
    });
    expect(blankRestored.quantity).toBe(blankAfterTorc.quantity);
    expect(d(blankRestored.materialValue)!.equals(d(blankAfterTorc.materialValue)!)).toBe(true);

    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `rev-pr2-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    await createSimplePurchase({
      nomenclatureId: world.fastener.id,
      quantity: 10,
      unitPrice: 12,
      purchaseDate: "2026-01-20",
    });
    await submitUpakovka({
      employeeId: world.emp.id,
      clientRequestId: `rev-up-${world.suffix}`,
      picks: [{ productId: world.product.id, quantity: 1 }],
    });
    const pack = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "UPAKOVKA" } });
    const destBefore = await prismaA.productStock.findUniqueOrThrow({ where: { productId: world.product.id } });
    await prismaA.productStock.update({
      where: { productId: world.product.id },
      data: { costVersion: destBefore.costVersion + 1 },
    });
    await expect(deleteProductionOperation(pack.id)).rejects.toThrow(COST_FLOW_VERSION_MISMATCH);
  });

  it("idempotent PRISADKA/UPAKOVKA replay does not double money", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    await createdTorcovka(world, `id-tor-${world.suffix}`);
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `id-pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `id-pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    expect(await prismaA.productionOperation.count({ where: { type: "PRISADKA" } })).toBe(1);
    await createSimplePurchase({
      nomenclatureId: world.fastener.id,
      quantity: 10,
      unitPrice: 12,
      purchaseDate: "2026-01-20",
    });
    await submitUpakovka({
      employeeId: world.emp.id,
      clientRequestId: `id-up-${world.suffix}`,
      picks: [{ productId: world.product.id, quantity: 1 }],
    });
    await submitUpakovka({
      employeeId: world.emp.id,
      clientRequestId: `id-up-${world.suffix}`,
      picks: [{ productId: world.product.id, quantity: 1 }],
    });
    expect(await prismaA.productStock.findUniqueOrThrow({ where: { productId: world.product.id } })).toMatchObject({
      quantity: 1,
    });
  });

  it("inventory shortage/surplus/empty-WIP fail-closed", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    await createdTorcovka(world, `inv-tor-${world.suffix}`);
    const blank = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: world.material.id, lengthM: new Prisma.Decimal("1.8000") },
    });
    const detNoPris = await prismaA.detail.create({
      data: {
        name: `blank-det-${world.suffix}`,
        materialId: world.material.id,
        detailNumber: 9,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    const shortageDoc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: detNoPris.id,
              accountedQty: 1,
              actualQty: 0,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(shortageDoc.id);
    const loss = await prismaA.costEvent.findFirstOrThrow({ where: { type: "INVENTORY_LOSS" } });
    expect(d(loss.totalValue)!.equals(d(loss.materialValue)!.plus(d(loss.laborValue)!).plus(d(loss.nomenclatureValue)!))).toBe(
      true,
    );
    const blankAfter = await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } });
    expect(blankAfter.quantity).toBe(0);

    const emptyDoc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: detNoPris.id,
              accountedQty: 0,
              actualQty: 1,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await expect(conductInventory(emptyDoc.id)).rejects.toThrow(COST_FLOW_EMPTY_SURPLUS_VALUATION);
    await prismaA.inventoryLine.deleteMany({ where: { inventoryId: emptyDoc.id } });
    await prismaA.inventory.delete({ where: { id: emptyDoc.id } });

    await createSimplePurchase({
      nomenclatureId: world.fastener.id,
      quantity: 2,
      unitPrice: 10,
      purchaseDate: "2026-01-20",
    });
    await prismaA.nomenclatureStock.update({
      where: { nomenclatureId: world.fastener.id },
      data: { quantity: 0, nomenclatureValue: new Prisma.Decimal(0), totalValue: new Prisma.Decimal(0) },
    });
    const nomEmpty = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "NOMENCLATURE",
              refId: world.fastener.id,
              accountedQty: 0,
              actualQty: 3,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(nomEmpty.id);
    const nom = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: world.fastener.id },
    });
    expect(nom.quantity).toBe(3);
    expect(d(nom.nomenclatureValue)!.equals(q6(36))).toBe(true);
    const gain = await prismaA.costEvent.findFirstOrThrow({ where: { type: "INVENTORY_GAIN" } });
    expect(d(gain.nomenclatureValue)!.equals(q6(36))).toBe(true);
  });

  it("pre-cutover reverse blocked; marketplace qty-only writer fail-closed", async () => {
    await setCostFlowActive(false);
    const world = await seedChain();
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 1,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `pre-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "PRISADKA" } });
    await setCostFlowActive(true);
    await expect(deleteProductionOperation(op.id)).rejects.toThrow(COST_FLOW_PRE_CUTOVER_REVERSE);

    await prismaA.productStock.create({
      data: {
        productId: world.product.id,
        quantity: 5,
        materialValue: new Prisma.Decimal("1"),
        laborValue: new Prisma.Decimal("1"),
        nomenclatureValue: new Prisma.Decimal("1"),
        totalValue: new Prisma.Decimal("3"),
        costVersion: 1,
      },
    });
    await prismaA.supply.create({
      data: {
        marketplace: "OZON",
        externalId: `s-${world.suffix}`,
        sku: `sku-${world.suffix}`,
        productId: world.product.id,
        quantity: 2,
        deductedQty: 0,
        shortfallQty: 0,
        status: "SHIPPED",
        createdAt: new Date("2026-01-20T00:00:00.000Z"),
      },
    });
    await expect(
      applySupplyDeduction(prismaA, {
        marketplace: "OZON",
        externalId: `s-${world.suffix}`,
        sku: `sku-${world.suffix}`,
        targetQty: 1,
        productId: world.product.id,
      }),
    ).rejects.toThrow(COST_FLOW_QTY_ONLY_WRITER);
  });

  it("concurrent SimplePurchase receipts land exact WAC", { timeout: CONCURRENCY_TIMEOUT_MS }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const item = world.fastener;
    const results = await raceSettled("simple-purchase-wac", [
      createSimplePurchase({
        nomenclatureId: item.id,
        quantity: 2,
        unitPrice: 10,
        purchaseDate: "2026-01-20",
      }),
      createSimplePurchase({
        nomenclatureId: item.id,
        quantity: 3,
        unitPrice: 20,
        purchaseDate: "2026-01-20",
      }),
    ]);
    expectNoDeadlock(results);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const nom = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: item.id },
    });
    expect(nom.quantity).toBe(5);
    expect(d(nom.nomenclatureValue)!.equals(q6(80))).toBe(true);
    expect(nom.costVersion).toBeGreaterThan(0);
  });

  it("PRISADKA quantity correction re-applies current source without live rates", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const input = {
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 2,
      picks: [{ lengthM: 1.8, sort: "SORT1" as const, quantity: 2 }],
      clientRequestId: `corr-tor-${world.suffix}`,
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
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `corr-pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    await updateProductionLineQuantity(op.id, 0, 2);
    const after = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    const qty = after.lines.reduce((s, l) => s + l.quantity, 0);
    expect(qty).toBe(2);
    expect(after.lines.every((l) => l.pieceLaborCost != null)).toBe(true);
  });

  it("concurrent PRISADKA consume same blank and land on same dest", { timeout: CONCURRENCY_TIMEOUT_MS }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const input = {
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 3,
      picks: [{ lengthM: 1.8, sort: "SORT1" as const, quantity: 3 }],
      clientRequestId: `cpr-tor-${world.suffix}`,
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
    const results = await raceSettled("prisadka-same-dest", [
      submitPrisadka({
        employeeId: world.emp.id,
        clientRequestId: `cpr-a-${world.suffix}`,
        picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
      }),
      submitPrisadka({
        employeeId: world.emp.id,
        clientRequestId: `cpr-b-${world.suffix}`,
        picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
      }),
    ]);
    expectNoDeadlock(results);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const dest = await prismaA.detailStock.findFirstOrThrow({
      where: { detailId: world.detail.id, torcevayaDone: true },
    });
    expect(dest.quantity).toBe(2);
    expect(dest.costVersion).toBeGreaterThan(0);
    expect(d(dest.totalValue)!.equals(d(dest.materialValue)!.plus(d(dest.laborValue)!))).toBe(true);
    expect(d(dest.materialValue)!.isNeg()).toBe(false);
  });

  it("concurrent UPAKOVKA consume same WIP onto same ProductStock", { timeout: CONCURRENCY_TIMEOUT_MS }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const input = {
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 3,
      picks: [{ lengthM: 1.8, sort: "SORT1" as const, quantity: 3 }],
      clientRequestId: `cup-tor-${world.suffix}`,
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
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `cup-pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 2 }],
    });
    await createSimplePurchase({
      nomenclatureId: world.fastener.id,
      quantity: 10,
      unitPrice: 12,
      purchaseDate: "2026-01-20",
    });
    const results = await raceSettled("upakovka-same-product", [
      submitUpakovka({
        employeeId: world.emp.id,
        clientRequestId: `cup-a-${world.suffix}`,
        picks: [{ productId: world.product.id, quantity: 1 }],
      }),
      submitUpakovka({
        employeeId: world.emp.id,
        clientRequestId: `cup-b-${world.suffix}`,
        picks: [{ productId: world.product.id, quantity: 1 }],
      }),
    ]);
    expectNoDeadlock(results);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const product = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: world.product.id },
    });
    expect(product.quantity).toBe(2);
    expect(d(product.totalValue)!.equals(
      d(product.materialValue)!.plus(d(product.laborValue)!).plus(d(product.nomenclatureValue)!),
    )).toBe(true);
    expect(d(product.materialValue)!.isNeg()).toBe(false);
  });

  async function raceSettled(label: string, tasks: Array<Promise<unknown>>): Promise<PromiseSettledResult<unknown>[]> {
    return Promise.race([
      Promise.allSettled(tasks),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`QueryTimeout: ${label} exceeded ${CONCURRENCY_TIMEOUT_MS}ms`)),
          CONCURRENCY_TIMEOUT_MS,
        ),
      ),
    ]);
  }

  it("active inventory TOCTOU: cannot validate then lose the race before monetary apply", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const start = await prismaA.productStock.create({
      data: {
        productId: world.product.id,
        quantity: 10,
        materialValue: new Prisma.Decimal("100"),
        laborValue: new Prisma.Decimal("0"),
        nomenclatureValue: new Prisma.Decimal("0"),
        totalValue: new Prisma.Decimal("100"),
        costVersion: 1,
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
              refId: world.product.id,
              accountedQty: 10,
              actualQty: 8,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    const writer = prismaB.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ProductStock" WHERE id = ${start.id} FOR UPDATE`;
      const updated = await tx.productStock.updateMany({
        where: { id: start.id, costVersion: start.costVersion, quantity: start.quantity },
        data: {
          quantity: { decrement: 1 },
          costVersion: { increment: 1 },
          materialValue: new Prisma.Decimal("90"),
          totalValue: new Prisma.Decimal("90"),
        },
      });
      if (updated.count !== 1) throw new Error("writer-lost");
    });
    const results = await raceSettled("inventory-toctou", [conductInventory(doc.id), writer]);
    expectNoDeadlock(results);
    const inv = results[0]!;
    const wr = results[1]!;
    const stock = await prismaA.productStock.findUniqueOrThrow({ where: { productId: world.product.id } });
    const afterDoc = await prismaA.inventory.findUniqueOrThrow({ where: { id: doc.id } });
    const invOk = inv.status === "fulfilled";
    const writerOk = wr.status === "fulfilled";
    expect(invOk && writerOk).toBe(false);
    if (invOk) {
      expect(afterDoc.status).toBe("CONDUCTED");
      expect(stock.quantity).toBe(8);
      expect(d(stock.materialValue)!.equals(q6(80))).toBe(true);
      expect(writerOk).toBe(false);
    } else {
      expect(afterDoc.status).toBe("DRAFT");
      expect(errorMessage((inv as PromiseRejectedResult).reason)).toBe(STALE_SNAPSHOT);
      expect(writerOk).toBe(true);
      expect(stock.quantity).toBe(9);
      expect(d(stock.materialValue)!.equals(q6(90))).toBe(true);
    }
  });

  it("inventory locks NomenclatureStock before ProductStock regardless of document line order", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    await prismaA.productStock.create({
      data: {
        productId: world.product.id,
        quantity: 4,
        materialValue: new Prisma.Decimal("40"),
        laborValue: new Prisma.Decimal("0"),
        nomenclatureValue: new Prisma.Decimal("0"),
        totalValue: new Prisma.Decimal("40"),
        costVersion: 1,
      },
    });
    await prismaA.nomenclatureStock.create({
      data: {
        nomenclatureId: world.fastener.id,
        quantity: 6,
        nomenclatureValue: new Prisma.Decimal("60"),
        totalValue: new Prisma.Decimal("60"),
        costVersion: 1,
      },
    });
    const nomRow = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: world.fastener.id },
    });
    const productRow = await prismaA.productStock.findUniqueOrThrow({ where: { productId: world.product.id } });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: world.product.id,
              accountedQty: 4,
              actualQty: 4,
              deviation: 0,
              deviationSum: 0,
            },
            {
              refType: "NOMENCLATURE",
              refId: world.fastener.id,
              accountedQty: 6,
              actualQty: 6,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    const opposite = prismaB.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "NomenclatureStock" WHERE id = ${nomRow.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "ProductStock" WHERE id = ${productRow.id} FOR UPDATE`;
    });
    const results = await raceSettled("inventory-lock-order", [conductInventory(doc.id), opposite]);
    expectNoDeadlock(results);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    const after = await prismaA.inventory.findUniqueOrThrow({ where: { id: doc.id } });
    expect(after.status).toBe("CONDUCTED");
  });

  it("DETAIL surplus/shortage uses aggregate ready-pool WAC across two buckets", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const detail = world.detail;
    await prismaA.detailStock.create({
      data: {
        detailId: detail.id,
        torcevayaDone: true,
        ploskostDone: true,
        quantity: 1,
        materialValue: new Prisma.Decimal("200"),
        laborValue: new Prisma.Decimal("20"),
        totalValue: new Prisma.Decimal("220"),
        costVersion: 1,
      },
    });
    await prismaA.detailStock.create({
      data: {
        detailId: detail.id,
        torcevayaDone: true,
        ploskostDone: false,
        quantity: 1,
        materialValue: new Prisma.Decimal("100"),
        laborValue: new Prisma.Decimal("10"),
        totalValue: new Prisma.Decimal("110"),
        costVersion: 1,
      },
    });
    const surplusDoc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: detail.id,
              accountedQty: 2,
              actualQty: 3,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(surplusDoc.id);
    const gain = await prismaA.costEvent.findFirstOrThrow({
      where: { type: "INVENTORY_GAIN", inventoryId: surplusDoc.id },
    });
    expect(d(gain.materialValue)!.equals(q6(150))).toBe(true);
    expect(d(gain.laborValue)!.equals(q6(15))).toBe(true);
    const afterSurplus = await prismaA.detailStock.findMany({ where: { detailId: detail.id } });
    const readySurplus = afterSurplus.filter((r) => r.torcevayaDone);
    const surplusQty = readySurplus.reduce((s, r) => s + r.quantity, 0);
    const surplusMat = readySurplus.reduce((s, r) => s.plus(d(r.materialValue) ?? D(0)), D(0));
    const surplusLab = readySurplus.reduce((s, r) => s.plus(d(r.laborValue) ?? D(0)), D(0));
    expect(surplusQty).toBe(3);
    expect(surplusMat.equals(q6(450))).toBe(true);
    expect(surplusLab.equals(q6(45))).toBe(true);
  });

  it("DETAIL shortage uses aggregate ready-pool WAC across two buckets independent of id order", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const detail = world.detail;
    await prismaA.detailStock.create({
      data: {
        detailId: detail.id,
        torcevayaDone: true,
        ploskostDone: true,
        quantity: 1,
        materialValue: new Prisma.Decimal("200"),
        laborValue: new Prisma.Decimal("20"),
        totalValue: new Prisma.Decimal("220"),
        costVersion: 1,
      },
    });
    await prismaA.detailStock.create({
      data: {
        detailId: detail.id,
        torcevayaDone: true,
        ploskostDone: false,
        quantity: 1,
        materialValue: new Prisma.Decimal("100"),
        laborValue: new Prisma.Decimal("10"),
        totalValue: new Prisma.Decimal("110"),
        costVersion: 1,
      },
    });
    const shortageDoc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: detail.id,
              accountedQty: 2,
              actualQty: 1,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    await conductInventory(shortageDoc.id);
    const loss = await prismaA.costEvent.findFirstOrThrow({
      where: { type: "INVENTORY_LOSS", inventoryId: shortageDoc.id },
    });
    expect(d(loss.materialValue)!.equals(q6(150))).toBe(true);
    expect(d(loss.laborValue)!.equals(q6(15))).toBe(true);
    const afterShortage = await prismaA.detailStock.findMany({ where: { detailId: detail.id } });
    const readyShortage = afterShortage.filter((r) => r.quantity > 0 && (r.torcevayaDone || r.ploskostDone));
    const shortageQty = readyShortage.reduce((s, r) => s + r.quantity, 0);
    const shortageMat = readyShortage.reduce((s, r) => s.plus(d(r.materialValue) ?? D(0)), D(0));
    const shortageLab = readyShortage.reduce((s, r) => s.plus(d(r.laborValue) ?? D(0)), D(0));
    expect(shortageQty).toBe(1);
    expect(shortageMat.equals(q6(150))).toBe(true);
    expect(shortageLab.equals(q6(15))).toBe(true);
  });

  it("PRISADKA split-source correction keeps shared outputCostVersion then exact reverse", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
        materialValue: new Prisma.Decimal("200"),
        laborValue: new Prisma.Decimal("0"),
        totalValue: new Prisma.Decimal("200"),
        costVersion: 1,
      },
    });
    await prismaA.detailStock.create({
      data: {
        detailId: world.detail.id,
        torcevayaDone: false,
        ploskostDone: false,
        quantity: 1,
        materialValue: new Prisma.Decimal("50"),
        laborValue: new Prisma.Decimal("10"),
        totalValue: new Prisma.Decimal("60"),
        costVersion: 1,
      },
    });
    const blank0 = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: world.material.id, lengthM: new Prisma.Decimal("1.8000") },
    });
    const partial0 = await prismaA.detailStock.findFirstOrThrow({
      where: { detailId: world.detail.id, torcevayaDone: false, ploskostDone: false },
    });
    const eventsBefore = await prismaA.costEvent.count();
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `split-pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 2 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    expect(op.lines.some((l) => l.sourceIsBlank)).toBe(true);
    expect(op.lines.some((l) => !l.sourceIsBlank)).toBe(true);
    await updateProductionLineQuantity(op.id, 0, 2);
    const corrected = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    const dest = await prismaA.detailStock.findFirstOrThrow({
      where: { detailId: world.detail.id, torcevayaDone: true, ploskostDone: false },
    });
    const destSharing = corrected.lines.filter((l) => l.detailId === world.detail.id);
    expect(destSharing.length).toBeGreaterThan(1);
    expect(new Set(destSharing.map((l) => l.outputCostVersion)).size).toBe(1);
    expect(destSharing[0]!.outputCostVersion).toBe(dest.costVersion);
    await deleteProductionOperation(op.id);
    const destAfter = await prismaA.detailStock.findFirst({
      where: { detailId: world.detail.id, torcevayaDone: true, ploskostDone: false },
    });
    expect(destAfter?.quantity ?? 0).toBe(0);
    expect(d(destAfter?.materialValue ?? 0)!.equals(q6(0))).toBe(true);
    expect(d(destAfter?.laborValue ?? 0)!.equals(q6(0))).toBe(true);
    const blankAfter = await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank0.id } });
    const partialAfter = await prismaA.detailStock.findUniqueOrThrow({ where: { id: partial0.id } });
    expect(blankAfter.quantity).toBe(blank0.quantity);
    expect(d(blankAfter.materialValue)!.equals(d(blank0.materialValue)!)).toBe(true);
    expect(d(blankAfter.laborValue)!.equals(d(blank0.laborValue)!)).toBe(true);
    expect(partialAfter.quantity).toBe(partial0.quantity);
    expect(d(partialAfter.materialValue)!.equals(d(partial0.materialValue)!)).toBe(true);
    expect(d(partialAfter.laborValue)!.equals(d(partial0.laborValue)!)).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(0);
    expect(await prismaA.costEvent.count()).toBe(eventsBefore);
  });

  it("exact UPAKOVKA reverse restores WIP, nomenclature, and removes packer piece labor", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    await createdTorcovka(world, `exup-tor-${world.suffix}`);
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `exup-pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    await createSimplePurchase({
      nomenclatureId: world.fastener.id,
      quantity: 10,
      unitPrice: 12,
      purchaseDate: "2026-01-20",
    });
    const wipBefore = await prismaA.detailStock.findFirstOrThrow({
      where: { detailId: world.detail.id, torcevayaDone: true },
    });
    const nomBefore = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: world.fastener.id },
    });
    await submitUpakovka({
      employeeId: world.emp.id,
      clientRequestId: `exup-up-${world.suffix}`,
      picks: [{ productId: world.product.id, quantity: 1 }],
    });
    const pack = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "UPAKOVKA" },
      include: { lines: true, nomenclatureLines: true },
    });
    expect(d(pack.pieceLaborCost)!.equals(q6(6))).toBe(true);
    const eventsBefore = await prismaA.costEvent.count();
    await deleteProductionOperation(pack.id);
    const product = await prismaA.productStock.findUniqueOrThrow({ where: { productId: world.product.id } });
    expect(product.quantity).toBe(0);
    expect(d(product.materialValue)!.equals(q6(0))).toBe(true);
    expect(d(product.laborValue)!.equals(q6(0))).toBe(true);
    expect(d(product.nomenclatureValue)!.equals(q6(0))).toBe(true);
    const wipAfter = await prismaA.detailStock.findUniqueOrThrow({ where: { id: wipBefore.id } });
    expect(wipAfter.quantity).toBe(wipBefore.quantity);
    expect(d(wipAfter.materialValue)!.equals(d(wipBefore.materialValue)!)).toBe(true);
    expect(d(wipAfter.laborValue)!.equals(d(wipBefore.laborValue)!)).toBe(true);
    const nomAfter = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: world.fastener.id },
    });
    expect(nomAfter.quantity).toBe(nomBefore.quantity);
    expect(d(nomAfter.nomenclatureValue)!.equals(d(nomBefore.nomenclatureValue)!)).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { id: pack.id } })).toBe(0);
    expect(await prismaA.costEvent.count()).toBe(eventsBefore);
  });

  it("UPAKOVKA reverse vs inventory on Nom+Product does not deadlock", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    await createdTorcovka(world, `rvlock-tor-${world.suffix}`);
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `rvlock-pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    await createSimplePurchase({
      nomenclatureId: world.fastener.id,
      quantity: 10,
      unitPrice: 12,
      purchaseDate: "2026-01-20",
    });
    await submitUpakovka({
      employeeId: world.emp.id,
      clientRequestId: `rvlock-up-${world.suffix}`,
      picks: [{ productId: world.product.id, quantity: 1 }],
    });
    const pack = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "UPAKOVKA" } });
    const product = await prismaA.productStock.findUniqueOrThrow({ where: { productId: world.product.id } });
    const nom = await prismaA.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId: world.fastener.id },
    });
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: world.product.id,
              accountedQty: product.quantity,
              actualQty: product.quantity,
              deviation: 0,
              deviationSum: 0,
            },
            {
              refType: "NOMENCLATURE",
              refId: world.fastener.id,
              accountedQty: nom.quantity,
              actualQty: nom.quantity,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    const results = await raceSettled("reverse-vs-inventory", [
      conductInventory(doc.id),
      deleteProductionOperation(pack.id),
    ]);
    expectNoDeadlock(results);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    for (const r of results) {
      if (r.status === "rejected") {
        expect(errorMessage(r.reason).startsWith("QueryTimeout")).toBe(false);
      }
    }
  });

  it("absent ProductStock inventory serializes against concurrent UPAKOVKA receipt", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    await createdTorcovka(world, `abs-p-tor-${world.suffix}`);
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `abs-p-pr-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    await createSimplePurchase({
      nomenclatureId: world.fastener.id,
      quantity: 10,
      unitPrice: 12,
      purchaseDate: "2026-01-20",
    });
    expect(await prismaA.productStock.findUnique({ where: { productId: world.product.id } })).toBeNull();
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "PRODUCT",
              refId: world.product.id,
              accountedQty: 0,
              actualQty: 0,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    const results = await raceSettled("absent-product-toctou", [
      conductInventory(doc.id),
      submitUpakovka({
        employeeId: world.emp.id,
        clientRequestId: `abs-p-up-${world.suffix}`,
        picks: [{ productId: world.product.id, quantity: 1 }],
      }),
    ]);
    expectNoDeadlock(results);
    const inv = results[0]!;
    const writer = results[1]!;
    const stock = await prismaA.productStock.findUnique({ where: { productId: world.product.id } });
    const after = await prismaA.inventory.findUniqueOrThrow({ where: { id: doc.id } });
    if (inv.status === "fulfilled") {
      expect(after.status).toBe("CONDUCTED");
      expect(await prismaA.costEvent.count({ where: { inventoryId: doc.id } })).toBe(0);
      if (writer.status === "fulfilled") {
        expect(stock?.quantity).toBe(1);
      } else {
        expect(stock?.quantity ?? 0).toBe(0);
      }
    } else {
      expect(errorMessage((inv as PromiseRejectedResult).reason)).toBe(STALE_SNAPSHOT);
      expect(writer.status).toBe("fulfilled");
      expect(stock?.quantity).toBe(1);
      expect(after.status).toBe("DRAFT");
    }
  });

  it("absent NomenclatureStock inventory serializes against concurrent SimplePurchase", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    expect(
      await prismaA.nomenclatureStock.findUnique({ where: { nomenclatureId: world.fastener.id } }),
    ).toBeNull();
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "NOMENCLATURE",
              refId: world.fastener.id,
              accountedQty: 0,
              actualQty: 0,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    const results = await raceSettled("absent-nom-toctou", [
      conductInventory(doc.id),
      createSimplePurchase({
        nomenclatureId: world.fastener.id,
        quantity: 2,
        unitPrice: 12,
        purchaseDate: "2026-01-20",
      }),
    ]);
    expectNoDeadlock(results);
    const inv = results[0]!;
    const writer = results[1]!;
    const nom = await prismaA.nomenclatureStock.findUnique({
      where: { nomenclatureId: world.fastener.id },
    });
    const after = await prismaA.inventory.findUniqueOrThrow({ where: { id: doc.id } });
    if (inv.status === "fulfilled") {
      expect(after.status).toBe("CONDUCTED");
      expect(await prismaA.costEvent.count({ where: { inventoryId: doc.id } })).toBe(0);
      if (writer.status === "fulfilled") {
        expect(nom?.quantity).toBe(2);
        expect(d(nom?.nomenclatureValue)!.equals(q6(24))).toBe(true);
      } else {
        expect(nom?.quantity ?? 0).toBe(0);
      }
    } else {
      expect(errorMessage((inv as PromiseRejectedResult).reason)).toBe(STALE_SNAPSHOT);
      expect(writer.status).toBe("fulfilled");
      expect(nom?.quantity).toBe(2);
      expect(after.status).toBe("DRAFT");
    }
  });

  it("absent BlankStock inventory serializes against concurrent TORCOVKA receive", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const detNoPris = await prismaA.detail.create({
      data: {
        name: `blank-abs-${world.suffix}`,
        materialId: world.material.id,
        detailNumber: 8,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    const existingBlank = await prismaA.blankStock.findFirst({
      where: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
      },
    });
    expect(existingBlank).toBeNull();
    const doc = await prismaA.inventory.create({
      data: {
        date: new Date(),
        status: "DRAFT",
        lines: {
          create: [
            {
              refType: "DETAIL",
              refId: detNoPris.id,
              accountedQty: 0,
              actualQty: 0,
              deviation: 0,
              deviationSum: 0,
            },
          ],
        },
      },
    });
    const results = await raceSettled("absent-blank-toctou", [
      conductInventory(doc.id),
      createdTorcovka(world, `abs-b-tor-${world.suffix}`),
    ]);
    expectNoDeadlock(results);
    const inv = results[0]!;
    const writer = results[1]!;
    const blank = await prismaA.blankStock.findFirst({
      where: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
      },
    });
    const after = await prismaA.inventory.findUniqueOrThrow({ where: { id: doc.id } });
    if (inv.status === "fulfilled") {
      expect(after.status).toBe("CONDUCTED");
      expect(await prismaA.costEvent.count({ where: { inventoryId: doc.id } })).toBe(0);
      if (writer.status === "fulfilled") {
        expect(blank?.quantity).toBe(1);
      } else {
        expect(blank?.quantity ?? 0).toBe(0);
      }
    } else {
      expect(errorMessage((inv as PromiseRejectedResult).reason)).toBe(STALE_SNAPSHOT);
      expect(writer.status).toBe("fulfilled");
      expect(blank?.quantity).toBe(1);
      expect(after.status).toBe("DRAFT");
    }
  });

  it("deleteDetail vs active DetailStock writer is atomic fail-closed", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const orphan = await prismaA.detail.create({
      data: {
        name: `del-${world.suffix}`,
        materialId: world.material.id,
        detailNumber: 11,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 1,
        materialValue: new Prisma.Decimal("40"),
        laborValue: new Prisma.Decimal("0"),
        totalValue: new Prisma.Decimal("40"),
        costVersion: 1,
      },
    });
    const results = await raceSettled("delete-vs-prisadka", [
      deleteDetail(orphan.id),
      submitPrisadka({
        employeeId: world.emp.id,
        clientRequestId: `del-pr-${world.suffix}`,
        picks: [{ detailId: orphan.id, kind: "torcev", quantity: 1 }],
      }),
    ]);
    expectNoDeadlock(results);
    const del = results[0]!;
    const writer = results[1]!;
    const detail = await prismaA.detail.findUnique({ where: { id: orphan.id } });
    const stocks = await prismaA.detailStock.findMany({ where: { detailId: orphan.id } });
    const moneyStocks = stocks.filter((s) => s.costVersion > 0 && s.quantity > 0);
    if (moneyStocks.length > 0) {
      expect(detail).not.toBeNull();
      expect(del.status).toBe("rejected");
      expect(errorMessage((del as PromiseRejectedResult).reason)).toBe(COST_FLOW_QTY_ONLY_WRITER);
    }
    if (del.status === "fulfilled") {
      expect(detail).toBeNull();
      expect(stocks).toHaveLength(0);
      expect(writer.status).toBe("rejected");
    }
    if (writer.status === "fulfilled") {
      expect(detail).not.toBeNull();
      expect(moneyStocks.length).toBeGreaterThan(0);
    }
  });

  it("one PRISADKA operation with two picks sharing dest has one outputCostVersion and exact reverse", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const both = await prismaA.detail.create({
      data: {
        name: `both-${world.suffix}`,
        materialId: world.material.id,
        detailNumber: 12,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    const torcevOnly = await prismaA.detailStock.create({
      data: {
        detailId: both.id,
        torcevayaDone: true,
        ploskostDone: false,
        quantity: 1,
        materialValue: new Prisma.Decimal("100"),
        laborValue: new Prisma.Decimal("10"),
        totalValue: new Prisma.Decimal("110"),
        costVersion: 1,
      },
    });
    const ploskOnly = await prismaA.detailStock.create({
      data: {
        detailId: both.id,
        torcevayaDone: false,
        ploskostDone: true,
        quantity: 1,
        materialValue: new Prisma.Decimal("80"),
        laborValue: new Prisma.Decimal("5"),
        totalValue: new Prisma.Decimal("85"),
        costVersion: 1,
      },
    });
    const eventsBefore = await prismaA.costEvent.count();
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `shared-dest-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "torcev", quantity: 1 },
        { detailId: both.id, kind: "plosk", quantity: 1 },
      ],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const dest = await prismaA.detailStock.findFirstOrThrow({
      where: { detailId: both.id, torcevayaDone: true, ploskostDone: true },
    });
    expect(dest.quantity).toBe(2);
    expect(new Set(op.lines.map((l) => l.outputCostVersion)).size).toBe(1);
    expect(op.lines[0]!.outputCostVersion).toBe(dest.costVersion);
    expect(d(op.pieceLaborCost)!.equals(q6(9))).toBe(true);
    await deleteProductionOperation(op.id);
    const destAfter = await prismaA.detailStock.findUniqueOrThrow({ where: { id: dest.id } });
    expect(destAfter.quantity).toBe(0);
    expect(d(destAfter.materialValue)!.equals(q6(0))).toBe(true);
    expect(d(destAfter.laborValue)!.equals(q6(0))).toBe(true);
    const torcevRestored = await prismaA.detailStock.findUniqueOrThrow({ where: { id: torcevOnly.id } });
    const ploskRestored = await prismaA.detailStock.findUniqueOrThrow({ where: { id: ploskOnly.id } });
    expect(torcevRestored.quantity).toBe(1);
    expect(d(torcevRestored.materialValue)!.equals(q6(100))).toBe(true);
    expect(d(torcevRestored.laborValue)!.equals(q6(10))).toBe(true);
    expect(ploskRestored.quantity).toBe(1);
    expect(d(ploskRestored.materialValue)!.equals(q6(80))).toBe(true);
    expect(d(ploskRestored.laborValue)!.equals(q6(5))).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(0);
    expect(await prismaA.costEvent.count()).toBe(eventsBefore);
  });

  it("mixed-kind same-destination PRISADKA correction then exact reverse", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const both = await prismaA.detail.create({
      data: {
        name: `mixcorr-${world.suffix}`,
        materialId: world.material.id,
        detailNumber: 13,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    const torcevSrc = await prismaA.detailStock.create({
      data: {
        detailId: both.id,
        torcevayaDone: true,
        ploskostDone: false,
        quantity: 2,
        materialValue: new Prisma.Decimal("200"),
        laborValue: new Prisma.Decimal("20"),
        totalValue: new Prisma.Decimal("220"),
        costVersion: 1,
      },
    });
    const ploskSrc = await prismaA.detailStock.create({
      data: {
        detailId: both.id,
        torcevayaDone: false,
        ploskostDone: true,
        quantity: 2,
        materialValue: new Prisma.Decimal("160"),
        laborValue: new Prisma.Decimal("10"),
        totalValue: new Prisma.Decimal("170"),
        costVersion: 1,
      },
    });
    const eventsBefore = await prismaA.costEvent.count();
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `mixcorr-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "torcev", quantity: 2 },
        { detailId: both.id, kind: "plosk", quantity: 2 },
      ],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const dest = await prismaA.detailStock.findFirstOrThrow({
      where: { detailId: both.id, torcevayaDone: true, ploskostDone: true },
    });
    expect(dest.quantity).toBe(4);
    expect(op.lines.some((l) => l.prisadkaTorcevaya)).toBe(true);
    expect(op.lines.some((l) => l.prisadkaPloskost)).toBe(true);
    expect(new Set(op.lines.map((l) => l.outputCostVersion)).size).toBe(1);
    expect(op.lines[0]!.outputCostVersion).toBe(dest.costVersion);
    expect(d(op.pieceLaborCost)!.equals(q6(18))).toBe(true);

    await prismaA.employee.update({
      where: { id: world.emp.id },
      data: { ratePrisadkaTorcev: 99, ratePrisadkaPloskt: 88 },
    });
    const torcevIndex = op.lines.findIndex((l) => l.prisadkaTorcevaya);
    expect(torcevIndex).toBeGreaterThanOrEqual(0);
    await updateProductionLineQuantity(op.id, torcevIndex, 1);

    const corrected = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    const destAfterCorr = await prismaA.detailStock.findUniqueOrThrow({ where: { id: dest.id } });
    const torcevQty = corrected.lines.filter((l) => l.prisadkaTorcevaya).reduce((s, l) => s + l.quantity, 0);
    const ploskQty = corrected.lines.filter((l) => l.prisadkaPloskost).reduce((s, l) => s + l.quantity, 0);
    expect(torcevQty).toBe(1);
    expect(ploskQty).toBe(2);
    expect(destAfterCorr.quantity).toBe(3);
    expect(d(destAfterCorr.materialValue)!.equals(q6(280))).toBe(true);
    expect(d(destAfterCorr.laborValue)!.equals(q6(38))).toBe(true);
    expect(new Set(corrected.lines.map((l) => l.outputCostVersion)).size).toBe(1);
    expect(corrected.lines[0]!.outputCostVersion).toBe(destAfterCorr.costVersion);
    const linePieceSum = corrected.lines.reduce((s, l) => s.plus(d(l.pieceLaborCost)!), D(0));
    expect(d(corrected.pieceLaborCost)!.equals(q6(13))).toBe(true);
    expect(d(corrected.pieceLaborCost)!.equals(q6(linePieceSum))).toBe(true);
    expect(d(corrected.pieceLaborCost)!.equals(q6(99 + 176))).toBe(false);
    const torcevAfterCorr = await prismaA.detailStock.findUniqueOrThrow({ where: { id: torcevSrc.id } });
    const ploskAfterCorr = await prismaA.detailStock.findUniqueOrThrow({ where: { id: ploskSrc.id } });
    expect(torcevAfterCorr.quantity).toBe(0);
    expect(d(torcevAfterCorr.materialValue)!.equals(q6(0))).toBe(true);
    expect(d(torcevAfterCorr.laborValue)!.equals(q6(0))).toBe(true);
    expect(ploskAfterCorr.quantity).toBe(1);
    expect(d(ploskAfterCorr.materialValue)!.equals(q6(80))).toBe(true);
    expect(d(ploskAfterCorr.laborValue)!.equals(q6(5))).toBe(true);
    expect(await prismaA.costEvent.count()).toBe(eventsBefore);

    await deleteProductionOperation(op.id);
    const destAfterDel = await prismaA.detailStock.findUniqueOrThrow({ where: { id: dest.id } });
    expect(destAfterDel.quantity).toBe(0);
    expect(d(destAfterDel.materialValue)!.equals(q6(0))).toBe(true);
    expect(d(destAfterDel.laborValue)!.equals(q6(0))).toBe(true);
    const torcevRestored = await prismaA.detailStock.findUniqueOrThrow({ where: { id: torcevSrc.id } });
    const ploskRestored = await prismaA.detailStock.findUniqueOrThrow({ where: { id: ploskSrc.id } });
    expect(torcevRestored.quantity).toBe(2);
    expect(d(torcevRestored.materialValue)!.equals(q6(200))).toBe(true);
    expect(d(torcevRestored.laborValue)!.equals(q6(20))).toBe(true);
    expect(ploskRestored.quantity).toBe(2);
    expect(d(ploskRestored.materialValue)!.equals(q6(160))).toBe(true);
    expect(d(ploskRestored.laborValue)!.equals(q6(10))).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(0);
    expect(await prismaA.costEvent.count()).toBe(eventsBefore);
  });

  it("legacy inactive sequential PRISADKA torcev then plosk from blanks chains to (true,true)", async () => {
    const world = await seedChain();
    const both = await createBothPrisadkaDetail(world, 40);
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `legacy-chain-tp-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "torcev", quantity: 2 },
        { detailId: both.id, kind: "plosk", quantity: 2 },
      ],
    });
    expect(await chainTopology(both.id, world.material.id)).toEqual({
      blank: 0,
      tf: 0,
      ft: 0,
      tt: 2,
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    expect(op.lines.some((l) => l.prisadkaTorcevaya && l.sourceIsBlank)).toBe(true);
    expect(op.lines.some((l) => l.prisadkaPloskost && !l.sourceIsBlank)).toBe(true);
  });

  it("legacy inactive sequential PRISADKA plosk then torcev from blanks chains to (true,true)", async () => {
    const world = await seedChain();
    const both = await createBothPrisadkaDetail(world, 41);
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `legacy-chain-pt-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "plosk", quantity: 2 },
        { detailId: both.id, kind: "torcev", quantity: 2 },
      ],
    });
    expect(await chainTopology(both.id, world.material.id)).toEqual({
      blank: 0,
      tf: 0,
      ft: 0,
      tt: 2,
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    expect(op.lines.some((l) => l.prisadkaPloskost && l.sourceIsBlank)).toBe(true);
    expect(op.lines.some((l) => l.prisadkaTorcevaya && !l.sourceIsBlank)).toBe(true);
  });

  it("legacy inactive chained PRISADKA: upstream quantity correction is rejected", async () => {
    const world = await seedChain();
    const both = await createBothPrisadkaDetail(world, 42);
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `legacy-corr-up-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "torcev", quantity: 2 },
        { detailId: both.id, kind: "plosk", quantity: 2 },
      ],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const torcevIndex = op.lines.findIndex((l) => l.prisadkaTorcevaya);
    await expect(updateProductionLineQuantity(op.id, torcevIndex, 1)).rejects.toThrow(
      "Нельзя изменить/удалить: деталь уже использована в упаковке или дальнейшей присадке",
    );
    expect(await chainTopology(both.id, world.material.id)).toEqual({
      blank: 0,
      tf: 0,
      ft: 0,
      tt: 2,
    });
  });

  it("legacy inactive chained PRISADKA: downstream quantity correction then remaining topology", async () => {
    const world = await seedChain();
    const both = await createBothPrisadkaDetail(world, 43);
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `legacy-corr-dn-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "torcev", quantity: 2 },
        { detailId: both.id, kind: "plosk", quantity: 2 },
      ],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const ploskIndex = op.lines.findIndex((l) => l.prisadkaPloskost);
    await updateProductionLineQuantity(op.id, ploskIndex, 1);
    expect(await chainTopology(both.id, world.material.id)).toEqual({
      blank: 0,
      tf: 1,
      ft: 0,
      tt: 1,
    });
  });

  it("active sequential PRISADKA torcev then plosk matches legacy topology and money", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const both = await createBothPrisadkaDetail(world, 50);
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
        materialValue: new Prisma.Decimal("200"),
        laborValue: new Prisma.Decimal("20"),
        totalValue: new Prisma.Decimal("220"),
        costVersion: 1,
      },
    });
    const eventsBefore = await prismaA.costEvent.count();
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `active-chain-tp-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "torcev", quantity: 2 },
        { detailId: both.id, kind: "plosk", quantity: 2 },
      ],
    });
    expect(await chainTopology(both.id, world.material.id)).toEqual({
      blank: 0,
      tf: 0,
      ft: 0,
      tt: 2,
    });
    const dest = await prismaA.detailStock.findUniqueOrThrow({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: both.id,
          torcevayaDone: true,
          ploskostDone: true,
        },
      },
    });
    expect(d(dest.materialValue)!.equals(q6(200))).toBe(true);
    expect(d(dest.laborValue)!.equals(q6(38))).toBe(true);
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    expect(op.lines.some((l) => l.prisadkaTorcevaya && l.sourceIsBlank)).toBe(true);
    expect(op.lines.some((l) => l.prisadkaPloskost && !l.sourceIsBlank)).toBe(true);
    expect(new Set(op.lines.filter((l) => {
      const destT = l.sourceIsBlank ? l.prisadkaTorcevaya : true;
      const destP = l.sourceIsBlank ? l.prisadkaPloskost : l.prisadkaPloskost ? true : l.sourcePloskostDone;
      return destT && destP;
    }).map((l) => l.outputCostVersion)).size).toBe(1);
    expect(op.lines.find((l) => l.prisadkaPloskost)!.outputCostVersion).toBe(dest.costVersion);
    expect(d(op.pieceLaborCost)!.equals(q6(18))).toBe(true);
    expect(await prismaA.costEvent.count()).toBe(eventsBefore);
  });

  it("active sequential PRISADKA plosk then torcev matches legacy topology", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const both = await createBothPrisadkaDetail(world, 51);
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
        materialValue: new Prisma.Decimal("200"),
        laborValue: new Prisma.Decimal("20"),
        totalValue: new Prisma.Decimal("220"),
        costVersion: 1,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `active-chain-pt-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "plosk", quantity: 2 },
        { detailId: both.id, kind: "torcev", quantity: 2 },
      ],
    });
    expect(await chainTopology(both.id, world.material.id)).toEqual({
      blank: 0,
      tf: 0,
      ft: 0,
      tt: 2,
    });
    const dest = await prismaA.detailStock.findUniqueOrThrow({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: both.id,
          torcevayaDone: true,
          ploskostDone: true,
        },
      },
    });
    expect(d(dest.materialValue)!.equals(q6(200))).toBe(true);
    expect(d(dest.laborValue)!.equals(q6(38))).toBe(true);
  });

  it("active sequential PRISADKA chain exact reverse restores pre-operation pools", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const both = await createBothPrisadkaDetail(world, 52);
    const blank = await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
        materialValue: new Prisma.Decimal("200"),
        laborValue: new Prisma.Decimal("20"),
        totalValue: new Prisma.Decimal("220"),
        costVersion: 1,
      },
    });
    const eventsBefore = await prismaA.costEvent.count();
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `active-chain-rev-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "torcev", quantity: 2 },
        { detailId: both.id, kind: "plosk", quantity: 2 },
      ],
    });
    await prismaA.employee.update({
      where: { id: world.emp.id },
      data: { ratePrisadkaTorcev: 99, ratePrisadkaPloskt: 88 },
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "PRISADKA" } });
    await deleteProductionOperation(op.id);
    const blankAfter = await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } });
    expect(blankAfter.quantity).toBe(2);
    expect(d(blankAfter.materialValue)!.equals(q6(200))).toBe(true);
    expect(d(blankAfter.laborValue)!.equals(q6(20))).toBe(true);
    expect(await detailBucketQty(both.id, true, false)).toBe(0);
    expect(await detailBucketQty(both.id, false, true)).toBe(0);
    expect(await detailBucketQty(both.id, true, true)).toBe(0);
    const tf = await prismaA.detailStock.findUnique({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: both.id,
          torcevayaDone: true,
          ploskostDone: false,
        },
      },
    });
    const tt = await prismaA.detailStock.findUnique({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: both.id,
          torcevayaDone: true,
          ploskostDone: true,
        },
      },
    });
    if (tf) {
      expect(d(tf.materialValue)!.equals(q6(0))).toBe(true);
      expect(d(tf.laborValue)!.equals(q6(0))).toBe(true);
    }
    if (tt) {
      expect(d(tt.materialValue)!.equals(q6(0))).toBe(true);
      expect(d(tt.laborValue)!.equals(q6(0))).toBe(true);
    }
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(0);
    expect(await prismaA.costEvent.count()).toBe(eventsBefore);
  });

  it("active sequential PRISADKA chain correction matches legacy semantics then exact reverse", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const both = await createBothPrisadkaDetail(world, 53);
    const blank = await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
        materialValue: new Prisma.Decimal("200"),
        laborValue: new Prisma.Decimal("20"),
        totalValue: new Prisma.Decimal("220"),
        costVersion: 1,
      },
    });
    const eventsBefore = await prismaA.costEvent.count();
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `active-chain-corr-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "torcev", quantity: 2 },
        { detailId: both.id, kind: "plosk", quantity: 2 },
      ],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const torcevIndex = op.lines.findIndex((l) => l.prisadkaTorcevaya);
    const ploskIndex = op.lines.findIndex((l) => l.prisadkaPloskost);
    await prismaA.employee.update({
      where: { id: world.emp.id },
      data: { ratePrisadkaTorcev: 99, ratePrisadkaPloskt: 88 },
    });
    await expect(updateProductionLineQuantity(op.id, torcevIndex, 1)).rejects.toThrow(
      "Нельзя изменить/удалить: деталь уже использована в упаковке или дальнейшей присадке",
    );
    expect(await chainTopology(both.id, world.material.id)).toEqual({
      blank: 0,
      tf: 0,
      ft: 0,
      tt: 2,
    });
    await updateProductionLineQuantity(op.id, ploskIndex, 1);
    expect(await chainTopology(both.id, world.material.id)).toEqual({
      blank: 0,
      tf: 1,
      ft: 0,
      tt: 1,
    });
    const dest = await prismaA.detailStock.findUniqueOrThrow({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: both.id,
          torcevayaDone: true,
          ploskostDone: true,
        },
      },
    });
    const mid = await prismaA.detailStock.findUniqueOrThrow({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: both.id,
          torcevayaDone: true,
          ploskostDone: false,
        },
      },
    });
    expect(d(dest.materialValue)!.equals(q6(100))).toBe(true);
    expect(d(dest.laborValue)!.equals(q6(19))).toBe(true);
    expect(d(mid.materialValue)!.equals(q6(100))).toBe(true);
    expect(d(mid.laborValue)!.equals(q6(15))).toBe(true);
    const corrected = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    expect(d(corrected.pieceLaborCost)!.equals(q6(14))).toBe(true);
    expect(d(corrected.pieceLaborCost)!.equals(q6(99 + 88))).toBe(false);
    expect(await prismaA.costEvent.count()).toBe(eventsBefore);
    await deleteProductionOperation(op.id);
    const blankAfter = await prismaA.blankStock.findUniqueOrThrow({ where: { id: blank.id } });
    expect(blankAfter.quantity).toBe(2);
    expect(d(blankAfter.materialValue)!.equals(q6(200))).toBe(true);
    expect(d(blankAfter.laborValue)!.equals(q6(20))).toBe(true);
    expect(await detailBucketQty(both.id, true, false)).toBe(0);
    expect(await detailBucketQty(both.id, true, true)).toBe(0);
    expect(await prismaA.costEvent.count()).toBe(eventsBefore);
  });

  it("PRISADKA correction does not rebase an untouched dest after external version bump", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const detA = await prismaA.detail.create({
      data: {
        name: `ver-a-${world.suffix}`,
        materialId: world.material.id,
        detailNumber: 60,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    const detB = await prismaA.detail.create({
      data: {
        name: `ver-b-${world.suffix}`,
        materialId: world.material.id,
        detailNumber: 61,
        lengthM: new Prisma.Decimal("1.5000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
        materialValue: new Prisma.Decimal("200"),
        laborValue: new Prisma.Decimal("20"),
        totalValue: new Prisma.Decimal("220"),
        costVersion: 1,
      },
    });
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.5000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
        materialValue: new Prisma.Decimal("150"),
        laborValue: new Prisma.Decimal("10"),
        totalValue: new Prisma.Decimal("160"),
        costVersion: 1,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `ver-ab-${world.suffix}`,
      picks: [
        { detailId: detA.id, kind: "torcev", quantity: 1 },
        { detailId: detB.id, kind: "torcev", quantity: 1 },
      ],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const lineAIndex = op.lines.findIndex((l) => l.detailId === detA.id);
    const lineB = op.lines.find((l) => l.detailId === detB.id)!;
    const historicalB = lineB.outputCostVersion!;
    expect(lineAIndex).toBeGreaterThanOrEqual(0);
    expect(historicalB).toBeGreaterThan(0);
    const destB = await prismaA.detailStock.findUniqueOrThrow({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: detB.id,
          torcevayaDone: true,
          ploskostDone: false,
        },
      },
    });
    expect(destB.costVersion).toBe(historicalB);
    await prismaA.detailStock.update({
      where: { id: destB.id },
      data: { costVersion: destB.costVersion + 1 },
    });
    const destBAfterExt = await prismaA.detailStock.findUniqueOrThrow({ where: { id: destB.id } });
    expect(destBAfterExt.costVersion).toBe(historicalB + 1);
    await updateProductionLineQuantity(op.id, lineAIndex, 2);
    const afterCorr = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    const lineBAfter = afterCorr.lines.find((l) => l.detailId === detB.id)!;
    expect(lineBAfter.outputCostVersion).toBe(historicalB);
    expect(lineBAfter.outputCostVersion).not.toBe(destBAfterExt.costVersion);
    await expect(deleteProductionOperation(op.id)).rejects.toThrow(COST_FLOW_VERSION_MISMATCH);
  });

  it("chain downstream correction rebases retained upstream dest version then exact delete succeeds", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const both = await createBothPrisadkaDetail(world, 62);
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
        materialValue: new Prisma.Decimal("200"),
        laborValue: new Prisma.Decimal("20"),
        totalValue: new Prisma.Decimal("220"),
        costVersion: 1,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `ver-chain-ok-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "torcev", quantity: 2 },
        { detailId: both.id, kind: "plosk", quantity: 2 },
      ],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const torcevLine = op.lines.find((l) => l.prisadkaTorcevaya)!;
    const ploskIndex = op.lines.findIndex((l) => l.prisadkaPloskost);
    const midBefore = await prismaA.detailStock.findUniqueOrThrow({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: both.id,
          torcevayaDone: true,
          ploskostDone: false,
        },
      },
    });
    expect(torcevLine.outputCostVersion).toBe(midBefore.costVersion);
    const historicalMid = midBefore.costVersion;
    await updateProductionLineQuantity(op.id, ploskIndex, 1);
    const midAfter = await prismaA.detailStock.findUniqueOrThrow({
      where: { id: midBefore.id },
    });
    expect(midAfter.costVersion).toBeGreaterThan(historicalMid);
    const after = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    const torcevAfter = after.lines.find((l) => l.prisadkaTorcevaya)!;
    expect(torcevAfter.outputCostVersion).toBe(midAfter.costVersion);
    expect(torcevAfter.outputCostVersion).not.toBe(historicalMid);
    await deleteProductionOperation(op.id);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(0);
  });

  it("chain downstream correction fail-closes if intermediate was externally mutated", async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const both = await createBothPrisadkaDetail(world, 63);
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 2,
        materialValue: new Prisma.Decimal("200"),
        laborValue: new Prisma.Decimal("20"),
        totalValue: new Prisma.Decimal("220"),
        costVersion: 1,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `ver-chain-ext-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "torcev", quantity: 2 },
        { detailId: both.id, kind: "plosk", quantity: 2 },
      ],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const torcevLine = op.lines.find((l) => l.prisadkaTorcevaya)!;
    const historicalUpstream = torcevLine.outputCostVersion!;
    const ploskIndex = op.lines.findIndex((l) => l.prisadkaPloskost);
    const mid = await prismaA.detailStock.findUniqueOrThrow({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: both.id,
          torcevayaDone: true,
          ploskostDone: false,
        },
      },
    });
    await prismaA.detailStock.update({
      where: { id: mid.id },
      data: { costVersion: mid.costVersion + 1 },
    });
    await expect(updateProductionLineQuantity(op.id, ploskIndex, 1)).rejects.toThrow(
      COST_FLOW_VERSION_MISMATCH,
    );
    const afterFail = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    expect(afterFail.lines.find((l) => l.prisadkaTorcevaya)!.outputCostVersion).toBe(historicalUpstream);
    expect(await prismaA.productionOperation.count({ where: { id: op.id } })).toBe(1);
  });

  it("updateProductionLineQuantity rejects zero quantity", async () => {
    const world = await seedChain();
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 1,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `ver-zero-${world.suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "PRISADKA" } });
    await expect(updateProductionLineQuantity(op.id, 0, 0)).rejects.toThrow(
      "Количество должно быть положительным",
    );
  });

  it("concurrent correction vs active PRISADKA on intermediate fails closed or serializes", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const both = await createBothPrisadkaDetail(world, 64);
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 4,
        materialValue: new Prisma.Decimal("400"),
        laborValue: new Prisma.Decimal("40"),
        totalValue: new Prisma.Decimal("440"),
        costVersion: 1,
      },
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `ver-chain-race-${world.suffix}`,
      picks: [
        { detailId: both.id, kind: "torcev", quantity: 2 },
        { detailId: both.id, kind: "plosk", quantity: 2 },
      ],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const historicalTorcev = op.lines.find((l) => l.prisadkaTorcevaya)!.outputCostVersion!;
    const ploskIndex = op.lines.findIndex((l) => l.prisadkaPloskost);
    expect(ploskIndex).toBeGreaterThanOrEqual(0);
    const results = await raceSettled("correction-vs-intermediate-writer", [
      updateProductionLineQuantity(op.id, ploskIndex, 1),
      submitPrisadka({
        employeeId: world.emp.id,
        clientRequestId: `ver-chain-race-b-${world.suffix}`,
        picks: [{ detailId: both.id, kind: "torcev", quantity: 1 }],
      }),
    ]);
    expectNoDeadlock(results);
    const correction = results[0]!;
    const writer = results[1]!;
    const after = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: op.id },
      include: { lines: true },
    });
    const torcevAfter = after.lines.find((l) => l.prisadkaTorcevaya)!;
    const mid = await prismaA.detailStock.findUniqueOrThrow({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: both.id,
          torcevayaDone: true,
          ploskostDone: false,
        },
      },
    });
    expect(mid.quantity).toBeGreaterThanOrEqual(0);
    if (correction.status === "rejected") {
      expect(errorMessage((correction as PromiseRejectedResult).reason)).toBe(COST_FLOW_VERSION_MISMATCH);
      expect(writer.status).toBe("fulfilled");
      expect(torcevAfter.outputCostVersion).toBe(historicalTorcev);
      expect(torcevAfter.outputCostVersion).not.toBe(mid.costVersion);
    } else {
      expect(correction.status).toBe("fulfilled");
      if (writer.status === "fulfilled") {
        expect(torcevAfter.outputCostVersion).not.toBe(mid.costVersion);
        expect(mid.costVersion).toBeGreaterThan(torcevAfter.outputCostVersion!);
      }
      const ploskLines = after.lines.filter((l) => l.prisadkaPloskost);
      expect(ploskLines.reduce((s, l) => s + l.quantity, 0)).toBe(1);
    }
  });

  it("concurrent TORCOVKA vs PRISADKA on missing BlankStock serializes without stale WAC", {
    timeout: CONCURRENCY_TIMEOUT_MS,
  }, async () => {
    await setCostFlowActive(true);
    const world = await seedChain();
    const existingBlank = await prismaA.blankStock.findFirst({
      where: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
      },
    });
    expect(existingBlank).toBeNull();
    const results = await raceSettled("absent-blank-torcovka-prisadka", [
      createdTorcovka(world, `abs-tp-tor-${world.suffix}`),
      submitPrisadka({
        employeeId: world.emp.id,
        clientRequestId: `abs-tp-pri-${world.suffix}`,
        picks: [{ detailId: world.detail.id, kind: "torcev", quantity: 1 }],
      }),
    ]);
    expectNoDeadlock(results);
    const tor = results[0]!;
    const pri = results[1]!;
    expect(tor.status).toBe("fulfilled");
    const blank = await prismaA.blankStock.findFirst({
      where: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
      },
    });
    const destQty = await detailBucketQty(world.detail.id, true, false);
    expect(blank).not.toBeNull();
    expect(blank!.quantity).toBeGreaterThanOrEqual(0);
    expect(destQty).toBeGreaterThanOrEqual(0);
    expect(blank!.quantity + destQty).toBe(1);
    expect(blank!.costVersion).toBeGreaterThanOrEqual(1);
    expect(blank!.totalValue).not.toBeNull();
    if (blank!.costVersion === 0) {
      expect(blank!.materialValue).toBeNull();
      expect(blank!.laborValue).toBeNull();
      expect(blank!.totalValue).toBeNull();
    }
    if (pri.status === "fulfilled") {
      expect(blank!.quantity).toBe(0);
      expect(destQty).toBe(1);
      const dest = await prismaA.detailStock.findUniqueOrThrow({
        where: {
          detailId_torcevayaDone_ploskostDone: {
            detailId: world.detail.id,
            torcevayaDone: true,
            ploskostDone: false,
          },
        },
      });
      expect(dest.costVersion).toBeGreaterThanOrEqual(1);
      expect(d(dest.totalValue)!.equals(d(dest.materialValue)!.plus(d(dest.laborValue)!))).toBe(true);
      expect(d(blank!.totalValue)!.equals(0)).toBe(true);
    } else {
      expect(errorMessage((pri as PromiseRejectedResult).reason)).toMatch(/Недостаточно заготовок/);
      expect(blank!.quantity).toBe(1);
      expect(destQty).toBe(0);
      expect(d(blank!.totalValue)!.gt(0)).toBe(true);
    }
  });
});
