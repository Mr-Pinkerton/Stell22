import { beforeEach, describe, expect, it, vi } from "vitest";

const ARCHIVE_GUIDANCE = "Используйте «В архив»";

const h = vi.hoisted(() => {
  type HistoryRow = { id: string; productId: string; label: string };

  const state = {
    product: null as null | { id: string; name: string; status: "ACTIVE" | "ARCHIVED" },
    goals: [] as HistoryRow[],
    costs: [] as HistoryRow[],
    stock: [] as HistoryRow[],
    sales: [] as HistoryRow[],
    supplies: [] as HistoryRow[],
    operations: [] as HistoryRow[],
    changeLogs: [] as unknown[],
    productDeletes: [] as string[],
    childDeletes: [] as string[],
    historyMutations: [] as string[],
  };

  const revalidatePath = vi.fn();

  function count(rows: HistoryRow[], args: { where: { productId: string } }) {
    return rows.filter((row) => row.productId === args.where.productId).length;
  }

  function historyWriter(name: string) {
    return async () => {
      state.historyMutations.push(name);
    };
  }

  return { state, revalidatePath, count, historyWriter };
});

vi.mock("@/server/session", () => ({
  requireAdmin: async () => ({
    id: "admin-1",
    name: "Админ",
    email: "admin@example.invalid",
    role: "ADMIN",
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: h.revalidatePath }));

vi.mock("@/server/db", () => ({
  prisma: {
    goal: { count: async (args: { where: { productId: string } }) => h.count(h.state.goals, args) },
    productCost: {
      count: async (args: { where: { productId: string } }) => h.count(h.state.costs, args),
    },
    productStock: {
      count: async (args: { where: { productId: string } }) => h.count(h.state.stock, args),
    },
    sale: {
      count: async (args: { where: { productId: string } }) => h.count(h.state.sales, args),
      delete: h.historyWriter("sale.delete"),
      deleteMany: h.historyWriter("sale.deleteMany"),
      update: h.historyWriter("sale.update"),
      updateMany: h.historyWriter("sale.updateMany"),
    },
    supply: {
      count: async (args: { where: { productId: string } }) => h.count(h.state.supplies, args),
      delete: h.historyWriter("supply.delete"),
      deleteMany: h.historyWriter("supply.deleteMany"),
      update: h.historyWriter("supply.update"),
      updateMany: h.historyWriter("supply.updateMany"),
    },
    productionOperation: {
      count: async (args: { where: { productId: string } }) => h.count(h.state.operations, args),
      delete: h.historyWriter("productionOperation.delete"),
      deleteMany: h.historyWriter("productionOperation.deleteMany"),
      update: h.historyWriter("productionOperation.update"),
      updateMany: h.historyWriter("productionOperation.updateMany"),
    },
    product: {
      findUnique: async () => h.state.product,
      delete: async (args: { where: { id: string } }) => {
        h.state.productDeletes.push(args.where.id);
        if (h.state.product?.id === args.where.id) h.state.product = null;
      },
    },
    productDetail: {
      deleteMany: async () => {
        h.state.childDeletes.push("productDetail");
      },
    },
    productFastener: {
      deleteMany: async () => {
        h.state.childDeletes.push("productFastener");
      },
    },
    productExtra: {
      deleteMany: async () => {
        h.state.childDeletes.push("productExtra");
      },
    },
    changeLog: {
      create: async (args: { data: unknown }) => {
        h.state.changeLogs.push(args.data);
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

import { deleteProduct } from "@/server/nomenclature";

beforeEach(() => {
  h.state.product = { id: "prod-1", name: "Полка", status: "ACTIVE" };
  h.state.goals = [];
  h.state.costs = [];
  h.state.stock = [];
  h.state.sales = [];
  h.state.supplies = [];
  h.state.operations = [];
  h.state.changeLogs = [];
  h.state.productDeletes = [];
  h.state.childDeletes = [];
  h.state.historyMutations = [];
  h.revalidatePath.mockClear();
});

async function expectDeletionRejected() {
  const productBefore = structuredClone(h.state.product);
  const historyBefore = {
    goals: structuredClone(h.state.goals),
    costs: structuredClone(h.state.costs),
    stock: structuredClone(h.state.stock),
    sales: structuredClone(h.state.sales),
    supplies: structuredClone(h.state.supplies),
    operations: structuredClone(h.state.operations),
  };

  await expect(deleteProduct("prod-1")).rejects.toThrow(ARCHIVE_GUIDANCE);

  expect(h.state.product).toEqual(productBefore);
  expect(h.state.goals).toEqual(historyBefore.goals);
  expect(h.state.costs).toEqual(historyBefore.costs);
  expect(h.state.stock).toEqual(historyBefore.stock);
  expect(h.state.sales).toEqual(historyBefore.sales);
  expect(h.state.supplies).toEqual(historyBefore.supplies);
  expect(h.state.operations).toEqual(historyBefore.operations);
  expect(h.state.productDeletes).toEqual([]);
  expect(h.state.childDeletes).toEqual([]);
  expect(h.state.historyMutations).toEqual([]);
  expect(h.state.changeLogs).toEqual([]);
  expect(h.revalidatePath).not.toHaveBeenCalled();
}

describe("удаление изделия с историей", () => {
  it("не удаляет изделие, на которое есть продажа, и сохраняет продажу", async () => {
    h.state.sales = [{ id: "sale-1", productId: "prod-1", label: "OZON 100" }];
    await expectDeletionRejected();
  });

  it("не удаляет изделие, на которое есть поставка, и сохраняет поставку", async () => {
    h.state.supplies = [{ id: "supply-1", productId: "prod-1", label: "WB income 7" }];
    await expectDeletionRejected();
  });

  it("не удаляет изделие, на которое есть производственная операция, и сохраняет её", async () => {
    h.state.operations = [{ id: "op-1", productId: "prod-1", label: "UPAKOVKA 2" }];
    await expectDeletionRejected();
  });

  it("по-прежнему не удаляет изделие с целью", async () => {
    h.state.goals = [{ id: "goal-1", productId: "prod-1", label: "ноябрь 10" }];
    await expectDeletionRejected();
  });

  it("по-прежнему не удаляет изделие со снапшотом себестоимости", async () => {
    h.state.costs = [{ id: "cost-1", productId: "prod-1", label: "ноябрь" }];
    await expectDeletionRejected();
  });

  it("по-прежнему не удаляет изделие со складским остатком", async () => {
    h.state.stock = [{ id: "stock-1", productId: "prod-1", label: "3" }];
    await expectDeletionRejected();
  });

  it("удаляет изделие без ссылок и не трогает чужую историю", async () => {
    h.state.sales = [{ id: "sale-other", productId: "prod-2", label: "чужая продажа" }];
    h.state.supplies = [{ id: "supply-other", productId: "prod-2", label: "чужая поставка" }];
    h.state.operations = [{ id: "op-other", productId: "prod-2", label: "чужая операция" }];

    await deleteProduct("prod-1");

    expect(h.state.product).toBeNull();
    expect(h.state.productDeletes).toEqual(["prod-1"]);
    expect(h.state.childDeletes).toEqual(["productDetail", "productFastener", "productExtra"]);
    expect(h.state.sales).toEqual([{ id: "sale-other", productId: "prod-2", label: "чужая продажа" }]);
    expect(h.state.supplies).toEqual([
      { id: "supply-other", productId: "prod-2", label: "чужая поставка" },
    ]);
    expect(h.state.operations).toEqual([
      { id: "op-other", productId: "prod-2", label: "чужая операция" },
    ]);
    expect(h.state.historyMutations).toEqual([]);
    expect(h.state.changeLogs).toEqual([
      {
        entity: "Product",
        entityId: "prod-1",
        userId: null,
        oldValues: { name: "Полка", status: "ACTIVE" },
        newValues: undefined,
      },
    ]);
    expect(h.revalidatePath).toHaveBeenCalledWith("/nomenclature");
  });
});
