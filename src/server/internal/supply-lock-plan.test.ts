import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  deriveSupplyProductStockTargets,
  incomingSupplyKeys,
  shippedSupplyAccountingKeys,
  sortSuppliesForUpsert,
  supplyKeyId,
  unionSupplyAccountingKeys,
  uniqueSortedProductIds,
  uniqueSortedSupplyKeys,
  type IncomingSupply,
  type LockedSupplyAccounting,
  type SupplyKey,
} from "./supply-lock-plan";

function key(marketplace: string, externalId: string, sku: string): SupplyKey {
  return { marketplace, externalId, sku };
}

function incoming(
  marketplace: string,
  externalId: string,
  sku: string,
  status: string,
  quantity = 10,
): IncomingSupply {
  return {
    marketplace,
    externalId,
    sku,
    status,
    quantity,
    number: null,
    warehouseName: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    acceptedAt: null,
  };
}

describe("canonical Supply upsert order", () => {
  it("is independent of incoming array order and deduplicates keys", () => {
    const wb = incoming("WB", "2", "sku-b", "SHIPPED");
    const ozonB = incoming("OZON", "1", "sku-b", "PENDING");
    const ozonA = incoming("OZON", "1", "sku-a", "SHIPPED");
    const ozonADup = incoming("OZON", "1", "sku-a", "ACCEPTED", 99);
    const forward = sortSuppliesForUpsert([wb, ozonB, ozonA, ozonADup]);
    const reversed = sortSuppliesForUpsert([ozonADup, ozonA, ozonB, wb]);
    expect(forward.map(supplyKeyId)).toEqual(reversed.map(supplyKeyId));
    expect(forward.map(supplyKeyId)).toEqual([
      supplyKeyId(ozonA),
      supplyKeyId(ozonB),
      supplyKeyId(wb),
    ]);
    expect(incomingSupplyKeys([wb, ozonA, ozonB])).toEqual(uniqueSortedSupplyKeys([ozonB, wb, ozonA]));
  });
});

describe("Supply accounting key union", () => {
  it("deduplicates deduct + cancel + same-sync identities into canonical order", () => {
    const deduct = [
      key("WB", "2", "z"),
      key("OZON", "1", "a"),
      key("OZON", "cancel", "x"),
    ];
    const cancel = [
      key("OZON", "cancel", "x"),
      key("OZON", "only-cancel", "y"),
    ];
    const forward = unionSupplyAccountingKeys({ deductKeys: deduct, cancelKeys: cancel });
    const reversed = unionSupplyAccountingKeys({
      deductKeys: [...deduct].reverse(),
      cancelKeys: [...cancel].reverse(),
    });
    expect(forward).toEqual(reversed);
    expect(forward).toEqual([
      key("OZON", "1", "a"),
      key("OZON", "cancel", "x"),
      key("OZON", "only-cancel", "y"),
      key("WB", "2", "z"),
    ]);
  });

  it("includes SHIPPED/ACCEPTED identities regardless of live product mapping", () => {
    expect(
      shippedSupplyAccountingKeys([
        incoming("WB", "2", "b", "PENDING"),
        incoming("OZON", "1", "a", "SHIPPED"),
        incoming("OZON", "1", "c", "ACCEPTED"),
      ]),
    ).toEqual([key("OZON", "1", "a"), key("OZON", "1", "c")]);
  });
});

