import { describe, expect, it } from "vitest";
import {
  allocatePackageCode,
  packageCodeBase,
  packageDatePart,
  packageLengthPart,
} from "./package-code";

describe("packageDatePart", () => {
  it("кодирует день и месяц как DDMM (Europe/Moscow)", () => {
    expect(packageDatePart(new Date("2026-06-30T12:00:00Z"))).toBe("3006");
    expect(packageDatePart(new Date("2026-01-05T12:00:00Z"))).toBe("0501");
  });
});

describe("packageLengthPart", () => {
  it("округляет длину до целых метров, 2 цифры", () => {
    expect(packageLengthPart(3)).toBe("03");
    expect(packageLengthPart(2.4)).toBe("02");
    expect(packageLengthPart(0.6)).toBe("01");
  });
});

describe("packageCodeBase", () => {
  it("собирает ПАК-DDMM-LL", () => {
    expect(packageCodeBase(3, new Date("2026-06-30T12:00:00Z"))).toBe("ПАК-3006-03");
  });
});

describe("allocatePackageCode", () => {
  it("добавляет суффикс при коллизии", () => {
    const used = new Set<string>();
    const date = new Date("2026-06-30T12:00:00Z");
    expect(allocatePackageCode(3, date, used)).toBe("ПАК-3006-03");
    expect(allocatePackageCode(3, date, used)).toBe("ПАК-3006-03-2");
    expect(allocatePackageCode(2.4, date, used)).toBe("ПАК-3006-02");
  });
});
