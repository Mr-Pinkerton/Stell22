vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));
vi.mock("@/server/session", () => ({
  requireAdmin: async () => {},
  requireTerminalEmployee: async () => {},
}));

const { enqueueMock } = vi.hoisted(() => ({
  enqueueMock: vi.fn(async () => {}),
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: enqueueMock }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import {
  submitHours,
  submitPrisadka,
  submitTorcovka,
  submitUpakovka,
} from "@/server/terminal";
import { getSalaryReport, markEmployeePaid } from "@/server/payroll";
import { updateProductionLineQuantity } from "@/server/production";
import { buildCostReport } from "@/server/internal/cost";
import {
  evaluateDi015Preflight,
  operationEarning,
  operationRateSnapshotWrite,
  operationRatesFromSnapshots,
  RATE_SNAPSHOT_VERSION,
} from "@/lib/payroll";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const BARRIER_TIMEOUT_MS = 20_000;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MIGRATION_SQL = path.join(
  repoRoot,
  "prisma/migrations/20260906013000_operation_rate_snapshots/migration.sql",
);
const PREFLIGHT = path.join(repoRoot, "scripts/preflight-prod.sh");

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

async function waitUntil(check: () => Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BARRIER_TIMEOUT_MS) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`barrier: ${label}`);
}

