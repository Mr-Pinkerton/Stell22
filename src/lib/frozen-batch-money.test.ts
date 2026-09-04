import { describe, expect, it } from "vitest";
import { frozenBatchMoneyChanged } from "./frozen-batch-money";

describe("frozenBatchMoneyChanged", () => {
  it("is false when purchase and sort prices match", () => {
    expect(
      frozenBatchMoneyChanged(
        { purchaseCost: 100_000, priceSort1: 10, priceSort2: 8 },
        { purchaseCost: 100_000, priceSort1: 10, priceSort2: 8 },
      ),
    ).toBe(false);
  });

  it("is true when purchaseCost differs", () => {
    expect(
      frozenBatchMoneyChanged(
        { purchaseCost: 100_000, priceSort1: 10, priceSort2: 8 },
        { purchaseCost: 120_000, priceSort1: 10, priceSort2: 8 },
      ),
    ).toBe(true);
  });

  it("is true when a sort price differs", () => {
    expect(
      frozenBatchMoneyChanged(
        { purchaseCost: 100_000, priceSort1: 10, priceSort2: 8 },
        { purchaseCost: 100_000, priceSort1: 11, priceSort2: 8 },
      ),
    ).toBe(true);
  });
});
