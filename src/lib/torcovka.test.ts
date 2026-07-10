import { describe, expect, it } from "vitest";
import { isOverRailLength, maxDetailQuantity, sumDetailLengthM } from "./torcovka";

describe("sumDetailLengthM", () => {
  it("суммирует длины по количеству (по всем сортам)", () => {
    expect(
      sumDetailLengthM([
        { quantity: 2, lengthM: 0.6, sort: "SORT1" },
        { quantity: 1, lengthM: 0.72, sort: "SORT2" },
      ]),
    ).toBe(1.92);
  });
});

describe("maxDetailQuantity", () => {
  const picks: { quantity: number; lengthM: number; sort: "SORT1" | "SORT2" }[] = [
    { quantity: 2, lengthM: 0.6, sort: "SORT1" }, // 1.2 м занято
  ];

  it("возвращает floor от оставшейся длины", () => {
    expect(
      maxDetailQuantity({
        takenLengthM: 2.4,
        picks,
        lengthM: 0.72,
        sort: "SORT1",
      }),
    ).toBe(1); // (2.4 - 1.2) / 0.72 = 1
  });

  it("не учитывает текущую комбинацию длина+сорт в занятой длине", () => {
    expect(
      maxDetailQuantity({
        takenLengthM: 2.4,
        picks: [...picks, { quantity: 1, lengthM: 0.72, sort: "SORT1" }],
        lengthM: 0.72,
        sort: "SORT1",
      }),
    ).toBe(1); // qty той же длины+сорта не вычитается: (2.4 - 1.2) / 0.72 = 1
  });

  it("другой сорт той же длины вычитается из общего материала", () => {
    expect(
      maxDetailQuantity({
        takenLengthM: 2.4,
        picks: [...picks, { quantity: 1, lengthM: 0.72, sort: "SORT2" }],
        lengthM: 0.72,
        sort: "SORT1",
      }),
    ).toBe(0); // занято 1.2 + 0.72 = 1.92; остаток 0.48 < 0.72 → 0
  });

  it("0 при нулевой взятой длине", () => {
    expect(
      maxDetailQuantity({
        takenLengthM: 0,
        picks: [],
        lengthM: 0.6,
        sort: "SORT1",
      }),
    ).toBe(0);
  });
});

describe("isOverRailLength", () => {
  it("true когда детали длиннее реек", () => {
    expect(isOverRailLength(2.4, 2.41)).toBe(true);
  });

  it("false при равной или меньшей длине", () => {
    expect(isOverRailLength(2.4, 2.4)).toBe(false);
    expect(isOverRailLength(2.4, 2.0)).toBe(false);
  });
});
