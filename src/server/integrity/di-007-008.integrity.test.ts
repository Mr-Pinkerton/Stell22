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
  CLIENT_REQUEST_ID_MAX_LENGTH,
  CLIENT_REQUEST_ID_REQUIRED,
  CLIENT_REQUEST_ID_TOO_LONG,
} from "@/lib/request-id";
import {
  submitHours,
  submitPrisadka,
  submitTorcovka,
  submitUpakovka,
} from "@/server/terminal";
import { lockRailLots } from "@/server/internal/finance-operations";
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
  "prisma/migrations/20260905170000_production_operation_client_request_id_not_null/migration.sql",
);

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sqlState(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  const walk = (value: unknown): string | undefined => {
    if (value == null || seen.has(value)) return undefined;
    if (typeof value !== "object") return undefined;
    seen.add(value);
    const rec = value as Record<string, unknown>;
    if (rec.code === "23502") return "23502";
    if (typeof rec.code === "string" && rec.code === "P2010" && rec.meta && typeof rec.meta === "object") {
      const meta = rec.meta as Record<string, unknown>;
      if (meta.code === "23502") return "23502";
    }
    for (const key of ["cause", "meta", "originalError", "error"]) {
      const nested = walk(rec[key]);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(err);
}

function isDuplicateClientRequest(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const err = e as { code?: string; meta?: { target?: unknown } };
  if (err.code !== "P2002") return false;
  const target = err.meta?.target;
  return Array.isArray(target)
    ? target.includes("clientRequestId")
    : String(target ?? "").includes("clientRequestId");
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

describe.skipIf(!enabled)("DI-007/DI-008 terminal idempotency", () => {
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

  async function seedTorcovka(suffix: string, remaining: number, lotLengthM = "2") {
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        rateTorcovkaSort1: 10,
        rateTorcovkaSort2: 10,
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
        lengthM: new Prisma.Decimal(lotLengthM),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: remaining,
        remainingQuantity: remaining,
      },
    });
    return { material, emp, batch, lot };
  }

  async function seedPrisadka(suffix: string, blankQty: number) {
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        ratePrisadkaTorcev: 5,
        ratePrisadkaPloskt: 5,
        rateUpakovka: 10,
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
        prisadkaPloskost: false,
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

  async function seedUpakovka(suffix: string, blankQty: number) {
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: { fullName: `emp-${suffix}`, pin: "1234", rateUpakovka: 10, hourlyRate: 100 },
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
        details: { create: [{ detailId: det.id, quantity: 2 }] },
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

  async function torcovkaState(w: { lot: { id: string }; material: { id: string } }) {
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } });
    const ops = await prismaA.productionOperation.count({ where: { type: "TORCOVKA" } });
    const blanks = await prismaA.blankStock.findMany({ where: { materialId: w.material.id } });
    const logs = await prismaA.changeLog.count({ where: { entity: "ProductionOperation" } });
    const batchLogs = await prismaA.changeLog.count({ where: { entity: "Batch" } });
    return {
      remaining: lot.remainingQuantity,
      ops,
      blankQty: blanks.reduce((s, b) => s + b.quantity, 0),
      logs,
      batchLogs,
    };
  }

  it("1 TORCOVKA depleted same-id retry is CREATED, ops=1, remaining=0", async () => {
    const w = await seedTorcovka(`s1-${Date.now()}`, 10);
    const input = {
      employeeId: w.emp.id,
      clientRequestId: `test:di007:s1-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 19 }],
    };
    const first = await submitTorcovka(input);
    expect(first).toEqual({ status: "CREATED" });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const afterFirst = await torcovkaState(w);
    expect(afterFirst.remaining).toBe(0);
    expect(afterFirst.ops).toBe(1);
    const second = await submitTorcovka(input);
    expect(second).toEqual({ status: "CREATED" });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    const after = await torcovkaState(w);
    expect(after.remaining).toBe(0);
    expect(after.ops).toBe(1);
    expect(after.logs).toBe(1);
    expect(after.blankQty).toBe(19);
  });

  it("2 TORCOVKA non-depleted same-id retry does not decrement twice", async () => {
    const w = await seedTorcovka(`s2-${Date.now()}`, 30);
    const input = {
      employeeId: w.emp.id,
      clientRequestId: `test:di007:s2-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 19 }],
    };
    await submitTorcovka(input);
    const afterFirst = await torcovkaState(w);
    await submitTorcovka(input);
    const after = await torcovkaState(w);
    expect(after.remaining).toBe(afterFirst.remaining);
    expect(after.ops).toBe(1);
    expect(after.blankQty).toBe(afterFirst.blankQty);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });

  it("3 SUSPICIOUS + ack, same id + ack → replay success", async () => {
    const w = await seedTorcovka(`s3-${Date.now()}`, 30);
    const requestId = `test:di007:s3-${Date.now()}`;
    const base = {
      employeeId: w.emp.id,
      clientRequestId: requestId,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 15 }],
    };
    const ack = {
      kind: "SUSPICIOUS" as const,
      railsTaken: 10,
      takenM: "20.0000",
      producedM: "15.0000",
      wastePct: "25.00",
    };
    expect((await submitTorcovka(base)).status).toBe("ACK_REQUIRED");
    expect((await submitTorcovka({ ...base, plausibilityAck: ack })).status).toBe("CREATED");
    expect((await submitTorcovka({ ...base, plausibilityAck: ack })).status).toBe("CREATED");
    expect(await prismaA.productionOperation.count({ where: { type: "TORCOVKA" } })).toBe(1);
  });

  it("4 SUSPICIOUS + ack, same id WITHOUT ack → replay CREATED not ACK_REQUIRED", async () => {
    const w = await seedTorcovka(`s4-${Date.now()}`, 30);
    const requestId = `test:di007:s4-${Date.now()}`;
    const base = {
      employeeId: w.emp.id,
      clientRequestId: requestId,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 15 }],
    };
    await submitTorcovka({
      ...base,
      plausibilityAck: {
        kind: "SUSPICIOUS",
        railsTaken: 10,
        takenM: "20.0000",
        producedM: "15.0000",
        wastePct: "25.00",
      },
    });
    const replay = await submitTorcovka(base);
    expect(replay).toEqual({ status: "CREATED" });
    expect(await prismaA.productionOperation.count({ where: { type: "TORCOVKA" } })).toBe(1);
  });

  it("5 EXTREME approval code, same id without code → replay success", async () => {
    const w = await seedTorcovka(`s5-${Date.now()}`, 30);
    const requestId = `test:di007:s5-${Date.now()}`;
    const base = {
      employeeId: w.emp.id,
      clientRequestId: requestId,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 4 }],
    };
    const first = await submitTorcovka(base);
    expect(first.status).toBe("APPROVAL_REQUIRED");
    if (first.status !== "APPROVAL_REQUIRED") return;
    const note = await prismaA.notification.findFirstOrThrow({
      where: { key: { startsWith: `event:torcovka-approval:${requestId}:` } },
    });
    const code = note.message.match(/Код подтверждения: (\d{4})/)?.[1];
    expect(code).toMatch(/^\d{4}$/);
    expect(await submitTorcovka({ ...base, approvalCode: code })).toEqual({ status: "CREATED" });
    expect(await submitTorcovka(base)).toEqual({ status: "CREATED" });
    expect(await prismaA.productionOperation.count({ where: { type: "TORCOVKA" } })).toBe(1);
  });

  it("6 concurrent same id with remaining > railsTaken → one op", async () => {
    const w = await seedTorcovka(`s6-${Date.now()}`, 30);
    const input = {
      employeeId: w.emp.id,
      clientRequestId: `test:di007:s6-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 19 }],
    };
    const results = await Promise.allSettled([submitTorcovka(input), submitTorcovka(input)]);
    expect(results.every((r) => r.status === "fulfilled" && r.value.status === "CREATED")).toBe(true);
    const after = await torcovkaState(w);
    expect(after.ops).toBe(1);
    expect(after.remaining).toBe(20);
    expect(after.blankQty).toBe(19);
  });

  it("7 CRITICAL post-lock recheck: remaining === railsTaken, two waiters then both CREATED", async () => {
    const w = await seedTorcovka(`s7-${Date.now()}`, 10);
    const input = {
      employeeId: w.emp.id,
      clientRequestId: `test:di007:s7-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 19 }],
    };

    let blockerPid = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let blockerLocked!: () => void;
    const blockerReady = new Promise<void>((resolve) => {
      blockerLocked = resolve;
    });

    const blocker = prismaB.$transaction(
      async (tx) => {
        await lockRailLots(tx, [w.lot.id]);
        const rows = await tx.$queryRaw<Array<{ pid: unknown }>>`SELECT pg_backend_pid() AS pid`;
        blockerPid = Number(rows[0]?.pid);
        blockerLocked();
        await held;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );

    await blockerReady;

    const p1 = submitTorcovka(input);
    const p2 = submitTorcovka(input);

    try {
      await waitUntil(async () => {
        const activity = await prismaA.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n
          FROM pg_stat_activity a
          WHERE a.datname = current_database()
            AND a.wait_event_type = 'Lock'
            AND a.pid <> ${blockerPid}
        `;
        // PG row-lock convoy: only one waiter is ungranted on the relation
        // (tuple); the second waits on transactionid with relation NULL.
        const locks = await prismaA.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n
          FROM pg_locks l
          WHERE NOT l.granted
            AND l.pid <> ${blockerPid}
            AND (
              l.relation = '"RailLot"'::regclass
              OR l.locktype = 'transactionid'
            )
            AND l.pid IN (
              SELECT a.pid
              FROM pg_stat_activity a
              WHERE a.datname = current_database()
                AND a.wait_event_type = 'Lock'
                AND a.pid <> ${blockerPid}
            )
        `;
        return (activity[0]?.n ?? 0) >= 2 && (locks[0]?.n ?? 0) >= 2;
      }, "expected 2 RailLot lock waiters");
    } finally {
      release();
    }
    const submitResults = await Promise.allSettled([p1, p2]);
    await blocker;
    expect(
      submitResults.every((r) => r.status === "fulfilled" && r.value.status === "CREATED"),
    ).toBe(true);
    expect(submitResults.some((r) => r.status === "rejected" && msg(r.reason).includes("Недостаточно реек"))).toBe(
      false,
    );
    const after = await torcovkaState(w);
    expect(after.remaining).toBe(0);
    expect(after.ops).toBe(1);
    expect(after.blankQty).toBe(19);
    expect(after.logs).toBe(1);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  }, 25_000);

  it("8 ChangeLog exactly once after replay", async () => {
    const w = await seedTorcovka(`s8-${Date.now()}`, 10);
    const input = {
      employeeId: w.emp.id,
      clientRequestId: `test:di007:s8-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 19 }],
    };
    await submitTorcovka(input);
    await submitTorcovka(input);
    expect(await prismaA.changeLog.count({ where: { entity: "ProductionOperation" } })).toBe(1);
  });

  it("9 BlankStock exactly once after replay", async () => {
    const w = await seedTorcovka(`s9-${Date.now()}`, 10);
    const input = {
      employeeId: w.emp.id,
      clientRequestId: `test:di007:s9-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 19 }],
    };
    await submitTorcovka(input);
    await submitTorcovka(input);
    const after = await torcovkaState(w);
    expect(after.blankQty).toBe(19);
  });

  it("10 Batch archive once; closedAt not rewritten by replay", async () => {
    const w = await seedTorcovka(`s10-${Date.now()}`, 10);
    const input = {
      employeeId: w.emp.id,
      clientRequestId: `test:di007:s10-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 19 }],
    };
    await submitTorcovka(input);
    const afterFirst = await prismaA.batch.findUniqueOrThrow({ where: { id: w.batch.id } });
    expect(afterFirst.closedAt).not.toBeNull();
    const closedAt = afterFirst.closedAt!.toISOString();
    const batchLogs = await prismaA.changeLog.count({ where: { entity: "Batch" } });
    await submitTorcovka(input);
    const afterReplay = await prismaA.batch.findUniqueOrThrow({ where: { id: w.batch.id } });
    expect(afterReplay.closedAt?.toISOString()).toBe(closedAt);
    expect(await prismaA.changeLog.count({ where: { entity: "Batch" } })).toBe(batchLogs);
  });

  it("11 TORCOVKA missing id → controlled error, zero writes", async () => {
    const w = await seedTorcovka(`s11-${Date.now()}`, 10);
    await expect(
      submitTorcovka({
        employeeId: w.emp.id,
        batchId: w.batch.id,
        railLotId: w.lot.id,
        railsTaken: 1,
        picks: [{ lengthM: 1, sort: "SORT1", quantity: 1 }],
      } as never),
    ).rejects.toThrow(CLIENT_REQUEST_ID_REQUIRED);
    expect(await torcovkaState(w)).toMatchObject({ remaining: 10, ops: 0, logs: 0, blankQty: 0 });
  });

  it("12 PRISADKA missing id → zero writes", async () => {
    const w = await seedPrisadka(`s12-${Date.now()}`, 4);
    await expect(
      submitPrisadka({
        employeeId: w.emp.id,
        picks: [{ detailId: w.det.id, kind: "torcev", quantity: 2 }],
      } as never),
    ).rejects.toThrow(CLIENT_REQUEST_ID_REQUIRED);
    const blanks = await prismaA.blankStock.aggregate({
      where: { materialId: w.material.id },
      _sum: { quantity: true },
    });
    expect(blanks._sum.quantity).toBe(4);
    expect(await prismaA.productionOperation.count()).toBe(0);
  });

  it("13 UPAKOVKA missing id → zero writes", async () => {
    const w = await seedUpakovka(`s13-${Date.now()}`, 4);
    await expect(
      submitUpakovka({
        employeeId: w.emp.id,
        picks: [{ productId: w.prod.id, quantity: 1 }],
      } as never),
    ).rejects.toThrow(CLIENT_REQUEST_ID_REQUIRED);
    expect(await prismaA.productionOperation.count()).toBe(0);
    expect(await prismaA.productStock.count()).toBe(0);
  });

  it("14 HOURS missing id → zero writes", async () => {
    const w = await seedPrisadka(`s14-${Date.now()}`, 1);
    await expect(
      submitHours(w.emp.id, 8, undefined as unknown as string),
    ).rejects.toThrow(CLIENT_REQUEST_ID_REQUIRED);
    expect(await prismaA.productionOperation.count()).toBe(0);
    expect(await prismaA.changeLog.count()).toBe(0);
  });

  it("15 empty/whitespace/too-long → controlled errors, zero writes", async () => {
    const w = await seedTorcovka(`s15-${Date.now()}`, 10);
    const base = {
      employeeId: w.emp.id,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 1,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 1 }],
    };
    await expect(submitTorcovka({ ...base, clientRequestId: "" })).rejects.toThrow(
      CLIENT_REQUEST_ID_REQUIRED,
    );
    await expect(submitTorcovka({ ...base, clientRequestId: "   " })).rejects.toThrow(
      CLIENT_REQUEST_ID_REQUIRED,
    );
    await expect(
      submitTorcovka({ ...base, clientRequestId: "a".repeat(CLIENT_REQUEST_ID_MAX_LENGTH + 1) }),
    ).rejects.toThrow(CLIENT_REQUEST_ID_TOO_LONG);
    expect(await prismaA.productionOperation.count()).toBe(0);
  });

  it("16 DB NOT NULL: raw SQL INSERT NULL → SQLSTATE 23502, zero row", async () => {
    const w = await seedPrisadka(`s16-${Date.now()}`, 1);
    const id = `raw-null-${Date.now()}`;
    let thrown: unknown;
    try {
      await prismaA.$executeRawUnsafe(
        `INSERT INTO "ProductionOperation" (id, type, "employeeId", "workDate", "clientRequestId")
         VALUES ($1, 'HOURS', $2, NOW(), NULL)`,
        id,
        w.emp.id,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeTruthy();
    expect(sqlState(thrown)).toBe("23502");
    expect(await prismaA.productionOperation.count({ where: { id } })).toBe(0);
  });

  it("17 duplicate non-null id: P2002 + submit replay", async () => {
    const w = await seedPrisadka(`s17-${Date.now()}`, 1);
    const requestId = `test:di008:s17-${Date.now()}`;
    await prismaA.productionOperation.create({
      data: {
        type: "HOURS",
        employeeId: w.emp.id,
        clientRequestId: requestId,
        hours: 1,
        workDate: new Date(),
      },
    });
    try {
      await prismaA.productionOperation.create({
        data: {
          type: "HOURS",
          employeeId: w.emp.id,
          clientRequestId: requestId,
          hours: 2,
          workDate: new Date(),
        },
      });
      expect.unreachable("second insert must fail");
    } catch (err) {
      expect(isDuplicateClientRequest(err)).toBe(true);
    }
    await submitHours(w.emp.id, 8, requestId);
    expect(await prismaA.productionOperation.count({ where: { clientRequestId: requestId } })).toBe(1);
  });

  it("18 valid id works on all four action paths", async () => {
    const t = await seedTorcovka(`s18t-${Date.now()}`, 10);
    const p = await seedPrisadka(`s18p-${Date.now()}`, 4);
    const u = await seedUpakovka(`s18u-${Date.now()}`, 4);
    const h = await seedPrisadka(`s18h-${Date.now()}`, 1);
    await submitTorcovka({
      employeeId: t.emp.id,
      clientRequestId: `test:di008:s18-t-${Date.now()}`,
      batchId: t.batch.id,
      railLotId: t.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: 19 }],
    });
    await submitPrisadka({
      employeeId: p.emp.id,
      clientRequestId: `test:di008:s18-p-${Date.now()}`,
      picks: [{ detailId: p.det.id, kind: "torcev", quantity: 1 }],
    });
    await submitUpakovka({
      employeeId: u.emp.id,
      clientRequestId: `test:di008:s18-u-${Date.now()}`,
      picks: [{ productId: u.prod.id, quantity: 1 }],
    });
    await submitHours(h.emp.id, 3, `test:di008:s18-h-${Date.now()}`);
    expect(await prismaA.productionOperation.count()).toBe(4);
  });

  it("19 UPAKOVKA duplicate productId → controlled error, zero writes", async () => {
    const w = await seedUpakovka(`s19-${Date.now()}`, 10);
    await expect(
      submitUpakovka({
        employeeId: w.emp.id,
        clientRequestId: `test:di008:s19-${Date.now()}`,
        picks: [
          { productId: w.prod.id, quantity: 1 },
          { productId: w.prod.id, quantity: 1 },
        ],
      }),
    ).rejects.toThrow("В списке упаковки изделие указано дважды");
    expect(await prismaA.productionOperation.count()).toBe(0);
    const blanks = await prismaA.blankStock.aggregate({
      where: { materialId: w.material.id },
      _sum: { quantity: true },
    });
    expect(blanks._sum.quantity).toBe(10);
  });

  it("20 multiple distinct non-null request ids coexist", async () => {
    const w = await seedPrisadka(`s20-${Date.now()}`, 1);
    await prismaA.productionOperation.create({
      data: {
        type: "HOURS",
        employeeId: w.emp.id,
        clientRequestId: `test:di008:s20-a-${Date.now()}`,
        hours: 1,
        workDate: new Date(),
      },
    });
    await prismaA.productionOperation.create({
      data: {
        type: "HOURS",
        employeeId: w.emp.id,
        clientRequestId: `test:di008:s20-b-${Date.now()}`,
        hours: 2,
        workDate: new Date(),
      },
    });
    expect(await prismaA.productionOperation.count()).toBe(2);
  });

  it("21a migration SQL comment-safe: LOCK/RAISE/SET NOT NULL, no DML", () => {
    const raw = readFileSync(MIGRATION_SQL, "utf8");
    const body = stripSqlComments(raw);
    expect(body).toMatch(/LOCK TABLE\s+"ProductionOperation"/);
    expect(body).toMatch(/RAISE EXCEPTION/);
    expect(body).toMatch(/ALTER COLUMN\s+"clientRequestId"\s+SET NOT NULL/);
    expect(body).not.toMatch(/\bUPDATE\s+"ProductionOperation"/i);
    expect(body).not.toMatch(/\bDELETE\s+FROM\s+"ProductionOperation"/i);
  });

  it("21b NULL-guard is crash-safe: ROLLBACK restores NOT NULL", async () => {
    const w = await seedPrisadka(`s21-${Date.now()}`, 1);
    const fixtureId = `null-guard-${Date.now()}`;
    try {
      await expect(
        prismaB.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe(
              `ALTER TABLE "ProductionOperation" ALTER COLUMN "clientRequestId" DROP NOT NULL`,
            );
            await tx.$executeRawUnsafe(
              `INSERT INTO "ProductionOperation" (id, type, "employeeId", "workDate", "clientRequestId")
               VALUES ($1, 'HOURS', $2, NOW(), NULL)`,
              fixtureId,
              w.emp.id,
            );
            await tx.$executeRawUnsafe(`
              DO $$
              DECLARE
                n_null integer;
                detail text;
              BEGIN
                SELECT count(*) INTO n_null
                FROM "ProductionOperation"
                WHERE "clientRequestId" IS NULL;
                IF n_null > 0 THEN
                  SELECT string_agg(
                           format(
                             'id=%s type=%s employeeId=%s workDate=%s createdAt=%s',
                             id, type, "employeeId", "workDate", "createdAt"
                           ),
                           '; ' ORDER BY "createdAt", id
                         )
                  INTO detail
                  FROM "ProductionOperation"
                  WHERE "clientRequestId" IS NULL;
                  RAISE EXCEPTION
                    'DI-008: % ProductionOperation row(s) have NULL clientRequestId: %; resolve before migrate (no backfill/delete)',
                    n_null, detail;
                END IF;
              END $$;
            `);
          },
          { timeout: 20_000, maxWait: 20_000 },
        ),
      ).rejects.toThrow(/DI-008/);
    } finally {
      await prismaA.productionOperation.deleteMany({ where: { id: fixtureId } });
      const nullness = await prismaA.$queryRaw<Array<{ attnotnull: boolean }>>`
        SELECT a.attnotnull
        FROM pg_attribute a
        WHERE a.attrelid = '"ProductionOperation"'::regclass
          AND a.attname = 'clientRequestId'
      `;
      if (nullness[0] && !nullness[0].attnotnull) {
        await prismaA.$executeRawUnsafe(
          `ALTER TABLE "ProductionOperation" ALTER COLUMN "clientRequestId" SET NOT NULL`,
        );
      }
      const after = await prismaA.$queryRaw<Array<{ attnotnull: boolean }>>`
        SELECT a.attnotnull
        FROM pg_attribute a
        WHERE a.attrelid = '"ProductionOperation"'::regclass
          AND a.attname = 'clientRequestId'
      `;
      expect(after[0]?.attnotnull).toBe(true);
      const nullCount = await prismaA.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM "ProductionOperation" WHERE "clientRequestId" IS NULL
      `;
      expect(nullCount[0]?.n).toBe(0);
    }
  });
});
