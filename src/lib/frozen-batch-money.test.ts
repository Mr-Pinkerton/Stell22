import { describe, expect, it } from "vitest";
import { frozenBatchCostInputsChanged, frozenBatchMoneyChanged } from "./frozen-batch-money";

const money = { purchaseCost: 100_000, priceSort1: 10, priceSort2: 8 };
const base = {
  ...money,
  sectionWidthMm: 40,
  sectionHeightMm: 20,
  materialId: "mat-a",
};

describe("frozenBatchMoneyChanged", () => {
  it("is false when purchase and sort prices match", () => {
    expect(frozenBatchMoneyChanged(money, { ...money })).toBe(false);
  });

  it("is true when purchaseCost differs", () => {
    expect(frozenBatchMoneyChanged(money, { ...money, purchaseCost: 120_000 })).toBe(true);
  });

  it("is true when a sort price differs", () => {
    expect(frozenBatchMoneyChanged(money, { ...money, priceSort1: 11 })).toBe(true);
  });
});

describe("frozenBatchCostInputsChanged", () => {
  it("is false when all six cost inputs match", () => {
    expect(frozenBatchCostInputsChanged(base, { ...base })).toBe(false);
  });

  it("is true when section millimetres change", () => {
    expect(frozenBatchCostInputsChanged(base, { ...base, sectionWidthMm: 50 })).toBe(true);
    expect(frozenBatchCostInputsChanged(base, { ...base, sectionHeightMm: 25 })).toBe(true);
  });

  it("is true when materialId changes even with the same section mm", () => {
    expect(frozenBatchCostInputsChanged(base, { ...base, materialId: "mat-b" })).toBe(true);
  });

  it("does not take name or note — those stay editable when frozen", () => {
    expect(Object.keys(base).sort()).toEqual(
      ["materialId", "priceSort1", "priceSort2", "purchaseCost", "sectionHeightMm", "sectionWidthMm"].sort(),
    );
  });
});
