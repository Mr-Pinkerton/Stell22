import { describe, expect, it } from "vitest";
import { D } from "./cost";
import {
  COST_FLOW_UNINITIALIZED_VERSION,
  allocatePersistenceShares,
  allocateRailLotValues,
  bootstrapRawTransfer,
  canExactMonetaryReverse,
  componentTotal,
  consumeRailValue,
  eventComponentsValid,
  isMonetaryPoolInitialized,
  remainingLotValue,
  wacConsume,
  wacReceive,
} from "./cost-foundation";

function comps(material: number | string, labor = 0, nomenclature = 0) {
  return { material: D(material), labor: D(labor), nomenclature: D(nomenclature) };
}

describe("componentTotal / COMP-001", () => {
  it("sums material + labor + nomenclature in Decimal", () => {
    expect(componentTotal(comps(80_000, 20_000, 15)).equals(D(100_015))).toBe(true);
  });

  it("does not use JS number as money SoT (0.1 + 0.2)", () => {
    expect(0.1 + 0.2 === 0.3).toBe(false);
    const total = componentTotal({
      material: D("0.1"),
      labor: D("0.2"),
      nomenclature: D(0),
    });
    expect(total.equals(D("0.3"))).toBe(true);
  });
});

describe("EVENT-001", () => {
  it("accepts CostEvent payload when total equals component sum", () => {
    expect(eventComponentsValid({ ...comps(10, 4, 1), totalValue: D(15) })).toBe(true);
  });

  it("rejects drifted total", () => {
    expect(eventComponentsValid({ ...comps(10, 4, 1), totalValue: D(16) })).toBe(false);
  });
});

describe("transitional uninitialized pool", () => {
  it("costVersion 0 is not initialized — NULL/zero is not factual cost", () => {
    expect(isMonetaryPoolInitialized(COST_FLOW_UNINITIALIZED_VERSION)).toBe(false);
    expect(isMonetaryPoolInitialized(0)).toBe(false);
  });

  it("costVersion > 0 is the explicit initialized state", () => {
    expect(isMonetaryPoolInitialized(1)).toBe(true);
  });
});

describe("wacReceive", () => {
  it("adds qty and every component; total is the sum", () => {
    const next = wacReceive(
      { qty: 10, ...comps(8000, 2000, 0) },
      { qty: 5, ...comps(4000, 1000, 50) },
    );
    expect(next.qty.equals(D(15))).toBe(true);
    expect(next.material.equals(D(12_000))).toBe(true);
    expect(next.labor.equals(D(3000))).toBe(true);
    expect(next.nomenclature.equals(D(50))).toBe(true);
    expect(next.totalValue.equals(D(15_050))).toBe(true);
  });

  it("rejects non-positive receipt qty", () => {
    expect(() =>
      wacReceive({ qty: 10, ...comps(1) }, { qty: 0, ...comps(0) }),
    ).toThrow(/INVALID_RECEIVE/);
  });

  it("rejects negative stock or value", () => {
    expect(() =>
      wacReceive({ qty: -1, ...comps(0) }, { qty: 1, ...comps(1) }),
    ).toThrow(/NEGATIVE/);
    expect(() =>
      wacReceive({ qty: 1, ...comps(-1) }, { qty: 1, ...comps(1) }),
    ).toThrow(/NEGATIVE/);
  });
});

