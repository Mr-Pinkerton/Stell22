import { describe, expect, it } from "vitest";
import { isOverRailLength, maxDetailQuantity, sumDetailLengthM } from "./torcovka";

describe("sumDetailLengthM", () => {
  it("суммирует длины по количеству", () => {
    expect(
      sumDetailLengthM([
        { quantity: 2, lengthM: 0.6 },
        { quantity: 1, lengthM: 0.72 },
      ]),
    ).toBe(1.92);
  });
});

describe("maxDetailQuantity", () => {
  const picks = [{ quantity: 2, lengthM: 0.6 }]; // 1.2 м занято

  it("возвращает floor от оставшейся длины", () => {
    expect(
      maxDetailQuantity({
        takenLengthM: 2.4,
        picks,
        lengthM: 0.72,
      }),
    ).toBe(1); // (2.4 - 1.2) / 0.72 = 1
  });

  it("не учитывает текущую длину в занятой длине", () => {
    expect(
      maxDetailQuantity({
        takenLengthM: 2.4,
        picks: [...picks, { quantity: 1, lengthM: 0.72 }],
        lengthM: 0.72,
      }),
    ).toBe(1); // qty той же длины не вычитается: (2.4 - 1.2) / 0.72 = 1
  });

  it("0 при нулевой взятой длине", () => {
    expect(
      maxDetailQuantity({
        takenLengthM: 0,
        picks: [],
        lengthM: 0.6,
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
