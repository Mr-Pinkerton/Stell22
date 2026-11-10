import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { PreparedUpakovkaApply, PreparedUpakovkaDetail } from "@/server/internal/inventory-integrity";
import { applyUpakovkaPrepared } from "@/server/internal/production-reversal";

const READY_MESSAGE = "Недостаточно готовых деталей для упаковки";

function detail(over: Partial<PreparedUpakovkaDetail> = {}): PreparedUpakovkaDetail {
  return {
    detailId: "det-1",
    quantity: 1,
    materialId: "mat-1",
    lengthM: new Prisma.Decimal("0.6000"),
    detailType: "POLKA",
    sort: "SORT1",
    prisadkaTorcevaya: true,
    prisadkaPloskost: true,
    ...over,
  };
}

function prepared(line: PreparedUpakovkaDetail): PreparedUpakovkaApply {
  return {
    productId: "prod-1",
    details: [line],
    fasteners: [],
    packagingId: null,
    extras: [],
  };
}

type StockRow = {
  id: string;
  detailId: string;
  quantity: number;
  torcevayaDone: boolean;
  ploskostDone: boolean;
};

function fakeTx(rows: StockRow[]) {
  return {
    $queryRaw: vi.fn(async () => []),
    detailStock: {
      findMany: vi.fn(async (args: { where: { detailId: string } }) =>
        rows
          .filter((row) => row.detailId === args.where.detailId && row.quantity > 0)
          .sort((a, b) => a.id.localeCompare(b.id)),
      ),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    blankStock: { updateMany: vi.fn(async () => ({ count: 1 })) },
    operationDetailLine: { create: vi.fn(async () => ({})) },
    nomenclatureStock: { updateMany: vi.fn(async () => ({ count: 1 })) },
    operationNomenclatureLine: { create: vi.fn(async () => ({})) },
    productStock: { upsert: vi.fn(async () => ({})) },
  };
}

async function refusalMessage(
  tx: ReturnType<typeof fakeTx>,
  quantity: number,
  line: PreparedUpakovkaDetail,
): Promise<string> {
  try {
    await applyUpakovkaPrepared(tx as never, "op-1", quantity, prepared(line), {
      costFlowActive: false,
    });
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  }
  throw new Error("упаковка должна была отказать");
}

describe("applyUpakovkaPrepared ready-part refusal", () => {
  it("отказывает, когда на складе есть детали, но готовых меньше потребности", async () => {
    const tx = fakeTx([
      {
        id: "row-unfinished",
        detailId: "det-1",
        quantity: 4,
        torcevayaDone: false,
        ploskostDone: false,
      },
      {
        id: "row-ready",
        detailId: "det-1",
        quantity: 1,
        torcevayaDone: true,
        ploskostDone: true,
      },
    ]);

    const message = await refusalMessage(tx, 2, detail());

    expect(message).toBe(READY_MESSAGE);
    expect(message).not.toMatch(/присадк/i);
    expect(tx.detailStock.updateMany).not.toHaveBeenCalled();
    expect(tx.blankStock.updateMany).not.toHaveBeenCalled();
    expect(tx.productStock.upsert).not.toHaveBeenCalled();
  });

  it("при достатке готовых деталей списывает прежнее распределение", async () => {
    const tx = fakeTx([
      {
        id: "row-a",
        detailId: "det-1",
        quantity: 5,
        torcevayaDone: true,
        ploskostDone: true,
      },
      {
        id: "row-b",
        detailId: "det-1",
        quantity: 5,
        torcevayaDone: true,
        ploskostDone: true,
      },
    ]);

    await applyUpakovkaPrepared(tx as never, "op-1", 7, prepared(detail()), {
      costFlowActive: false,
    });

    const decrements = (
      tx.detailStock.updateMany.mock.calls as unknown as Array<
        [
          {
            where: { id: string; quantity: { gte: number } };
            data: { quantity: { decrement: number } };
          },
        ]
      >
    ).map((call) => call[0]);
    expect(decrements).toEqual([
      {
        where: { id: "row-a", quantity: { gte: 5 } },
        data: { quantity: { decrement: 5 } },
      },
      {
        where: { id: "row-b", quantity: { gte: 2 } },
        data: { quantity: { decrement: 2 } },
      },
    ]);
    expect(tx.productStock.upsert).toHaveBeenCalledOnce();
  });
});