describe("wacConsume", () => {
  it("proportional consume: 10 of 100 with mixed components (architecture example)", () => {
    const out = wacConsume({ qty: 100, ...comps(80_000, 20_000, 0) }, 10);
    expect(out.taken.qty.equals(D(10))).toBe(true);
    expect(out.taken.material.equals(D(8000))).toBe(true);
    expect(out.taken.labor.equals(D(2000))).toBe(true);
    expect(out.taken.nomenclature.equals(D(0))).toBe(true);
    expect(out.remaining.qty.equals(D(90))).toBe(true);
    expect(out.remaining.material.equals(D(72_000))).toBe(true);
    expect(out.remaining.labor.equals(D(18_000))).toBe(true);
    expect(out.remaining.totalValue.equals(D(90_000))).toBe(true);
  });

  it("last-unit consume takes the exact residual of EVERY component", () => {
    const first = wacConsume({ qty: 3, ...comps(100, 10, 1) }, 1);
    const second = wacConsume(first.remaining, 1);
    const last = wacConsume(second.remaining, second.remaining.qty);
    expect(last.remaining.qty.equals(D(0))).toBe(true);
    expect(last.remaining.material.equals(D(0))).toBe(true);
    expect(last.remaining.labor.equals(D(0))).toBe(true);
    expect(last.remaining.nomenclature.equals(D(0))).toBe(true);
    const sumM = first.taken.material.plus(second.taken.material).plus(last.taken.material);
    const sumL = first.taken.labor.plus(second.taken.labor).plus(last.taken.labor);
    const sumN = first.taken.nomenclature.plus(second.taken.nomenclature).plus(last.taken.nomenclature);
    expect(sumM.equals(D(100))).toBe(true);
    expect(sumL.equals(D(10))).toBe(true);
    expect(sumN.equals(D(1))).toBe(true);
  });

  it("STOCK-002: qty 0 ⇒ all remaining components 0", () => {
    const out = wacConsume({ qty: 7, ...comps(21, 14, 7) }, 7);
    expect(out.remaining.qty.equals(D(0))).toBe(true);
    expect(out.remaining.material.equals(D(0))).toBe(true);
    expect(out.remaining.labor.equals(D(0))).toBe(true);
    expect(out.remaining.nomenclature.equals(D(0))).toBe(true);
    expect(out.remaining.totalValue.equals(D(0))).toBe(true);
  });

  it("rejects dq <= 0", () => {
    expect(() => wacConsume({ qty: 5, ...comps(10) }, 0)).toThrow(/INVALID_CONSUME/);
    expect(() => wacConsume({ qty: 5, ...comps(10) }, -1)).toThrow(/INVALID_CONSUME/);
  });

  it("rejects overdraw dq > qty", () => {
    expect(() => wacConsume({ qty: 5, ...comps(10) }, 6)).toThrow(/OVERDRAW/);
  });

  it("rejects negative stock/value", () => {
    expect(() => wacConsume({ qty: 5, material: D(-1), labor: D(0), nomenclature: D(0) }, 1)).toThrow(
      /NEGATIVE/,
    );
  });
});

describe("wacConsume storage-scale 1/3 regression", () => {
  it("qty 3 material 1 labor 1 consume 1: q6 out + exact residual; per-component conservation", () => {
    const original = { qty: 3, ...comps(1, 1, 0) };
    const first = wacConsume(original, 1);
    expect(first.taken.material.equals(D("0.333333"))).toBe(true);
    expect(first.taken.labor.equals(D("0.333333"))).toBe(true);
    expect(first.taken.totalValue.equals(D("0.666666"))).toBe(true);
    expect(first.remaining.material.equals(D("0.666667"))).toBe(true);
    expect(first.remaining.labor.equals(D("0.666667"))).toBe(true);
    expect(first.remaining.totalValue.equals(D("1.333334"))).toBe(true);
    expect(first.taken.material.plus(first.remaining.material).equals(D(1))).toBe(true);
    expect(first.taken.labor.plus(first.remaining.labor).equals(D(1))).toBe(true);
    expect(first.taken.nomenclature.plus(first.remaining.nomenclature).equals(D(0))).toBe(true);

    const second = wacConsume(first.remaining, 1);
    const last = wacConsume(second.remaining, second.remaining.qty);
    expect(last.remaining.qty.equals(D(0))).toBe(true);
    expect(last.remaining.material.equals(D(0))).toBe(true);
    expect(last.remaining.labor.equals(D(0))).toBe(true);
    expect(last.remaining.totalValue.equals(D(0))).toBe(true);
    expect(
      first.taken.material
        .plus(second.taken.material)
        .plus(last.taken.material)
        .equals(D(1)),
    ).toBe(true);
    expect(first.taken.labor.plus(second.taken.labor).plus(last.taken.labor).equals(D(1))).toBe(true);
  });
});

