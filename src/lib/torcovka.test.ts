import { describe, expect, it } from "vitest";
import { isOverRailLength, maxDetailQuantity, sumDetailLengthM } from "./torcovka";

describe("sumDetailLengthM", () => {
  it("суммирует длины по количеству", () => {
    expect(
      sumDetailLengthM([
        { detailId: "a", quantity: 2, lengthM: 0.6 },
        { detailId: "b", quantity: 1, lengthM: 0.72 },
      ]),
    ).toBe(1.92);
  });
});

describe("maxDetailQuantity", () => {
  const picks = [{ detailId: "a", quantity: 2, lengthM: 0.6 }]; // 1.2 м занято

  it("возвращает floor от оставшейся длины", () => {
    expect(
      maxDetailQuantity({
        takenLengthM: 2.4,
        picks,
        detailId: "b",
        detailLengthM: 0.6,
      }),
    ).toBe(2); // (2.4 - 1.2) / 0.6 = 2
  });

  it("не учитывает текущую деталь в занятой длине", () => {
    expect(
      maxDetailQuantity({
        takenLengthM: 2.4,
        picks: [...picks, { detailId: "b", quantity: 1, lengthM: 0.6 }],
        detailId: "b",
        detailLengthM: 0.6,
      }),
    ).toBe(3); // (2.4 - 1.2) / 0.6 — qty b не вычитается
  });

  it("0 при нулевой взятой длине", () => {
    expect(
      maxDetailQuantity({
        takenLengthM: 0,
        picks: [],
        detailId: "a",
        detailLengthM: 0.6,
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
