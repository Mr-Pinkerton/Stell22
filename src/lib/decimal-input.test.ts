import { describe, expect, it } from "vitest";
import {
  assertMaxFractionDigits,
  exactMoneyString,
  formatMeasured,
  parseDecimalText,
  parsePositiveIntDraft,
} from "@/lib/decimal-input";

describe("parseDecimalText", () => {
  it("accepts comma and dot as the same length", () => {
    expect(parseDecimalText("0,72", 4)).toMatchObject({ value: 0.72, complete: true, error: null });
    expect(parseDecimalText("0.72", 4)).toMatchObject({ value: 0.72, complete: true, text: "0.72" });
    expect(parseDecimalText("0,35", 4).value).toBe(0.35);
    expect(parseDecimalText("0.35", 4).value).toBe(0.35);
    expect(parseDecimalText("2,475", 4).value).toBe(2.475);
    expect(parseDecimalText("0,0001", 4).value).toBe(0.0001);
    expect(parseDecimalText("40,5", 2).value).toBe(40.5);
    expect(parseDecimalText("40.5", 2).value).toBe(40.5);
  });

  it("keeps an unfinished separator and does not turn it into zero", () => {
    expect(parseDecimalText("0,", 4)).toMatchObject({ text: "0,", value: null, complete: false, empty: false });
    expect(parseDecimalText("0.", 4)).toMatchObject({ text: "0.", value: null, complete: false });
    expect(parseDecimalText("", 4)).toMatchObject({ empty: true, value: null });
  });

  it("rejects extra fraction digits without cutting them", () => {
    const draft = parseDecimalText("1,23456", 4);
    expect(draft.error).toBe("precision");
    expect(draft.value).toBeNull();
    expect(draft.text).toBe("1,23456");
  });

  it("rejects a second separator and a minus", () => {
    expect(parseDecimalText("1,2,3", 4).error).toBe("invalid");
    expect(parseDecimalText("-1", 4).error).toBe("negative");
  });

  it("formats a stored number with a comma and without trailing zeros", () => {
    expect(formatMeasured(0.72, 4)).toBe("0,72");
    expect(formatMeasured(2.4, 4)).toBe("2,4");
    expect(formatMeasured(0.0001, 4)).toBe("0,0001");
  });

  it("refuses more fraction digits than the column allows", () => {
    expect(() => assertMaxFractionDigits(1.23456, 4, "too fine")).toThrow("too fine");
    expect(() => assertMaxFractionDigits(0.72, 4, "too fine")).not.toThrow();
    expect(() => assertMaxFractionDigits(40.55, 2, "section")).not.toThrow();
    expect(() => assertMaxFractionDigits(40.555, 2, "section")).toThrow("section");
  });
});

describe("exactMoneyString", () => {
  it("keeps kopecks and pads to two places without rounding to a ruble", () => {
    expect(exactMoneyString(0.35)).toBe("0.35");
    expect(exactMoneyString(10.5)).toBe("10.50");
    expect(exactMoneyString(1999.5)).toBe("1999.50");
    expect(exactMoneyString(0)).toBe("0.00");
  });

  it("rejects a third decimal digit instead of rounding it", () => {
    expect(() => exactMoneyString(10.556)).toThrow(/2 знаков/);
    expect(() => exactMoneyString(0.369)).toThrow(/2 знаков/);
  });
});

describe("parsePositiveIntDraft", () => {
  it("accepts a positive integer and rejects fractions", () => {
    expect(parsePositiveIntDraft("12")).toMatchObject({ value: 12, complete: true, error: null });
    expect(parsePositiveIntDraft("1,5").error).toBe("fraction");
    expect(parsePositiveIntDraft("1.5").error).toBe("fraction");
    expect(parsePositiveIntDraft("1,5").value).toBeNull();
    expect(parsePositiveIntDraft("").empty).toBe(true);
  });
});