describe.skipIf(!enabled)("DI-015 payroll rate snapshot", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityInventory(prismaA);
    enqueueMock.mockClear();
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
  });

  async function seedTorcovka(suffix: string, t1: number, t2: number) {
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        rateTorcovkaSort1: t1,
        rateTorcovkaSort2: t2,
        hourlyRate: 100,
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
        quantity: 20,
        remainingQuantity: 20,
      },
    });
    return { material, emp, batch, lot };
  }

  async function seedPrisadka(suffix: string, rt: number, rp: number, blankQty: number) {
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        ratePrisadkaTorcev: rt,
        ratePrisadkaPloskt: rp,
        hourlyRate: 100,
      },
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
    await prismaA.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: blankQty,
      },
    });
    return { material, emp, det };
  }

  async function seedUpakovka(suffix: string, rate: number, blankQty: number) {
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: { fullName: `emp-${suffix}`, pin: "1234", rateUpakovka: rate, hourlyRate: 100 },
    });
    const det = await prismaA.detail.create({
      data: {
        name: `det-${suffix}`,
        materialId: material.id,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: false,
        prisadkaPloskost: false,
      },
    });
    const prod = await prismaA.product.create({
      data: {
        name: `prod-${suffix}`,
        materialId: material.id,
        skuOzon: `OZ-${suffix}`,
        skuWb: `WB-${suffix}`,
        sort: "SORT1",
        details: { create: [{ detailId: det.id, quantity: 1 }] },
      },
    });
    await prismaA.blankStock.create({
      data: {
        materialId: material.id,
        lengthM: new Prisma.Decimal("0.6000"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: blankQty,
      },
    });
    return { material, emp, det, prod };
  }

  it("K migration SQL and schema-state-aware preflight", async () => {
    const body = stripSqlComments(readFileSync(MIGRATION_SQL, "utf8"));
    expect(body).toMatch(/LOCK TABLE\s+"ProductionOperation"\s+IN ACCESS EXCLUSIVE MODE/);
    expect(body).toMatch(/DI-015: ProductionOperation contains/);
    expect(body).toMatch(/hourlyRateSnapshot/);
    expect(body).toMatch(/rateUpakovkaSnapshot/);
    expect(body).toMatch(/"rateSnapshotVersion" integer NOT NULL/);
    expect(body).not.toMatch(/rateSnapshotVersion[^;]*DEFAULT/i);
    expect(body).not.toMatch(/\bUPDATE\b/i);
    expect(body).not.toMatch(/\bDELETE\b/i);
    expect(body).not.toMatch(/DEFAULT\s+0/);

    expect(evaluateDi015Preflight(0, 0)).toBe("ok");
    expect(evaluateDi015Preflight(0, 1)).toBe("stop-ops-before-migrate");
    expect(evaluateDi015Preflight(7, 12)).toBe("ok");
    expect(evaluateDi015Preflight(3, 0)).toBe("stop-inconsistent-schema");

    const preflight = readFileSync(PREFLIGHT, "utf8");
    expect(preflight).toMatch(/snapshot_column_count/);
    expect(preflight).toMatch(/rateSnapshotVersion/);
    expect(preflight).toMatch(/INCONSISTENT DI-015 SCHEMA/);
    expect(preflight).toMatch(/before rate-snapshot columns/);
    expect(preflight).toMatch(/snapshot_column_count" -eq 7/);
    expect(preflight).not.toMatch(
      /DI-015: ProductionOperation count is \$\{op_total\}\. STOP\. Rate snapshots cannot be reconstructed automatically/,
    );

    const cols = await prismaA.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public'
        AND c.relname = 'ProductionOperation'
        AND a.attnum > 0
        AND NOT a.attisdropped
        AND a.attname IN (
          'hourlyRateSnapshot',
          'rateTorcovkaSort1Snapshot',
          'rateTorcovkaSort2Snapshot',
          'ratePrisadkaTorcevSnapshot',
          'ratePrisadkaPlosktSnapshot',
          'rateUpakovkaSnapshot',
          'rateSnapshotVersion'
        )
    `;
    expect(cols[0]?.n).toBe(7);

    const catalog = await prismaA.$queryRaw<
      Array<{ attname: string; attnotnull: boolean; def: string | null }>
    >`
      SELECT a.attname, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = '"ProductionOperation"'::regclass
        AND a.attname IN (
          'hourlyRateSnapshot',
          'rateTorcovkaSort1Snapshot',
          'rateTorcovkaSort2Snapshot',
          'ratePrisadkaTorcevSnapshot',
          'ratePrisadkaPlosktSnapshot',
          'rateUpakovkaSnapshot',
          'rateSnapshotVersion'
        )
    `;
    const byName = new Map(catalog.map((c) => [c.attname, c]));
    const versionCol = byName.get("rateSnapshotVersion");
    expect(versionCol?.attnotnull).toBe(true);
    expect(versionCol?.def).toBeNull();
    for (const name of [
      "hourlyRateSnapshot",
      "rateTorcovkaSort1Snapshot",
      "rateTorcovkaSort2Snapshot",
      "ratePrisadkaTorcevSnapshot",
      "ratePrisadkaPlosktSnapshot",
      "rateUpakovkaSnapshot",
    ]) {
      expect(byName.get(name)?.attnotnull).toBe(false);
      expect(byName.get(name)?.def).toBeNull();
    }

    const emp = await prismaA.employee.create({
      data: { fullName: `k-${Date.now()}`, pin: "1234", hourlyRate: 1 },
    });
    await submitHours(emp.id, 1, `test:di015:k-${Date.now()}`);
    expect(await prismaA.productionOperation.count()).toBeGreaterThan(0);
    expect(evaluateDi015Preflight(cols[0]?.n ?? 0, 1)).toBe("ok");
  });

  it("old pre-DI-015 writer INSERT without rateSnapshotVersion fails closed", async () => {
    const emp = await prismaA.employee.create({
      data: { fullName: `oldw-${Date.now()}`, pin: "1234", hourlyRate: 40 },
    });
    const id = `old-writer-${Date.now()}`;
    const requestId = `test:di015:old-writer-${Date.now()}`;
    let thrown: unknown;
    try {
      await prismaA.$executeRawUnsafe(
        `INSERT INTO "ProductionOperation" (id, type, "employeeId", "workDate", "clientRequestId")
         VALUES ($1, 'HOURS', $2, NOW(), $3)`,
        id,
        emp.id,
        requestId,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    const rec = thrown as { code?: string; meta?: { code?: string }; message?: string };
    const state = rec.meta?.code ?? rec.code;
    expect(state === "23502" || rec.code === "P2010" || String(thrown).includes("23502")).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { id } })).toBe(0);
    expect(await prismaA.productionOperation.count({ where: { clientRequestId: requestId } })).toBe(0);
  });

  it("A TORCOVKA mixed sorts keep old snapshot after Employee raise", async () => {
    const w = await seedTorcovka(`a-${Date.now()}`, 20, 10);
    const req = `test:di015:a-${Date.now()}`;
    const first = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: req,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 2,
      picks: [
        { lengthM: 1.5, sort: "SORT1", quantity: 2 },
        { lengthM: 1, sort: "SORT2", quantity: 1 },
      ],
    });
    expect(first).toEqual({ status: "CREATED" });
    await prismaA.employee.update({
      where: { id: w.emp.id },
      data: { rateTorcovkaSort1: 25, rateTorcovkaSort2: 15 },
    });
    const oldOp = await prismaA.productionOperation.findUniqueOrThrow({
      where: { clientRequestId: req },
      include: { lines: true },
    });
    expect(num(oldOp.rateTorcovkaSort1Snapshot)).toBe(20);
    expect(num(oldOp.rateTorcovkaSort2Snapshot)).toBe(10);
    expect(oldOp.rateSnapshotVersion).toBe(RATE_SNAPSHOT_VERSION);
    const oldEarn = operationEarning({
      type: "TORCOVKA",
      rates: operationRatesFromSnapshots(oldOp),
      lines: oldOp.lines.map((l) => ({ quantity: l.quantity, sort: l.blankSort ?? undefined })),
    });
    expect(oldEarn.amount).toBe(50);
    const report = await getSalaryReport();
    const unpaid = report.find((r) => r.id === `unpaid:${w.emp.id}`);
    expect(unpaid?.total).toBe(50);

    const second = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: `test:di015:a2-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 1,
      picks: [{ lengthM: 2, sort: "SORT1", quantity: 1 }],
    });
    expect(second).toEqual({ status: "CREATED" });
    const report2 = await getSalaryReport();
    const unpaid2 = report2.find((r) => r.id === `unpaid:${w.emp.id}`);
    expect(unpaid2?.total).toBe(75);
  });

  it("B PRISADKA mixed kinds keep old snapshot after raise", async () => {
    const w = await seedPrisadka(`b-${Date.now()}`, 4, 6, 10);
    const req = `test:di015:b-${Date.now()}`;
    await submitPrisadka({
      employeeId: w.emp.id,
      clientRequestId: req,
      picks: [
        { detailId: w.det.id, kind: "torcev", quantity: 2 },
        { detailId: w.det.id, kind: "plosk", quantity: 1 },
      ],
    });
    await prismaA.employee.update({
      where: { id: w.emp.id },
      data: { ratePrisadkaTorcev: 40, ratePrisadkaPloskt: 60 },
    });
    const report = await getSalaryReport();
    expect(report.find((r) => r.id === `unpaid:${w.emp.id}`)?.total).toBe(14);
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { clientRequestId: req } });
    expect(op.rateSnapshotVersion).toBe(RATE_SNAPSHOT_VERSION);
    expect(num(op.ratePrisadkaTorcevSnapshot)).toBe(4);
    expect(num(op.ratePrisadkaPlosktSnapshot)).toBe(6);
  });

  it("C UPAKOVKA keeps old snapshot after raise", async () => {
    const w = await seedUpakovka(`c-${Date.now()}`, 8, 5);
    const req = `test:di015:c-${Date.now()}`;
    await submitUpakovka({
      employeeId: w.emp.id,
      clientRequestId: req,
      picks: [{ productId: w.prod.id, quantity: 2 }],
    });
    await prismaA.employee.update({ where: { id: w.emp.id }, data: { rateUpakovka: 99 } });
    expect(await getSalaryReport().then((rows) => rows.find((r) => r.id === `unpaid:${w.emp.id}`)?.total)).toBe(
      16,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { employeeId: w.emp.id } });
    expect(op.rateSnapshotVersion).toBe(RATE_SNAPSHOT_VERSION);
    expect(num(op.rateUpakovkaSnapshot)).toBe(8);
  });

  it("D HOURS keeps old snapshot after raise", async () => {
    const emp = await prismaA.employee.create({
      data: { fullName: `h-${Date.now()}`, pin: "1234", hourlyRate: 50 },
    });
    await submitHours(emp.id, 2, `test:di015:d-${Date.now()}`);
    await prismaA.employee.update({ where: { id: emp.id }, data: { hourlyRate: 80 } });
    expect(await getSalaryReport().then((rows) => rows.find((r) => r.id === `unpaid:${emp.id}`)?.total)).toBe(
      100,
    );
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { employeeId: emp.id } });
    expect(op.rateSnapshotVersion).toBe(RATE_SNAPSHOT_VERSION);
    expect(num(op.hourlyRateSnapshot)).toBe(50);
  });

  it("E fact correction uses historical snapshot", async () => {
    const emp = await prismaA.employee.create({
      data: { fullName: `e-${Date.now()}`, pin: "1234", hourlyRate: 20 },
    });
    const req = `test:di015:e-${Date.now()}`;
    await submitHours(emp.id, 10, req);
    await prismaA.employee.update({ where: { id: emp.id }, data: { hourlyRate: 50 } });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { clientRequestId: req } });
    await updateProductionLineQuantity(op.id, 0, 9);
    const after = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(num(after.hourlyRateSnapshot)).toBe(20);
    expect(num(after.hours)).toBe(9);
    expect(await getSalaryReport().then((rows) => rows.find((r) => r.id === `unpaid:${emp.id}`)?.total)).toBe(
      180,
    );
  });

  it("F markEmployeePaid uses snapshot not live rate", async () => {
    const emp = await prismaA.employee.create({
      data: { fullName: `f-${Date.now()}`, pin: "1234", hourlyRate: 30 },
    });
    await submitHours(emp.id, 2, `test:di015:f-${Date.now()}`);
    await prismaA.employee.update({ where: { id: emp.id }, data: { hourlyRate: 90 } });
    await markEmployeePaid(emp.id);
    const payment = await prismaA.payment.findFirstOrThrow({ where: { employeeId: emp.id } });
    expect(num(payment.amount)).toBe(60);
    expect(await prismaA.paymentBatchItem.count({ where: { paymentId: payment.id } })).toBe(1);
  });

  it("G paid day breakdown stays on snapshots after later raise", async () => {
    const emp = await prismaA.employee.create({
      data: { fullName: `g-${Date.now()}`, pin: "1234", hourlyRate: 40 },
    });
    await submitHours(emp.id, 3, `test:di015:g-${Date.now()}`);
    await markEmployeePaid(emp.id);
    await prismaA.employee.update({ where: { id: emp.id }, data: { hourlyRate: 400 } });
    const paid = (await getSalaryReport()).find((r) => r.paid && r.id !== `unpaid:${emp.id}`);
    expect(paid?.total).toBe(120);
    expect(paid?.days[0]?.total).toBe(120);
  });

  it("H cost labor does not move after Employee raise", async () => {
    const w = await seedTorcovka(`h-${Date.now()}`, 5, 5);
    expect(
      await submitTorcovka({
        employeeId: w.emp.id,
        clientRequestId: `test:di015:h-${Date.now()}`,
        batchId: w.batch.id,
        railLotId: w.lot.id,
        railsTaken: 1,
        picks: [{ lengthM: 1, sort: "SORT1", quantity: 2 }],
      }),
    ).toEqual({ status: "CREATED" });
    const before = await buildCostReport(null);
    const workBefore = before.details.reduce((s, d) => s + d.workCost, 0);
    await prismaA.employee.update({ where: { id: w.emp.id }, data: { rateTorcovkaSort1: 50 } });
    const after = await buildCostReport(null);
    const workAfter = after.details.reduce((s, d) => s + d.workCost, 0);
    expect(workAfter).toBe(workBefore);
    expect(workBefore).toBeGreaterThan(0);
  });

  it("I-seq: update then submit uses new rate; submit then update keeps old", async () => {
    const emp = await prismaA.employee.create({
      data: { fullName: `i-${Date.now()}`, pin: "1234", hourlyRate: 10 },
    });
    const first = `test:di015:i1-${Date.now()}`;
    await submitHours(emp.id, 1, first);
    await prismaA.employee.update({ where: { id: emp.id }, data: { hourlyRate: 40 } });
    const second = `test:di015:i2-${Date.now()}`;
    await submitHours(emp.id, 1, second);
    const oldOp = await prismaA.productionOperation.findUniqueOrThrow({ where: { clientRequestId: first } });
    const newOp = await prismaA.productionOperation.findUniqueOrThrow({ where: { clientRequestId: second } });
    expect(num(oldOp.hourlyRateSnapshot)).toBe(10);
    expect(num(newOp.hourlyRateSnapshot)).toBe(40);
  });

  it("I-conc: submitHours and Employee UPDATE serialize without deadlock", async () => {
    const emp = await prismaA.employee.create({
      data: { fullName: `ic-${Date.now()}`, pin: "1234", hourlyRate: 12 },
    });
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = prismaB.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Employee" WHERE id = ${emp.id} FOR UPDATE`;
      await hold;
    });
    await waitUntil(async () => {
      const locks = await prismaA.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM pg_locks l
        JOIN pg_class c ON c.oid = l.relation
        WHERE c.relname = 'Employee' AND l.granted AND l.mode = 'RowShareLock'
      `;
      return (locks[0]?.n ?? 0) > 0;
    }, "blocker holds Employee");

    const submitP = submitHours(emp.id, 1, `test:di015:ic-${Date.now()}`);
    const updateP = prismaA.employee.update({ where: { id: emp.id }, data: { hourlyRate: 99 } });
    await waitUntil(async () => {
      const waiting = await prismaA.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
      `;
      return (waiting[0]?.n ?? 0) >= 1;
    }, "submit or update waiting on Employee");
    release();
    await Promise.all([blocker, submitP, updateP]);
    const ops = await prismaA.productionOperation.findMany({ where: { employeeId: emp.id } });
    expect(ops).toHaveLength(1);
    const snap = num(ops[0]?.hourlyRateSnapshot ?? null);
    expect(snap === 12 || snap === 99).toBe(true);
    const live = await prismaA.employee.findUniqueOrThrow({ where: { id: emp.id } });
    expect(num(live.hourlyRate)).toBe(99);
  });

  it("J client cannot inject snapshot rate", async () => {
    const w = await seedTorcovka(`j-${Date.now()}`, 7, 7);
    const created = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: `test:di015:j-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 1,
      picks: [{ lengthM: 2, sort: "SORT1", quantity: 1 }],
      hourlyRateSnapshot: 999,
      rateTorcovkaSort1Snapshot: 999,
      rateSnapshotVersion: 99,
    } as never);
    expect(created).toEqual({ status: "CREATED" });
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { employeeId: w.emp.id } });
    expect(num(op.rateTorcovkaSort1Snapshot)).toBe(7);
    expect(num(op.hourlyRateSnapshot)).toBe(100);
    expect(op.rateSnapshotVersion).toBe(RATE_SNAPSHOT_VERSION);
  });

  it("L PRISADKA committed replay after stock consume", async () => {
    const w = await seedPrisadka(`l-${Date.now()}`, 3, 3, 2);
    const req = `test:di015:l-${Date.now()}`;
    await submitPrisadka({
      employeeId: w.emp.id,
      clientRequestId: req,
      picks: [{ detailId: w.det.id, kind: "torcev", quantity: 2 }],
    });
    const before = await prismaA.productionOperation.findMany({ include: { lines: true } });
    await prismaA.blankStock.updateMany({ data: { quantity: 0 } });
    await prismaA.detailStock.deleteMany();
    await submitPrisadka({
      employeeId: w.emp.id,
      clientRequestId: req,
      picks: [{ detailId: w.det.id, kind: "torcev", quantity: 2 }],
    });
    const after = await prismaA.productionOperation.findMany({ include: { lines: true } });
    expect(after).toHaveLength(1);
    expect(num(after[0]?.ratePrisadkaTorcevSnapshot ?? null)).toBe(3);
    expect(after[0]?.id).toBe(before[0]?.id);
  });

  it("M UPAKOVKA committed replay after stock consume", async () => {
    const w = await seedUpakovka(`m-${Date.now()}`, 11, 3);
    const req = `test:di015:m-${Date.now()}`;
    await submitUpakovka({
      employeeId: w.emp.id,
      clientRequestId: req,
      picks: [{ productId: w.prod.id, quantity: 1 }],
    });
    const beforeQty = await prismaA.productStock.aggregate({ _sum: { quantity: true } });
    await prismaA.blankStock.updateMany({ data: { quantity: 0 } });
    await submitUpakovka({
      employeeId: w.emp.id,
      clientRequestId: req,
      picks: [{ productId: w.prod.id, quantity: 1 }],
    });
    expect(await prismaA.productionOperation.count()).toBe(1);
    const afterQty = await prismaA.productStock.aggregate({ _sum: { quantity: true } });
    expect(afterQty._sum.quantity).toBe(beforeQty._sum.quantity);
    const op = await prismaA.productionOperation.findFirstOrThrow();
    expect(num(op.rateUpakovkaSnapshot)).toBe(11);
    expect(op.rateSnapshotVersion).toBe(RATE_SNAPSHOT_VERSION);
  });

  async function seedTwoProductsSharedDetail(suffix: string, rate: number, blankQty: number) {
    const w = await seedUpakovka(suffix, rate, blankQty);
    const prod2 = await prismaA.product.create({
      data: {
        name: `prod2-${suffix}`,
        materialId: w.material.id,
        skuOzon: `OZ2-${suffix}`,
        skuWb: `WB2-${suffix}`,
        sort: "SORT1",
        details: { create: [{ detailId: w.det.id, quantity: 1 }] },
      },
    });
    return { ...w, prod2 };
  }

  it("M2 multi-product shared detail with enough stock", async () => {
    const w = await seedTwoProductsSharedDetail(`m2-${Date.now()}`, 9, 5);
    const req = `test:di015:m2-${Date.now()}`;
    await submitUpakovka({
      employeeId: w.emp.id,
      clientRequestId: req,
      picks: [
        { productId: w.prod.id, quantity: 1 },
        { productId: w.prod2.id, quantity: 1 },
      ],
    });
    const ops = await prismaA.productionOperation.findMany({ orderBy: { clientRequestId: "asc" } });
    expect(ops.map((o) => o.clientRequestId).sort()).toEqual(
      [`${req}:${w.prod.id}`, `${req}:${w.prod2.id}`].sort(),
    );
    expect(ops).toHaveLength(2);
    for (const op of ops) {
      expect(op.rateSnapshotVersion).toBe(RATE_SNAPSHOT_VERSION);
      expect(num(op.rateUpakovkaSnapshot)).toBe(9);
      expect(num(op.hourlyRateSnapshot)).toBe(100);
    }
    expect((await prismaA.blankStock.aggregate({ _sum: { quantity: true } }))._sum.quantity).toBe(3);
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: w.prod.id } })).quantity).toBe(
      1,
    );
    expect((await prismaA.productStock.findUniqueOrThrow({ where: { productId: w.prod2.id } })).quantity).toBe(
      1,
    );
  });

  it("M3 multi-product shared detail insufficient combined stock rolls back", async () => {
    const w = await seedTwoProductsSharedDetail(`m3-${Date.now()}`, 9, 1);
    const req = `test:di015:m3-${Date.now()}`;
    await expect(
      submitUpakovka({
        employeeId: w.emp.id,
        clientRequestId: req,
        picks: [
          { productId: w.prod.id, quantity: 1 },
          { productId: w.prod2.id, quantity: 1 },
        ],
      }),
    ).rejects.toThrow(/Недостаточно заготовок для упаковки/);
    expect(await prismaA.productionOperation.count()).toBe(0);
    expect((await prismaA.blankStock.aggregate({ _sum: { quantity: true } }))._sum.quantity).toBe(1);
    expect(await prismaA.productStock.count()).toBe(0);
    expect(await prismaA.operationDetailLine.count()).toBe(0);
  });

  it("M4 multi-product committed replay after stock consume", async () => {
    const w = await seedTwoProductsSharedDetail(`m4-${Date.now()}`, 13, 4);
    const req = `test:di015:m4-${Date.now()}`;
    const picks = [
      { productId: w.prod.id, quantity: 1 },
      { productId: w.prod2.id, quantity: 1 },
    ];
    await submitUpakovka({ employeeId: w.emp.id, clientRequestId: req, picks });
    const beforeOps = await prismaA.productionOperation.findMany({ orderBy: { id: "asc" } });
    const beforeBlanks = (await prismaA.blankStock.aggregate({ _sum: { quantity: true } }))._sum.quantity;
    const beforeProducts = await prismaA.productStock.findMany({ orderBy: { productId: "asc" } });
    await prismaA.blankStock.updateMany({ data: { quantity: 0 } });
    await submitUpakovka({ employeeId: w.emp.id, clientRequestId: req, picks });
    const afterOps = await prismaA.productionOperation.findMany({ orderBy: { id: "asc" } });
    expect(afterOps).toHaveLength(2);
    expect(afterOps.map((o) => o.id)).toEqual(beforeOps.map((o) => o.id));
    expect(afterOps.map((o) => o.rateSnapshotVersion)).toEqual([1, 1]);
    expect(afterOps.map((o) => num(o.rateUpakovkaSnapshot))).toEqual([13, 13]);
    expect((await prismaA.blankStock.aggregate({ _sum: { quantity: true } }))._sum.quantity).toBe(0);
    const afterProducts = await prismaA.productStock.findMany({ orderBy: { productId: "asc" } });
    expect(afterProducts.map((p) => p.quantity)).toEqual(beforeProducts.map((p) => p.quantity));
    expect(beforeBlanks).toBe(2);
  });

  it("M5 partial expected-id set is an invariant anomaly", async () => {
    const w = await seedTwoProductsSharedDetail(`m5-${Date.now()}`, 6, 4);
    const req = `test:di015:m5-${Date.now()}`;
    const emp = await prismaA.employee.findUniqueOrThrow({ where: { id: w.emp.id } });
    await prismaA.productionOperation.create({
      data: {
        type: "UPAKOVKA",
        employeeId: w.emp.id,
        clientRequestId: `${req}:${w.prod.id}`,
        workDate: new Date(),
        productId: w.prod.id,
        productQty: 1,
        ...operationRateSnapshotWrite(emp),
      },
    });
    const blanksBefore = (await prismaA.blankStock.aggregate({ _sum: { quantity: true } }))._sum.quantity;
    await expect(
      submitUpakovka({
        employeeId: w.emp.id,
        clientRequestId: req,
        picks: [
          { productId: w.prod.id, quantity: 1 },
          { productId: w.prod2.id, quantity: 1 },
        ],
      }),
    ).rejects.toThrow(/Несогласованный повтор упаковки/);
    expect(await prismaA.productionOperation.count()).toBe(1);
    expect((await prismaA.blankStock.aggregate({ _sum: { quantity: true } }))._sum.quantity).toBe(
      blanksBefore,
    );
    expect(await prismaA.productStock.count()).toBe(0);
  });

  it("N concurrent same-id PRISADKA: one op, one stock effect", async () => {
    const w = await seedPrisadka(`n-${Date.now()}`, 2, 2, 4);
    const req = `test:di015:n-${Date.now()}`;
    const input = {
      employeeId: w.emp.id,
      clientRequestId: req,
      picks: [{ detailId: w.det.id, kind: "torcev" as const, quantity: 1 }],
    };
    const settled = await Promise.allSettled([submitPrisadka(input), submitPrisadka(input)]);
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(2);
    expect(await prismaA.productionOperation.count()).toBe(1);
    const blanks = await prismaA.blankStock.aggregate({ _sum: { quantity: true } });
    expect(blanks._sum.quantity).toBe(3);
  });
});
