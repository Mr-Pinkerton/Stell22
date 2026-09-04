import { beforeEach, describe, expect, it, vi } from "vitest";
import { activeSkuClashMessage, assertUniqueActiveSkus, isDuplicateActiveSku } from "./active-sku";

vi.mock("@/server/db", () => ({
  prisma: {
    product: {
      findFirst: vi.fn(),
    },
  },
}));

import { prisma } from "@/server/db";

const findFirst = prisma.product.findFirst as ReturnType<typeof vi.fn>;

describe("assertUniqueActiveSkus", () => {
  beforeEach(() => {
    findFirst.mockReset();
  });

  it("throws on ACTIVE skuOzon clash", async () => {
    findFirst.mockImplementation(async (args: { where: { skuOzon?: string } }) => {
      if (args.where.skuOzon) return { id: "other" };
      return null;
    });
    await expect(assertUniqueActiveSkus("OZ-1", "WB-1")).rejects.toThrow(
      activeSkuClashMessage("Ozon", "OZ-1"),
    );
  });

  it("throws on ACTIVE skuWb clash", async () => {
    findFirst.mockImplementation(async (args: { where: { skuWb?: string } }) => {
      if (args.where.skuWb) return { id: "other" };
      return null;
    });
    await expect(assertUniqueActiveSkus("OZ-1", "WB-1")).rejects.toThrow(
      activeSkuClashMessage("WB", "WB-1"),
    );
  });

  it("passes when no ACTIVE clash", async () => {
    findFirst.mockResolvedValue(null);
    await expect(assertUniqueActiveSkus("OZ-1", "WB-1", "self")).resolves.toBeUndefined();
  });

  it("matches Product ACTIVE SKU P2002 discriminators", () => {
    expect(isDuplicateActiveSku({ code: "P2002", meta: { target: ["skuOzon"] } })).toBe(true);
    expect(isDuplicateActiveSku({ code: "P2002", meta: { target: "Product_skuWb_active_key" } })).toBe(
      true,
    );
    expect(isDuplicateActiveSku({ code: "P2002", meta: { target: ["accountNumber"] } })).toBe(false);
  });
});
