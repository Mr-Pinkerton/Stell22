import { describe, expect, it } from "vitest";
import { calcBanknotes } from "./cash-bills";

describe("calcBanknotes", () => {
  it("округляет до 100 и раскладывает по номиналам", () => {
    const { rounded, bills } = calcBanknotes(12_749);
    expect(rounded).toBe(12_700);
    expect(bills[5000]).toBe(2);
    expect(bills[1000]).toBe(2);
    expect(bills[500]).toBe(1);
    expect(bills[100]).toBe(2);
  });

  it("1250 округляется вверх до 1300", () => {
    const { rounded, bills } = calcBanknotes(1250);
    expect(rounded).toBe(1300);
    expect(bills[1000]).toBe(1);
    expect(bills[100]).toBe(3);
    expect(bills[5000]).toBe(0);
    expect(bills[500]).toBe(0);
  });
});
