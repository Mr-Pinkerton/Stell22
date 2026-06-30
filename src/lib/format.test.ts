import { describe, it, expect } from "vitest";
import {
  dayKeyInProjectTz,
  formatDateTime,
  formatGroupedInteger,
  formatIsoDateTime,
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

describe("formatDateTime / formatIsoDateTime (UTC+3)", () => {
  it("показывает дату-время в зоне проекта (UTC+3)", () => {
    // 2026-06-30T10:00:00Z → 13:00 по Москве.
    const d = new Date("2026-06-30T10:00:00.000Z");
    expect(formatDateTime(d)).toBe("30.06.2026, 13:00");
  });

  it("formatIsoDateTime разбирает ISO и применяет зону", () => {
    expect(formatIsoDateTime("2026-06-30T21:30:00.000Z")).toBe("01.07.2026, 00:30");
  });

  it("пустую/битую строку отдаёт как есть", () => {
    expect(formatIsoDateTime(null)).toBe("");
    expect(formatIsoDateTime("")).toBe("");
    expect(formatIsoDateTime("не дата")).toBe("не дата");
  });
});

describe("dayKeyInProjectTz", () => {
  it("ключ дня в зоне проекта учитывает сдвиг UTC+3", () => {
    // 23:30 UTC = 02:30 следующего дня по Москве.
    expect(dayKeyInProjectTz("2026-06-30T23:30:00.000Z")).toBe("2026-07-01");
    expect(dayKeyInProjectTz("2026-06-30T10:00:00.000Z")).toBe("2026-06-30");
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
