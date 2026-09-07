import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { D } from "@/lib/cost";
import { COST_FLOW_UNINITIALIZED_VERSION, eventComponentsValid } from "@/lib/cost-foundation";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

function isCheckViolation(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return (
    code === "P2004" ||
    code === "23514" ||
    /23514/.test(text) ||
    /check constraint/i.test(text)
  );
}

async function insertCostPeriod(
  db: ReturnType<typeof createIntegrityClients>["prismaA"],
  id: string,
  startSql: string,
  endSql: string,
) {
  await db.$executeRawUnsafe(`
    INSERT INTO "CostPeriod" (
      "id", "periodStart", "periodEnd",
      "hourlyProductionLaborPool", "productionOverheadPool",
      "unallocatedHourlyProductionLabor", "unallocatedProductionOverhead"
    ) VALUES (
      '${id}',
      TIMESTAMP '${startSql}',
      TIMESTAMP '${endSql}',
      0, 0, 0, 0
    )
  `);
}

describe.skipIf(!enabled)("Package 1 cost-flow foundation (schema only)", () => {
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

  it("new WAC pool rows are uninitialized (costVersion 0, money NULL — not factual zero)", async () => {
    const material = await prismaA.material.create({
      data: { name: "p1-foundation", sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const blank = await prismaA.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: 1,
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 4,
      },
    });
    expect(blank.costVersion).toBe(COST_FLOW_UNINITIALIZED_VERSION);
    expect(blank.materialValue).toBeNull();
    expect(blank.laborValue).toBeNull();
    expect(blank.totalValue).toBeNull();
    expect(blank.quantity).toBe(4);
  });

  it("CostPeriod 2026-09-01 is accepted; duplicate month is P2002", async () => {
    await insertCostPeriod(prismaA, "cp-sep-a", "2026-09-01 00:00:00", "2026-10-01 00:00:00");
    await expect(
      insertCostPeriod(prismaA, "cp-sep-b", "2026-09-01 00:00:00", "2026-10-01 00:00:00"),
    ).rejects.toSatisfy((e) => {
      const code =
        typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
      const text = e instanceof Error ? e.message : String(e);
      return code === "P2002" || /unique|duplicate|23505/i.test(text);
    });
  });

  it("CostPeriod mid-month start is rejected by CHECK", async () => {
    await expect(
      insertCostPeriod(prismaA, "cp-mid", "2026-09-15 00:00:00", "2026-10-15 00:00:00"),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it("CostPeriod wrong exclusive periodEnd is rejected by CHECK", async () => {
    await expect(
      insertCostPeriod(prismaA, "cp-bad-end", "2026-09-01 00:00:00", "2026-09-30 00:00:00"),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it("CostEvent stores matching components; drifted total is rejected by DB", async () => {
    const payload = {
      materialValue: new Prisma.Decimal("10"),
      laborValue: new Prisma.Decimal("4"),
      nomenclatureValue: new Prisma.Decimal("1"),
      totalValue: new Prisma.Decimal("15"),
    };
    expect(
      eventComponentsValid({
        material: D(payload.materialValue.toString()),
        labor: D(payload.laborValue.toString()),
        nomenclature: D(payload.nomenclatureValue.toString()),
        totalValue: D(payload.totalValue.toString()),
      }),
    ).toBe(true);
    const row = await prismaA.costEvent.create({
      data: { type: "TORCOVKA_ZERO_OUTPUT", ...payload },
    });
    expect(row.totalValue.toString()).toBe("15");

    await expect(
      prismaA.costEvent.create({
        data: {
          type: "MANUAL_ADJUSTMENT",
          materialValue: new Prisma.Decimal("10"),
          laborValue: new Prisma.Decimal("4"),
          nomenclatureValue: new Prisma.Decimal("1"),
          totalValue: new Prisma.Decimal("16"),
        },
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it("initialized BlankStock COMP-001 drift is rejected by DB CHECK", async () => {
    const material = await prismaA.material.create({
      data: { name: "p1-comp-check", sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    await expect(
      prismaA.blankStock.create({
        data: {
          materialId: material.id,
          lengthM: 1,
          detailType: "POLKA",
          sort: "SORT1",
          quantity: 3,
          costVersion: 1,
          materialValue: new Prisma.Decimal("1"),
          laborValue: new Prisma.Decimal("1"),
          totalValue: new Prisma.Decimal("3"),
        },
      }),
    ).rejects.toSatisfy(isCheckViolation);
  });

  it("ProductCost.materialTotal column exists and is nullable", async () => {
    const cols = await prismaA.$queryRawUnsafe<{ column_name: string; is_nullable: string }[]>(`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'ProductCost' AND column_name = 'materialTotal'
    `);
    expect(cols).toHaveLength(1);
    expect(cols[0].is_nullable).toBe("YES");
  });
});
