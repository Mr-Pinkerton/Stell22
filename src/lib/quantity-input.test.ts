import { describe, expect, it } from "vitest";
import { canConfirmQuantity, nextPickedQuantity } from "./quantity-input";

describe("canConfirmQuantity", () => {
  it("rejects 0 by default so unselected lines still start from a positive qty", () => {
    expect(canConfirmQuantity({ numeric: 0 })).toBe(false);
    expect(canConfirmQuantity({ numeric: 0, allowZero: false })).toBe(false);
  });

  it("allows 0 only when allowZero is set (TORCOVKA edit of an existing pick)", () => {
    expect(canConfirmQuantity({ numeric: 0, allowZero: true })).toBe(true);
  });

  it("accepts a positive quantity within max", () => {
    expect(canConfirmQuantity({ numeric: 3, max: 10 })).toBe(true);
    expect(canConfirmQuantity({ numeric: 3, max: 10, allowZero: true })).toBe(true);
  });

  it("rejects over-limit and non-finite or negative values", () => {
    expect(canConfirmQuantity({ numeric: 4, max: 3 })).toBe(false);
    expect(canConfirmQuantity({ numeric: 0, max: 3, allowZero: true })).toBe(true);
    expect(canConfirmQuantity({ numeric: -1, allowZero: true })).toBe(false);
    expect(canConfirmQuantity({ numeric: Number.NaN })).toBe(false);
  });
});

describe("nextPickedQuantity", () => {
  it("removes only that line when quantity is set to 0", () => {
    expect(nextPickedQuantity(0)).toBeNull();
  });

  it("keeps a positive quantity", () => {
    expect(nextPickedQuantity(2)).toBe(2);
  });
});
