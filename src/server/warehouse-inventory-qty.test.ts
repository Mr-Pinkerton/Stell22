import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  transactions: 0,
  updates: [] as number[],
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => ({
    id: "admin-1",
    name: "Админ",
    email: "admin@example.invalid",
    role: "ADMIN",
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/server/db", () => ({
  prisma: {
    $transaction: async (fn: (tx: {
      $queryRaw: () => Promise<Array<{ id: string; status: string }>>;
      inventoryLine: {
        findUnique: () => Promise<{ id: string; inventoryId: string; actualQty: number }>;
        update: (args: { data: { actualQty: number } }) => Promise<void>;
      };
      changeLog: { create: () => Promise<void> };
    }) => Promise<void>) => {
      state.transactions += 1;
      await fn({
        $queryRaw: async () => [{ id: "inv-1", status: "DRAFT" }],
        inventoryLine: {
          findUnique: async () => ({ id: "line-1", inventoryId: "inv-1", actualQty: 0 }),
          update: async (args) => {
            state.updates.push(args.data.actualQty);
          },
        },
        changeLog: { create: async () => {} },
      });
    },
  },
}));

import { updateInventoryLineActual } from "@/server/warehouse";

beforeEach(() => {
  state.transactions = 0;
  state.updates = [];
});

describe("факт инвентаризации — целое неотрицательное количество", () => {
  it.each([0, 1])("принимает %s и пишет его в строку", async (qty) => {
    await updateInventoryLineActual("line-1", qty);
    expect(state.transactions).toBe(1);
    expect(state.updates).toEqual([qty]);
  });

  it.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "отклоняет %s до транзакции",
    async (qty) => {
      await expect(updateInventoryLineActual("line-1", qty)).rejects.toThrow(
        "Некорректное количество",
      );
      expect(state.transactions).toBe(0);
      expect(state.updates).toEqual([]);
    },
  );
});
