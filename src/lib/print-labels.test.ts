import { describe, expect, it } from "vitest";
import { codeFontSizePt } from "./print-labels";

describe("codeFontSizePt", () => {
  it("короткий код — максимальный кегль (22pt)", () => {
    expect(codeFontSizePt("ПАК-24-1")).toBe(22);
  });

  it("базовый код ПАК-24-569-01 (13 симв.) уже уменьшается, но не сильно", () => {
    const pt = codeFontSizePt("ПАК-24-569-01");
    expect(pt).toBeLessThanOrEqual(22);
    expect(pt).toBeGreaterThan(14);
  });

  it("код с суффиксом коллизии длиннее — шрифт мельче, но не ниже минимума", () => {
    const shortCode = codeFontSizePt("ПАК-24-569-01");
    const longCode = codeFontSizePt("ПАК-24-569-01-2");
    expect(longCode).toBeLessThan(shortCode);
    expect(longCode).toBeGreaterThanOrEqual(9);
  });

  it("очень длинный код не уходит ниже минимума читаемости (9pt)", () => {
    expect(codeFontSizePt("ПАК-24-123456789-01-999")).toBe(9);
  });

  it("монотонно убывает с длиной кода", () => {
    const sizes = ["A", "AB", "ABC", "ABCD", "ABCDE", "ABCDEF"].map(codeFontSizePt);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeLessThanOrEqual(sizes[i - 1]);
    }
  });
});
