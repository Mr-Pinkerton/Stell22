import { describe, it, expect } from "vitest";
import { roundCashTo100, formatLength } from "@/lib/format";

describe("roundCashTo100", () => {
  it("округляет вниз при остатке меньше 50", () => {
    expect(roundCashTo100(1249)).toBe(1200);
  });

  it("округляет вверх при остатке 50 и более", () => {
    expect(roundCashTo100(1250)).toBe(1300);
    expect(roundCashTo100(1280)).toBe(1300);
  });

  it("не меняет кратные 100", () => {
    expect(roundCashTo100(1300)).toBe(1300);
  });
});

describe("formatLength", () => {
  it("добавляет единицу измерения", () => {
    expect(formatLength(2.4)).toContain("м");
  });
});
