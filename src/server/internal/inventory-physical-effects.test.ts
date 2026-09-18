import { describe, expect, it } from "vitest";
import {
  DUPLICATE_INVENTORY_PHYSICAL_TARGET,
  planInventoryPhysicalEffects,
  physicalTargetKey,
  type InventoryPhysicalPlanInput,
} from "./inventory-physical-effects";

function blankPool(over: Partial<InventoryPhysicalPlanInput["blanksById"] extends Map<string, infer V> ? V : never> = {}) {
  return {
    id: "blank-1",
    materialId: "mat-m",
    lengthM: 1.2,
    detailType: "POLKA" as const,
    sort: "SORT1" as const,
    quantity: 10,
    ...over,
  };
}

describe("planInventoryPhysicalEffects", () => {
  it("maps one BLANK line to one physical blank spec", () => {
    const blank = blankPool();
    const effects = planInventoryPhysicalEffects({
      lines: [
        { id: "l1", refType: "BLANK", refId: blank.id, accountedQty: 10, actualQty: 7 },
      ],
      blanksById: new Map([[blank.id, blank]]),
      detailsById: new Map(),
      detailBucketsByDetailId: new Map(),
      productQtyById: new Map(),
      nomenclatureQtyById: new Map(),
    });
    expect(effects).toHaveLength(1);
    expect(effects[0]).toMatchObject({
      stockDomain: "BLANK",
      beforeQty: 10,
      afterQty: 7,
      quantityDelta: -3,
      physicalTarget: {
        materialId: "mat-m",
        lengthM: 1.2,
        detailType: "POLKA",
        sort: "SORT1",
      },
    });
  });

  it("rejects two BLANK lines that share the same physical spec", () => {
    const a = blankPool({ id: "b-a" });
    const b = blankPool({ id: "b-b" });
    expect(() =>
      planInventoryPhysicalEffects({
        lines: [
          { id: "l1", refType: "BLANK", refId: a.id, accountedQty: 10, actualQty: 7 },
          { id: "l2", refType: "BLANK", refId: b.id, accountedQty: 10, actualQty: 8 },
        ],
        blanksById: new Map([
          [a.id, a],
          [b.id, b],
        ]),
        detailsById: new Map(),
        detailBucketsByDetailId: new Map(),
        productQtyById: new Map(),
        nomenclatureQtyById: new Map(),
      }),
    ).toThrow(DUPLICATE_INVENTORY_PHYSICAL_TARGET);
  });

  it("DETAIL ready aggregate: canon gets actualQty, other ready → 0, WIP omitted", () => {
    const effects = planInventoryPhysicalEffects({
      lines: [
        { id: "ld", refType: "DETAIL", refId: "det-1", accountedQty: 7, actualQty: 5 },
      ],
      blanksById: new Map(),
      detailsById: new Map([
        ["det-1", { id: "det-1", prisadkaTorcevaya: true, prisadkaPloskost: false }],
      ]),
      detailBucketsByDetailId: new Map([
        [
          "det-1",
          [
            { torcevayaDone: true, ploskostDone: false, quantity: 4 },
            { torcevayaDone: true, ploskostDone: true, quantity: 3 },
            { torcevayaDone: false, ploskostDone: false, quantity: 2 },
          ],
        ],
      ]),
      productQtyById: new Map(),
      nomenclatureQtyById: new Map(),
    });
    const detailEffects = effects.filter((e) => e.stockDomain === "DETAIL");
    expect(detailEffects).toHaveLength(2);
    expect(detailEffects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          physicalTarget: { detailId: "det-1", torcevayaDone: true, ploskostDone: false },
          beforeQty: 4,
          afterQty: 5,
          quantityDelta: 1,
        }),
        expect.objectContaining({
          physicalTarget: { detailId: "det-1", torcevayaDone: true, ploskostDone: true },
          beforeQty: 3,
          afterQty: 0,
          quantityDelta: -3,
        }),
      ]),
    );
    expect(
      detailEffects.some(
        (e) =>
          e.stockDomain === "DETAIL" &&
          e.physicalTarget.torcevayaDone === false &&
          e.physicalTarget.ploskostDone === false,
      ),
    ).toBe(false);
  });

  it("line iteration order does not change the physical target set", () => {
    const input = (lineOrder: Array<"p" | "n">): InventoryPhysicalPlanInput => ({
      lines: lineOrder.map((k) =>
        k === "p"
          ? { id: "lp", refType: "PRODUCT", refId: "prod-1", accountedQty: 2, actualQty: 3 }
          : { id: "ln", refType: "NOMENCLATURE", refId: "nom-1", accountedQty: 5, actualQty: 5 },
      ),
      blanksById: new Map(),
      detailsById: new Map(),
      detailBucketsByDetailId: new Map(),
      productQtyById: new Map([["prod-1", 2]]),
      nomenclatureQtyById: new Map([["nom-1", 5]]),
    });
    const a = planInventoryPhysicalEffects(input(["p", "n"]));
    const b = planInventoryPhysicalEffects(input(["n", "p"]));
    const keysA = a.map(physicalTargetKey).sort();
    const keysB = b.map(physicalTargetKey).sort();
    expect(keysA).toEqual(keysB);
    expect(a.find((e) => e.stockDomain === "PRODUCT")?.afterQty).toBe(3);
    expect(b.find((e) => e.stockDomain === "PRODUCT")?.afterQty).toBe(3);
  });

  it("keeps zero-delta pool effects in the internal plan", () => {
    const blank = blankPool({ quantity: 10 });
    const effects = planInventoryPhysicalEffects({
      lines: [{ id: "l1", refType: "BLANK", refId: blank.id, accountedQty: 10, actualQty: 10 }],
      blanksById: new Map([[blank.id, blank]]),
      detailsById: new Map(),
      detailBucketsByDetailId: new Map(),
      productQtyById: new Map(),
      nomenclatureQtyById: new Map(),
    });
    expect(effects[0]?.quantityDelta).toBe(0);
    expect(effects[0]?.afterQty).toBe(10);
  });

  it("fails closed on no-prisadka DETAIL lines (legacy identity)", () => {
    expect(() =>
      planInventoryPhysicalEffects({
        lines: [{ id: "l1", refType: "DETAIL", refId: "det-a", accountedQty: 10, actualQty: 7 }],
        blanksById: new Map(),
        detailsById: new Map([
          ["det-a", { id: "det-a", prisadkaTorcevaya: false, prisadkaPloskost: false }],
        ]),
        detailBucketsByDetailId: new Map(),
        productQtyById: new Map(),
        nomenclatureQtyById: new Map(),
      }),
    ).toThrow("LEGACY_INVENTORY_DRAFT_RECREATE");
  });
});