describe("ProductStock target set", () => {
  it("deduplicates overlapping deduct + cancel targets and sorts by productId", () => {
    const p1 = "prod-aaa";
    const p2 = "prod-zzz";
    const deductA = key("OZON", "a", "sku-a");
    const deductB = key("OZON", "b", "sku-b");
    const cancelA = key("OZON", "a", "sku-a");
    const locked: LockedSupplyAccounting[] = [
      {
        ...deductB,
        productId: p2,
        deductedQty: 2,
        shortfallQty: 0,
        stockAccountingOpen: true,
      },
      {
        ...deductA,
        productId: p1,
        deductedQty: 4,
        shortfallQty: 0,
        stockAccountingOpen: true,
      },
    ];
    const live = new Map<string, string | null>([
      [supplyKeyId(deductA), p1],
      [supplyKeyId(deductB), p2],
    ]);
    const targets = deriveSupplyProductStockTargets({
      lockedSupplies: locked,
      liveProductIdByKey: live,
      deductKeys: [deductB, deductA],
      cancelKeys: [cancelA],
      cancelledOzonExternalIds: new Set(),
    });
    expect(targets).toEqual([p1, p2]);
  });

  it("same-sync Ozon cancellation wins: no deduct target, restore uses retained productId", () => {
    const p1 = "prod-retain";
    const liveOther = "prod-live";
    const supplyKey = key("OZON", "win", "sku");
    const locked: LockedSupplyAccounting[] = [
      {
        ...supplyKey,
        productId: p1,
        deductedQty: 5,
        shortfallQty: 0,
        stockAccountingOpen: true,
      },
    ];
    const targets = deriveSupplyProductStockTargets({
      lockedSupplies: locked,
      liveProductIdByKey: new Map([[supplyKeyId(supplyKey), liveOther]]),
      deductKeys: [supplyKey],
      cancelKeys: [supplyKey],
      cancelledOzonExternalIds: new Set(["win"]),
    });
    expect(targets).toEqual([p1]);
  });

  it("zero-restore cancellation does not require a ProductStock target", () => {
    const supplyKey = key("OZON", "short", "sku");
    const targets = deriveSupplyProductStockTargets({
      lockedSupplies: [
        {
          ...supplyKey,
          productId: null,
          deductedQty: 0,
          shortfallQty: 8,
          stockAccountingOpen: true,
        },
      ],
      liveProductIdByKey: new Map(),
      deductKeys: [],
      cancelKeys: [supplyKey],
      cancelledOzonExternalIds: new Set(["short"]),
    });
    expect(targets).toEqual([]);
  });

  it("null-product positive restore is not a ProductStock target (fail-closed later)", () => {
    const supplyKey = key("OZON", "null-bind", "sku");
    const targets = deriveSupplyProductStockTargets({
      lockedSupplies: [
        {
          ...supplyKey,
          productId: null,
          deductedQty: 3,
          shortfallQty: 0,
          stockAccountingOpen: true,
        },
      ],
      liveProductIdByKey: new Map([[supplyKeyId(supplyKey), "live-now"]]),
      deductKeys: [],
      cancelKeys: [supplyKey],
      cancelledOzonExternalIds: new Set(["null-bind"]),
    });
    expect(targets).toEqual([]);
  });

  it("frozen binding after accounting started ignores live SKU remapping", () => {
    const bound = "prod-bound";
    const live = "prod-live";
    const supplyKey = key("OZON", "frozen", "sku");
    const targets = deriveSupplyProductStockTargets({
      lockedSupplies: [
        {
          ...supplyKey,
          productId: bound,
          deductedQty: 1,
          shortfallQty: 0,
          stockAccountingOpen: true,
        },
      ],
      liveProductIdByKey: new Map([[supplyKeyId(supplyKey), live]]),
      deductKeys: [supplyKey],
      cancelKeys: [],
      cancelledOzonExternalIds: new Set(),
    });
    expect(targets).toEqual([bound]);
    expect(uniqueSortedProductIds([live, bound, bound, null])).toEqual([bound, live]);
  });
});

describe("Supply prerequisite static invariants", () => {
  it("does not add an InventoryMovement writer or SHADOW gate read", () => {
    const files = [
      new URL("./supply-deduct.ts", import.meta.url),
      new URL("./supply-lock-plan.ts", import.meta.url),
      new URL("./marketplace-sync.ts", import.meta.url),
    ];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src).not.toContain("appendShadowInventoryMovements");
      expect(src).not.toContain("appendProductionShadowMovements");
      expect(src).not.toContain("inventory_movement_shadow_write");
      expect(src).not.toMatch(/inventoryMovement\.create/);
    }
  });
});
