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
import { submitTorcovka } from "@/server/terminal";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

describe.skipIf(!enabled)("TORCOVKA P2025 length canonicalization", () => {
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

  async function seedWorld(opts?: { remaining?: number; lotLengthM?: string }) {
    const remaining = opts?.remaining ?? 10;
    const suffix = `p2025-${seq}-${Date.now()}`;
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        rateTorcovkaSort1: 10,
        rateTorcovkaSort2: 10,
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
        lengthM: new Prisma.Decimal(opts?.lotLengthM ?? "2"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: remaining,
        remainingQuantity: remaining,
      },
    });
    return { material, emp, batch, lot, suffix };
  }

  function inputOf(
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

  async function blanksOf(materialId: string) {
    return prismaA.blankStock.findMany({
      where: { materialId },
      orderBy: [{ lengthM: "asc" }, { sort: "asc" }],
    });
  }

  it("T1 near-equal SORT1 floats merge to one BlankStock 0.7360 qty 5", async () => {
    const world = await seedWorld({ remaining: 10, lotLengthM: "2" });
    const clientRequestId = `t1-${world.suffix}`;
    const result = await submitTorcovka(
      inputOf(
        world,
        2,
        [
          { lengthM: 0.736, sort: "SORT1", quantity: 2 },
          { lengthM: 0.7359999999999, sort: "SORT1", quantity: 3 },
        ],
        clientRequestId,
      ),
    );
    expect(result.status).toBe("CREATED");
    const blanks = await blanksOf(world.material.id);
    expect(blanks).toHaveLength(1);
    expect(blanks[0]!.quantity).toBe(5);
    expect(blanks[0]!.lengthM.toFixed(4)).toBe("0.7360");
    const op = await prismaA.productionOperation.findUniqueOrThrow({
      where: { clientRequestId },
      include: { lines: true },
    });
    expect(op.lines).toHaveLength(1);
    expect(op.lines[0]!.quantity).toBe(5);
    expect(op.lines[0]!.blankLengthM!.toFixed(4)).toBe("0.7360");
    const log = await prismaA.changeLog.findFirstOrThrow({
      where: { entity: "ProductionOperation", entityId: op.id },
    });
    const values = log.newValues as { picks: Array<Record<string, unknown>> };
    expect(values.picks).toEqual([{ lengthM: 0.736, sort: "SORT1", quantity: 5 }]);
    expect(JSON.stringify(values.picks)).not.toContain("lengthMFixed4");
    expect(values).not.toHaveProperty("rawPicks");
  });

  it("T2 0.736 and 0.7360000000001 merge", async () => {
    const world = await seedWorld({ remaining: 10, lotLengthM: "1.6" });
    const result = await submitTorcovka(
      inputOf(
        world,
        1,
        [
          { lengthM: 0.736, sort: "SORT1", quantity: 1 },
          { lengthM: 0.7360000000001, sort: "SORT1", quantity: 1 },
        ],
        `t2-${world.suffix}`,
      ),
    );
    expect(result.status).toBe("CREATED");
    const blanks = await blanksOf(world.material.id);
    expect(blanks).toHaveLength(1);
    expect(blanks[0]!.quantity).toBe(2);
    expect(blanks[0]!.lengthM.toFixed(4)).toBe("0.7360");
  });

  it("T3 same canonical length SORT1/SORT2 stay two rows", async () => {
    const world = await seedWorld({ remaining: 10, lotLengthM: "1.6" });
    const result = await submitTorcovka(
      inputOf(
        world,
        1,
        [
          { lengthM: 0.736, sort: "SORT1", quantity: 1 },
          { lengthM: 0.7359999999999, sort: "SORT2", quantity: 1 },
        ],
        `t3-${world.suffix}`,
      ),
    );
    expect(result.status).toBe("CREATED");
    const blanks = await blanksOf(world.material.id);
    expect(blanks).toHaveLength(2);
    expect(blanks.map((b) => `${b.lengthM.toFixed(4)}|${b.sort}|${b.quantity}`)).toEqual([
      "0.7360|SORT1|1",
      "0.7360|SORT2|1",
    ]);
  });

  it("T4 0.7360 vs 0.7361 do not merge", async () => {
    const world = await seedWorld({ remaining: 10, lotLengthM: "1.6" });
    const result = await submitTorcovka(
      inputOf(
        world,
        1,
        [
          { lengthM: 0.736, sort: "SORT1", quantity: 1 },
          { lengthM: 0.7361, sort: "SORT1", quantity: 1 },
        ],
        `t4-${world.suffix}`,
      ),
    );
    expect(result.status).toBe("CREATED");
    const blanks = await blanksOf(world.material.id);
    expect(blanks).toHaveLength(2);
    expect(blanks.map((b) => `${b.lengthM.toFixed(4)}|${b.quantity}`)).toEqual([
      "0.7360|1",
      "0.7361|1",
    ]);
  });

  it("T5 existing 0.7360 row increments from near-equal raw input", async () => {
    const world = await seedWorld({ remaining: 10, lotLengthM: "0.8" });
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("0.7360"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 7,
      },
    });
    const result = await submitTorcovka(
      inputOf(
        world,
        1,
        [{ lengthM: 0.7359999999999, sort: "SORT1", quantity: 1 }],
        `t5-${world.suffix}`,
      ),
    );
    expect(result.status).toBe("CREATED");
    const blanks = await blanksOf(world.material.id);
    expect(blanks).toHaveLength(1);
    expect(blanks[0]!.id).toBeDefined();
    expect(blanks[0]!.quantity).toBe(8);
    expect(blanks[0]!.lengthM.toFixed(4)).toBe("0.7360");
  });

  it("T6 collision not in first picks still succeeds", async () => {
    const world = await seedWorld({ remaining: 10, lotLengthM: "3" });
    const result = await submitTorcovka(
      inputOf(
        world,
        1,
        [
          { lengthM: 0.36, sort: "SORT1", quantity: 1 },
          { lengthM: 0.67, sort: "SORT1", quantity: 1 },
          { lengthM: 0.736, sort: "SORT1", quantity: 1 },
          { lengthM: 0.7359999999999, sort: "SORT1", quantity: 1 },
        ],
        `t6-${world.suffix}`,
      ),
    );
    expect(result.status).toBe("CREATED");
    const blanks = await blanksOf(world.material.id);
    expect(blanks).toHaveLength(3);
    const merged = blanks.find((b) => b.lengthM.toFixed(4) === "0.7360");
    expect(merged?.quantity).toBe(2);
    expect(await prismaA.productionOperation.count({ where: { railLotId: world.lot.id } })).toBe(1);
  });

  it("T7 later transaction error still rolls back", async () => {
    const world = await seedWorld({ remaining: 1, lotLengthM: "2" });
    await expect(
      submitTorcovka(
        inputOf(
          world,
          2,
          [
            { lengthM: 0.736, sort: "SORT1", quantity: 2 },
            { lengthM: 0.7359999999999, sort: "SORT1", quantity: 3 },
          ],
          `t7-${world.suffix}`,
        ),
      ),
    ).rejects.toThrow("Недостаточно реек в пакете");
    expect(await prismaA.productionOperation.count({ where: { railLotId: world.lot.id } })).toBe(0);
    expect(await prismaA.blankStock.count({ where: { materialId: world.material.id } })).toBe(0);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: world.lot.id } });
    expect(lot.remainingQuantity).toBe(1);
    expect(await prismaA.changeLog.count()).toBe(0);
  });
});
