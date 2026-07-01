import { describe, expect, it } from "vitest";
import { computeSupplyDeduction } from "@/lib/supply-stock";

describe("computeSupplyDeduction", () => {
  it("списывает целиком при достатке остатка", () => {
    expect(
      computeSupplyDeduction({ targetQty: 10, alreadyDeducted: 0, alreadyShort: 0, available: 50 }),
    ).toEqual({ toRemove: 10, shortfall: 0, newDeducted: 10, newShort: 0 });
  });

  it("недостача при нехватке остатка (в минус не уходим)", () => {
    expect(
      computeSupplyDeduction({ targetQty: 10, alreadyDeducted: 0, alreadyShort: 0, available: 3 }),
    ).toEqual({ toRemove: 3, shortfall: 7, newDeducted: 3, newShort: 7 });
  });

  it("нулевой остаток → всё в недостачу", () => {
    expect(
      computeSupplyDeduction({ targetQty: 5, alreadyDeducted: 0, alreadyShort: 0, available: 0 }),
    ).toEqual({ toRemove: 0, shortfall: 5, newDeducted: 0, newShort: 5 });
  });

  it("идемпотентность: повторная синхронизация без изменений ничего не списывает", () => {
    expect(
      computeSupplyDeduction({ targetQty: 10, alreadyDeducted: 10, alreadyShort: 0, available: 50 }),
    ).toEqual({ toRemove: 0, shortfall: 0, newDeducted: 10, newShort: 0 });
  });

  it("учтённая недостача не списывается повторно", () => {
    // раньше: списано 3, недостача 7. Остаток пополнился до 100, target тот же.
    expect(
      computeSupplyDeduction({ targetQty: 10, alreadyDeducted: 3, alreadyShort: 7, available: 100 }),
    ).toEqual({ toRemove: 0, shortfall: 0, newDeducted: 3, newShort: 7 });
  });

  it("дозакрывает только увеличение target", () => {
    // было учтено 10 (все списаны), target вырос до 15, остаток есть.
    expect(
      computeSupplyDeduction({ targetQty: 15, alreadyDeducted: 10, alreadyShort: 0, available: 50 }),
    ).toEqual({ toRemove: 5, shortfall: 0, newDeducted: 15, newShort: 0 });
  });

  it("target=0 (не отгружено) — ничего не делаем", () => {
    expect(
      computeSupplyDeduction({ targetQty: 0, alreadyDeducted: 0, alreadyShort: 0, available: 50 }),
    ).toEqual({ toRemove: 0, shortfall: 0, newDeducted: 0, newShort: 0 });
  });
});