describe("STOCK-002 input validity", () => {
  it("rejects qty=0 with non-zero components", () => {
    expect(() => wacConsume({ qty: 0, ...comps(1, 0, 0) }, 1)).toThrow(/STOCK_002/);
    expect(() =>
      wacReceive({ qty: 0, ...comps(1, 0, 0) }, { qty: 1, ...comps(0, 0, 0) }),
    ).toThrow(/STOCK_002/);
  });

  it("allows qty=0 with all components 0 (empty pool receive)", () => {
    const next = wacReceive({ qty: 0, ...comps(0, 0, 0) }, { qty: 2, ...comps(4, 1, 0) });
    expect(next.qty.equals(D(2))).toBe(true);
    expect(next.totalValue.equals(D(5))).toBe(true);
  });

  it("allows qty>0 with zero-cost components", () => {
    const out = wacConsume({ qty: 5, ...comps(0, 0, 0) }, 2);
    expect(out.taken.qty.equals(D(2))).toBe(true);
    expect(out.taken.totalValue.equals(D(0))).toBe(true);
    expect(out.remaining.qty.equals(D(3))).toBe(true);
  });
});

describe("allocateRailLotValues", () => {
  const area = D("0.0008"); // 40×20 мм

  it("SORT1 only: entire C on the SORT1 lots", () => {
    const rows = allocateRailLotValues({
      totalCost: 100_000,
      priceSort1: 30_000,
      priceSort2: 20_000,
      sectionAreaM2: area,
      lots: [
        { id: "a", lengthM: 3, quantity: 100, sort: "SORT1" },
        { id: "b", lengthM: 2, quantity: 50, sort: "SORT1" },
      ],
    });
    const sum = rows.reduce((acc, r) => acc.plus(r.initialValue), D(0));
    expect(sum.equals(D(100_000))).toBe(true);
    expect(rows.every((r) => r.initialValue.gte(0))).toBe(true);
  });

  it("SORT2 only", () => {
    const rows = allocateRailLotValues({
      totalCost: 50_000,
      priceSort1: 30_000,
      priceSort2: 20_000,
      sectionAreaM2: area,
      lots: [{ id: "x", lengthM: 4, quantity: 10, sort: "SORT2" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].initialValue.equals(D(50_000))).toBe(true);
  });

  it("both sorts share by P·V; Σ initialValue = C exactly", () => {
    const rows = allocateRailLotValues({
      totalCost: 100_000,
      priceSort1: 30_000,
      priceSort2: 20_000,
      sectionAreaM2: area,
      lots: [
        { id: "s1", lengthM: 3, quantity: 100, sort: "SORT1" },
        { id: "s2", lengthM: 3, quantity: 100, sort: "SORT2" },
      ],
    });
    const sum = rows.reduce((acc, r) => acc.plus(r.initialValue), D(0));
    expect(sum.equals(D(100_000))).toBe(true);
    const s1 = rows.find((r) => r.id === "s1")!;
    const s2 = rows.find((r) => r.id === "s2")!;
    expect(s1.initialValue.gt(s2.initialValue)).toBe(true);
  });

  it("P1=P2=0 falls back to volume share; still conserves C", () => {
    const rows = allocateRailLotValues({
      totalCost: 90_000,
      priceSort1: 0,
      priceSort2: 0,
      sectionAreaM2: area,
      lots: [
        { id: "a", lengthM: 1, quantity: 10, sort: "SORT1" },
        { id: "b", lengthM: 2, quantity: 10, sort: "SORT2" },
      ],
    });
    const sum = rows.reduce((acc, r) => acc.plus(r.initialValue), D(0));
    expect(sum.equals(D(90_000))).toBe(true);
    expect(rows.find((r) => r.id === "b")!.initialValue.equals(D(60_000))).toBe(true);
  });

  it("different lengths and quantities still conserve C", () => {
    const rows = allocateRailLotValues({
      totalCost: "12345.67",
      priceSort1: 11,
      priceSort2: 7,
      sectionAreaM2: area,
      lots: [
        { id: "a", lengthM: "2.5", quantity: 3, sort: "SORT1" },
        { id: "b", lengthM: "0.4", quantity: 17, sort: "SORT2" },
        { id: "c", lengthM: "8", quantity: 1, sort: "SORT1" },
      ],
    });
    const sum = rows.reduce((acc, r) => acc.plus(r.initialValue), D(0));
    expect(sum.equals(D("12345.67"))).toBe(true);
  });

  it("C=0 allocates zeros", () => {
    const rows = allocateRailLotValues({
      totalCost: 0,
      priceSort1: 30_000,
      priceSort2: 20_000,
      sectionAreaM2: area,
      lots: [{ id: "a", lengthM: 3, quantity: 10, sort: "SORT1" }],
    });
    expect(rows[0].initialValue.equals(D(0))).toBe(true);
  });

  it("3-way repeating-decimal split is Decimal(18,6) and conserves C", () => {
    const rows = allocateRailLotValues({
      totalCost: 1,
      priceSort1: 1,
      priceSort2: 1,
      sectionAreaM2: 1,
      lots: [
        { id: "z", lengthM: 1, quantity: 1, sort: "SORT1" },
        { id: "a", lengthM: 1, quantity: 1, sort: "SORT1" },
        { id: "m", lengthM: 1, quantity: 1, sort: "SORT1" },
      ],
    });
    const sum = rows.reduce((acc, r) => acc.plus(r.initialValue), D(0));
    expect(sum.equals(D(1))).toBe(true);
    for (const row of rows) {
      expect(row.initialValue.decimalPlaces()).toBeLessThanOrEqual(6);
    }
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.initialValue.toFixed(6)]));
    expect(byId.a).toBe("0.333333");
    expect(byId.m).toBe("0.333333");
    expect(byId.z).toBe("0.333334");
  });

  it("same lots in different array order yield identical id → initialValue", () => {
    const base = {
      totalCost: 1,
      priceSort1: 1,
      priceSort2: 1,
      sectionAreaM2: 1,
    };
    const lotsA = [
      { id: "z", lengthM: 1, quantity: 1, sort: "SORT1" as const },
      { id: "a", lengthM: 1, quantity: 1, sort: "SORT1" as const },
      { id: "m", lengthM: 1, quantity: 1, sort: "SORT1" as const },
    ];
    const lotsB = [lotsA[1], lotsA[2], lotsA[0]];
    const mapA = Object.fromEntries(
      allocateRailLotValues({ ...base, lots: lotsA }).map((r) => [r.id, r.initialValue.toFixed(6)]),
    );
    const mapB = Object.fromEntries(
      allocateRailLotValues({ ...base, lots: lotsB }).map((r) => [r.id, r.initialValue.toFixed(6)]),
    );
    expect(mapA).toEqual(mapB);
  });

  it("zero-weight lot never receives persistence residual", () => {
    const rows = allocateRailLotValues({
      totalCost: 1,
      priceSort1: 1,
      priceSort2: 1,
      sectionAreaM2: 1,
      lots: [
        { id: "a", lengthM: 1, quantity: 1, sort: "SORT1" },
        { id: "b", lengthM: 1, quantity: 1, sort: "SORT1" },
        { id: "c", lengthM: 1, quantity: 1, sort: "SORT1" },
        { id: "z", lengthM: 0, quantity: 1, sort: "SORT1" },
      ],
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.initialValue]));
    expect(byId.z.equals(D(0))).toBe(true);
    const sum = rows.reduce((acc, r) => acc.plus(r.initialValue), D(0));
    expect(sum.equals(D(1))).toBe(true);
    expect(rows.every((r) => r.initialValue.gte(0))).toBe(true);
  });

  it("zero-weight residual mapping is identical across input permutations", () => {
    const base = {
      totalCost: 1,
      priceSort1: 1,
      priceSort2: 1,
      sectionAreaM2: 1,
    };
    const lots = [
      { id: "z", lengthM: 0, quantity: 1, sort: "SORT1" as const },
      { id: "c", lengthM: 1, quantity: 1, sort: "SORT1" as const },
      { id: "a", lengthM: 1, quantity: 1, sort: "SORT1" as const },
      { id: "b", lengthM: 1, quantity: 1, sort: "SORT1" as const },
    ];
    const perms = [lots, [lots[3], lots[0], lots[1], lots[2]], [lots[1], lots[2], lots[3], lots[0]]];
    const maps = perms.map((order) =>
      Object.fromEntries(
        allocateRailLotValues({ ...base, lots: order }).map((r) => [r.id, r.initialValue.toFixed(6)]),
      ),
    );
    expect(maps[0]).toEqual(maps[1]);
    expect(maps[0]).toEqual(maps[2]);
    expect(maps[0].z).toBe("0.000000");
  });

  it("equal positive weights stay deterministic and non-negative", () => {
    const rows = allocateRailLotValues({
      totalCost: 1,
      priceSort1: 1,
      priceSort2: 1,
      sectionAreaM2: 1,
      lots: [
        { id: "m", lengthM: 1, quantity: 1, sort: "SORT1" },
        { id: "a", lengthM: 1, quantity: 1, sort: "SORT1" },
        { id: "z", lengthM: 1, quantity: 1, sort: "SORT1" },
      ],
    });
    expect(rows.every((r) => r.initialValue.gte(0))).toBe(true);
    const reversed = allocateRailLotValues({
      totalCost: 1,
      priceSort1: 1,
      priceSort2: 1,
      sectionAreaM2: 1,
      lots: [...rows].reverse().map((r) => ({
        id: r.id,
        lengthM: 1,
        quantity: 1,
        sort: "SORT1" as const,
      })),
    });
    const mapA = Object.fromEntries(rows.map((r) => [r.id, r.initialValue.toFixed(6)]));
    const mapB = Object.fromEntries(reversed.map((r) => [r.id, r.initialValue.toFixed(6)]));
    expect(mapA).toEqual(mapB);
  });

  it("invalid zero total purchased volume", () => {
    expect(() =>
      allocateRailLotValues({
        totalCost: 10,
        priceSort1: 1,
        priceSort2: 1,
        sectionAreaM2: area,
        lots: [{ id: "a", lengthM: 0, quantity: 0, sort: "SORT1" }],
      }),
    ).toThrow(/ZERO_PURCHASED_VOLUME/);
  });
});

