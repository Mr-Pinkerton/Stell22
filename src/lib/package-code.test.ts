import { describe, expect, it } from "vitest";
import {
  allocatePackageCode,
  packageCodeBase,
  packageLengthPart,
  packageSortPart,
} from "./package-code";

describe("packageLengthPart", () => {
  it("кодирует длину в дециметрах, 2 цифры", () => {
    expect(packageLengthPart(2.4)).toBe("24");
    expect(packageLengthPart(3)).toBe("30");
    expect(packageLengthPart(0.6)).toBe("06");
  });
});

describe("packageSortPart", () => {
  it("сорт 2 цифры", () => {
    expect(packageSortPart("SORT1")).toBe("01");
    expect(packageSortPart("SORT2")).toBe("02");
  });
});

describe("packageCodeBase", () => {
  it("собирает ПАК-длина-кол-во-сорт", () => {
    expect(packageCodeBase(2.4, 569, "SORT1")).toBe("ПАК-24-569-01");
    expect(packageCodeBase(3, 100, "SORT2")).toBe("ПАК-30-100-02");
  });
});

describe("allocatePackageCode", () => {
  it("добавляет суффикс при коллизии", () => {
    const used = new Set<string>();
    expect(allocatePackageCode(2.4, 569, "SORT1", used)).toBe("ПАК-24-569-01");
    expect(allocatePackageCode(2.4, 569, "SORT1", used)).toBe("ПАК-24-569-01-2");
    expect(allocatePackageCode(2.4, 300, "SORT2", used)).toBe("ПАК-24-300-02");
  });
});
