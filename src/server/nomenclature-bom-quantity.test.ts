import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as string[],
  writtenDetails: [] as { detailId: string; quantity: number }[],
  writtenFasteners: [] as { nomenclatureId: string; quantity: number }[],
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

function touch(name: string) {
  state.calls.push(name);
}

function productRecord(data: {
  name: string;
  materialId: string;
  skuOzon: string;
  skuWb: string;
  sort: string;
  packagingId: string | null;
  details: { create: { detailId: string; quantity: number }[] };
  fasteners: { create: { nomenclatureId: string; quantity: number }[] };
  extras: { create: { nomenclatureId: string }[] };
}) {
  state.writtenDetails = data.details.create.map((row) => ({ ...row }));
  state.writtenFasteners = data.fasteners.create.map((row) => ({ ...row }));
  return {
    id: "prod-1",
    name: data.name,
    materialId: data.materialId,
    skuOzon: data.skuOzon,
    skuWb: data.skuWb,
    sort: data.sort,
    packagingId: data.packagingId,
    status: "ACTIVE",
    details: data.details.create,
    fasteners: data.fasteners.create,
    extras: data.extras.create,
  };
}

const existingProduct = {
  id: "prod-1",
  name: "Полка",
  materialId: "mat-1",
  skuOzon: "OZ-1",
  skuWb: "WB-1",
  sort: "SORT1",
  packagingId: null,
  status: "ACTIVE",
  details: [{ detailId: "det-1", quantity: 1 }],
  fasteners: [{ nomenclatureId: "fast-1", quantity: 1 }],
  extras: [],
};

vi.mock("@/server/db", () => ({
  prisma: {
    detail: {
      findMany: async () => {
        touch("detail.findMany");
        return [{ materialId: "mat-1" }];
      },
    },
    product: {
      findFirst: async () => {
        touch("product.findFirst");
        return null;
      },
      findUnique: async () => {
        touch("product.findUnique");
        return existingProduct;
      },
      create: async (args: { data: Parameters<typeof productRecord>[0] }) => {
        touch("product.create");
        return productRecord(args.data);
      },
      update: async (args: { data: Parameters<typeof productRecord>[0] }) => {
        touch("product.update");
        return productRecord(args.data);
      },
    },
    productDetail: {
      deleteMany: async () => {
        touch("productDetail.deleteMany");
      },
    },
    productFastener: {
      deleteMany: async () => {
        touch("productFastener.deleteMany");
      },
    },
    productExtra: {
      deleteMany: async () => {
        touch("productExtra.deleteMany");
      },
    },
    changeLog: {
      create: async () => {
        touch("changeLog.create");
      },
    },
    $transaction: async (fn: (tx: {
      productDetail: { deleteMany: () => Promise<void> };
      productFastener: { deleteMany: () => Promise<void> };
      productExtra: { deleteMany: () => Promise<void> };
      product: { update: (args: { data: Parameters<typeof productRecord>[0] }) => Promise<unknown> };
    }) => Promise<unknown>) => {
      touch("$transaction");
      return fn({
        productDetail: {
          deleteMany: async () => {
            touch("productDetail.deleteMany");
          },
        },
        productFastener: {
          deleteMany: async () => {
            touch("productFastener.deleteMany");
          },
        },
        productExtra: {
          deleteMany: async () => {
            touch("productExtra.deleteMany");
          },
        },
        product: {
          update: async (args) => {
            touch("product.update");
            return productRecord(args.data);
          },
        },
      });
    },
  },
}));

import { createProduct, updateProduct } from "@/server/nomenclature";
import type { ProductFormValues } from "@/server/nomenclature";

const invalidQuantities = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY] as const;

function form(patch: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    name: "Полка",
    materialId: "mat-1",
    skuOzon: "OZ-1",
    skuWb: "WB-1",
    sort: "SORT1",
    packagingId: null,
    details: [{ detailId: "det-1", quantity: 1 }],
    fasteners: [{ nomenclatureId: "fast-1", quantity: 1 }],
    extraIds: [],
    ...patch,
  };
}

beforeEach(() => {
  state.calls = [];
  state.writtenDetails = [];
  state.writtenFasteners = [];
});

describe("количество детали в составе", () => {
  it.each([1, 5])("createProduct принимает %s и записывает его без округления", async (quantity) => {
    const created = await createProduct(form({ details: [{ detailId: "det-1", quantity }] }));
    expect(created.details).toEqual([{ detailId: "det-1", quantity }]);
    expect(state.writtenDetails).toEqual([{ detailId: "det-1", quantity }]);
    expect(state.calls).toContain("product.create");
  });

  it.each(invalidQuantities)("createProduct отклоняет %s до записи в базу", async (quantity) => {
    await expect(
      createProduct(form({ details: [{ detailId: "det-1", quantity }] })),
    ).rejects.toThrow("Количество детали в составе должно быть целым числом не меньше 1");
    expect(state.calls).toEqual([]);
  });

  it.each([1, 5])("updateProduct принимает %s и записывает его без округления", async (quantity) => {
    const updated = await updateProduct("prod-1", form({ details: [{ detailId: "det-1", quantity }] }));
    expect(updated.details).toEqual([{ detailId: "det-1", quantity }]);
    expect(state.writtenDetails).toEqual([{ detailId: "det-1", quantity }]);
    expect(state.calls).toContain("product.update");
  });

  it.each(invalidQuantities)("updateProduct отклоняет %s до записи в базу", async (quantity) => {
    await expect(
      updateProduct("prod-1", form({ details: [{ detailId: "det-1", quantity }] })),
    ).rejects.toThrow("Количество детали в составе должно быть целым числом не меньше 1");
    expect(state.calls).toEqual([]);
  });
});

describe("количество крепежа в составе", () => {
  it.each([1, 5])("createProduct принимает %s и записывает его без округления", async (quantity) => {
    const created = await createProduct(
      form({ fasteners: [{ nomenclatureId: "fast-1", quantity }] }),
    );
    expect(created.fastenerIds).toEqual([{ nomenclatureId: "fast-1", quantity }]);
    expect(state.writtenFasteners).toEqual([{ nomenclatureId: "fast-1", quantity }]);
    expect(state.calls).toContain("product.create");
  });

  it.each(invalidQuantities)("createProduct отклоняет %s до записи в базу", async (quantity) => {
    await expect(
      createProduct(form({ fasteners: [{ nomenclatureId: "fast-1", quantity }] })),
    ).rejects.toThrow("Количество крепежа в составе должно быть целым числом не меньше 1");
    expect(state.calls).toEqual([]);
  });

  it.each([1, 5])("updateProduct принимает %s и записывает его без округления", async (quantity) => {
    const updated = await updateProduct(
      "prod-1",
      form({ fasteners: [{ nomenclatureId: "fast-1", quantity }] }),
    );
    expect(updated.fastenerIds).toEqual([{ nomenclatureId: "fast-1", quantity }]);
    expect(state.writtenFasteners).toEqual([{ nomenclatureId: "fast-1", quantity }]);
    expect(state.calls).toContain("product.update");
  });

  it.each(invalidQuantities)("updateProduct отклоняет %s до записи в базу", async (quantity) => {
    await expect(
      updateProduct("prod-1", form({ fasteners: [{ nomenclatureId: "fast-1", quantity }] })),
    ).rejects.toThrow("Количество крепежа в составе должно быть целым числом не меньше 1");
    expect(state.calls).toEqual([]);
  });
});
