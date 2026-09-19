import { describe, expect, it } from "vitest";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
  targetHashV1,
  targetKeyV1,
} from "@/server/internal/inventory-movement-identity";
import type { InventoryPhysicalEffect } from "@/server/internal/inventory-physical-effects";
import { inventoryPhysicalEffectsToMovementEffects } from "@/server/internal/inventory-physical-effects-to-movement";

function blankEffect(
  overrides: Partial<Extract<InventoryPhysicalEffect, { stockDomain: "BLANK" }>> = {},
): Extract<InventoryPhysicalEffect, { stockDomain: "BLANK" }> {
  return {
    inventoryLineId: "line-blank",
    stockDomain: "BLANK",
    physicalTarget: {
      materialId: "mat-z",
      lengthM: 1.8,
      detailType: "POLKA",
      sort: "SORT1",
    },
    beforeQty: 10,
    afterQty: 7,
    quantityDelta: -3,
    ...overrides,
  };
}

describe("inventoryPhysicalEffectsToMovementEffects", () => {
  it("maps every domain to ADJUSTMENT / adjust with no qualifier and no RAIL_LOT", () => {
    const effects: InventoryPhysicalEffect[] = [
      blankEffect(),
      {
        inventoryLineId: "line-detail",
        stockDomain: "DETAIL",
        physicalTarget: { detailId: "det-1", torcevayaDone: true, ploskostDone: false },
        beforeQty: 4,
        afterQty: 7,
        quantityDelta: 3,
      },
      {
        inventoryLineId: "line-product",
        stockDomain: "PRODUCT",
        physicalTarget: { productId: "prod-1" },
        beforeQty: 2,
        afterQty: 1,
        quantityDelta: -1,
      },
      {
        inventoryLineId: "line-nom",
        stockDomain: "NOMENCLATURE",
        physicalTarget: { nomenclatureId: "nom-1" },
        beforeQty: 20,
        afterQty: 20,
        quantityDelta: 0,
      },
    ];
    const mapped = inventoryPhysicalEffectsToMovementEffects(effects);
    expect(mapped).toHaveLength(4);
    for (const row of mapped) {
      expect(row.role).toBe("adjust");
      expect(row.kind).toBe("ADJUSTMENT");
      expect(row.qualifier).toBeUndefined();
      expect(row.target.stockDomain).not.toBe("RAIL_LOT");
    }
    expect(mapped.map((row) => row.quantityDelta)).toEqual([-3, 3, -1, 0]);
  });

  it("BLANK identity uses gateway canonicalLengthFixed4, never JS 1.8 vs 1.8000 split", () => {
    const mapped = inventoryPhysicalEffectsToMovementEffects([blankEffect()]);
    const target = mapped[0]!.target;
    expect(target.stockDomain).toBe("BLANK");
    const canonical = canonicalizeMovementTarget(target);
    expect(canonical.targetSnapshot).toEqual({
      v: 1,
      d: "BLANK",
      materialId: "mat-z",
      lengthM: "1.8000",
      detailType: "POLKA",
      sort: "SORT1",
    });
    expect(effectKeyV1("adjust", canonical.targetHashV1)).toBe(
      `imfx1:adjust:${targetHashV1(targetKeyV1(target))}`,
    );
  });

  it("does not net DETAIL multi-effects from one InventoryLine", () => {
    const lineId = "line-ready";
    const mapped = inventoryPhysicalEffectsToMovementEffects([
      {
        inventoryLineId: lineId,
        stockDomain: "DETAIL",
        physicalTarget: { detailId: "det-1", torcevayaDone: true, ploskostDone: false },
        beforeQty: 4,
        afterQty: 7,
        quantityDelta: 3,
      },
      {
        inventoryLineId: lineId,
        stockDomain: "DETAIL",
        physicalTarget: { detailId: "det-1", torcevayaDone: true, ploskostDone: true },
        beforeQty: 3,
        afterQty: 0,
        quantityDelta: -3,
      },
    ]);
    expect(mapped).toHaveLength(2);
    expect(mapped.map((row) => row.quantityDelta)).toEqual([3, -3]);
    const keys = mapped.map((row) =>
      effectKeyV1("adjust", canonicalizeMovementTarget(row.target).targetHashV1),
    );
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("reversed input yields the same effectKey set (gateway owns insert order)", () => {
    const a = blankEffect({ quantityDelta: -3, afterQty: 7 });
    const b: InventoryPhysicalEffect = {
      inventoryLineId: "line-product",
      stockDomain: "PRODUCT",
      physicalTarget: { productId: "prod-1" },
      beforeQty: 2,
      afterQty: 5,
      quantityDelta: 3,
    };
    const keys = (effects: InventoryPhysicalEffect[]) =>
      new Set(
        inventoryPhysicalEffectsToMovementEffects(effects).map((row) =>
          effectKeyV1("adjust", canonicalizeMovementTarget(row.target).targetHashV1),
        ),
      );
    expect(keys([a, b])).toEqual(keys([b, a]));
  });
});
