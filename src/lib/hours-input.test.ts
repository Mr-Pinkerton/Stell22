import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  HOURS_NO_RATE_MESSAGE,
  HOURS_STEP_MESSAGE,
  applyHoursKeypadChange,
  assertValidHours,
  formatHoursRu,
  isHourlyRateUnavailable,
  isValidHoursStep,
} from "./hours-input";

describe("isValidHoursStep", () => {
  it("accepts half-hour steps", () => {
    expect(isValidHoursStep(0.5)).toBe(true);
    expect(isValidHoursStep(1)).toBe(true);
    expect(isValidHoursStep(1.5)).toBe(true);
    expect(isValidHoursStep(7.5)).toBe(true);
  });

  it("rejects non-positive and non-half values", () => {
    expect(isValidHoursStep(0)).toBe(false);
    expect(isValidHoursStep(-0.5)).toBe(false);
    expect(isValidHoursStep(1.25)).toBe(false);
    expect(isValidHoursStep(1.1)).toBe(false);
    expect(isValidHoursStep(2.25)).toBe(false);
  });
});

describe("assertValidHours", () => {
  it("throws on missing or invalid hours", () => {
    expect(() => assertValidHours(0)).toThrow("Укажите количество часов");
    expect(() => assertValidHours(-1)).toThrow("Укажите количество часов");
    expect(() => assertValidHours(1.25)).toThrow(HOURS_STEP_MESSAGE);
  });

  it("allows 0.5 and 7.5", () => {
    expect(() => assertValidHours(0.5)).not.toThrow();
    expect(() => assertValidHours(7.5)).not.toThrow();
  });
});

describe("isHourlyRateUnavailable", () => {
  it("treats null, undefined, zero, and negative as unavailable", () => {
    expect(isHourlyRateUnavailable(null)).toBe(true);
    expect(isHourlyRateUnavailable(undefined)).toBe(true);
    expect(isHourlyRateUnavailable(0)).toBe(true);
    expect(isHourlyRateUnavailable(-1)).toBe(true);
    expect(isHourlyRateUnavailable(300)).toBe(false);
  });

  it("is Decimal-safe for locked snapshots", () => {
    expect(isHourlyRateUnavailable(new Decimal(0))).toBe(true);
    expect(isHourlyRateUnavailable(new Decimal(-1))).toBe(true);
    expect(isHourlyRateUnavailable(new Decimal(300))).toBe(false);
  });
});

describe("applyHoursKeypadChange", () => {
  it("clears whole hours and the half-hour on empty input (C)", () => {
    expect(applyHoursKeypadChange({ whole: 0, half: true }, "")).toEqual({
      whole: 0,
      half: false,
    });
    expect(applyHoursKeypadChange({ whole: 1, half: true }, "")).toEqual({
      whole: 0,
      half: false,
    });
    expect(applyHoursKeypadChange({ whole: 7, half: true }, "")).toEqual({
      whole: 0,
      half: false,
    });
  });

  it("preserves the half-hour when digits remain", () => {
    expect(applyHoursKeypadChange({ whole: 1, half: true }, "2")).toEqual({
      whole: 2,
      half: true,
    });
    expect(applyHoursKeypadChange({ whole: 0, half: false }, "2")).toEqual({
      whole: 2,
      half: false,
    });
  });
});

describe("formatHoursRu", () => {
  it("uses a comma for the half hour", () => {
    expect(formatHoursRu(0.5)).toBe("0,5");
    expect(formatHoursRu(1)).toBe("1");
    expect(formatHoursRu(7.5)).toBe("7,5");
  });
});

describe("HOURS_NO_RATE_MESSAGE", () => {
  it("is the owner-facing copy", () => {
    expect(HOURS_NO_RATE_MESSAGE).toBe("Почасовая ставка не задана");
  });
});
