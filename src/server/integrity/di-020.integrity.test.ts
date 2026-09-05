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
import { writeOffBatchRemainder } from "@/server/purchases";
import { correctTorcovkaRailsTaken, deleteProductionOperation } from "@/server/production";
import { submitTorcovka } from "@/server/terminal";
import { archiveBatchIfDepleted } from "@/server/internal/cost";
import { lockBatches, lockRailLots } from "@/server/internal/finance-operations";
import {
  approvalCodeMatches,
  approvalHmacSecret,
  TORCOVKA_APPROVAL_OWNER_MISMATCH,
  TORCOVKA_WRONG_CODE_MESSAGE,
} from "@/lib/torcovka-approval";
import {
  TORCOVKA_APPROVAL_REDACT_INVALIDATED,
  TORCOVKA_APPROVAL_REDACT_NOT_REQUIRED,
  TORCOVKA_APPROVAL_REDACT_USED,
  ensurePendingApproval,
  lockTorcovkaApprovalByClientRequestId,
} from "@/server/internal/torcovka-approval";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityCostFreeze,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const CONCURRENCY_TIMEOUT_MS = 20_000;
const BARRIER_TIMEOUT_MS = 20_000;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

describe.skipIf(!enabled)("DI-020 TORCOVKA input safety", () => {
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

  async function seedWorld(opts: {
    suffix: string;
    lotLengthM: string;
    lotQty: number;
    remaining: number;
    closed?: boolean;
    frozen?: boolean;
  }) {
    const material = await prismaA.material.create({
      data: {
        name: `mat-${opts.suffix}`,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
      },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${opts.suffix}`,
        pin: "1234",
        rateTorcovkaSort1: 10,
        rateTorcovkaSort2: 10,
      },
    });
    const batch = await prismaA.batch.create({
      data: {
        name: `batch-${opts.suffix}`,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 10_000,
        totalCost: 10_000,
        priceSort1: 30_000,
        priceSort2: 20_000,
        purchaseDate: new Date("2026-01-15T00:00:00.000Z"),
        status: opts.closed ? "ARCHIVED" : "IN_WORK",
        closedAt: opts.closed ? new Date("2026-09-01T00:00:00.000Z") : null,
        frozenAt: opts.frozen ? new Date("2026-09-01T00:00:00.000Z") : null,
      },
    });
    const lot = await prismaA.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: new Prisma.Decimal(opts.lotLengthM),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: opts.lotQty,
        remainingQuantity: opts.remaining,
      },
    });
    return { material, emp, batch, lot };
  }

  function extractApprovalCode(message: string): string {
    const m = message.match(/Код подтверждения: (\d{4})/);
    if (!m?.[1]) throw new Error(`no approval code in notification: ${message}`);
    return m[1];
  }

  async function approvalBundle(clientRequestId: string) {
    const row = await prismaA.torcovkaApproval.findUnique({ where: { clientRequestId } });
    const notes = await prismaA.notification.findMany({
      where: { key: { startsWith: `event:torcovka-approval:${clientRequestId}:` } },
      orderBy: [{ createdAt: "asc" }, { key: "asc" }],
    });
    return { row, notes };
  }

  function extremeInput(w: Awaited<ReturnType<typeof seedWorld>>, clientRequestId: string) {
    return {
      employeeId: w.emp.id,
      clientRequestId,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 27 }],
    };
  }

  function suspiciousInput(w: Awaited<ReturnType<typeof seedWorld>>, clientRequestId: string) {
    return {
      ...extremeInput(w, clientRequestId),
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 70 }],
    };
  }

  function normalBandInput(w: Awaited<ReturnType<typeof seedWorld>>, clientRequestId: string) {
    return {
      ...extremeInput(w, clientRequestId),
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 85 }],
    };
  }

  function approvalSnapshot(
    w: Awaited<ReturnType<typeof seedWorld>>,
    clientRequestId: string,
  ) {
    return {
      clientRequestId,
      employeeId: w.emp.id,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      takenM: "100.0000",
      producedM: "27.0000",
      wasteM: "73.0000",
      wastePct: "73.00",
    };
  }

  async function waitUntil(check: () => Promise<boolean>, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < BARRIER_TIMEOUT_MS) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`barrier: ${label}`);
  }

  async function waitForRelationLockWaiters(
    blockerPid: number,
    relation: "RailLot" | "TorcovkaApproval" | "Notification",
    minWaiters: number,
    label: string,
  ): Promise<void> {
    const rel =
      relation === "RailLot"
        ? Prisma.sql`'"RailLot"'::regclass`
        : relation === "Notification"
          ? Prisma.sql`'"Notification"'::regclass`
          : Prisma.sql`'"TorcovkaApproval"'::regclass`;
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
            l.relation = ${rel}
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

  function startRowBlocker(lock: (tx: Prisma.TransactionClient) => Promise<void>): {
    ready: Promise<void>;
    release: () => void;
    pid: () => number;
    done: Promise<unknown>;
  } {
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
        await lock(tx);
        const rows = await tx.$queryRaw<Array<{ pid: unknown }>>`SELECT pg_backend_pid() AS pid`;
        blockerPid = Number(rows[0]?.pid);
        locked();
        await held;
      },
      { timeout: 20_000, maxWait: 20_000 },
    );
    return { ready, release, pid: () => blockerPid, done };
  }

  async function seedExistingOp(opts: {
    suffix: string;
    railsTaken: number;
    remaining: number;
    blankQty: number;
    blankLengthM: string;
    lotLengthM: string;
    closed?: boolean;
    frozen?: boolean;
    paid?: boolean;
  }) {
    const world = await seedWorld({
      suffix: opts.suffix,
      lotLengthM: opts.lotLengthM,
      lotQty: opts.railsTaken + opts.remaining,
      remaining: opts.remaining,
      closed: opts.closed,
      frozen: opts.frozen,
    });
    const op = await prismaA.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId: world.emp.id,
        clientRequestId: `test:di020:seed:${opts.suffix}`,
        batchId: world.batch.id,
        railLotId: world.lot.id,
        railsTaken: opts.railsTaken,
        workDate: new Date("2026-09-01T00:00:00.000Z"),
        isPaid: opts.paid ?? false,
        paidAt: opts.paid ? new Date("2026-09-02T00:00:00.000Z") : null,
        torcovkaSubmitAckBand: "HIGH_WASTE",
        torcovkaSubmitWasteReason: "KNOTS",
        lines: {
          create: [
            {
              quantity: opts.blankQty,
              blankLengthM: new Prisma.Decimal(opts.blankLengthM),
              blankType: "POLKA",
              blankSort: "SORT1",
              blankMaterialId: world.material.id,
            },
          ],
        },
      },
    });
    const stock = await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal(opts.blankLengthM),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: opts.blankQty,
      },
    });
    return { ...world, op, stock };
  }

  it("1: waste 10% no ack → CREATED, submit fields null", async () => {
    const w = await seedWorld({
      suffix: `s1-${Date.now()}`,
      lotLengthM: "2",
      lotQty: 20,
      remaining: 20,
    });
    const result = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: `s1-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 5,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: 9 }],
    });
    expect(result).toEqual({ status: "CREATED" });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { railLotId: w.lot.id },
    });
    expect(op.torcovkaSubmitAckBand).toBeNull();
    expect(op.torcovkaSubmitWasteReason).toBeNull();
    expect(op.torcovkaSubmitWasteNote).toBeNull();
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } });
    expect(lot.remainingQuantity).toBe(15);
  });

  it("2: waste 30% no ack → ACK_REQUIRED, no Op, remaining unchanged", async () => {
    const w = await seedWorld({
      suffix: `s2-${Date.now()}`,
      lotLengthM: "2",
      lotQty: 20,
      remaining: 20,
    });
    const result = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: `s2-${Date.now()}`,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 5,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: 7 }],
    });
    expect(result.status).toBe("ACK_REQUIRED");
    if (result.status !== "ACK_REQUIRED") return;
    expect(result.band).toBe("SUSPICIOUS");
    expect(result.takenM).toBe("10.0000");
    expect(result.producedM).toBe("7.0000");
    expect(result.wastePct).toBe("30.00");
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(0);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } });
    expect(lot.remainingQuantity).toBe(20);
    expect(await prismaA.blankStock.count({ where: { materialId: w.material.id } })).toBe(0);
    expect(await prismaA.changeLog.count({ where: { entity: "ProductionOperation" } })).toBe(0);
  });

  it("3: waste 30% + SUSPICIOUS echo → CREATED, ack band persisted", async () => {
    const w = await seedWorld({
      suffix: `s3-${Date.now()}`,
      lotLengthM: "2",
      lotQty: 20,
      remaining: 20,
    });
    const requestId = `s3-${Date.now()}`;
    const first = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: requestId,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 5,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: 7 }],
    });
    expect(first.status).toBe("ACK_REQUIRED");
    if (first.status !== "ACK_REQUIRED") return;
    const created = await submitTorcovka({
      employeeId: w.emp.id,
      clientRequestId: requestId,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 5,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: 7 }],
      plausibilityAck: {
        kind: "SUSPICIOUS",
        railsTaken: first.railsTaken,
        takenM: first.takenM,
        producedM: first.producedM,
        wastePct: first.wastePct,
      },
    });
    expect(created).toEqual({ status: "CREATED" });
    const ops = await prismaA.productionOperation.findMany({
      where: { railLotId: w.lot.id },
    });
    expect(ops).toHaveLength(1);
    expect(ops[0].clientRequestId).toBe(requestId);
    expect(ops[0].torcovkaSubmitAckBand).toBe("SUSPICIOUS");
    expect(ops[0].torcovkaSubmitWasteReason).toBeNull();
  });

  it("4: EXTREME no code → APPROVAL_REQUIRED, no Op, one approval, one Notification", async () => {
    const w = await seedWorld({
      suffix: `s4-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = extremeInput(w, `s4-${Date.now()}`);
    const first = await submitTorcovka(input);
    expect(first.status).toBe("APPROVAL_REQUIRED");
    if (first.status !== "APPROVAL_REQUIRED") return;
    expect(first.band).toBe("EXTREME");
    expect(first.wasteM).toBe("73.0000");
    expect(first.wastePct).toBe("73.00");
    expect(JSON.stringify(first)).not.toContain("Код подтверждения");
    expect(first).not.toHaveProperty("approvalCode");
    await expect(
      submitTorcovka({
        ...input,
        plausibilityAck: {
          kind: "SUSPICIOUS",
          railsTaken: first.railsTaken,
          takenM: first.takenM,
          producedM: first.producedM,
          wastePct: first.wastePct,
        },
      }),
    ).rejects.toThrow();
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(0);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } });
    expect(lot.remainingQuantity).toBe(20);
    const { row, notes } = await approvalBundle(input.clientRequestId);
    expect(row).not.toBeNull();
    expect(row?.generation).toBe(1);
    expect(notes).toHaveLength(1);
    expect(notes[0].isSystem).toBe(false);
    expect(notes[0].tone).toBe("ERROR");
    expect(notes[0].title).toBe("Требуется подтверждение высокого отхода");
    expect(notes[0].message).toContain("Действует до");
    expect(notes[0].message).toContain(w.emp.fullName);
    expect(notes[0].message).not.toMatch(/(?:PIN|ПИН)\s*[:=]/i);
    const code = extractApprovalCode(notes[0].message);
    expect(approvalCodeMatches(code, row!.codeHash, approvalHmacSecret())).toBe(true);
  });

  it("4b: same id no code again → same approval generation, no new Notification", async () => {
    const w = await seedWorld({
      suffix: `s4b-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = extremeInput(w, `s4b-${Date.now()}`);
    const first = await submitTorcovka(input);
    const second = await submitTorcovka(input);
    expect(first.status).toBe("APPROVAL_REQUIRED");
    expect(second.status).toBe("APPROVAL_REQUIRED");
    const { row, notes } = await approvalBundle(input.clientRequestId);
    expect(row?.generation).toBe(1);
    expect(notes).toHaveLength(1);
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(0);
  });

  it("4c: employee B cannot rebind employee A's approval", async () => {
    const w = await seedWorld({
      suffix: `s4c-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = extremeInput(w, `s4c-${Date.now()}`);
    await submitTorcovka(input);
    const before = await approvalBundle(input.clientRequestId);
    expect(before.row?.employeeId).toBe(w.emp.id);
    expect(before.row?.generation).toBe(1);
    const empB = await prismaA.employee.create({
      data: {
        fullName: `emp-b-${Date.now()}`,
        pin: "5678",
        rateTorcovkaSort1: 10,
        rateTorcovkaSort2: 10,
      },
    });
    await expect(submitTorcovka({ ...input, employeeId: empB.id })).rejects.toThrow(
      TORCOVKA_APPROVAL_OWNER_MISMATCH,
    );
    const after = await approvalBundle(input.clientRequestId);
    expect(after.row?.employeeId).toBe(w.emp.id);
    expect(after.row?.generation).toBe(1);
    expect(after.row?.codeHash).toBe(before.row?.codeHash);
    expect(after.notes).toHaveLength(1);
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(0);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } });
    expect(lot.remainingQuantity).toBe(20);
    expect(await prismaA.blankStock.count()).toBe(0);
  });

  it("5: valid code → CREATED, stock decremented, reason/note null, HIGH_WASTE, consumed", async () => {
    const w = await seedWorld({
      suffix: `s5-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const requestId = `s5-${Date.now()}`;
    const input = extremeInput(w, requestId);
    const first = await submitTorcovka(input);
    expect(first.status).toBe("APPROVAL_REQUIRED");
    const { row, notes } = await approvalBundle(requestId);
    const code = extractApprovalCode(notes[0].message);
    const created = await submitTorcovka({ ...input, approvalCode: code });
    expect(created).toEqual({ status: "CREATED" });
    const ops = await prismaA.productionOperation.findMany({ where: { railLotId: w.lot.id } });
    expect(ops).toHaveLength(1);
    expect(ops[0].clientRequestId).toBe(requestId);
    expect(ops[0].torcovkaSubmitAckBand).toBe("HIGH_WASTE");
    expect(ops[0].torcovkaSubmitWasteReason).toBeNull();
    expect(ops[0].torcovkaSubmitWasteNote).toBeNull();
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } });
    expect(lot.remainingQuantity).toBe(10);
    const consumed = await prismaA.torcovkaApproval.findUniqueOrThrow({
      where: { clientRequestId: requestId },
    });
    expect(consumed.consumedAt).not.toBeNull();
    const redacted = await prismaA.notification.findUniqueOrThrow({ where: { key: notes[0].key } });
    expect(redacted.message).toBe(TORCOVKA_APPROVAL_REDACT_USED);
    expect(redacted.message).not.toMatch(/\d{4}/);
    const log = await prismaA.changeLog.findFirstOrThrow({
      where: { entity: "ProductionOperation", entityId: ops[0].id },
    });
    const values = log.newValues as Record<string, unknown>;
    expect(values.approvalRequired).toBe(true);
    expect(values.approvalId).toBe(row!.id);
    expect(JSON.stringify(values)).not.toContain(code);
    expect(JSON.stringify(values)).not.toContain("codeHash");
    expect(values.approvalCode).toBeUndefined();
  });

  it("5b: wrong code increments attempts, no Op, no stock change", async () => {
    const w = await seedWorld({
      suffix: `s5b-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = extremeInput(w, `s5b-${Date.now()}`);
    await submitTorcovka(input);
    const before = await approvalBundle(input.clientRequestId);
    const real = extractApprovalCode(before.notes[0].message);
    const wrong = real === "0000" ? "0001" : "0000";
    await expect(submitTorcovka({ ...input, approvalCode: wrong })).rejects.toThrow(
      TORCOVKA_WRONG_CODE_MESSAGE,
    );
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(0);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } });
    expect(lot.remainingQuantity).toBe(20);
    const after = await approvalBundle(input.clientRequestId);
    expect(after.row?.failedAttempts).toBe(1);
    expect(after.row?.generation).toBe(1);
    expect(after.notes).toHaveLength(1);
  });

  it("5c: 5 wrong codes rotate generation, redact old notification, public APPROVAL_REQUIRED", async () => {
    const w = await seedWorld({
      suffix: `s5c-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = extremeInput(w, `s5c-${Date.now()}`);
    await submitTorcovka(input);
    const first = await approvalBundle(input.clientRequestId);
    const real = extractApprovalCode(first.notes[0].message);
    const wrong = real === "0000" ? "1111" : "0000";
    for (let i = 0; i < 4; i++) {
      await expect(submitTorcovka({ ...input, approvalCode: wrong })).rejects.toThrow(
        TORCOVKA_WRONG_CODE_MESSAGE,
      );
    }
    const fifth = await submitTorcovka({ ...input, approvalCode: wrong });
    expect(fifth.status).toBe("APPROVAL_REQUIRED");
    expect(fifth).not.toHaveProperty("approvalCode");
    expect(JSON.stringify(fifth)).not.toContain("Код подтверждения");
    const after = await approvalBundle(input.clientRequestId);
    expect(after.row?.generation).toBe(2);
    expect(after.row?.failedAttempts).toBe(0);
    expect(after.notes).toHaveLength(2);
    expect(after.notes[0].message).toBe(TORCOVKA_APPROVAL_REDACT_INVALIDATED);
    const newCode = extractApprovalCode(after.notes[1].message);
    expect(newCode).not.toBe(real);
    expect(approvalCodeMatches(newCode, after.row!.codeHash, approvalHmacSecret())).toBe(true);
  });

  it("6: leftover HIGH_WASTE ack cannot create Op", async () => {
    const w = await seedWorld({
      suffix: `s6-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = {
      employeeId: w.emp.id,
      batchId: w.batch.id,
      railLotId: w.lot.id,
      railsTaken: 10,
      picks: [{ lengthM: 1, sort: "SORT1" as const, quantity: 27 }],
    };
    const first = await submitTorcovka({ ...input, clientRequestId: `s6-a-${Date.now()}` });
    expect(first.status).toBe("APPROVAL_REQUIRED");
    await expect(
      submitTorcovka({
        ...input,
        clientRequestId: `s6-b-${Date.now()}`,
        plausibilityAck: { confirmed: true } as never,
      }),
    ).rejects.toThrow();
    if (first.status === "APPROVAL_REQUIRED") {
      await expect(
        submitTorcovka({
          ...input,
          clientRequestId: `s6-c-${Date.now()}`,
          plausibilityAck: {
            kind: "HIGH_WASTE",
            railsTaken: first.railsTaken,
            takenM: first.takenM,
            producedM: first.producedM,
            wastePct: first.wastePct,
            reason: "KNOTS",
          },
        }),
      ).rejects.toThrow();
    }
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(0);
  });

  it("6b: replay same committed id without code → CREATED, no extra approval/notification", async () => {
    const w = await seedWorld({
      suffix: `s6b-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = extremeInput(w, `s6b-${Date.now()}`);
    await submitTorcovka(input);
    const { notes } = await approvalBundle(input.clientRequestId);
    const code = extractApprovalCode(notes[0].message);
    expect(await submitTorcovka({ ...input, approvalCode: code })).toEqual({ status: "CREATED" });
    expect(await submitTorcovka(input)).toEqual({ status: "CREATED" });
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(1);
    const after = await approvalBundle(input.clientRequestId);
    expect(after.notes).toHaveLength(1);
    expect(after.row?.generation).toBe(1);
    expect(after.row?.consumedAt).not.toBeNull();
  });

  it("7: correction 20 → 4 returns rails, blanks and submit ack fields unchanged", async () => {
    const seeded = await seedExistingOp({
      suffix: `c7-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
    });
    await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      newRailsTaken: 4,
      reason: "ошиблись количеством",
    });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const stock = await prismaA.blankStock.findFirstOrThrow({
      where: { materialId: seeded.material.id },
    });
    const line = await prismaA.operationDetailLine.findFirstOrThrow({
      where: { operationId: seeded.op.id },
    });
    expect(op.railsTaken).toBe(4);
    expect(lot.remainingQuantity).toBe(26);
    expect(stock.quantity).toBe(4);
    expect(line.quantity).toBe(4);
    expect(op.torcovkaSubmitAckBand).toBe("HIGH_WASTE");
    expect(op.torcovkaSubmitWasteReason).toBe("KNOTS");
  });

  it("8: correction that breaks INV-008 is rejected with no writes", async () => {
    const seeded = await seedExistingOp({
      suffix: `c8-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 10,
      blankLengthM: "1",
      lotLengthM: "1",
    });
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        newRailsTaken: 4,
        reason: "too far",
      }),
    ).rejects.toThrow("Суммарная длина заготовок превышает длину взятых реек");
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    expect(op.railsTaken).toBe(20);
    expect(lot.remainingQuantity).toBe(10);
    expect(op.torcovkaSubmitAckBand).toBe("HIGH_WASTE");
  });

  it("9: paid + not frozen: correction allowed, Payment unchanged", async () => {
    const seeded = await seedExistingOp({
      suffix: `c9-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
      paid: true,
    });
    const payment = await prismaA.payment.create({
      data: {
        employeeId: seeded.emp.id,
        amount: 40,
        items: { create: [{ operationId: seeded.op.id }] },
      },
    });
    await correctTorcovkaRailsTaken({
      operationId: seeded.op.id,
      newRailsTaken: 4,
      reason: "paid ok",
    });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const pay = await prismaA.payment.findUniqueOrThrow({ where: { id: payment.id } });
    expect(op.isPaid).toBe(true);
    expect(op.railsTaken).toBe(4);
    expect(Number(pay.amount)).toBe(40);
    expect(op.torcovkaSubmitAckBand).toBe("HIGH_WASTE");
  });

  it("10: frozen batch: correction rejected, FINAL unchanged", async () => {
    const seeded = await seedExistingOp({
      suffix: `c10-${Date.now()}`,
      railsTaken: 20,
      remaining: 0,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
      closed: true,
      frozen: true,
    });
    const final = await prismaA.batchCost.create({
      data: {
        batchId: seeded.batch.id,
        status: "FINAL",
        volumeSort1: 1,
        volumeSort2: 0,
        costSort1: 10_000,
        costSort2: 0,
        pricePerM3Sort1: 10_000,
        pricePerM3Sort2: 0,
      },
    });
    await expect(
      correctTorcovkaRailsTaken({
        operationId: seeded.op.id,
        newRailsTaken: 4,
        reason: "frozen",
      }),
    ).rejects.toThrow("Нельзя исправить — себестоимость партии заморожена");
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const cost = await prismaA.batchCost.findUniqueOrThrow({ where: { id: final.id } });
    expect(op.railsTaken).toBe(20);
    expect(lot.remainingQuantity).toBe(0);
    expect(cost.status).toBe("FINAL");
    expect(Number(cost.costSort1)).toBe(10_000);
  });

  it("11: reopen after depletion and after write-off", async () => {
    const depleted = await seedExistingOp({
      suffix: `c11d-${Date.now()}`,
      railsTaken: 20,
      remaining: 0,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
      closed: true,
    });
    await correctTorcovkaRailsTaken({
      operationId: depleted.op.id,
      newRailsTaken: 4,
      reason: "reopen depletion",
    });
    const dBatch = await prismaA.batch.findUniqueOrThrow({ where: { id: depleted.batch.id } });
    expect(dBatch.status).toBe("IN_WORK");
    expect(dBatch.closedAt).toBeNull();

    const written = await seedExistingOp({
      suffix: `c11w-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
    });
    await writeOffBatchRemainder(written.batch.id);
    const archived = await prismaA.batch.findUniqueOrThrow({ where: { id: written.batch.id } });
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.closedAt).not.toBeNull();
    await correctTorcovkaRailsTaken({
      operationId: written.op.id,
      newRailsTaken: 4,
      reason: "reopen write-off",
    });
    const reopened = await prismaA.batch.findUniqueOrThrow({ where: { id: written.batch.id } });
    expect(reopened.status).toBe("IN_WORK");
    expect(reopened.closedAt).toBeNull();
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: written.lot.id } });
    expect(lot.remainingQuantity).toBe(16);
  });

  it("12: delete TORCOVKA does not return rails", async () => {
    const seeded = await seedExistingOp({
      suffix: `c12-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
    });
    await deleteProductionOperation(seeded.op.id);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    expect(lot.remainingQuantity).toBe(10);
    expect(await prismaA.productionOperation.findUnique({ where: { id: seeded.op.id } })).toBeNull();
  });

  it("13a: correction || submit same RailLot: remaining >= 0, railsTaken authoritative, no partial", async () => {
    const seeded = await seedExistingOp({
      suffix: `c13s-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
    });
    const remainingStart = 10;
    const submitTake = 5;
    const oldRails = 20;
    const newRails = 4;
    const delta = oldRails - newRails;

    const settled = await withTimeout(
      Promise.allSettled([
        correctTorcovkaRailsTaken({
          operationId: seeded.op.id,
          newRailsTaken: newRails,
          reason: "race submit",
        }),
        submitTorcovka({
          employeeId: seeded.emp.id,
          clientRequestId: `c13s-${Date.now()}`,
          batchId: seeded.batch.id,
          railLotId: seeded.lot.id,
          railsTaken: submitTake,
          picks: [{ lengthM: 1, sort: "SORT1", quantity: 18 }],
        }),
      ]),
      "correction || submit",
    );
    expect(settled).toHaveLength(2);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);

    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const extraOps = await prismaA.productionOperation.count({
      where: { railLotId: seeded.lot.id, id: { not: seeded.op.id } },
    });
    const batch = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });

    expect(lot.remainingQuantity).toBeGreaterThanOrEqual(0);
    expect([oldRails, newRails]).toContain(op.railsTaken);
    const correctionApplied = op.railsTaken === newRails;
    const submitApplied = extraOps === 1;
    expect(extraOps).toBeLessThanOrEqual(1);
    expect(lot.remainingQuantity).toBe(
      remainingStart + (correctionApplied ? delta : 0) - (submitApplied ? submitTake : 0),
    );
    if (lot.remainingQuantity > 0) {
      expect(batch.status).toBe("IN_WORK");
      expect(batch.closedAt).toBeNull();
    } else {
      expect(batch.status).toBe("ARCHIVED");
      expect(batch.closedAt).not.toBeNull();
    }
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
  });

  it("13b: correction || writeOff same Batch: remaining >= 0, reopen/archive consistent, no partial", async () => {
    const seeded = await seedExistingOp({
      suffix: `c13w-${Date.now()}`,
      railsTaken: 20,
      remaining: 10,
      blankQty: 4,
      blankLengthM: "1",
      lotLengthM: "4",
    });
    const remainingStart = 10;
    const oldRails = 20;
    const newRails = 4;
    const delta = oldRails - newRails;

    const settled = await withTimeout(
      Promise.allSettled([
        correctTorcovkaRailsTaken({
          operationId: seeded.op.id,
          newRailsTaken: newRails,
          reason: "race write-off",
        }),
        writeOffBatchRemainder(seeded.batch.id),
      ]),
      "correction || writeOff",
    );
    expect(settled).toHaveLength(2);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);

    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: seeded.lot.id } });
    const op = await prismaA.productionOperation.findUniqueOrThrow({ where: { id: seeded.op.id } });
    const batch = await prismaA.batch.findUniqueOrThrow({ where: { id: seeded.batch.id } });
    const logs = await prismaA.changeLog.findMany({
      where: { entity: "Batch", entityId: seeded.batch.id },
    });
    const writeOffApplied = logs.some((log) => {
      const nv = log.newValues as Record<string, unknown> | null;
      return Boolean(nv && "writeOff" in nv);
    });

    expect(lot.remainingQuantity).toBeGreaterThanOrEqual(0);
    expect([oldRails, newRails]).toContain(op.railsTaken);
    const correctionApplied = op.railsTaken === newRails;
    if (correctionApplied && writeOffApplied) {
      expect([0, delta]).toContain(lot.remainingQuantity);
    } else if (correctionApplied) {
      expect(lot.remainingQuantity).toBe(remainingStart + delta);
    } else if (writeOffApplied) {
      expect(lot.remainingQuantity).toBe(0);
    } else {
      expect(lot.remainingQuantity).toBe(remainingStart);
    }
    if (lot.remainingQuantity > 0) {
      expect(batch.status).toBe("IN_WORK");
      expect(batch.closedAt).toBeNull();
    } else {
      expect(batch.status).toBe("ARCHIVED");
      expect(batch.closedAt).not.toBeNull();
    }
  });

  it("13c: archive depleted precheck waits Batch; other lot restored; must refuse archive", async () => {
    const suffix = `c13c-${Date.now()}`;
    const world = await seedWorld({
      suffix,
      lotLengthM: "4",
      lotQty: 2,
      remaining: 1,
    });
    const lotA = world.lot;
    const lotB = await prismaA.railLot.create({
      data: {
        batchId: world.batch.id,
        lengthM: new Prisma.Decimal("4"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: 20,
        remainingQuantity: 0,
      },
    });
    await prismaA.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId: world.emp.id,
        clientRequestId: `test:di020:13c:${suffix}`,
        batchId: world.batch.id,
        railLotId: lotB.id,
        railsTaken: 20,
        workDate: new Date("2026-09-01T00:00:00.000Z"),
        lines: {
          create: [
            {
              quantity: 4,
              blankLengthM: new Prisma.Decimal("1"),
              blankType: "POLKA",
              blankSort: "SORT1",
              blankMaterialId: world.material.id,
            },
          ],
        },
      },
    });

    const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
    const holder = prismaA.$transaction(async (tx) => {
      await lockRailLots(tx, [lotB.id]);
      await lockBatches(tx, [world.batch.id]);
      await delay(300);
      await tx.railLot.update({
        where: { id: lotB.id },
        data: { remainingQuantity: { increment: 16 } },
      });
    }, txOpts);

    await delay(80);

    const archiver = prismaB.$transaction(async (tx) => {
      await lockRailLots(tx, [lotA.id]);
      await tx.railLot.update({
        where: { id: lotA.id },
        data: { remainingQuantity: 0 },
      });
      return archiveBatchIfDepleted(tx, world.batch.id);
    }, txOpts);

    const [, archived] = await withTimeout(Promise.all([holder, archiver]), "13c archive recheck");
    expect(archived).toBe(false);

    const lots = await prismaA.railLot.findMany({ where: { batchId: world.batch.id } });
    const remaining = lots.reduce((s, l) => s + l.remainingQuantity, 0);
    const batch = await prismaA.batch.findUniqueOrThrow({ where: { id: world.batch.id } });
    expect(remaining).toBeGreaterThan(0);
    expect(batch.status).toBe("IN_WORK");
    expect(batch.closedAt).toBeNull();
  });

  it("13d: correction LotB || submit last rail LotA: remaining vs status; both fulfilled", async () => {
    const suffix = `c13d-${Date.now()}`;
    const world = await seedWorld({
      suffix,
      lotLengthM: "4",
      lotQty: 2,
      remaining: 1,
    });
    const lotA = world.lot;
    const lotB = await prismaA.railLot.create({
      data: {
        batchId: world.batch.id,
        lengthM: new Prisma.Decimal("4"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: 20,
        remainingQuantity: 0,
      },
    });
    const opB = await prismaA.productionOperation.create({
      data: {
        type: "TORCOVKA",
        employeeId: world.emp.id,
        clientRequestId: `test:di020:13d:${suffix}`,
        batchId: world.batch.id,
        railLotId: lotB.id,
        railsTaken: 20,
        workDate: new Date("2026-09-01T00:00:00.000Z"),
        lines: {
          create: [
            {
              quantity: 4,
              blankLengthM: new Prisma.Decimal("1"),
              blankType: "POLKA",
              blankSort: "SORT1",
              blankMaterialId: world.material.id,
            },
          ],
        },
      },
    });
    await prismaA.blankStock.create({
      data: {
        materialId: world.material.id,
        lengthM: new Prisma.Decimal("1"),
        detailType: "POLKA",
        sort: "SORT1",
        quantity: 4,
      },
    });

    const settled = await withTimeout(
      Promise.allSettled([
        correctTorcovkaRailsTaken({
          operationId: opB.id,
          newRailsTaken: 4,
          reason: "different-lot race",
        }),
        submitTorcovka({
          employeeId: world.emp.id,
          clientRequestId: `c13d-${Date.now()}`,
          batchId: world.batch.id,
          railLotId: lotA.id,
          railsTaken: 1,
          picks: [{ lengthM: 1, sort: "SORT1", quantity: 4 }],
        }),
      ]),
      "correction LotB || submit LotA",
    );
    expect(settled).toHaveLength(2);
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);

    const lots = await prismaA.railLot.findMany({ where: { batchId: world.batch.id } });
    const remaining = lots.reduce((s, l) => s + l.remainingQuantity, 0);
    const batch = await prismaA.batch.findUniqueOrThrow({ where: { id: world.batch.id } });
    if (remaining > 0) {
      expect(batch.status).toBe("IN_WORK");
      expect(batch.closedAt).toBeNull();
    } else {
      expect(batch.status).toBe("ARCHIVED");
      expect(batch.closedAt).not.toBeNull();
    }
  });

  it("concurrency A: two concurrent no-code EXTREME → one approval gen 1, one Notification, hash matches", async () => {
    const w = await seedWorld({
      suffix: `ca-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = extremeInput(w, `ca-${Date.now()}`);
    const settled = await withTimeout(
      Promise.allSettled([submitTorcovka(input), submitTorcovka(input)]),
      "approval create race",
    );
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    const statuses = settled.map((s) =>
      s.status === "fulfilled" ? s.value.status : "rejected",
    );
    expect(statuses.every((s) => s === "APPROVAL_REQUIRED" || s === "CREATED")).toBe(true);
    const { row, notes } = await approvalBundle(input.clientRequestId);
    expect(row).not.toBeNull();
    expect(row?.generation).toBe(1);
    expect(notes).toHaveLength(1);
    const code = extractApprovalCode(notes[0].message);
    expect(approvalCodeMatches(code, row!.codeHash, approvalHmacSecret())).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(0);
  });

  it("concurrency B: two concurrent rotations of expired gen 1 → exactly gen 2, one new Notification, hash matches", async () => {
    const w = await seedWorld({
      suffix: `cb-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = extremeInput(w, `cb-${Date.now()}`);
    await submitTorcovka(input);
    await prismaA.torcovkaApproval.update({
      where: { clientRequestId: input.clientRequestId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const blocker = startRowBlocker((tx) =>
      lockTorcovkaApprovalByClientRequestId(tx, input.clientRequestId),
    );
    await blocker.ready;
    const t1 = submitTorcovka(input);
    await waitForRelationLockWaiters(
      blocker.pid(),
      "TorcovkaApproval",
      1,
      "concurrency B T1 waiting on TorcovkaApproval FOR UPDATE",
    );
    const t2 = submitTorcovka(input);
    await waitForRelationLockWaiters(
      blocker.pid(),
      "TorcovkaApproval",
      2,
      "concurrency B T2 waiting on TorcovkaApproval FOR UPDATE",
    );
    blocker.release();
    const settled = await withTimeout(Promise.allSettled([t1, t2]), "approval rotation race");
    await blocker.done;

    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    const { row, notes } = await approvalBundle(input.clientRequestId);
    expect(row?.generation).toBe(2);
    expect(notes).toHaveLength(2);
    expect(notes[0].message).toBe(TORCOVKA_APPROVAL_REDACT_INVALIDATED);
    const code = extractApprovalCode(notes[1].message);
    expect(approvalCodeMatches(code, row!.codeHash, approvalHmacSecret())).toBe(true);
    expect(notes.filter((n) => n.key.endsWith(":2"))).toHaveLength(1);
    expect(notes.filter((n) => n.key.endsWith(":3"))).toHaveLength(0);
  });

  it("concurrency C: consume vs no-code retry both end CREATED; never approval-consumed orphan", async () => {
    const w = await seedWorld({
      suffix: `cc-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = extremeInput(w, `cc-${Date.now()}`);
    await submitTorcovka(input);
    const before = await approvalBundle(input.clientRequestId);
    const code = extractApprovalCode(before.notes[0].message);

    const blocker = startRowBlocker((tx) => lockRailLots(tx, [w.lot.id]));
    await blocker.ready;
    const t1 = submitTorcovka({ ...input, approvalCode: code });
    await waitForRelationLockWaiters(
      blocker.pid(),
      "RailLot",
      1,
      "concurrency C T1 waiting on RailLot FOR UPDATE",
    );
    const t2 = submitTorcovka(input);
    await waitForRelationLockWaiters(
      blocker.pid(),
      "RailLot",
      2,
      "concurrency C T2 waiting on RailLot FOR UPDATE",
    );
    blocker.release();
    const settled = await withTimeout(Promise.allSettled([t1, t2]), "consume vs no-code");
    await blocker.done;

    expect(settled).toHaveLength(2);
    expect(
      settled.every((s) => s.status === "fulfilled" && s.value.status === "CREATED"),
    ).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(1);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: w.lot.id } });
    expect(lot.remainingQuantity).toBe(10);
    const after = await approvalBundle(input.clientRequestId);
    expect(after.row?.generation).toBe(1);
    expect(after.row?.consumedAt).not.toBeNull();
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0].message).toBe(TORCOVKA_APPROVAL_REDACT_USED);
  });

  it("concurrency D1: consume first — ensure sees CONSUMED, no rotate", async () => {
    const w = await seedWorld({
      suffix: `cd1-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = extremeInput(w, `cd1-${Date.now()}`);
    await submitTorcovka(input);
    const before = await approvalBundle(input.clientRequestId);
    const code = extractApprovalCode(before.notes[0].message);
    const snapshot = approvalSnapshot(w, input.clientRequestId);

    const blocker = startRowBlocker((tx) =>
      lockTorcovkaApprovalByClientRequestId(tx, input.clientRequestId),
    );
    await blocker.ready;
    const consume = submitTorcovka({ ...input, approvalCode: code });
    await waitForRelationLockWaiters(
      blocker.pid(),
      "TorcovkaApproval",
      1,
      "concurrency D1 consume waiting on TorcovkaApproval",
    );
    const ensure = ensurePendingApproval(snapshot);
    await waitForRelationLockWaiters(
      blocker.pid(),
      "TorcovkaApproval",
      2,
      "concurrency D1 ensure waiting on TorcovkaApproval",
    );
    blocker.release();
    const [consumeSettled, ensureSettled] = await withTimeout(
      Promise.allSettled([consume, ensure]),
      "concurrency D1 consume vs ensure",
    );
    await blocker.done;

    expect(consumeSettled.status).toBe("fulfilled");
    if (consumeSettled.status === "fulfilled") {
      expect(consumeSettled.value).toEqual({ status: "CREATED" });
    }
    expect(ensureSettled.status).toBe("fulfilled");
    if (ensureSettled.status === "fulfilled") {
      expect(ensureSettled.value).toEqual({ kind: "CONSUMED" });
    }
    const after = await approvalBundle(input.clientRequestId);
    expect(after.row?.generation).toBe(before.row?.generation);
    expect(after.row?.consumedAt).not.toBeNull();
    expect(after.notes).toHaveLength(1);
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(1);
  });

  it("concurrency D2: rotate first — old code cannot consume gen 2", async () => {
    const w = await seedWorld({
      suffix: `cd2-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const input = extremeInput(w, `cd2-${Date.now()}`);
    await submitTorcovka(input);
    const before = await approvalBundle(input.clientRequestId);
    const oldCode = extractApprovalCode(before.notes[0].message);
    await prismaA.torcovkaApproval.update({
      where: { clientRequestId: input.clientRequestId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const snapshot = approvalSnapshot(w, input.clientRequestId);

    const blocker = startRowBlocker((tx) =>
      lockTorcovkaApprovalByClientRequestId(tx, input.clientRequestId),
    );
    await blocker.ready;
    const ensure = ensurePendingApproval(snapshot);
    await waitForRelationLockWaiters(
      blocker.pid(),
      "TorcovkaApproval",
      1,
      "concurrency D2 ensure waiting on TorcovkaApproval",
    );
    const oldSubmit = submitTorcovka({ ...input, approvalCode: oldCode });
    await waitForRelationLockWaiters(
      blocker.pid(),
      "TorcovkaApproval",
      2,
      "concurrency D2 old-code stock TX waiting on TorcovkaApproval",
    );
    blocker.release();
    const [ensureSettled, oldSettled] = await withTimeout(
      Promise.allSettled([ensure, oldSubmit]),
      "concurrency D2 rotate vs old code",
    );
    await blocker.done;

    expect(ensureSettled.status).toBe("fulfilled");
    if (ensureSettled.status === "fulfilled") {
      expect(ensureSettled.value.kind).toBe("PENDING");
    }
    expect(oldSettled.status).toBe("rejected");
    if (oldSettled.status === "rejected") {
      expect(String(oldSettled.reason)).toContain(TORCOVKA_WRONG_CODE_MESSAGE);
    }
    const rotated = await approvalBundle(input.clientRequestId);
    expect(rotated.row?.generation).toBe(2);
    expect(rotated.row?.consumedAt).toBeNull();
    expect(rotated.notes).toHaveLength(2);
    expect(rotated.notes[0].message).toBe(TORCOVKA_APPROVAL_REDACT_INVALIDATED);
    const newCode = extractApprovalCode(rotated.notes[1].message);
    expect(approvalCodeMatches(newCode, rotated.row!.codeHash, approvalHmacSecret())).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(0);

    const created = await submitTorcovka({ ...input, approvalCode: newCode });
    expect(created).toEqual({ status: "CREATED" });
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(1);
  });

  it("stale A: EXTREME approval then SUSPICIOUS commit invalidates without consume", async () => {
    const w = await seedWorld({
      suffix: `stale-a-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const requestId = `stale-a-${Date.now()}`;
    const extreme = extremeInput(w, requestId);
    const first = await submitTorcovka(extreme);
    expect(first.status).toBe("APPROVAL_REQUIRED");
    const before = await approvalBundle(requestId);
    expect(before.row?.generation).toBe(1);
    expect(before.row?.consumedAt).toBeNull();
    const code = extractApprovalCode(before.notes[0].message);
    expect(code).toMatch(/^\d{4}$/);

    const suspicious = suspiciousInput(w, requestId);
    const ack = await submitTorcovka(suspicious);
    expect(ack.status).toBe("ACK_REQUIRED");
    if (ack.status !== "ACK_REQUIRED") throw new Error("setup");
    const stillPending = await approvalBundle(requestId);
    expect(stillPending.row?.generation).toBe(1);
    expect(stillPending.row?.consumedAt).toBeNull();
    expect(stillPending.notes).toHaveLength(1);
    expect(extractApprovalCode(stillPending.notes[0].message)).toBe(code);

    const created = await submitTorcovka({
      ...suspicious,
      plausibilityAck: {
        kind: "SUSPICIOUS",
        railsTaken: ack.railsTaken,
        takenM: ack.takenM,
        producedM: ack.producedM,
        wastePct: ack.wastePct,
      },
    });
    expect(created).toEqual({ status: "CREATED" });
    const ops = await prismaA.productionOperation.findMany({ where: { railLotId: w.lot.id } });
    expect(ops).toHaveLength(1);
    expect(ops[0].torcovkaSubmitAckBand).toBe("SUSPICIOUS");
    const after = await approvalBundle(requestId);
    expect(after.row?.consumedAt).toBeNull();
    expect(after.row?.generation).toBe(1);
    expect(after.row?.codeHash).toBe(before.row?.codeHash);
    expect(after.row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0].message).toBe(TORCOVKA_APPROVAL_REDACT_NOT_REQUIRED);
    expect(after.notes[0].message).not.toMatch(/\d{4}/);
    expect(after.notes.filter((n) => n.key.endsWith(":2"))).toHaveLength(0);
  });

  it("stale B: EXTREME approval then NORMAL commit invalidates without consume", async () => {
    const w = await seedWorld({
      suffix: `stale-b-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const requestId = `stale-b-${Date.now()}`;
    await submitTorcovka(extremeInput(w, requestId));
    const before = await approvalBundle(requestId);
    expect(before.row?.generation).toBe(1);
    const created = await submitTorcovka(normalBandInput(w, requestId));
    expect(created).toEqual({ status: "CREATED" });
    const ops = await prismaA.productionOperation.findMany({ where: { railLotId: w.lot.id } });
    expect(ops).toHaveLength(1);
    expect(ops[0].torcovkaSubmitAckBand).toBeNull();
    const after = await approvalBundle(requestId);
    expect(after.row?.consumedAt).toBeNull();
    expect(after.row?.generation).toBe(1);
    expect(after.row?.codeHash).toBe(before.row?.codeHash);
    expect(after.row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0].message).toBe(TORCOVKA_APPROVAL_REDACT_NOT_REQUIRED);
    expect(after.notes[0].message).not.toMatch(/\d{4}/);
    expect(after.notes.filter((n) => n.key.endsWith(":2"))).toHaveLength(0);
  });

  it("stale C: late ensure after non-EXTREME Op is invalidated; public CREATED", async () => {
    const w = await seedWorld({
      suffix: `stale-c-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const requestId = `stale-c-${Date.now()}`;
    const normal = normalBandInput(w, requestId);
    const created = await submitTorcovka(normal);
    expect(created).toEqual({ status: "CREATED" });
    expect(await prismaA.torcovkaApproval.count({ where: { clientRequestId: requestId } })).toBe(0);

    const lateEnsure = await ensurePendingApproval(approvalSnapshot(w, requestId));
    expect(lateEnsure.kind).toBe("PENDING");
    const planted = await approvalBundle(requestId);
    expect(planted.row?.generation).toBe(1);
    expect(planted.row?.consumedAt).toBeNull();
    expect(planted.notes).toHaveLength(1);
    extractApprovalCode(planted.notes[0].message);

    const replay = await submitTorcovka(normal);
    expect(replay).toEqual({ status: "CREATED" });
    expect(await prismaA.productionOperation.count({ where: { railLotId: w.lot.id } })).toBe(1);
    const after = await approvalBundle(requestId);
    expect(after.row?.generation).toBe(1);
    expect(after.row?.consumedAt).toBeNull();
    expect(after.row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(after.notes).toHaveLength(1);
    expect(after.notes[0].message).toBe(TORCOVKA_APPROVAL_REDACT_NOT_REQUIRED);
    expect(after.notes[0].message).not.toMatch(/\d{4}/);

    const raceWorld = await seedWorld({
      suffix: `stale-c-race-${Date.now()}`,
      lotLengthM: "10",
      lotQty: 20,
      remaining: 20,
    });
    const raceId = `stale-c-race-${Date.now()}`;
    const blocker = startRowBlocker(async (tx) => {
      await tx.$executeRawUnsafe(`LOCK TABLE "Notification" IN EXCLUSIVE MODE`);
    });
    await blocker.ready;
    const t1 = submitTorcovka(extremeInput(raceWorld, raceId));
    await waitForRelationLockWaiters(
      blocker.pid(),
      "Notification",
      1,
      "stale C T1 ensure waiting on Notification",
    );
    const t2Result = await withTimeout(
      submitTorcovka(normalBandInput(raceWorld, raceId)),
      "stale C T2 non-EXTREME commit",
    );
    expect(t2Result.status).toBe("CREATED");
    blocker.release();
    const t1Result = await withTimeout(t1, "stale C T1 late ensure after Op");
    await blocker.done;
    expect(t1Result.status).toBe("CREATED");
    expect(await prismaA.productionOperation.count({ where: { clientRequestId: raceId } })).toBe(1);
    const raced = await approvalBundle(raceId);
    expect(raced.row).not.toBeNull();
    expect(raced.row?.consumedAt).toBeNull();
    expect(raced.row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(raced.notes.every((n) => n.message === TORCOVKA_APPROVAL_REDACT_NOT_REQUIRED)).toBe(true);
    expect(raced.notes.some((n) => /\d{4}/.test(n.message))).toBe(false);
  });
});
