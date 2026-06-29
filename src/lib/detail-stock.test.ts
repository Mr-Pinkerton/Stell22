import { describe, expect, it } from "vitest";
import { buildStockSnapshot, isReady, type DetailStockRow } from "@/lib/detail-stock";
import type { Detail } from "@/types/domain";

function detail(over: Partial<Detail>): Detail {
  return {
    id: "d",
    name: "Деталь",
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

describe("buildStockSnapshot", () => {
  it("суммирует готовые детали (без присадок) в detailsReady", () => {
    const d = detail({ id: "d1" });
    const rows: DetailStockRow[] = [
      { detailId: "d1", torcevayaDone: false, ploskostDone: false, quantity: 10 },
      { detailId: "d1", torcevayaDone: false, ploskostDone: false, quantity: 5 },
    ];
    const snap = buildStockSnapshot([d], rows);
    expect(snap.detailsReady.d1).toBe(15);
    expect(snap.prisadkaPending.d1).toBeUndefined();
  });

  it("деталь с обеими присадками на сырой стадии ждёт оба типа", () => {
    const d = detail({ id: "d2", prisadkaTorcevaya: true, prisadkaPloskost: true });
    const rows: DetailStockRow[] = [
      { detailId: "d2", torcevayaDone: false, ploskostDone: false, quantity: 8 },
    ];
    const snap = buildStockSnapshot([d], rows);
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

  it("игнорирует нулевые и неизвестные строки, пробрасывает склад номенклатуры", () => {
    const d = detail({ id: "d4" });
    const rows: DetailStockRow[] = [
      { detailId: "d4", torcevayaDone: false, ploskostDone: false, quantity: 0 },
      { detailId: "unknown", torcevayaDone: false, ploskostDone: false, quantity: 9 },
    ];
    const snap = buildStockSnapshot([d], rows, { "nom-1": 100 });
    expect(snap.detailsReady.d4).toBeUndefined();
    expect(snap.nomenclature).toEqual({ "nom-1": 100 });
  });
});
