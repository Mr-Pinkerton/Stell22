import { describe, expect, it } from "vitest";
import {
  allocate,
  buildStockSnapshot,
  isReady,
  type BlankStockRow,
  type DetailStockRow,
} from "@/lib/detail-stock";
import type { Detail } from "@/types/domain";

function detail(over: Partial<Detail>): Detail {
  return {
    id: "d",
    name: "Деталь",
    materialId: "mat-1",
    detailNumber: 1,
    lengthM: 0.6,
    detailType: "POLKA",
    sort: "SORT1",
    prisadkaTorcevaya: false,
    prisadkaPloskost: false,
    status: "ACTIVE",
    ...over,
  };
}

describe("isReady", () => {
  it("деталь без присадок готова сразу", () => {
    expect(isReady(detail({}), false, false)).toBe(true);
  });

  it("деталь с торцевой готова только после торцевой", () => {
    const d = detail({ prisadkaTorcevaya: true });
    expect(isReady(d, false, false)).toBe(false);
    expect(isReady(d, true, false)).toBe(true);
  });

  it("деталь с обеими присадками готова только когда обе выполнены", () => {
    const d = detail({ prisadkaTorcevaya: true, prisadkaPloskost: true });
    expect(isReady(d, true, false)).toBe(false);
    expect(isReady(d, false, true)).toBe(false);
    expect(isReady(d, true, true)).toBe(true);
  });
});

describe("allocate", () => {
  it("берёт из первых строк по порядку", () => {
    expect(allocate([5, 5, 5], 7)).toEqual([5, 2, 0]);
  });

  it("точное совпадение опустошает строки", () => {
    expect(allocate([3, 4], 7)).toEqual([3, 4]);
  });

  it("нулевая потребность — ничего не берём", () => {
    expect(allocate([10], 0)).toEqual([0]);
  });

  it("бросает при нехватке остатка", () => {
    expect(() => allocate([2, 2], 5)).toThrow("Недостаточно остатка");
  });
});

describe("buildStockSnapshot", () => {
  it("заготовки складываются по ключу; деталь без присадок годна из заготовки", () => {
    const d = detail({ id: "d1", lengthM: 0.6, detailType: "POLKA", sort: "SORT1" });
    const blanks: BlankStockRow[] = [
      { materialId: "mat-1", lengthM: 0.6, detailType: "POLKA", sort: "SORT1", quantity: 10 },
      { materialId: "mat-1", lengthM: 0.6, detailType: "POLKA", sort: "SORT1", quantity: 5 },
    ];
    const snap = buildStockSnapshot([d], [], blanks);
    expect(snap.blanks["mat-1|0.6000|POLKA|SORT1"]).toBe(15);
    expect(snap.detailsReady.d1).toBe(15);
    expect(snap.prisadkaPending.d1).toBeUndefined();
  });

  it("деталь с обеими присадками: заготовка спецификации ждёт оба типа", () => {
    const d = detail({ id: "d2", prisadkaTorcevaya: true, prisadkaPloskost: true });
    const blanks: BlankStockRow[] = [
      { materialId: "mat-1", lengthM: 0.6, detailType: "POLKA", sort: "SORT1", quantity: 8 },
    ];
    const snap = buildStockSnapshot([d], [], blanks);
    expect(snap.detailsReady.d2).toBeUndefined();
    expect(snap.prisadkaPending.d2).toEqual({ torcev: 8, plosk: 8 });
  });

  it("после торцевой остаётся ждать только плоскостную", () => {
    const d = detail({ id: "d3", prisadkaTorcevaya: true, prisadkaPloskost: true });
    const rows: DetailStockRow[] = [
      { detailId: "d3", torcevayaDone: true, ploskostDone: false, quantity: 4 },
      { detailId: "d3", torcevayaDone: true, ploskostDone: true, quantity: 3 },
    ];
    const snap = buildStockSnapshot([d], rows);
    expect(snap.prisadkaPending.d3).toEqual({ torcev: 0, plosk: 4 });
    expect(snap.detailsReady.d3).toBe(3);
  });

  it("заготовки одной спецификации, но разных материалов, не смешиваются", () => {
    const hvoya = detail({ id: "dh", materialId: "mat-hvoya", lengthM: 0.6, detailType: "POLKA", sort: "SORT1" });
    const bereza = detail({ id: "db", materialId: "mat-bereza", lengthM: 0.6, detailType: "POLKA", sort: "SORT1" });
    const blanks: BlankStockRow[] = [
      { materialId: "mat-hvoya", lengthM: 0.6, detailType: "POLKA", sort: "SORT1", quantity: 10 },
      { materialId: "mat-bereza", lengthM: 0.6, detailType: "POLKA", sort: "SORT1", quantity: 3 },
    ];
    const snap = buildStockSnapshot([hvoya, bereza], [], blanks);
    // Отдельные ключи и раздельные остатки по материалу.
    expect(snap.blanks["mat-hvoya|0.6000|POLKA|SORT1"]).toBe(10);
    expect(snap.blanks["mat-bereza|0.6000|POLKA|SORT1"]).toBe(3);
    // Деталь без присадок берёт заготовки только своего материала.
    expect(snap.detailsReady.dh).toBe(10);
    expect(snap.detailsReady.db).toBe(3);
  });

  it("игнорирует нулевые строки, пробрасывает склад номенклатуры", () => {
    const d = detail({ id: "d4" });
    const rows: DetailStockRow[] = [];
    const blanks: BlankStockRow[] = [
      { materialId: "mat-1", lengthM: 0.6, detailType: "POLKA", sort: "SORT1", quantity: 0 },
    ];
    const snap = buildStockSnapshot([d], rows, blanks, { "nom-1": 100 });
    expect(snap.detailsReady.d4).toBeUndefined();
    expect(snap.nomenclature).toEqual({ "nom-1": 100 });
  });
});