describe("remainingLotValue / bootstrapRawTransfer / RAW-OPEN-001", () => {
  it("remaining = initial × remainingQty / originalQty; identity when untouched", () => {
    expect(remainingLotValue({ initialValue: 60_000, remainingQty: 100, originalQty: 100 }).equals(D(60_000))).toBe(
      true,
    );
    expect(remainingLotValue({ initialValue: 60_000, remainingQty: 0, originalQty: 100 }).equals(D(0))).toBe(true);
    expect(remainingLotValue({ initialValue: 60_000, remainingQty: 40, originalQty: 100 }).equals(D(24_000))).toBe(
      true,
    );
  });

  it("C=100000 remaining raw=60000 known losses=0 → transfer opening=40000", () => {
    const transfer = bootstrapRawTransfer({
      totalCost: 100_000,
      remainingRawValue: 60_000,
      knownOpeningRawLosses: 0,
    });
    expect(transfer.equals(D(40_000))).toBe(true);
    expect(D(60_000).plus(transfer).plus(0).equals(D(100_000))).toBe(true);
  });

  it("invalid remaining+losses > C is rejected (no negative transfer)", () => {
    expect(() =>
      bootstrapRawTransfer({
        totalCost: 100_000,
        remainingRawValue: 100_001,
        knownOpeningRawLosses: 0,
      }),
    ).toThrow(/BOOTSTRAP_OVER_C/);
  });
});

