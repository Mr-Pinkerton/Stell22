import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  compareSupplyKeys,
  isRetryableSyncDeadlock,
  lockSuppliesInOrder,
  resolveSupplyProductBinding,
  uniqueSortedSupplyKeys,
} from "./supply-deduct";

describe("supply lock order", () => {
  it("sorts keys by marketplace, externalId, sku", () => {
    expect(
      uniqueSortedSupplyKeys([
        { marketplace: "WB", externalId: "2", sku: "a" },
        { marketplace: "OZON", externalId: "1", sku: "b" },
        { marketplace: "OZON", externalId: "1", sku: "a" },
        { marketplace: "OZON", externalId: "1", sku: "a" },
      ]),
    ).toEqual([
      { marketplace: "OZON", externalId: "1", sku: "a" },
      { marketplace: "OZON", externalId: "1", sku: "b" },
      { marketplace: "WB", externalId: "2", sku: "a" },
    ]);
  });

  it("lockSuppliesInOrder issues FOR UPDATE in sorted key order", async () => {
    const sqls: string[] = [];
    const db = {
      $queryRaw: vi.fn(async (query: Prisma.Sql) => {
        sqls.push(query.values.join("|"));
        return [];
      }),
    };
    await lockSuppliesInOrder(db as never, [
      { marketplace: "WB", externalId: "2", sku: "z" },
      { marketplace: "OZON", externalId: "1", sku: "a" },
    ]);
    expect(sqls).toEqual(["OZON|1|a", "WB|2|z"]);
    expect(db.$queryRaw.mock.calls[0][0].strings.join("?")).toContain("FOR UPDATE");
  });

  it("applySupplyDeduction refuses available=0 fallback after failed gte", () => {
    const src = readFileSync(new URL("./supply-deduct.ts", import.meta.url), "utf8");
    expect(src).toContain("refusing available=0 shortfall fallback");
    expect(src).not.toContain("available: 0 }");
  });

  it("treats Prisma P2034 / 40P01 as retryable deadlock", () => {
    expect(isRetryableSyncDeadlock({ code: "P2034" })).toBe(true);
    expect(isRetryableSyncDeadlock({ meta: { code: "40P01" }, message: "x" })).toBe(true);
    expect(
      compareSupplyKeys(
        { marketplace: "A", externalId: "1", sku: "s" },
        { marketplace: "B", externalId: "1", sku: "s" },
      ),
    ).toBeLessThan(0);
  });
});

describe("resolveSupplyProductBinding", () => {
  it("rebinds to live product while counters are zero", () => {
    expect(
      resolveSupplyProductBinding({
        deductedQty: 0,
        shortfallQty: 0,
        boundProductId: "A",
        liveProductId: "B",
      }),
    ).toEqual({ productId: "B", rebind: true });
  });

  it("freezes bound product once accounting has started", () => {
    expect(
      resolveSupplyProductBinding({
        deductedQty: 1,
        shortfallQty: 0,
        boundProductId: "A",
        liveProductId: "B",
      }),
    ).toEqual({ productId: "A", rebind: false });
  });
});
