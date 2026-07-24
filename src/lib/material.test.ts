import { describe, expect, it } from "vitest";
import { materialLabel, sectionLabel } from "./material";

describe("sectionLabel", () => {
  it("форматирует сечение как ШхВ", () => {
    expect(sectionLabel({ sectionWidthMm: 40, sectionHeightMm: 20 })).toBe("40×20");
  });
  it("пусто, если сечение не задано", () => {
    expect(sectionLabel({ sectionWidthMm: null, sectionHeightMm: 20 })).toBe("");
    expect(sectionLabel({ sectionWidthMm: 40, sectionHeightMm: null })).toBe("");
  });
});

describe("materialLabel", () => {
  it("порода + сечение", () => {
    expect(
      materialLabel({ name: "Хвоя", sectionWidthMm: 40, sectionHeightMm: 20 }),
    ).toBe("Хвоя 40×20");
  });
  it("только название без сечения", () => {
    expect(
      materialLabel({ name: "Хвоя", sectionWidthMm: null, sectionHeightMm: null }),
    ).toBe("Хвоя");
  });
});
