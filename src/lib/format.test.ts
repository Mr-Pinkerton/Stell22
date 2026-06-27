import { describe, it, expect } from "vitest";
import {
  formatGroupedInteger,
  formatLength,
  formatMoney,
  parseGroupedInteger,
  roundCashTo100,
} from "@/lib/format";

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

describe("formatMoney", () => {
  it("без копеек, с разделителем тысяч и символом ₽", () => {
    const formatted = formatMoney(1234567);
    expect(formatted).toMatch(/1[\s\u00a0\u202f]?234[\s\u00a0\u202f]?567/);
    expect(formatted).not.toMatch(/,\d{2}/);
    expect(formatted).toContain("₽");
  });
});

describe("formatGroupedInteger / parseGroupedInteger", () => {
  it("форматирует тысячи пробелом", () => {
    expect(formatGroupedInteger(150000)).toMatch(/150[\s\u00a0\u202f]000/);
  });

  it("парсит строку поля, игнорируя пробелы и символы", () => {
    expect(parseGroupedInteger("1 234 567 ₽")).toBe(1234567);
    expect(parseGroupedInteger("")).toBeNull();
  });

  it("round-trip для поля ввода", () => {
    const n = 9876543;
    expect(parseGroupedInteger(formatGroupedInteger(n))).toBe(n);
  });
});
