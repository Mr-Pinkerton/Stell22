import { describe, it, expect } from "vitest";
import {
  dayKeyInProjectTz,
  formatDateTime,
  formatGroupedInteger,
  formatIsoDateTime,
  formatLength,
  formatMoney,
  formatMoneyDecimal,
  formatProductSku,
  parseGroupedInteger,
  parseGroupedMoney,
  roundCashTo100,
} from "@/lib/format";

const clean = (s: string) => s.replace(/[\s\u00a0\u202f]/g, " ");

describe("formatProductSku", () => {
  it("показывает оба артикула, когда они различаются", () => {
    expect(formatProductSku("OZ-1", "WB-1")).toBe("OZ OZ-1 · WB WB-1");
  });

  it("схлопывает одинаковые артикулы в один", () => {
    expect(formatProductSku("ART-1", "ART-1")).toBe("ART-1");
  });

  it("опускает пустой артикул", () => {
    expect(formatProductSku("OZ-1", "")).toBe("OZ OZ-1");
    expect(formatProductSku("", "WB-1")).toBe("WB WB-1");
  });

  it("отдаёт «—», если артикулов нет", () => {
    expect(formatProductSku("", "")).toBe("—");
  });
});

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

describe("formatMoneyDecimal (копейки, когда есть)", () => {
  it("показывает копейки дешёвых позиций", () => {
    expect(clean(formatMoneyDecimal(0.36))).toBe("0,36 ₽");
  });
  it("целые — без копеек", () => {
    expect(clean(formatMoneyDecimal(35))).toBe("35 ₽");
  });
  it("тысячи с группировкой и одним знаком", () => {
    expect(clean(formatMoneyDecimal(1234.5))).toBe("1 234,5 ₽");
  });
});

describe("parseGroupedMoney (ввод с копейками)", () => {
  it("decimals=0 — как целое поле", () => {
    const r = parseGroupedMoney("1 234 ₽", 0);
    expect(clean(r.text)).toBe("1 234");
    expect(r.value).toBe(1234);
    expect(parseGroupedMoney("", 0)).toEqual({ text: "", value: null });
  });

  it("принимает 0,36 (запятая)", () => {
    const r = parseGroupedMoney("0,36", 2);
    expect(r.value).toBe(0.36);
    expect(r.text).toBe("0,36");
  });

  it("принимает точку как разделитель", () => {
    expect(parseGroupedMoney("0.36", 2).value).toBe(0.36);
  });

  it("ограничивает копейки до decimals знаков", () => {
    expect(parseGroupedMoney("0,369", 2).value).toBe(0.36);
  });

  it("сохраняет промежуточный ввод «0,»", () => {
    expect(parseGroupedMoney("0,", 2)).toEqual({ text: "0,", value: 0 });
  });

  it("группирует целую часть, сохраняя дробную", () => {
    const r = parseGroupedMoney("1234,5", 2);
    expect(clean(r.text)).toBe("1 234,5");
    expect(r.value).toBe(1234.5);
  });

  it("пусто → null", () => {
    expect(parseGroupedMoney("", 2)).toEqual({ text: "", value: null });
  });
});
