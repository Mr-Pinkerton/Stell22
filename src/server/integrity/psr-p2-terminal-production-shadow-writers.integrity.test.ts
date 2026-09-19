/**
 * PSR-P2 terminal production SHADOW writers.
 * Trigger reject is integrity-only and keyed by actorDisplaySnapshot.
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));

const sessionState = vi.hoisted(() => ({
  employee: { id: "", fullName: "" },
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => ({
    id: "integrity-admin",
    name: "Admin",
    email: "admin@test.local",
    role: "ADMIN",
  }),
  requireTerminalEmployee: async (expected?: string) => {
    if (!sessionState.employee.id) {
      throw new Error("Нет активной сессии терминала. Войдите по PIN.");
    }
    if (expected && expected !== sessionState.employee.id) {
      throw new Error("Несовпадение сотрудника сессии.");
    }
    return { id: sessionState.employee.id, fullName: sessionState.employee.fullName };
  },
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import { lockRailLots } from "@/server/internal/finance-operations";
import {
  lockDetails,
  snapshotUpakovkaApply,
} from "@/server/internal/inventory-integrity";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
} from "@/server/internal/inventory-movement-identity";
import { planUpakovkaPhysicalLockSet } from "@/server/internal/upakovka-lock-plan";
import { employeeMovementActor } from "@/server/internal/inventory-movement-actor";
import {
  INVENTORY_MOVEMENT_SHADOW_LOCK_KEY,
  INVENTORY_MOVEMENT_SHADOW_LOCK_NS,
} from "@/server/internal/inventory-movement-shadow-coordination";
import { utcNaiveTimestampString } from "@/server/internal/inventory-movement-time";
import {
  INVENTORY_MOVEMENT_SHADOW_WRITE_KEY,
  InventoryMovementShadowWriteConfigError,
  setInventoryMovementShadowWriteGate,
} from "@/server/internal/inventory-movement-shadow-write";
import { planProductionShadowMovements } from "@/server/internal/production-movement-plan";
import {
  submitPrisadka,
  submitTorcovka,
  submitUpakovka,
} from "@/server/terminal";
import { submitTorcovkaInTransaction } from "@/server/internal/submit-torcovka-tx";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  integrityDatabaseUrl,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
const BARRIER_TIMEOUT_MS = 25_000;
const REJECT_ACTOR = "INTEGRITY_REJECT_IM";

const holdOpts = { maxWait: 30_000, timeout: 30_000 } as const;

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BARRIER_TIMEOUT_MS) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`barrier: ${label}`);
}

describe.skipIf(!enabled)("PSR-P2 terminal production SHADOW writers", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];
  let prismaC: PrismaClient;

  beforeAll(async () => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
    prismaC = new PrismaClient({ datasourceUrl: integrityDatabaseUrl() });
    await prismaA.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION stell22_integrity_reject_im_insert()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."actorDisplaySnapshot" = '${REJECT_ACTOR}' THEN
          RAISE EXCEPTION 'integrity reject InventoryMovement insert';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prismaA.$executeRawUnsafe(`DROP TRIGGER IF EXISTS stell22_integrity_reject_im_insert ON "InventoryMovement"`);
    await prismaA.$executeRawUnsafe(`
      CREATE TRIGGER stell22_integrity_reject_im_insert
      BEFORE INSERT ON "InventoryMovement"
      FOR EACH ROW EXECUTE FUNCTION stell22_integrity_reject_im_insert();
    `);
  });

  beforeEach(async () => {
    sessionState.employee = { id: "", fullName: "" };
    await resetIntegrityInventory(prismaA);
    await prismaA.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`);
  });

  afterAll(async () => {
    await prismaA
      ?.$executeRawUnsafe(`DROP TRIGGER IF EXISTS stell22_integrity_reject_im_insert ON "InventoryMovement"`)
      .catch(() => {});
    await prismaA
      ?.$executeRawUnsafe(`DROP FUNCTION IF EXISTS stell22_integrity_reject_im_insert()`)
      .catch(() => {});
    await prismaA?.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`).catch(() => {});
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
    await prismaC?.$disconnect();
  });

  async function setShadowGate(active: boolean) {
    await prismaA.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, active);
    }, txOpts);
  }

  async function advisoryCounts() {
    const rows = await prismaA.$queryRaw<Array<{ mode: string; granted: boolean; n: bigint }>>`
      SELECT mode, granted, count(*)::bigint AS n
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}
        AND objid = ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}
      GROUP BY mode, granted
    `;
    const count = (mode: string, granted: boolean) =>
      Number(rows.find((row) => row.mode === mode && row.granted === granted)?.n ?? 0);
    return {
      sharedGranted: count("ShareLock", true),
      exclusiveGranted: count("ExclusiveLock", true),
      exclusiveWaiting: count("ExclusiveLock", false),
    };
  }

  async function lockWaiterEvidence(holderPid: number) {
    const activity = await prismaA.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM pg_stat_activity a
      WHERE a.datname = current_database()
        AND a.wait_event_type = 'Lock'
        AND a.pid <> ${holderPid}
    `;
    const locks = await prismaA.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM pg_locks l
      WHERE NOT l.granted
        AND l.pid <> ${holderPid}
        AND (
          l.relation = '"Detail"'::regclass
          OR l.locktype = 'transactionid'
        )
        AND l.pid IN (
          SELECT a.pid
          FROM pg_stat_activity a
          WHERE a.datname = current_database()
            AND a.wait_event_type = 'Lock'
            AND a.pid <> ${holderPid}
        )
    `;
    return { activity: activity[0]?.n ?? 0, locks: locks[0]?.n ?? 0 };
  }

  function productionOpLogs(
    logs: Array<{ entity: string; entityId: string; id: string; newValues: unknown }>,
  ) {
    return logs
      .filter((row) => row.entity === "ProductionOperation")
      .map((row) => ({ id: row.id, entityId: row.entityId, newValues: row.newValues }));
  }

  async function bindEmployee(emp: { id: string; fullName: string }) {
    sessionState.employee = { id: emp.id, fullName: emp.fullName };
    return emp;
  }

  async function seedEmployee(fullName: string) {
    return bindEmployee(
      await prismaA.employee.create({
        data: {
          fullName,
          pin: "1234",
          rateTorcovkaSort1: 10,
          rateTorcovkaSort2: 10,
          ratePrisadkaTorcev: 5,
          ratePrisadkaPloskt: 5,
          rateUpakovka: 10,
          hourlyRate: 100,
        },
      }),
    );
  }

  async function seedTorcovka(suffix: string, remaining = 10) {
    const emp = await seedEmployee(`emp-${suffix}`);
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
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
      },
    });
    return { emp, material, batch, lot };
  }

  async function seedPrisadkaMixed(suffix: string) {
    const emp = await seedEmployee(`emp-${suffix}`);
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const det = await prismaA.detail.create({
      data: {
        name: `det-${suffix}`,
        materialId: material.id,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    await prismaA.detailStock.create({
      data: { detailId: det.id, torcevayaDone: false, ploskostDone: true, quantity: 1 },
    });
    await prismaA.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 5,
      },
    });
    return { emp, material, det };
  }

  async function seedUpakovkaMixed(suffix: string, productCount = 1) {
    const emp = await seedEmployee(`emp-${suffix}`);
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const fastener = await prismaA.nomenclatureItem.create({
      data: { name: `fast-${suffix}`, type: "FASTENER", unitPrice: 10 },
    });
    const pack = await prismaA.nomenclatureItem.create({
      data: { name: `pack-${suffix}`, type: "PACKAGING", unitPrice: 5 },
    });
    const extra = await prismaA.nomenclatureItem.create({
      data: { name: `extra-${suffix}`, type: "OTHER", unitPrice: 3 },
    });
    await prismaA.nomenclatureStock.create({ data: { nomenclatureId: fastener.id, quantity: 100 } });
    await prismaA.nomenclatureStock.create({ data: { nomenclatureId: pack.id, quantity: 100 } });
    await prismaA.nomenclatureStock.create({ data: { nomenclatureId: extra.id, quantity: 100 } });

    const blankDet = await prismaA.detail.create({
      data: {
        name: `blank-det-${suffix}`,
        materialId: material.id,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    const readyDet = await prismaA.detail.create({
      data: {
        name: `ready-det-${suffix}`,
        materialId: material.id,
        detailNumber: 2,
        lengthM: new Prisma.Decimal("0.8000"),
        detailType: "KANAVKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    await prismaA.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 40,
      },
    });
    await prismaA.detailStock.create({
      data: { detailId: readyDet.id, torcevayaDone: true, ploskostDone: true, quantity: 20 },
    });

    const products = [];
    for (let i = 0; i < productCount; i += 1) {
      const prod = await prismaA.product.create({
        data: {
          name: `prod-${suffix}-${i}`,
          materialId: material.id,
          skuOzon: `OZ-${suffix}-${i}`,
          skuWb: `WB-${suffix}-${i}`,
          sort: "SORT1",
          packagingId: pack.id,
          details: {
            create: [
              { detailId: blankDet.id, quantity: 2 },
              { detailId: readyDet.id, quantity: 1 },
            ],
          },
          fasteners: { create: [{ nomenclatureId: fastener.id, quantity: 4 }] },
          extras: { create: [{ nomenclatureId: extra.id }, { nomenclatureId: fastener.id }] },
        },
      });
      products.push(prod);
    }
    return { emp, material, fastener, pack, extra, blankDet, readyDet, products };
  }

  async function snapshotPhysical() {
    const [ops, lines, noms, logs, movements, blanks, details, products, railLots, nomenclature] =
      await Promise.all([
        prismaA.productionOperation.findMany({ orderBy: { id: "asc" } }),
        prismaA.operationDetailLine.findMany({ orderBy: { id: "asc" } }),
        prismaA.operationNomenclatureLine.findMany({ orderBy: { id: "asc" } }),
        prismaA.changeLog.findMany({ orderBy: { id: "asc" } }),
        prismaA.inventoryMovement.findMany({ orderBy: { effectKey: "asc" } }),
        prismaA.blankStock.findMany({ orderBy: { id: "asc" } }),
        prismaA.detailStock.findMany({ orderBy: { id: "asc" } }),
        prismaA.productStock.findMany({ orderBy: { productId: "asc" } }),
        prismaA.railLot.findMany({ orderBy: { id: "asc" } }),
        prismaA.nomenclatureStock.findMany({ orderBy: { nomenclatureId: "asc" } }),
      ]);
    return { ops, lines, noms, logs, movements, blanks, details, products, railLots, nomenclature };
  }

  it("SHADOW off: three normal submits keep projection and write 0 movements", async () => {
    const torc = await seedTorcovka(`off-t-${Date.now()}`);
    await submitTorcovka({
      employeeId: torc.emp.id,
      clientRequestId: `off-t-${Date.now()}`,
      batchId: torc.batch.id,
      railLotId: torc.lot.id,
      railsTaken: 2,
      picks: [{ lengthM: 2, sort: "SORT1", quantity: 2 }],
    });
    const pris = await seedPrisadkaMixed(`off-p-${Date.now()}`);
    await submitPrisadka({
      employeeId: pris.emp.id,
      clientRequestId: `off-p-${Date.now()}`,
      picks: [{ detailId: pris.det.id, kind: "torcev", quantity: 2 }],
    });
    const upak = await seedUpakovkaMixed(`off-u-${Date.now()}`);
    await submitUpakovka({
      employeeId: upak.emp.id,
      clientRequestId: `off-u-${Date.now()}`,
      picks: [{ productId: upak.products[0]!.id, quantity: 1 }],
    });
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect(await prismaA.productionOperation.count()).toBe(3);

    await setShadowGate(false);
    const torc2 = await seedTorcovka(`off2-t-${Date.now()}`);
    await submitTorcovka({
      employeeId: torc2.emp.id,
      clientRequestId: `off2-t-${Date.now()}`,
      batchId: torc2.batch.id,
      railLotId: torc2.lot.id,
      railsTaken: 2,
      picks: [{ lengthM: 2, sort: "SORT1", quantity: 2 }],
    });
    const pris2 = await seedPrisadkaMixed(`off2-p-${Date.now()}`);
    await submitPrisadka({
      employeeId: pris2.emp.id,
      clientRequestId: `off2-p-${Date.now()}`,
      picks: [{ detailId: pris2.det.id, kind: "torcev", quantity: 2 }],
    });
    const upak2 = await seedUpakovkaMixed(`off2-u-${Date.now()}`);
    await submitUpakovka({
      employeeId: upak2.emp.id,
      clientRequestId: `off2-u-${Date.now()}`,
      picks: [{ productId: upak2.products[0]!.id, quantity: 1 }],
    });
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect(await prismaA.productionOperation.count()).toBe(6);
  });

  it("TORCOVKA SHADOW ACTIVE writes exact consume/output set and same workDate/effectiveAt", async () => {
    const w = await seedTorcovka(`on-t-${Date.now()}`);
    await setShadowGate(true);
    const result = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: `on-t-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 2,
      picks: [
        { lengthM: 1.8, sort: "SORT1", quantity: 1 },
        { lengthM: 1.8, sort: "SORT1", quantity: 1 },
      ],
    });
    expect(result).toEqual({ status: "CREATED" });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "TORCOVKA" },
      include: { lines: true },
    });
    const movements = await prismaA.inventoryMovement.findMany({ orderBy: { effectKey: "asc" } });
    expect(movements).toHaveLength(2);
    const consume = movements.find((row) => row.kind === "CONSUMPTION");
    const output = movements.find((row) => row.kind === "PRODUCTION_OUTPUT");
    expect(consume).toMatchObject({
      stockDomain: "RAIL_LOT",
      railLotId: w.lot.id,
      quantityDelta: -2,
      actorKind: "EMPLOYEE",
      employeeId: w.emp.id,
      actorDisplaySnapshot: w.emp.fullName,
      userId: null,
      systemActorKey: null,
      causationKind: "PRODUCTION_OPERATION",
      causationId: op.id,
      authority: "SHADOW",
      epochId: null,
      reason: null,
    });
    expect(output).toMatchObject({
      stockDomain: "BLANK",
      materialId: w.material.id,
      detailType: "POLKA",
      sort: "SORT1",
      quantityDelta: 2,
    });
    expect(output?.lengthM?.toFixed(4)).toBe("1.8000");
    const consumeKey = effectKeyV1(
      "consume",
      canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId: w.lot.id }).targetHashV1,
    );
    expect(consume?.effectKey).toBe(consumeKey);
    expect(op.workDate.getTime()).toBe(consume?.effectiveAt.getTime());
    expect(op.workDate.getTime()).toBe(output?.effectiveAt.getTime());
    const snapshot = consume?.causationSnapshot as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      v: 1,
      d: "PRODUCTION_OPERATION",
      operationId: op.id,
      operationType: "TORCOVKA",
      clientRequestId: op.clientRequestId,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 2,
    });
  });

  it("TORCOVKA retry and concurrent same request do not duplicate projection or movements", async () => {
    const w = await seedTorcovka(`retry-t-${Date.now()}`, 4);
    await setShadowGate(true);
    const input = {
      employeeId: w.emp.id,
      clientRequestId: `retry-t-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 2,
      picks: [{ lengthM: 2, sort: "SORT1" as const, quantity: 2 }],
    };
    expect(await submitTorcovka(input)).toEqual({ status: "CREATED" });
    expect(await submitTorcovka(input)).toEqual({ status: "CREATED" });
    expect(await prismaA.productionOperation.count()).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(2);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } })).remainingQuantity).toBe(2);

    const w2 = await seedTorcovka(`conc-t-${Date.now()}`, 4);
    await bindEmployee(w2.emp);
    const concurrentInput = {
      employeeId: w2.emp.id,
      clientRequestId: `conc-t-${Date.now()}`,
      batchId: w2.batch.id,
      railLotId: w2.lot.id,
      railsTaken: 2,
      picks: [{ lengthM: 2, sort: "SORT1" as const, quantity: 2 }],
    };
    const settled = await Promise.allSettled([
      submitTorcovka(concurrentInput),
      submitTorcovka(concurrentInput),
    ]);
    expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(2);
    expect(await prismaA.productionOperation.count({ where: { railLotId: w2.lot.id } })).toBe(1);
    expect(
      await prismaA.inventoryMovement.count({
        where: { causationKind: "PRODUCTION_OPERATION" },
      }),
    ).toBe(4);
  });

  it("retry of SHADOW-off TORCOVKA / PRISADKA / UPAKOVKA does not backfill movements after gate ON", async () => {
    const w = await seedTorcovka(`backfill-${Date.now()}`);
    const input = {
      employeeId: w.emp.id,
      clientRequestId: `backfill-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 2,
      picks: [{ lengthM: 2, sort: "SORT1" as const, quantity: 2 }],
    };
    await submitTorcovka(input);
    const pris = await seedPrisadkaMixed(`backfill-p-${Date.now()}`);
    const prisInput = {
      employeeId: pris.emp.id,
      clientRequestId: `backfill-p-${Date.now()}`,
      picks: [{ detailId: pris.det.id, kind: "torcev" as const, quantity: 1 }],
    };
    await submitPrisadka(prisInput);
    const upak = await seedUpakovkaMixed(`backfill-u-${Date.now()}`);
    const upakInput = {
      employeeId: upak.emp.id,
      clientRequestId: `backfill-u-${Date.now()}`,
      picks: [{ productId: upak.products[0]!.id, quantity: 1 }],
    };
    await submitUpakovka(upakInput);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    await setShadowGate(true);
    await bindEmployee(w.emp);
    await submitTorcovka(input);
    await bindEmployee(pris.emp);
    await submitPrisadka(prisInput);
    await bindEmployee(upak.emp);
    await submitUpakovka(upakInput);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect(await prismaA.productionOperation.count()).toBe(3);
  });

  it("PRISADKA mixed source writes DETAIL+BLANK consume and DETAIL output", async () => {
    const w = await seedPrisadkaMixed(`mix-p-${Date.now()}`);
    await setShadowGate(true);
    await submitPrisadka({
      employeeId: w.emp.id,
      clientRequestId: `mix-p-${Date.now()}`,
      picks: [{ detailId: w.det.id, kind: "torcev", quantity: 3 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA" },
      include: { lines: true },
    });
    const plan = planProductionShadowMovements({ kind: "PRISADKA", operation: op });
    const movements = await prismaA.inventoryMovement.findMany({ orderBy: { effectKey: "asc" } });
    expect(movements).toHaveLength(plan.effects.length);
    expect(movements.some((row) => row.stockDomain === "DETAIL" && row.kind === "CONSUMPTION")).toBe(true);
    expect(movements.some((row) => row.stockDomain === "BLANK" && row.kind === "CONSUMPTION")).toBe(true);
    expect(movements.some((row) => row.stockDomain === "DETAIL" && row.kind === "PRODUCTION_OUTPUT")).toBe(true);
    expect(movements.every((row) => row.causationId === op.id)).toBe(true);
    expect(movements.every((row) => row.employeeId === w.emp.id)).toBe(true);
  });

  it("PRISADKA retry/concurrent keep one projection and one movement set", async () => {
    const w = await seedPrisadkaMixed(`retry-p-${Date.now()}`);
    await setShadowGate(true);
    const input = {
      employeeId: w.emp.id,
      clientRequestId: `retry-p-${Date.now()}`,
      picks: [{ detailId: w.det.id, kind: "torcev" as const, quantity: 2 }],
    };
    await submitPrisadka(input);
    const first = await snapshotPhysical();
    await submitPrisadka(input);
    const second = await snapshotPhysical();
    expect(second.ops).toHaveLength(1);
    expect(second.movements).toHaveLength(first.movements.length);
    expect(second.lines).toHaveLength(first.lines.length);

    const w2 = await seedPrisadkaMixed(`conc-p-${Date.now()}`);
    await bindEmployee(w2.emp);
    const concurrent = {
      employeeId: w2.emp.id,
      clientRequestId: `conc-p-${Date.now()}`,
      picks: [{ detailId: w2.det.id, kind: "torcev" as const, quantity: 1 }],
    };
    await Promise.allSettled([submitPrisadka(concurrent), submitPrisadka(concurrent)]);
    expect(await prismaA.productionOperation.count({ where: { type: "PRISADKA" } })).toBe(2);
  });

  it("UPAKOVKA mixed source groups overlapping nomenclature and keeps per-op causation", async () => {
    const w = await seedUpakovkaMixed(`mix-u-${Date.now()}`, 2);
    await setShadowGate(true);
    const clientRequestId = `mix-u-${Date.now()}`;
    await submitUpakovka({
      employeeId: w.emp.id,
      clientRequestId,
      picks: [
        { productId: w.products[0]!.id, quantity: 1 },
        { productId: w.products[1]!.id, quantity: 1 },
      ],
    });
    const ops = await prismaA.productionOperation.findMany({
      where: { type: "UPAKOVKA" },
      include: { lines: true, nomenclatureLines: true },
      orderBy: { clientRequestId: "asc" },
    });
    expect(ops).toHaveLength(2);
    expect(ops[0]?.clientRequestId).toBe(`${clientRequestId}:${w.products[0]!.id}`);
    for (const op of ops) {
      const plan = planProductionShadowMovements({ kind: "UPAKOVKA", operation: op });
      const rows = await prismaA.inventoryMovement.findMany({
        where: { causationId: op.id },
        orderBy: { effectKey: "asc" },
      });
      expect(rows).toHaveLength(plan.effects.length);
      expect(rows.some((row) => row.stockDomain === "BLANK" && row.kind === "CONSUMPTION")).toBe(true);
      expect(rows.some((row) => row.stockDomain === "DETAIL" && row.kind === "CONSUMPTION")).toBe(true);
      expect(rows.some((row) => row.stockDomain === "NOMENCLATURE" && row.kind === "CONSUMPTION")).toBe(true);
      expect(rows.filter((row) => row.nomenclatureId === w.fastener.id)).toHaveLength(1);
      expect(rows.find((row) => row.nomenclatureId === w.fastener.id)?.quantityDelta).toBe(-5);
      expect(rows.filter((row) => row.kind === "PRODUCTION_OUTPUT")).toHaveLength(1);
      expect((rows[0]?.causationSnapshot as Record<string, unknown>).clientRequestId).toBe(
        op.clientRequestId,
      );
    }
  });

  it("UPAKOVKA replay is whole-request and partial replay stays blocked", async () => {
    const w = await seedUpakovkaMixed(`replay-u-${Date.now()}`, 2);
    await setShadowGate(true);
    const clientRequestId = `replay-u-${Date.now()}`;
    const picks = [
      { productId: w.products[0]!.id, quantity: 1 },
      { productId: w.products[1]!.id, quantity: 1 },
    ];
    await submitUpakovka({ employeeId: w.emp.id, clientRequestId, picks });
    const firstCount = await prismaA.inventoryMovement.count();
    await submitUpakovka({ employeeId: w.emp.id, clientRequestId, picks });
    expect(await prismaA.inventoryMovement.count()).toBe(firstCount);
    await expect(
      submitUpakovka({
        employeeId: w.emp.id,
        clientRequestId,
        picks: [...picks, { productId: w.products[0]!.id, quantity: 1 }],
      }),
    ).rejects.toThrow("В списке упаковки изделие указано дважды");
    const doomed = await prismaA.productionOperation.findUniqueOrThrow({
      where: { clientRequestId: `${clientRequestId}:${w.products[1]!.id}` },
    });
    await prismaA.operationDetailLine.deleteMany({ where: { operationId: doomed.id } });
    await prismaA.operationNomenclatureLine.deleteMany({ where: { operationId: doomed.id } });
    await prismaA.changeLog.deleteMany({
      where: { entity: "ProductionOperation", entityId: doomed.id },
    });
    await prismaA.productionOperation.delete({ where: { id: doomed.id } });
    await expect(
      submitUpakovka({ employeeId: w.emp.id, clientRequestId, picks }),
    ).rejects.toThrow("Несогласованный повтор упаковки");
    expect(await prismaA.inventoryMovement.count()).toBe(firstCount);
  });

  it("UPAKOVKA captured cost-flow mode survives a mid-TX Setting flip", async () => {
    const w = await seedUpakovkaMixed(`mode-u-${Date.now()}`);
    await setShadowGate(true);
    await prismaA.setting.upsert({
      where: { key: PRODUCTION_COST_FLOW_KEY },
      create: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active: false } },
      update: { value: { version: 1, active: false } },
    });

    let holderPid = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderLocked!: () => void;
    const holderReady = new Promise<void>((resolve) => {
      holderLocked = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      await lockDetails(tx, [w.blankDet.id, w.readyDet.id]);
      const rows = await tx.$queryRaw<Array<{ pid: unknown }>>`SELECT pg_backend_pid() AS pid`;
      holderPid = Number(rows[0]?.pid);
      holderLocked();
      await held;
    }, holdOpts);
    await holderReady;

    const submit = submitUpakovka({
      employeeId: w.emp.id,
      clientRequestId: `mode-u-${Date.now()}`,
      picks: [{ productId: w.products[0]!.id, quantity: 1 }],
    });
    try {
      await waitUntil(async () => {
        const evidence = await lockWaiterEvidence(holderPid);
        return evidence.activity >= 1 && evidence.locks >= 1;
      }, "UPAKOVKA waiter blocked on Detail before apply");
      await prismaC.setting.upsert({
        where: { key: PRODUCTION_COST_FLOW_KEY },
        create: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active: true } },
        update: { value: { version: 1, active: true } },
      });
      const flipped = await prismaA.setting.findUniqueOrThrow({
        where: { key: PRODUCTION_COST_FLOW_KEY },
      });
      expect(flipped.value).toMatchObject({ version: 1, active: true });
    } finally {
      release();
    }
    await holder;
    await submit;

    const stillActive = await prismaA.setting.findUniqueOrThrow({
      where: { key: PRODUCTION_COST_FLOW_KEY },
    });
    expect(stillActive.value).toMatchObject({ version: 1, active: true });
    const product = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: w.products[0]!.id },
    });
    expect(product.quantity).toBe(1);
    expect(product.costVersion).toBe(0);
    expect(product.materialValue).toBeNull();
    expect(product.laborValue).toBeNull();
    expect(product.nomenclatureValue).toBeNull();
    expect(product.totalValue).toBeNull();
    const blank = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: w.material.id },
    });
    expect(blank.quantity).toBe(38);
    expect(blank.costVersion).toBe(0);
    expect(blank.materialValue).toBeNull();
    expect(await prismaA.productionOperation.count({ where: { type: "UPAKOVKA" } })).toBe(1);
  }, 35_000);

  it("UPAKOVKA reversed-order concurrent requests complete without deadlock", async () => {
    const w = await seedUpakovkaMixed(`conc-u-${Date.now()}`, 2);
    await setShadowGate(true);
    const picksA = [
      { productId: w.products[0]!.id, quantity: 1 },
      { productId: w.products[1]!.id, quantity: 1 },
    ];
    const picksB = [...picksA].reverse();
    await prismaA.$transaction(async (tx) => {
      const rowsA = [];
      for (const pick of picksA) {
        rowsA.push({ pick, prepared: await snapshotUpakovkaApply(tx, pick.productId) });
      }
      const forward = planUpakovkaPhysicalLockSet(rowsA);
      expect(planUpakovkaPhysicalLockSet([...rowsA].reverse())).toEqual(forward);
      expect(forward.detailIds).toEqual([w.blankDet.id, w.readyDet.id].sort());
    });

    let holderPid = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holderLocked!: () => void;
    const holderReady = new Promise<void>((resolve) => {
      holderLocked = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      await lockDetails(tx, [w.blankDet.id, w.readyDet.id]);
      const rows = await tx.$queryRaw<Array<{ pid: unknown }>>`SELECT pg_backend_pid() AS pid`;
      holderPid = Number(rows[0]?.pid);
      holderLocked();
      await held;
    }, holdOpts);
    await holderReady;

    const requestA = submitUpakovka({
      employeeId: w.emp.id,
      clientRequestId: `conc-u-a-${Date.now()}`,
      picks: picksA,
    });
    const requestB = submitUpakovka({
      employeeId: w.emp.id,
      clientRequestId: `conc-u-b-${Date.now()}`,
      picks: picksB,
    });
    let overlap = { activity: 0, locks: 0 };
    try {
      await waitUntil(async () => {
        overlap = await lockWaiterEvidence(holderPid);
        return overlap.activity >= 2 && overlap.locks >= 2;
      }, "expected 2 Detail lock waiters");
    } finally {
      release();
    }
    expect(overlap.activity).toBeGreaterThanOrEqual(2);
    expect(overlap.locks).toBeGreaterThanOrEqual(2);
    const settled = await Promise.allSettled([requestA, requestB]);
    await holder;
    expect(settled.map((row) => row.status)).toEqual(["fulfilled", "fulfilled"]);

    expect((await prismaA.blankStock.findFirstOrThrow({ where: { materialId: w.material.id } })).quantity).toBe(32);
    expect(
      (await prismaA.detailStock.findFirstOrThrow({
        where: { detailId: w.readyDet.id, torcevayaDone: true, ploskostDone: true },
      })).quantity,
    ).toBe(16);
    expect((await prismaA.nomenclatureStock.findUniqueOrThrow({ where: { nomenclatureId: w.fastener.id } })).quantity).toBe(80);
    expect((await prismaA.nomenclatureStock.findUniqueOrThrow({ where: { nomenclatureId: w.pack.id } })).quantity).toBe(96);
    expect((await prismaA.nomenclatureStock.findUniqueOrThrow({ where: { nomenclatureId: w.extra.id } })).quantity).toBe(96);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: w.products[0]!.id } })).quantity).toBe(2);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: w.products[1]!.id } })).quantity).toBe(2);

    const ops = await prismaA.productionOperation.findMany({
      where: { type: "UPAKOVKA" },
      include: { lines: true, nomenclatureLines: true },
      orderBy: { clientRequestId: "asc" },
    });
    expect(ops).toHaveLength(4);
    const clientRequestIds = ops.map((op) => op.clientRequestId);
    expect(new Set(clientRequestIds).size).toBe(4);
    for (const op of ops) {
      const plan = planProductionShadowMovements({ kind: "UPAKOVKA", operation: op });
      const rows = await prismaA.inventoryMovement.findMany({
        where: { causationId: op.id },
        orderBy: { effectKey: "asc" },
      });
      expect(rows).toHaveLength(plan.effects.length);
      expect(rows.every((row) => row.causationId === op.id)).toBe(true);
      const keys = rows.map((row) => row.effectKey);
      expect(new Set(keys).size).toBe(keys.length);
    }
  }, 35_000);

  it("malformed SHADOW gate fails before physical mutation on all three submits", async () => {
    const torc = await seedTorcovka(`bad-${Date.now()}`);
    await prismaA.setting.upsert({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
      create: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value: { version: 99, active: true } },
      update: { value: { version: 99, active: true } },
    });
    const before = await snapshotPhysical();
    await expect(
      submitTorcovka({
        employeeId: torc.emp.id,
        clientRequestId: `bad-t-${Date.now()}`,
        batchId: torc.batch.id,
        railLotId: torc.lot.id,
        railsTaken: 1,
        picks: [{ lengthM: 2, sort: "SORT1", quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
    const pris = await seedPrisadkaMixed(`bad-p-${Date.now()}`);
    await expect(
      submitPrisadka({
        employeeId: pris.emp.id,
        clientRequestId: `bad-p-${Date.now()}`,
        picks: [{ detailId: pris.det.id, kind: "torcev", quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
    const upak = await seedUpakovkaMixed(`bad-u-${Date.now()}`);
    await expect(
      submitUpakovka({
        employeeId: upak.emp.id,
        clientRequestId: `bad-u-${Date.now()}`,
        picks: [{ productId: upak.products[0]!.id, quantity: 1 }],
      }),
    ).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
    const after = await snapshotPhysical();
    expect(after.ops).toHaveLength(before.ops.length);
    expect(after.lines).toHaveLength(before.lines.length);
    expect(after.movements).toHaveLength(0);
    expect(after.logs.filter((row) => row.entity === "ProductionOperation")).toHaveLength(0);
  });

  it("movement-layer failure rolls back TORCOVKA / PRISADKA / UPAKOVKA atomically", async () => {
    await setShadowGate(true);
    const torc = await seedTorcovka(`rb-t-${Date.now()}`);
    await bindEmployee({ id: torc.emp.id, fullName: REJECT_ACTOR });
    await prismaA.employee.update({ where: { id: torc.emp.id }, data: { fullName: REJECT_ACTOR } });
    const beforeT = await snapshotPhysical();
    await expect(
      submitTorcovka({
        employeeId: torc.emp.id,
        clientRequestId: `rb-t-${Date.now()}`,
        batchId: torc.batch.id,
        railLotId: torc.lot.id,
        railsTaken: 1,
        picks: [{ lengthM: 2, sort: "SORT1", quantity: 1 }],
      }),
    ).rejects.toThrow(/integrity reject InventoryMovement insert/);
    const afterT = await snapshotPhysical();
    const torcOpsBefore = beforeT.ops.filter((row) => row.type === "TORCOVKA");
    const torcOpsAfter = afterT.ops.filter((row) => row.type === "TORCOVKA");
    const torcOpIds = new Set(torcOpsBefore.map((row) => row.id));
    expect(torcOpsAfter.map((row) => row.id)).toEqual(torcOpsBefore.map((row) => row.id));
    expect(afterT.railLots.find((row) => row.id === torc.lot.id)?.remainingQuantity).toBe(10);
    expect(
      afterT.blanks
        .filter((row) => row.materialId === torc.material.id)
        .map((row) => ({ id: row.id, quantity: row.quantity })),
    ).toEqual(
      beforeT.blanks
        .filter((row) => row.materialId === torc.material.id)
        .map((row) => ({ id: row.id, quantity: row.quantity })),
    );
    expect(afterT.lines.filter((row) => torcOpIds.has(row.operationId))).toEqual(
      beforeT.lines.filter((row) => torcOpIds.has(row.operationId)),
    );
    expect(afterT.noms.filter((row) => torcOpIds.has(row.operationId))).toEqual(
      beforeT.noms.filter((row) => torcOpIds.has(row.operationId)),
    );
    expect(productionOpLogs(afterT.logs)).toEqual(productionOpLogs(beforeT.logs));
    expect(afterT.movements.filter((row) => row.causationKind === "PRODUCTION_OPERATION")).toHaveLength(0);

    const pris = await seedPrisadkaMixed(`rb-p-${Date.now()}`);
    await prismaA.employee.update({ where: { id: pris.emp.id }, data: { fullName: REJECT_ACTOR } });
    await bindEmployee({ id: pris.emp.id, fullName: REJECT_ACTOR });
    const beforeP = await snapshotPhysical();
    await expect(
      submitPrisadka({
        employeeId: pris.emp.id,
        clientRequestId: `rb-p-${Date.now()}`,
        picks: [{ detailId: pris.det.id, kind: "torcev", quantity: 1 }],
      }),
    ).rejects.toThrow(/integrity reject InventoryMovement insert/);
    const afterP = await snapshotPhysical();
    const prisOpsBefore = beforeP.ops.filter((row) => row.type === "PRISADKA");
    const prisOpIds = new Set(prisOpsBefore.map((row) => row.id));
    expect(afterP.ops.filter((row) => row.type === "PRISADKA").map((row) => row.id)).toEqual(
      prisOpsBefore.map((row) => row.id),
    );
    expect(
      afterP.blanks
        .filter((row) => row.materialId === pris.material.id)
        .map((row) => ({ id: row.id, quantity: row.quantity })),
    ).toEqual(
      beforeP.blanks
        .filter((row) => row.materialId === pris.material.id)
        .map((row) => ({ id: row.id, quantity: row.quantity })),
    );
    expect(
      afterP.details
        .filter((row) => row.detailId === pris.det.id)
        .map((row) => ({
          id: row.id,
          quantity: row.quantity,
          torcevayaDone: row.torcevayaDone,
          ploskostDone: row.ploskostDone,
        })),
    ).toEqual(
      beforeP.details
        .filter((row) => row.detailId === pris.det.id)
        .map((row) => ({
          id: row.id,
          quantity: row.quantity,
          torcevayaDone: row.torcevayaDone,
          ploskostDone: row.ploskostDone,
        })),
    );
    expect(afterP.lines.filter((row) => prisOpIds.has(row.operationId))).toEqual(
      beforeP.lines.filter((row) => prisOpIds.has(row.operationId)),
    );
    expect(afterP.noms.filter((row) => prisOpIds.has(row.operationId))).toEqual(
      beforeP.noms.filter((row) => prisOpIds.has(row.operationId)),
    );
    expect(productionOpLogs(afterP.logs)).toEqual(productionOpLogs(beforeP.logs));
    expect(afterP.movements.filter((row) => row.causationKind === "PRODUCTION_OPERATION")).toHaveLength(0);

    const upak = await seedUpakovkaMixed(`rb-u-${Date.now()}`);
    await prismaA.employee.update({ where: { id: upak.emp.id }, data: { fullName: REJECT_ACTOR } });
    await bindEmployee({ id: upak.emp.id, fullName: REJECT_ACTOR });
    const beforeU = await snapshotPhysical();
    await expect(
      submitUpakovka({
        employeeId: upak.emp.id,
        clientRequestId: `rb-u-${Date.now()}`,
        picks: [{ productId: upak.products[0]!.id, quantity: 1 }],
      }),
    ).rejects.toThrow(/integrity reject InventoryMovement insert/);
    const afterU = await snapshotPhysical();
    const upakOpsBefore = beforeU.ops.filter((row) => row.type === "UPAKOVKA");
    const upakOpIds = new Set(upakOpsBefore.map((row) => row.id));
    const productIds = upak.products.map((row) => row.id);
    const nomIds = [upak.fastener.id, upak.pack.id, upak.extra.id];
    expect(afterU.ops.filter((row) => row.type === "UPAKOVKA").map((row) => row.id)).toEqual(
      upakOpsBefore.map((row) => row.id),
    );
    expect(
      afterU.blanks
        .filter((row) => row.materialId === upak.material.id)
        .map((row) => ({ id: row.id, quantity: row.quantity })),
    ).toEqual(
      beforeU.blanks
        .filter((row) => row.materialId === upak.material.id)
        .map((row) => ({ id: row.id, quantity: row.quantity })),
    );
    expect(
      afterU.details
        .filter((row) => row.detailId === upak.blankDet.id || row.detailId === upak.readyDet.id)
        .map((row) => ({ id: row.id, detailId: row.detailId, quantity: row.quantity })),
    ).toEqual(
      beforeU.details
        .filter((row) => row.detailId === upak.blankDet.id || row.detailId === upak.readyDet.id)
        .map((row) => ({ id: row.id, detailId: row.detailId, quantity: row.quantity })),
    );
    expect(
      afterU.nomenclature
        .filter((row) => nomIds.includes(row.nomenclatureId))
        .map((row) => ({ nomenclatureId: row.nomenclatureId, quantity: row.quantity })),
    ).toEqual(
      beforeU.nomenclature
        .filter((row) => nomIds.includes(row.nomenclatureId))
        .map((row) => ({ nomenclatureId: row.nomenclatureId, quantity: row.quantity })),
    );
    expect(
      afterU.products
        .filter((row) => productIds.includes(row.productId))
        .map((row) => ({ productId: row.productId, quantity: row.quantity })),
    ).toEqual(
      beforeU.products
        .filter((row) => productIds.includes(row.productId))
        .map((row) => ({ productId: row.productId, quantity: row.quantity })),
    );
    expect(afterU.lines.filter((row) => upakOpIds.has(row.operationId))).toEqual(
      beforeU.lines.filter((row) => upakOpIds.has(row.operationId)),
    );
    expect(afterU.noms.filter((row) => upakOpIds.has(row.operationId))).toEqual(
      beforeU.noms.filter((row) => upakOpIds.has(row.operationId)),
    );
    expect(productionOpLogs(afterU.logs)).toEqual(productionOpLogs(beforeU.logs));
    expect(afterU.movements.filter((row) => row.causationKind === "PRODUCTION_OPERATION")).toHaveLength(0);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("terminal gate-flip: EXCLUSIVE waits while TORCOVKA holds SHARED", async () => {
    const w = await seedTorcovka(`flip-${Date.now()}`);
    await setShadowGate(true);
    const hold = { release: () => {}, ready: false };
    const holding = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      await lockRailLots(tx, [w.lot.id]);
      hold.ready = true;
      await holding;
    }, txOpts);
    await waitUntil(() => hold.ready, "rail lot held");
    const submit = submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: `flip-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 1,
      picks: [{ lengthM: 2, sort: "SORT1", quantity: 1 }],
    });
    await waitUntil(async () => (await advisoryCounts()).sharedGranted >= 1, "SHARED granted");
    let gateFinished = false;
    const gateOff = prismaC
      .$transaction(async (tx) => {
        await setInventoryMovementShadowWriteGate(tx, false);
        gateFinished = true;
        return true;
      }, txOpts)
      .catch((err) => err as Error);
    await waitUntil(async () => (await advisoryCounts()).exclusiveWaiting >= 1, "EXCLUSIVE waiting");
    expect(gateFinished).toBe(false);
    expect(await prismaA.productionOperation.count()).toBe(0);
    hold.release();
    await holder;
    await submit;
    await gateOff;
    expect(gateFinished).toBe(true);
    expect(await prismaA.productionOperation.count()).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBeGreaterThan(0);
    const gate = await prismaA.setting.findUniqueOrThrow({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
    });
    expect(gate.value).toMatchObject({ version: 1, active: false });
  });

  it("non-UTC session stores equal workDate and movement effectiveAt", async () => {
    const w = await seedTorcovka(`tz-${Date.now()}`);
    await setShadowGate(true);
    const actor = employeeMovementActor(w.emp);
    const clientRequestId = `tz-${Date.now()}`;
    await prismaA.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'America/New_York'`);
      const tz = await tx.$queryRaw<Array<{ tz: string }>>`SELECT current_setting('TimeZone') AS tz`;
      expect(tz[0]?.tz).toBe("America/New_York");
      const result = await submitTorcovkaInTransaction(tx, {
        actor,
        employeeId: w.emp.id,
        clientRequestId,
        batchId: w.batch.id,
        railLotId: w.lot.id,
        railsTaken: 1,
        picks: [{ lengthM: 2, lengthMFixed4: "2.0000", sort: "SORT1", quantity: 1 }],
        plausibilityAck: undefined,
        code: null,
      });
      expect(result.status).toBe("CREATED_NEW");
    }, txOpts);
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { clientRequestId } });
    const movement = await prismaA.inventoryMovement.findFirstOrThrow({
      where: { causationId: op.id },
    });
    const db = await prismaA.$queryRaw<Array<{ work: string; effective: string; equal: boolean }>>`
      SELECT
        to_char("workDate", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS work,
        to_char(m."effectiveAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS effective,
        ("workDate" = m."effectiveAt") AS equal
      FROM "ProductionOperation" o
      JOIN "InventoryMovement" m ON m."causationId" = o.id
      WHERE o.id = ${op.id}
      LIMIT 1
    `;
    expect(db[0]?.equal).toBe(true);
    expect(db[0]?.work).toBe(db[0]?.effective);
    expect(op.workDate.toISOString()).toBe(movement.effectiveAt.toISOString());
    expect(op.workDate.toISOString().replace("Z", "")).toBe(utcNaiveTimestampString(op.workDate));
  });
});