describe("pre-cutover snapshot representability (no runtime block)", () => {
  it("null and 0 are not exact-reverse versions; >0 is", () => {
    expect(canExactMonetaryReverse({ outputCostVersion: null })).toBe(false);
    expect(canExactMonetaryReverse({ outputCostVersion: 0 })).toBe(false);
    expect(canExactMonetaryReverse({ outputCostVersion: 1 })).toBe(true);
    expect(canExactMonetaryReverse({ outputCostVersion: 3 })).toBe(true);
  });
});

describe("consumeRailValue", () => {
  it("last-rail take uses the exact stored remainingValue", () => {
    const out = consumeRailValue({ remainingQuantity: 3, remainingValue: "1.000001", railsTaken: 3 });
    expect(out.consumedRawValue.equals(D("1.000001"))).toBe(true);
    expect(out.newRemainingValue.equals(D(0))).toBe(true);
    expect(out.newRemainingQuantity).toBe(0);
  });

  it("1/3 consume is q6 and remainder is exact residual of stored value", () => {
    const out = consumeRailValue({ remainingQuantity: 3, remainingValue: 1, railsTaken: 1 });
    expect(out.consumedRawValue.equals(D("0.333333"))).toBe(true);
    expect(out.newRemainingValue.equals(D("0.666667"))).toBe(true);
    expect(out.consumedRawValue.plus(out.newRemainingValue).equals(D(1))).toBe(true);
    expect(out.newRemainingQuantity).toBe(2);
  });

  it("does not independently re-round the remainder", () => {
    const first = consumeRailValue({ remainingQuantity: 3, remainingValue: 1, railsTaken: 1 });
    const second = consumeRailValue({
      remainingQuantity: first.newRemainingQuantity,
      remainingValue: first.newRemainingValue,
      railsTaken: 1,
    });
    const last = consumeRailValue({
      remainingQuantity: second.newRemainingQuantity,
      remainingValue: second.newRemainingValue,
      railsTaken: 1,
    });
    expect(first.consumedRawValue.plus(second.consumedRawValue).plus(last.consumedRawValue).equals(D(1))).toBe(
      true,
    );
    expect(last.newRemainingValue.equals(D(0))).toBe(true);
  });
});

describe("allocatePersistenceShares", () => {
  it("zero-weight item never receives residual", () => {
    const rows = allocatePersistenceShares({
      total: 1,
      items: [
        { id: "a", shareBase: 1 },
        { id: "b", shareBase: 1 },
        { id: "c", shareBase: 1 },
        { id: "z", shareBase: 0 },
      ],
    });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.value]));
    expect(byId.z.equals(D(0))).toBe(true);
    expect(rows.reduce((acc, r) => acc.plus(r.value), D(0)).equals(D(1))).toBe(true);
  });

  it("equal positive weights stay deterministic across input order", () => {
    const items = [
      { id: "m", shareBase: 1 },
      { id: "a", shareBase: 1 },
      { id: "z", shareBase: 1 },
    ];
    const mapA = Object.fromEntries(
      allocatePersistenceShares({ total: 1, items }).map((r) => [r.id, r.value.toFixed(6)]),
    );
    const mapB = Object.fromEntries(
      allocatePersistenceShares({ total: 1, items: [...items].reverse() }).map((r) => [
        r.id,
        r.value.toFixed(6),
      ]),
    );
    expect(mapA).toEqual(mapB);
    expect(mapA.z).toBe("0.333334");
  });
});
