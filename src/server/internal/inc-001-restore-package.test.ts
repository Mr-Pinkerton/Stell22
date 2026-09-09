import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  DELETED_OPERATION_ID,
  EXPECTED_BATCH_ID,
  EXPECTED_CODE,
  EXPECTED_QUANTITY,
  EXPECTED_CURRENT_REMAINING,
  RAIL_LOT_ID,
  TARGET_REMAINING,
  restoreInc001SourcePackage,
} from "./inc-001-restore-package";

type LotRow = {
  id: string;
  code: string | null;
  batchId: string;
  quantity: number;
  remainingQuantity: number;
  initialValue: Prisma.Decimal | null;
  remainingValue: Prisma.Decimal | null;
};

type BatchRow = {
  id: string;
  status: string;
  closedAt: Date | null;
  frozenAt: Date | null;
};

function baseLot(over: Partial<LotRow> = {}): LotRow {
  return {
    id: RAIL_LOT_ID,
    code: EXPECTED_CODE,
    batchId: EXPECTED_BATCH_ID,
    quantity: EXPECTED_QUANTITY,
    remainingQuantity: EXPECTED_CURRENT_REMAINING,
    initialValue: null,
    remainingValue: null,
    ...over,
  };
}

function baseBatch(over: Partial<BatchRow> = {}): BatchRow {
  return {
    id: EXPECTED_BATCH_ID,
    status: "IN_WORK",
    closedAt: null,
    frozenAt: null,
    ...over,
  };
}

function makeTx(opts?: {
  lot?: LotRow | null;
  batch?: BatchRow | null;
  deletedOp?: { id: string } | null;
  liveOps?: number;
  costFlowActive?: boolean;
}) {
  const state = {
    lot: opts && "lot" in opts ? opts.lot : baseLot(),
    batch: opts && "batch" in opts ? opts.batch : baseBatch(),
    deletedOp: opts?.deletedOp ?? null,
    liveOps: opts?.liveOps ?? 0,
    changelog: [] as Array<{
      entity: string;
      entityId: string;
      userId: string | null | undefined;
      newValues: unknown;
    }>,
    updateCalls: [] as Array<{ where: unknown; data: unknown }>,
  };

  const tx = {
    railLot: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.lot && state.lot.id === where.id ? state.lot : null,
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id: string;
          batchId: string;
          quantity: number;
          remainingQuantity: number;
        };
        data: { remainingQuantity: number };
      }) => {
        state.updateCalls.push({ where, data });
        if (
          !state.lot ||
          state.lot.id !== where.id ||
          state.lot.batchId !== where.batchId ||
          state.lot.quantity !== where.quantity ||
          state.lot.remainingQuantity !== where.remainingQuantity
        ) {
          return { count: 0 };
        }
        state.lot = { ...state.lot, remainingQuantity: data.remainingQuantity };
        return { count: 1 };
      },
    },
    batch: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state.batch && state.batch.id === where.id ? state.batch : null,
    },
    productionOperation: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === DELETED_OPERATION_ID ? (opts?.deletedOp ?? null) : null,
      count: async ({ where }: { where: { railLotId: string } }) =>
        where.railLotId === RAIL_LOT_ID ? state.liveOps : 0,
    },
  };

  const deps = {
    lockRailLots: async () => undefined,
    lockBatches: async () => undefined,
    isCostFlowActive: async () => opts?.costFlowActive ?? false,
    writeChangeLog: async (input: {
      entity: string;
      entityId: string;
      userId?: string | null;
      newValues?: unknown;
    }) => {
      state.changelog.push({
        entity: input.entity,
        entityId: input.entityId,
        userId: input.userId ?? null,
        newValues: input.newValues,
      });
    },
  };

  return { tx, deps, state };
}

