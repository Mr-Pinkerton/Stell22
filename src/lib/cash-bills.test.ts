import { describe, expect, it } from "vitest";
import { aggregateBanknotes, calcBanknotes } from "./cash-bills";

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

describe("aggregateBanknotes", () => {
  it("суммирует купюры по работникам (округление на каждого отдельно)", () => {
    const a = calcBanknotes(12_749);
    const b = calcBanknotes(1250);
    const total = aggregateBanknotes([12_749, 1250]);
    expect(total.rounded).toBe(a.rounded + b.rounded);
    expect(total.bills[5000]).toBe(a.bills[5000] + b.bills[5000]);
    expect(total.bills[1000]).toBe(a.bills[1000] + b.bills[1000]);
    expect(total.bills[500]).toBe(a.bills[500] + b.bills[500]);
    expect(total.bills[100]).toBe(a.bills[100] + b.bills[100]);
  });
});
