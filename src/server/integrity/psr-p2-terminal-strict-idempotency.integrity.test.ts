/**
 * C1: a repeated terminal clientRequestId matches only the original essential
 * payload. A different payload or employee is rejected without a second write.
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
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: vi.fn(async () => {}) }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { enqueueRecalcBatchCosts } from "@/server/cost-queue";
import {
  setApprovalGateAfterEnsureForTests,
  TERMINAL_REQUEST_ALREADY_RECORDED,
  UPAKOVKA_ALREADY_RECORDED,
} from "@/server/internal/terminal-request-identity";
import { TORCOVKA_APPROVAL_MAX_ATTEMPTS, TORCOVKA_WRONG_CODE_MESSAGE } from "@/lib/torcovka-approval";
import { setInventoryMovementShadowWriteGate } from "@/server/internal/inventory-movement-shadow-write";
import { planProductionShadowMovements } from "@/server/internal/production-movement-plan";
import { submitHours, submitPrisadka, submitTorcovka, submitUpakovka } from "@/server/terminal";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;

describe.skipIf(!enabled)("terminal strict idempotency", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityInventory(prismaA);
    sessionState.employee = { id: "", fullName: "" };
    vi.mocked(enqueueRecalcBatchCosts).mockClear();
    setApprovalGateAfterEnsureForTests(null);
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
  });

  async function setShadowGate(active: boolean) {
    await prismaA.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, active);
    }, txOpts);
  }

  async function bind(emp: { id: string; fullName: string }) {
    sessionState.employee = { id: emp.id, fullName: emp.fullName };
    return emp;
  }

  async function employee(fullName: string) {
    return bind(
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

  async function effects() {
    const [ops, movements, lots, blanks, details, products, nomenclature, costs, logs] =
      await Promise.all([
        prismaA.productionOperation.findMany({
          orderBy: { clientRequestId: "asc" },
          include: { lines: { orderBy: { id: "asc" } } },
        }).then((rows) =>
          rows.map((op) => ({
            id: op.id,
            type: op.type,
            employeeId: op.employeeId,
            clientRequestId: op.clientRequestId,
            batchId: op.batchId,
            railLotId: op.railLotId,
            railsTaken: op.railsTaken,
            productId: op.productId,
            productQty: op.productQty,
            hours: op.hours?.toFixed(2) ?? null,
            torcovkaRate: op.rateTorcovkaSort1Snapshot?.toFixed(2) ?? null,
            hourlyRate: op.hourlyRateSnapshot?.toFixed(2) ?? null,
            ack: op.torcovkaSubmitAckBand,
            lines: op.lines.map((line) => ({
              quantity: line.quantity,
              detailId: line.detailId,
              length: line.blankLengthM?.toFixed(4) ?? null,
              sort: line.blankSort,
              torcev: line.prisadkaTorcevaya,
              plosk: line.prisadkaPloskost,
            })),
          })),
        ),
        prismaA.inventoryMovement.count(),
        prismaA.railLot.findMany({ orderBy: { id: "asc" }, select: { id: true, remainingQuantity: true } }),
        prismaA.blankStock.findMany({ orderBy: { id: "asc" }, select: { id: true, quantity: true } }),
        prismaA.detailStock.findMany({
          orderBy: { id: "asc" },
          select: { id: true, quantity: true, torcevayaDone: true, ploskostDone: true },
        }),
        prismaA.productStock.findMany({
          orderBy: { productId: "asc" },
          select: { productId: true, quantity: true },
        }),
        prismaA.nomenclatureStock.findMany({
          orderBy: { nomenclatureId: "asc" },
          select: { nomenclatureId: true, quantity: true },
        }),
        prismaA.batchCost.count(),
        prismaA.changeLog.count(),
      ]);
    return { ops, movements, lots, blanks, details, products, nomenclature, costs, logs };
  }

  async function seedTorcovka(suffix: string, opts?: { lengthM?: string; remaining?: number }) {
    const emp = await employee(`emp-${suffix}`);
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
    const remaining = opts?.remaining ?? 10;
    const lot = await prismaA.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: new Prisma.Decimal(opts?.lengthM ?? "2"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: remaining,
        remainingQuantity: remaining,
      },
    });
    return { emp, material, batch, lot };
  }

  function torcovkaInput(
    world: Awaited<ReturnType<typeof seedTorcovka>>,
    clientRequestId: string,
    railsTaken: number,
    picks: { lengthM: number; sort: "SORT1" | "SORT2"; quantity: number }[],
  ) {
    return {
      employeeId: world.emp.id,
      clientRequestId,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken,
      picks,
    };
  }

  async function seedPrisadka(suffix: string) {
    const emp = await employee(`emp-${suffix}`);
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

  async function seedUpakovka(suffix: string) {
    const emp = await employee(`emp-${suffix}`);
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const fastener = await prismaA.nomenclatureItem.create({
      data: { name: `fast-${suffix}`, type: "FASTENER", unitPrice: 10 },
    });
    const pack = await prismaA.nomenclatureItem.create({
      data: { name: `pack-${suffix}`, type: "PACKAGING", unitPrice: 5 },
    });
    await prismaA.nomenclatureStock.create({ data: { nomenclatureId: fastener.id, quantity: 100 } });
    await prismaA.nomenclatureStock.create({ data: { nomenclatureId: pack.id, quantity: 100 } });
    const blankDet = await prismaA.detail.create({
      data: {
        name: `blank-${suffix}`,
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
        name: `ready-${suffix}`,
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
    for (let i = 0; i < 2; i += 1) {
      products.push(
        await prismaA.product.create({
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
          },
        }),
      );
    }
    return { emp, products };
  }

  function rejectionMessage(error: unknown): string {
    return error instanceof Error ? error.message : "";
  }

  it("TORCOVKA exact replay, canonical lengths, changed payload, other employee, and lost response", async () => {
    await setShadowGate(true);
    const world = await seedTorcovka(`t-${Date.now()}`);
    const requestId = `t-${Date.now()}`;
    const input = torcovkaInput(world, requestId, 2, [
      { lengthM: 0.736, sort: "SORT1", quantity: 2 },
      { lengthM: 0.7359999999999, sort: "SORT1", quantity: 3 },
    ]);
    expect(await submitTorcovka(input)).toEqual({ status: "CREATED" });
    const saved = await effects();
    expect(saved.ops).toHaveLength(1);
    expect(saved.movements).toBeGreaterThan(0);
    expect(vi.mocked(enqueueRecalcBatchCosts)).toHaveBeenCalledTimes(1);

    const equivalent = torcovkaInput(world, requestId, 2, [
      { lengthM: 0.736, sort: "SORT1", quantity: 5 },
    ]);
    expect(await submitTorcovka(equivalent)).toEqual({ status: "CREATED" });
    expect(await effects()).toEqual(saved);
    expect(vi.mocked(enqueueRecalcBatchCosts)).toHaveBeenCalledTimes(1);

    await prismaA.employee.update({
      where: { id: world.emp.id },
      data: { rateTorcovkaSort1: 99 },
    });
    expect(await submitTorcovka(input)).toEqual({ status: "CREATED" });
    const afterLost = await effects();
    expect(afterLost).toEqual(saved);
    expect(afterLost.ops[0]?.torcovkaRate).toBe("10.00");

    const changed = torcovkaInput(world, requestId, 2, [
      { lengthM: 0.7361, sort: "SORT1", quantity: 5 },
    ]);
    await expect(submitTorcovka(changed)).rejects.toThrow(TERMINAL_REQUEST_ALREADY_RECORDED);
    expect(await effects()).toEqual(saved);

    const other = await employee("Другой работник торцовки");
    await expect(
      submitTorcovka({ ...input, employeeId: other.id }),
    ).rejects.toThrow(TERMINAL_REQUEST_ALREADY_RECORDED);
    try {
      await submitTorcovka({ ...changed, employeeId: other.id });
    } catch (error) {
      expect(rejectionMessage(error)).toBe(TERMINAL_REQUEST_ALREADY_RECORDED);
      expect(rejectionMessage(error)).not.toContain(world.emp.fullName);
      expect(rejectionMessage(error)).not.toContain(world.emp.id);
    }
    expect(await prismaA.productionOperation.count()).toBe(1);
    expect(await effects()).toEqual(saved);
  });

  it("TORCOVKA concurrent same id keeps one operation", async () => {
    await setShadowGate(true);
    const same = await seedTorcovka(`tc-same-${Date.now()}`, { remaining: 8 });
    const sameInput = torcovkaInput(same, `tc-same-${Date.now()}`, 2, [
      { lengthM: 2, sort: "SORT1", quantity: 2 },
    ]);
    const sameSettled = await Promise.allSettled([
      submitTorcovka(sameInput),
      submitTorcovka(sameInput),
    ]);
    expect(sameSettled.every((row) => row.status === "fulfilled")).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { railLotId: same.lot.id } })).toBe(1);
    expect((await prismaA.railLot.findUniqueOrThrow({ where: { id: same.lot.id } })).remainingQuantity).toBe(6);

    const diff = await seedTorcovka(`tc-diff-${Date.now()}`, { remaining: 10 });
    const requestId = `tc-diff-${Date.now()}`;
    const settled = await Promise.allSettled([
      submitTorcovka(torcovkaInput(diff, requestId, 1, [{ lengthM: 2, sort: "SORT1", quantity: 1 }])),
      submitTorcovka(torcovkaInput(diff, requestId, 2, [{ lengthM: 2, sort: "SORT1", quantity: 2 }])),
    ]);
    expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((row) => row.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejectionMessage(rejected.reason)).toBe(TERMINAL_REQUEST_ALREADY_RECORDED);
    }
    const ops = await prismaA.productionOperation.findMany({ where: { railLotId: diff.lot.id } });
    expect(ops).toHaveLength(1);
    expect([1, 2]).toContain(ops[0]?.railsTaken);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: diff.lot.id } });
    expect(lot.remainingQuantity).toBe(10 - (ops[0]?.railsTaken ?? 0));
    const retained = await prismaA.productionOperation.findUniqueOrThrow({
      where: { id: ops[0]!.id },
      include: { lines: true, nomenclatureLines: true },
    });
    const plan = planProductionShadowMovements({ kind: "TORCOVKA", operation: retained });
    expect(await prismaA.inventoryMovement.count({ where: { causationId: retained.id } })).toBe(
      plan.effects.length,
    );
  });

  it("TORCOVKA conflict after high-waste approval does not write again", async () => {
    await setShadowGate(true);
    const world = await seedTorcovka(`ap-${Date.now()}`, { lengthM: "10", remaining: 20 });
    const requestId = `ap-${Date.now()}`;
    const input = torcovkaInput(world, requestId, 10, [{ lengthM: 1, sort: "SORT1", quantity: 27 }]);
    const first = await submitTorcovka(input);
    expect(first.status).toBe("APPROVAL_REQUIRED");
    const note = await prismaA.notification.findFirstOrThrow({
      where: { key: { startsWith: `event:torcovka-approval:${requestId}:` } },
    });
    const code = note.message.match(/Код подтверждения: (\d{4})/)?.[1];
    expect(code).toBeTruthy();
    expect(await submitTorcovka({ ...input, approvalCode: code })).toEqual({ status: "CREATED" });
    const saved = await effects();
    expect(saved.ops).toHaveLength(1);
    expect(saved.ops[0]?.ack).toBe("HIGH_WASTE");

    expect(await submitTorcovka(input)).toEqual({ status: "CREATED" });
    expect(await effects()).toEqual(saved);

    await expect(
      submitTorcovka(torcovkaInput(world, requestId, 9, [{ lengthM: 1, sort: "SORT1", quantity: 27 }])),
    ).rejects.toThrow(TERMINAL_REQUEST_ALREADY_RECORDED);
    expect(await effects()).toEqual(saved);
  });

  function armApprovalWindow(action: () => Promise<void>) {
    setApprovalGateAfterEnsureForTests(async () => {
      setApprovalGateAfterEnsureForTests(null);
      await action();
    });
  }

  async function latestApprovalCode(requestId: string): Promise<string> {
    const note = await prismaA.notification.findFirstOrThrow({
      where: { key: { startsWith: `event:torcovka-approval:${requestId}:` } },
      orderBy: { createdAt: "desc" },
    });
    const code = note.message.match(/Код подтверждения: (\d{4})/)?.[1];
    if (!code) throw new Error("no approval code");
    return code;
  }

  async function assertOnlyPeerWrite(opts: {
    requestId: string;
    peerId: string;
    lotId: string;
    railsTaken: number;
    remaining: number;
  }) {
    const ops = await prismaA.productionOperation.findMany({
      where: { clientRequestId: opts.requestId },
      include: { lines: true, nomenclatureLines: true },
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]?.employeeId).toBe(opts.peerId);
    expect(ops[0]?.railsTaken).toBe(opts.railsTaken);
    const lot = await prismaA.railLot.findUniqueOrThrow({ where: { id: opts.lotId } });
    expect(lot.remainingQuantity).toBe(opts.remaining);
    const plan = planProductionShadowMovements({ kind: "TORCOVKA", operation: ops[0]! });
    expect(await prismaA.inventoryMovement.count()).toBe(plan.effects.length);
    expect(await prismaA.batchCost.count()).toBe(0);
  }

  it.each(["APPROVAL_NEEDED", "WRONG_CODE", "EXPIRED", "METRICS_CHANGED"] as const)(
    "finishApprovalGate %s rejects a different composition committed in the approval window",
    async (gate) => {
      await setShadowGate(true);
      const world = await seedTorcovka(`gate-c-${gate}-${Date.now()}`, { lengthM: "10", remaining: 20 });
      const requestId = `gate-c-${gate}-${Date.now()}`;
      const extreme = torcovkaInput(world, requestId, 10, [{ lengthM: 1, sort: "SORT1", quantity: 27 }]);
      const shifted = torcovkaInput(world, requestId, 10, [{ lengthM: 1, sort: "SORT1", quantity: 20 }]);
      const peerInput = torcovkaInput(world, requestId, 1, [{ lengthM: 1, sort: "SORT1", quantity: 9 }]);
      const peer = await prismaA.employee.create({
        data: {
          fullName: `Чужой ${gate} ${requestId}`,
          pin: "5678",
          rateTorcovkaSort1: 10,
          rateTorcovkaSort2: 10,
          hourlyRate: 100,
        },
      });
      const savePeer = async () => {
        expect(await submitTorcovka(peerInput)).toEqual({ status: "CREATED" });
        await prismaA.productionOperation.update({
          where: { clientRequestId: requestId },
          data: { employeeId: peer.id },
        });
      };
      armApprovalWindow(savePeer);

      let error: unknown;
      try {
        if (gate === "APPROVAL_NEEDED") {
          await submitTorcovka(extreme);
        } else {
          setApprovalGateAfterEnsureForTests(null);
          expect((await submitTorcovka(extreme)).status).toBe("APPROVAL_REQUIRED");
          const code = await latestApprovalCode(requestId);
          const wrong = code === "0000" ? "0001" : "0000";
          armApprovalWindow(savePeer);
          if (gate === "WRONG_CODE") {
            for (let attempt = 0; attempt < TORCOVKA_APPROVAL_MAX_ATTEMPTS - 1; attempt += 1) {
              setApprovalGateAfterEnsureForTests(null);
              await expect(submitTorcovka({ ...extreme, approvalCode: wrong })).rejects.toThrow(
                TORCOVKA_WRONG_CODE_MESSAGE,
              );
            }
            armApprovalWindow(savePeer);
            await submitTorcovka({ ...extreme, approvalCode: wrong });
          } else if (gate === "EXPIRED") {
            await prismaA.torcovkaApproval.update({
              where: { clientRequestId: requestId },
              data: { expiresAt: new Date(Date.now() - 1000) },
            });
            await submitTorcovka({ ...extreme, approvalCode: code });
          } else {
            await submitTorcovka({ ...shifted, approvalCode: code });
          }
        }
      } catch (err) {
        error = err;
      }
      const message = rejectionMessage(error);
      expect(message).toBe(TERMINAL_REQUEST_ALREADY_RECORDED);
      expect(message).not.toContain(world.emp.fullName);
      expect(message).not.toContain(world.emp.id);
      expect(message).not.toContain(peer.fullName);
      expect(message).not.toContain(peer.id);
      expect(message).not.toMatch(/сотрудник|работник|другому/i);
      await assertOnlyPeerWrite({
        requestId,
        peerId: peer.id,
        lotId: world.lot.id,
        railsTaken: 1,
        remaining: 19,
      });
      const lines = await prismaA.operationDetailLine.findMany({
        where: { operation: { clientRequestId: requestId } },
      });
      expect(lines.map((line) => line.quantity)).toEqual([9]);
    },
  );

  it.each(["APPROVAL_NEEDED", "WRONG_CODE", "EXPIRED", "METRICS_CHANGED"] as const)(
    "finishApprovalGate %s replays an exact composition committed in the approval window",
    async (gate) => {
      await setShadowGate(true);
      const world = await seedTorcovka(`gate-m-${gate}-${Date.now()}`, { lengthM: "10", remaining: 20 });
      const requestId = `gate-m-${gate}-${Date.now()}`;
      const extreme = torcovkaInput(world, requestId, 10, [{ lengthM: 1, sort: "SORT1", quantity: 27 }]);
      const shifted = torcovkaInput(world, requestId, 10, [{ lengthM: 1, sort: "SORT1", quantity: 20 }]);
      const matching = gate === "METRICS_CHANGED" ? shifted : extreme;
      const saveExact = async () => {
        const code = await latestApprovalCode(requestId);
        expect(await submitTorcovka({ ...matching, approvalCode: code })).toEqual({ status: "CREATED" });
      };

      let result: Awaited<ReturnType<typeof submitTorcovka>> | undefined;
      if (gate === "APPROVAL_NEEDED") {
        armApprovalWindow(saveExact);
        result = await submitTorcovka(extreme);
      } else {
        expect((await submitTorcovka(extreme)).status).toBe("APPROVAL_REQUIRED");
        const code = await latestApprovalCode(requestId);
        const wrong = code === "0000" ? "0001" : "0000";
        if (gate === "WRONG_CODE") {
          for (let attempt = 0; attempt < TORCOVKA_APPROVAL_MAX_ATTEMPTS - 1; attempt += 1) {
            await expect(submitTorcovka({ ...extreme, approvalCode: wrong })).rejects.toThrow(
              TORCOVKA_WRONG_CODE_MESSAGE,
            );
          }
          armApprovalWindow(saveExact);
          result = await submitTorcovka({ ...extreme, approvalCode: wrong });
        } else if (gate === "EXPIRED") {
          await prismaA.torcovkaApproval.update({
            where: { clientRequestId: requestId },
            data: { expiresAt: new Date(Date.now() - 1000) },
          });
          armApprovalWindow(saveExact);
          result = await submitTorcovka({ ...extreme, approvalCode: code });
        } else {
          armApprovalWindow(saveExact);
          result = await submitTorcovka({ ...shifted, approvalCode: code });
        }
      }
      expect(result).toEqual({ status: "CREATED" });
      await assertOnlyPeerWrite({
        requestId,
        peerId: world.emp.id,
        lotId: world.lot.id,
        railsTaken: matching.railsTaken,
        remaining: 10,
      });
      const again = await effects();
      expect(await submitTorcovka(matching)).toEqual({ status: "CREATED" });
      expect(await effects()).toEqual(again);
    },
  );

  it("PRISADKA split sources match, changed quantity and other employee do not", async () => {
    await setShadowGate(true);
    const world = await seedPrisadka(`p-${Date.now()}`);
    const requestId = `p-${Date.now()}`;
    const input = {
      employeeId: world.emp.id,
      clientRequestId: requestId,
      picks: [{ detailId: world.det.id, kind: "torcev" as const, quantity: 3 }],
    };
    await submitPrisadka(input);
    const op = await prismaA.productionOperation.findUniqueOrThrow({
      where: { clientRequestId: requestId },
      include: { lines: true },
    });
    expect(op.lines).toHaveLength(2);
    expect(op.lines.reduce((sum, line) => sum + line.quantity, 0)).toBe(3);
    const saved = await effects();
    await submitPrisadka(input);
    expect(await effects()).toEqual(saved);

    await expect(
      submitPrisadka({ ...input, picks: [{ detailId: world.det.id, kind: "torcev", quantity: 4 }] }),
    ).rejects.toThrow(TERMINAL_REQUEST_ALREADY_RECORDED);
    expect(await effects()).toEqual(saved);

    const other = await employee("Другой работник присадки");
    await expect(submitPrisadka({ ...input, employeeId: other.id })).rejects.toThrow(
      TERMINAL_REQUEST_ALREADY_RECORDED,
    );
    expect(rejectionMessage(await submitPrisadka({ ...input, employeeId: other.id }).catch((error) => error))).not.toContain(
      world.emp.fullName,
    );
    expect(await effects()).toEqual(saved);
  });

  it("PRISADKA concurrent same id does not double the stock effect", async () => {
    await setShadowGate(true);
    const same = await seedPrisadka(`pc-same-${Date.now()}`);
    const sameInput = {
      employeeId: same.emp.id,
      clientRequestId: `pc-same-${Date.now()}`,
      picks: [{ detailId: same.det.id, kind: "torcev" as const, quantity: 2 }],
    };
    const sameSettled = await Promise.allSettled([submitPrisadka(sameInput), submitPrisadka(sameInput)]);
    expect(sameSettled.every((row) => row.status === "fulfilled")).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { employeeId: same.emp.id } })).toBe(1);

    const diff = await seedPrisadka(`pc-diff-${Date.now()}`);
    const requestId = `pc-diff-${Date.now()}`;
    const settled = await Promise.allSettled([
      submitPrisadka({
        employeeId: diff.emp.id,
        clientRequestId: requestId,
        picks: [{ detailId: diff.det.id, kind: "torcev", quantity: 2 }],
      }),
      submitPrisadka({
        employeeId: diff.emp.id,
        clientRequestId: requestId,
        picks: [{ detailId: diff.det.id, kind: "torcev", quantity: 3 }],
      }),
    ]);
    expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((row) => row.status === "rejected");
    if (rejected?.status === "rejected") {
      expect(rejectionMessage(rejected.reason)).toBe(TERMINAL_REQUEST_ALREADY_RECORDED);
    }
    const ops = await prismaA.productionOperation.findMany({
      where: { clientRequestId: requestId },
      include: { lines: true, nomenclatureLines: true },
    });
    expect(ops).toHaveLength(1);
    const qty = ops[0]!.lines.reduce((sum, line) => sum + line.quantity, 0);
    expect([2, 3]).toContain(qty);
    const blank = await prismaA.blankStock.findFirstOrThrow({ where: { materialId: diff.material.id } });
    expect([3, 4]).toContain(blank.quantity);
    const plan = planProductionShadowMovements({ kind: "PRISADKA", operation: ops[0]! });
    expect(await prismaA.inventoryMovement.count({ where: { causationId: ops[0]!.id } })).toBe(
      plan.effects.length,
    );
  });

  it("UPAKOVKA matches the whole set, rejects a changed payload, and reports a stored subset", async () => {
    await setShadowGate(true);
    const world = await seedUpakovka(`u-${Date.now()}`);
    const [prodA, prodB] = world.products;
    const requestId = `u-${Date.now()}`;
    const input = {
      employeeId: world.emp.id,
      clientRequestId: requestId,
      picks: [
        { productId: prodA!.id, quantity: 1 },
        { productId: prodB!.id, quantity: 2 },
      ],
    };
    await submitUpakovka(input);
    const saved = await effects();
    expect(saved.ops).toHaveLength(2);
    await expect(submitUpakovka(input)).resolves.toEqual({ status: "RECORDED" });
    expect(await effects()).toEqual(saved);

    await expect(
      submitUpakovka({
        ...input,
        picks: [
          { productId: prodA!.id, quantity: 2 },
          { productId: prodB!.id, quantity: 2 },
        ],
      }),
    ).rejects.toThrow(TERMINAL_REQUEST_ALREADY_RECORDED);
    await expect(
      submitUpakovka({
        ...input,
        picks: [{ productId: prodA!.id, quantity: 1 }],
      }),
    ).rejects.toThrow(TERMINAL_REQUEST_ALREADY_RECORDED);
    expect(await effects()).toEqual(saved);

    const doomed = await prismaA.productionOperation.findUniqueOrThrow({
      where: { clientRequestId: `${requestId}:${prodB!.id}` },
    });
    await prismaA.operationDetailLine.deleteMany({ where: { operationId: doomed.id } });
    await prismaA.operationNomenclatureLine.deleteMany({ where: { operationId: doomed.id } });
    await prismaA.changeLog.deleteMany({
      where: { entity: "ProductionOperation", entityId: doomed.id },
    });
    await prismaA.productionOperation.delete({ where: { id: doomed.id } });
    const partialEffects = await effects();
    expect(partialEffects.ops).toHaveLength(1);
    await expect(submitUpakovka(input)).resolves.toEqual({
      status: "PARTIAL",
      saved: [{ productId: prodA!.id, quantity: 1 }],
    });
    expect(await effects()).toEqual(partialEffects);

    const other = await employee("Другой работник упаковки");
    await expect(submitUpakovka({ ...input, employeeId: other.id })).rejects.toThrow(
      TERMINAL_REQUEST_ALREADY_RECORDED,
    );
    expect(await prismaA.productionOperation.count()).toBe(1);
  });

  it("UPAKOVKA partial recovery writes only a confirmed new request", async () => {
    await setShadowGate(true);
    const world = await seedUpakovka(`ur-${Date.now()}`);
    const [prodA, prodB] = world.products;
    const requestId = `ur-${Date.now()}`;
    await prismaA.productionOperation.create({
      data: {
        type: "UPAKOVKA",
        employeeId: world.emp.id,
        clientRequestId: `${requestId}:${prodA!.id}`,
        workDate: new Date(),
        productId: prodA!.id,
        productQty: 1,
        rateSnapshotVersion: 1,
        rateUpakovkaSnapshot: 10,
      },
    });
    const before = await effects();
    const full = {
      employeeId: world.emp.id,
      clientRequestId: requestId,
      picks: [
        { productId: prodA!.id, quantity: 1 },
        { productId: prodB!.id, quantity: 1 },
      ],
    };
    const partial = await submitUpakovka(full);
    expect(partial).toEqual({
      status: "PARTIAL",
      saved: [{ productId: prodA!.id, quantity: 1 }],
    });
    expect(partial.status === "PARTIAL" && partial.saved.some((row) => row.productId === prodB!.id)).toBe(
      false,
    );
    expect(await effects()).toEqual(before);

    await expect(
      submitUpakovka({
        employeeId: world.emp.id,
        clientRequestId: `${requestId}-again`,
        recordedRequestId: requestId,
        picks: [{ productId: prodA!.id, quantity: 1 }],
      }),
    ).rejects.toThrow(UPAKOVKA_ALREADY_RECORDED);
    expect(await effects()).toEqual(before);

    const other = await employee("Чужой сотрудник упаковки");
    const beforeForeign = await effects();
    let foreign = "";
    try {
      await submitUpakovka({
        employeeId: other.id,
        clientRequestId: `${requestId}-foreign`,
        recordedRequestId: requestId,
        picks: [{ productId: prodB!.id, quantity: 1 }],
      });
    } catch (error) {
      foreign = error instanceof Error ? error.message : "";
    }
    expect(foreign).toBe(TERMINAL_REQUEST_ALREADY_RECORDED);
    expect(foreign).not.toContain(world.emp.id);
    expect(foreign).not.toContain(other.id);
    expect(foreign).not.toContain("Чужой");
    expect(await effects()).toEqual(beforeForeign);

    await bind(world.emp);
    await expect(
      submitUpakovka({
        employeeId: world.emp.id,
        clientRequestId: `${requestId}-confirmed`,
        recordedRequestId: requestId,
        picks: [{ productId: prodB!.id, quantity: 1 }],
      }),
    ).resolves.toEqual({ status: "RECORDED" });
    const after = await effects();
    expect(after.ops).toHaveLength(before.ops.length + 1);
    expect(after.ops.filter((op) => op.productId === prodA!.id)).toHaveLength(1);
    expect(
      after.ops.some(
        (op) => op.productId === prodB!.id && op.clientRequestId === `${requestId}-confirmed:${prodB!.id}`,
      ),
    ).toBe(true);
    expect(after.products).toEqual([{ productId: prodB!.id, quantity: 1 }]);
    expect(after.costs).toBe(before.costs);
    expect(after.movements).toBeGreaterThan(before.movements);
    expect(after.ops.filter((op) => op.clientRequestId?.startsWith(`${requestId}:`))).toHaveLength(1);
  });

  it("UPAKOVKA corrupt stored row refuses without a new write", async () => {
    const world = await seedUpakovka(`ucorrupt-${Date.now()}`);
    const [prodA, prodB] = world.products;
    const requestId = `ucorrupt-${Date.now()}`;
    await prismaA.productionOperation.create({
      data: {
        type: "UPAKOVKA",
        employeeId: world.emp.id,
        clientRequestId: `${requestId}:${prodA!.id}`,
        workDate: new Date(),
        productId: prodA!.id,
        productQty: null,
        rateSnapshotVersion: 1,
      },
    });
    const before = await effects();
    await expect(
      submitUpakovka({
        employeeId: world.emp.id,
        clientRequestId: requestId,
        picks: [
          { productId: prodA!.id, quantity: 1 },
          { productId: prodB!.id, quantity: 1 },
        ],
      }),
    ).rejects.toThrow(TERMINAL_REQUEST_ALREADY_RECORDED);
    expect(await effects()).toEqual(before);
  });

  it("UPAKOVKA concurrent same id does not pack both quantities", async () => {
    await setShadowGate(true);
    const world = await seedUpakovka(`uc-${Date.now()}`);
    const requestId = `uc-${Date.now()}`;
    const base = { employeeId: world.emp.id, clientRequestId: requestId };
    const settled = await Promise.allSettled([
      submitUpakovka({ ...base, picks: [{ productId: world.products[0]!.id, quantity: 1 }] }),
      submitUpakovka({ ...base, picks: [{ productId: world.products[0]!.id, quantity: 2 }] }),
    ]);
    expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const ops = await prismaA.productionOperation.findMany({
      where: { clientRequestId: { startsWith: `${requestId}:` } },
      include: { lines: true, nomenclatureLines: true },
    });
    expect(ops).toHaveLength(1);
    expect([1, 2]).toContain(ops[0]?.productQty);
    const stock = await prismaA.productStock.findUniqueOrThrow({
      where: { productId: world.products[0]!.id },
    });
    expect(stock.quantity).toBe(ops[0]?.productQty);
    const plan = planProductionShadowMovements({ kind: "UPAKOVKA", operation: ops[0]! });
    expect(await prismaA.inventoryMovement.count({ where: { causationId: ops[0]!.id } })).toBe(
      plan.effects.length,
    );
  });

  it("HOURS exact replay, changed hours, other employee, and concurrent requests", async () => {
    await setShadowGate(true);
    const emp = await employee(`hours-${Date.now()}`);
    const requestId = `h-${Date.now()}`;
    await submitHours(emp.id, 8.5, requestId);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    const saved = await effects();
    expect(saved.ops).toHaveLength(1);
    await submitHours(emp.id, 8.5, requestId);
    expect(await effects()).toEqual(saved);

    await prismaA.employee.update({ where: { id: emp.id }, data: { hourlyRate: 250 } });
    await submitHours(emp.id, 8.5, requestId);
    const afterRate = await effects();
    expect(afterRate.ops).toHaveLength(1);
    expect(afterRate.ops[0]?.hourlyRate).toBe("100.00");
    expect(afterRate.movements).toBe(0);

    await expect(submitHours(emp.id, 8, requestId)).rejects.toThrow(TERMINAL_REQUEST_ALREADY_RECORDED);
    expect(await effects()).toEqual(afterRate);

    const other = await employee("Другой работник часов");
    await expect(submitHours(other.id, 8.5, requestId)).rejects.toThrow(TERMINAL_REQUEST_ALREADY_RECORDED);
    expect(await prismaA.productionOperation.count()).toBe(1);

    const concurrentEmp = await employee(`hours-c-${Date.now()}`);
    const concurrentId = `hc-${Date.now()}`;
    const settled = await Promise.allSettled([
      submitHours(concurrentEmp.id, 1, concurrentId),
      submitHours(concurrentEmp.id, 1.5, concurrentId),
    ]);
    expect(settled.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    const row = await prismaA.productionOperation.findUniqueOrThrow({
      where: { clientRequestId: concurrentId },
    });
    expect(["1.00", "1.50"]).toContain(row.hours?.toFixed(2));
    expect(await prismaA.productionOperation.count({ where: { clientRequestId: concurrentId } })).toBe(1);

    const sameEmp = await employee(`hours-same-${Date.now()}`);
    const sameId = `hs-${Date.now()}`;
    const sameSettled = await Promise.allSettled([
      submitHours(sameEmp.id, 2, sameId),
      submitHours(sameEmp.id, 2, sameId),
    ]);
    expect(sameSettled.every((item) => item.status === "fulfilled")).toBe(true);
    expect(await prismaA.productionOperation.count({ where: { clientRequestId: sameId } })).toBe(1);
  });
});