describe("restoreInc001SourcePackage", () => {
  it("permits repair on the exact expected state (dry-run: no writes)", async () => {
    const { tx, deps, state } = makeTx();
    const plan = await restoreInc001SourcePackage({
      tx: tx as never,
      execute: false,
      deps: deps as never,
    });
    expect(plan.ready).toBe(true);
    expect(state.lot?.remainingQuantity).toBe(0);
    expect(state.updateCalls).toHaveLength(0);
    expect(state.changelog).toHaveLength(0);
  });

  it("rejects remaining != 0", async () => {
    const { tx, deps } = makeTx({ lot: baseLot({ remainingQuantity: 7 }) });
    await expect(
      restoreInc001SourcePackage({ tx: tx as never, execute: true, deps: deps as never }),
    ).rejects.toThrow(/remainingQuantity/);
  });

  it("rejects wrong lot code", async () => {
    const { tx, deps } = makeTx({ lot: baseLot({ code: "WRONG" }) });
    await expect(
      restoreInc001SourcePackage({ tx: tx as never, execute: true, deps: deps as never }),
    ).rejects.toThrow(/код пакета/);
  });

  it("rejects wrong batch", async () => {
    const { tx, deps } = makeTx({ lot: baseLot({ batchId: "other-batch" }) });
    await expect(
      restoreInc001SourcePackage({ tx: tx as never, execute: true, deps: deps as never }),
    ).rejects.toThrow(/batchId/);
  });

  it("rejects closed batch", async () => {
    const { tx, deps } = makeTx({ batch: baseBatch({ closedAt: new Date("2026-09-01") }) });
    await expect(
      restoreInc001SourcePackage({ tx: tx as never, execute: true, deps: deps as never }),
    ).rejects.toThrow(/closedAt/);
  });

  it("rejects frozen batch", async () => {
    const { tx, deps } = makeTx({ batch: baseBatch({ frozenAt: new Date("2026-09-01") }) });
    await expect(
      restoreInc001SourcePackage({ tx: tx as never, execute: true, deps: deps as never }),
    ).rejects.toThrow(/заморож/);
  });

  it("rejects live op on lot", async () => {
    const { tx, deps } = makeTx({ liveOps: 1 });
    await expect(
      restoreInc001SourcePackage({ tx: tx as never, execute: true, deps: deps as never }),
    ).rejects.toThrow(/живая операция/);
  });

  it("rejects if incident op unexpectedly exists", async () => {
    const { tx, deps } = makeTx({ deletedOp: { id: DELETED_OPERATION_ID } });
    await expect(
      restoreInc001SourcePackage({ tx: tx as never, execute: true, deps: deps as never }),
    ).rejects.toThrow(/удалённая операция существует/);
  });

  it("rejects active cost-flow", async () => {
    const { tx, deps } = makeTx({ costFlowActive: true });
    await expect(
      restoreInc001SourcePackage({ tx: tx as never, execute: true, deps: deps as never }),
    ).rejects.toThrow(/production_cost_flow/);
  });

  it("second execution rejects after remaining is 1280", async () => {
    const { tx, deps, state } = makeTx();
    await restoreInc001SourcePackage({
      tx: tx as never,
      execute: true,
      deps: deps as never,
    });
    expect(state.lot?.remainingQuantity).toBe(TARGET_REMAINING);
    await expect(
      restoreInc001SourcePackage({
        tx: tx as never,
        execute: true,
        deps: deps as never,
      }),
    ).rejects.toThrow(/remainingQuantity/);
    expect(state.changelog).toHaveLength(1);
  });

  it("execute writes only remainingQuantity and one ChangeLog with userId null", async () => {
    const { tx, deps, state } = makeTx();
    await restoreInc001SourcePackage({
      tx: tx as never,
      execute: true,
      deps: deps as never,
    });
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0]).toEqual({
      where: {
        id: RAIL_LOT_ID,
        batchId: EXPECTED_BATCH_ID,
        quantity: EXPECTED_QUANTITY,
        remainingQuantity: 0,
      },
      data: { remainingQuantity: TARGET_REMAINING },
    });
    expect(state.changelog).toHaveLength(1);
    expect(state.changelog[0]?.entity).toBe("RailLot");
    expect(state.changelog[0]?.entityId).toBe(RAIL_LOT_ID);
    expect(state.changelog[0]?.userId).toBeNull();
    const values = state.changelog[0]?.newValues as Record<string, unknown>;
    expect(values.incidentId).toBe("INC-001");
    expect(values.source).toBe("cli-incident-repair");
    expect(values.action).toBe("restore_source_package_for_factual_replay");
    expect(values.oldRemainingQuantity).toBe(0);
    expect(values.newRemainingQuantity).toBe(1280);
    expect(values.deletedOperationId).toBe(DELETED_OPERATION_ID);
  });

  it("rejects non-null remainingValue (cost field would need restore)", async () => {
    const { tx, deps } = makeTx({
      lot: baseLot({ remainingValue: new Prisma.Decimal("1") }),
    });
    await expect(
      restoreInc001SourcePackage({ tx: tx as never, execute: true, deps: deps as never }),
    ).rejects.toThrow(/remainingValue/);
  });
});
