vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/session", () => ({ requireAdmin: async () => {} }));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prismaUniqueDiscriminator } from "@/lib/prisma-unique-conflict";
import { lockProductionOperations } from "@/server/internal/finance-operations";
import { markEmployeePaid } from "@/server/payroll";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityCostFreeze,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const CONCURRENCY_TIMEOUT_MS = 20_000;
const BARRIER_TIMEOUT_MS = 20_000;

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function waitUntil(check: () => Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BARRIER_TIMEOUT_MS) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`barrier: ${label}`);
}

describe.skipIf(!enabled)("DI-014 PaymentBatchItem.operationId uniqueness", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityCostFreeze(prismaA);
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
  });

  async function seedUnpaidHours(suffix: string) {
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        hourlyRate: 100,
      },
    });
    const op = await prismaA.productionOperation.create({
      data: {
        type: "HOURS",
        employeeId: emp.id,
        clientRequestId: `test:di-014:${suffix}`,
        workDate: new Date("2026-09-01T00:00:00.000Z"),
        hours: 2,
        isPaid: false,
      },
    });
    return { emp, op };
  }

  async function waitForOpLockWaiters(blockerPid: number, minWaiters: number, label: string) {
    await waitUntil(async () => {
      const activity = await prismaA.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM pg_stat_activity a
        WHERE a.datname = current_database()
          AND a.wait_event_type = 'Lock'
          AND a.pid <> ${blockerPid}
      `;
      const locks = await prismaA.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM pg_locks l
        WHERE NOT l.granted
          AND l.pid <> ${blockerPid}
          AND (
            l.relation = ${Prisma.sql`'"ProductionOperation"'::regclass`}
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
      return (activity[0]?.n ?? 0) >= minWaiters && (locks[0]?.n ?? 0) >= minWaiters;
    }, label);
  }

  function startOpBlocker(operationId: string) {
    let blockerPid = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const done = prismaB.$transaction(
      async (tx) => {
        await lockProductionOperations(tx, [operationId]);
        const rows = await tx.$queryRaw<Array<{ pid: unknown }>>`SELECT pg_backend_pid() AS pid`;
        blockerPid = Number(rows[0]?.pid);
        locked();
        await held;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    return { ready, release, pid: () => blockerPid, done };
  }

  it("DB UNIQUE: second PaymentBatchItem for the same operationId is P2002", async () => {
    const { emp, op } = await seedUnpaidHours(`uniq-${Date.now()}`);
    const paymentA = await prismaA.payment.create({
      data: { employeeId: emp.id, amount: "200.00" },
    });
    const paymentB = await prismaA.payment.create({
      data: { employeeId: emp.id, amount: "200.00" },
    });
    await prismaA.paymentBatchItem.create({
      data: { paymentId: paymentA.id, operationId: op.id },
    });

    try {
      await prismaA.paymentBatchItem.create({
        data: { paymentId: paymentB.id, operationId: op.id },
      });
      throw new Error("expected P2002");
    } catch (e) {
      expect(e).toMatchObject({ code: "P2002" });
      expect(prismaUniqueDiscriminator(e)).toMatch(
        /PaymentBatchItem_operationId_key|operationId|PaymentBatchItem/i,
      );
    }

    expect(await prismaA.paymentBatchItem.count({ where: { operationId: op.id } })).toBe(1);
  });

  it("sequential markEmployeePaid same employee: second call is no-unpaid, one item", async () => {
    const { emp, op } = await seedUnpaidHours(`seq-${Date.now()}`);

    await markEmployeePaid(emp.id);

    await expect(markEmployeePaid(emp.id)).rejects.toThrow(/невыплаченных/i);

    expect(await prismaA.payment.count({ where: { employeeId: emp.id } })).toBe(1);
    expect(await prismaA.paymentBatchItem.count({ where: { operationId: op.id } })).toBe(1);
    const after = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(after.isPaid).toBe(true);
  });

  it("concurrent markEmployeePaid same unpaid op: one succeeds, one controlled error", async () => {
    const { emp, op } = await seedUnpaidHours(`conc-${Date.now()}`);

    const blocker = startOpBlocker(op.id);
    await blocker.ready;

    const t1 = markEmployeePaid(emp.id);
    await waitForOpLockWaiters(blocker.pid(), 1, "DI-014 T1 waiting on ProductionOperation FOR UPDATE");
    const t2 = markEmployeePaid(emp.id);
    await waitForOpLockWaiters(blocker.pid(), 2, "DI-014 T2 waiting on ProductionOperation FOR UPDATE");

    blocker.release();
    const settled = await Promise.allSettled([
      Promise.race([
        t1,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("QueryTimeout: T1")), CONCURRENCY_TIMEOUT_MS),
        ),
      ]),
      Promise.race([
        t2,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("QueryTimeout: T2")), CONCURRENCY_TIMEOUT_MS),
        ),
      ]),
    ]);
    await blocker.done;

    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(errorMessage((rejected[0] as PromiseRejectedResult).reason)).toMatch(
      /уже выплачены|невыплаченных/i,
    );

    expect(await prismaA.payment.count({ where: { employeeId: emp.id } })).toBe(1);
    expect(await prismaA.paymentBatchItem.count({ where: { operationId: op.id } })).toBe(1);
    const after = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: op.id } });
    expect(after.isPaid).toBe(true);
  });
});
