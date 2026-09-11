import { describe, expect, it } from "vitest";
import {
  canonicalLengthFixed4,
  canonicalizeTorcovkaPicks,
} from "./blank-length";

describe("canonicalLengthFixed4", () => {
  it("rounds HALF_UP at 4 decimal places", () => {
    expect(canonicalLengthFixed4(0.73604)).toBe("0.7360");
    expect(canonicalLengthFixed4(0.73605)).toBe("0.7361");
    expect(canonicalLengthFixed4(0.736049999999)).toBe("0.7360");
    expect(canonicalLengthFixed4(0.736050000001)).toBe("0.7361");
    expect(canonicalLengthFixed4(0.7359999999999)).toBe("0.7360");
    expect(canonicalLengthFixed4(0.7360000000001)).toBe("0.7360");
  });

  it("rejects non-finite and non-positive lengths", () => {
    expect(() => canonicalLengthFixed4(NaN)).toThrow("Некорректная длина заготовки");
    expect(() => canonicalLengthFixed4(Infinity)).toThrow("Некорректная длина заготовки");
    expect(() => canonicalLengthFixed4(-Infinity)).toThrow("Некорректная длина заготовки");
    expect(() => canonicalLengthFixed4(0)).toThrow("Некорректная длина заготовки");
    expect(() => canonicalLengthFixed4(-0.736)).toThrow("Некорректная длина заготовки");
  });

  it("rejects values that round to canonical 0.0000", () => {
    expect(() => canonicalLengthFixed4(0.00004)).toThrow("Некорректная длина заготовки");
    expect(() => canonicalLengthFixed4(0.000049999)).toThrow("Некорректная длина заготовки");
    expect(() => canonicalLengthFixed4(1e-9)).toThrow("Некорректная длина заготовки");
  });

  it("accepts the positive HALF_UP minimum 0.0001", () => {
    expect(canonicalLengthFixed4(0.00005)).toBe("0.0001");
    expect(canonicalLengthFixed4(0.0000500001)).toBe("0.0001");
    expect(canonicalLengthFixed4("0.0001")).toBe("0.0001");
  });
});

describe("canonicalizeTorcovkaPicks", () => {
  it("merges near-equal JS floats of the same sort and sums quantity", () => {
    const merged = canonicalizeTorcovkaPicks([
      { lengthM: 0.736, sort: "SORT1", quantity: 2 },
      { lengthM: 0.7359999999999, sort: "SORT1", quantity: 3 },
    ]);
    expect(merged).toEqual([
      { lengthM: 0.736, lengthMFixed4: "0.7360", sort: "SORT1", quantity: 5 },
    ]);
  });

  it("does not merge SORT1 and SORT2 at the same canonical length", () => {
    const merged = canonicalizeTorcovkaPicks([
      { lengthM: 0.736, sort: "SORT1", quantity: 1 },
      { lengthM: 0.7359999999999, sort: "SORT2", quantity: 1 },
    ]);
    expect(merged).toEqual([
      { lengthM: 0.736, lengthMFixed4: "0.7360", sort: "SORT1", quantity: 1 },
      { lengthM: 0.736, lengthMFixed4: "0.7360", sort: "SORT2", quantity: 1 },
    ]);
  });

  it("does not merge 0.7360 and 0.7361", () => {
    const merged = canonicalizeTorcovkaPicks([
      { lengthM: 0.736, sort: "SORT1", quantity: 1 },
      { lengthM: 0.7361, sort: "SORT1", quantity: 1 },
    ]);
    expect(merged.map((p) => p.lengthMFixed4)).toEqual(["0.7360", "0.7361"]);
  });

  it("keeps quantity > 0 filter and first-seen canonical key order", () => {
    const merged = canonicalizeTorcovkaPicks([
      { lengthM: 0.7361, sort: "SORT1", quantity: 0 },
      { lengthM: 0.7361, sort: "SORT2", quantity: 1 },
      { lengthM: 0.736, sort: "SORT1", quantity: 1 },
    ]);
    expect(merged.map((p) => `${p.lengthMFixed4}|${p.sort}`)).toEqual([
      "0.7361|SORT2",
      "0.7360|SORT1",
    ]);
  });

  it("preserves first appearance order of canonical keys after merge", () => {
    const merged = canonicalizeTorcovkaPicks([
      { lengthM: 0.7361, sort: "SORT1", quantity: 1 },
      { lengthM: 0.5, sort: "SORT1", quantity: 1 },
      { lengthM: 0.7361000000001, sort: "SORT1", quantity: 2 },
      { lengthM: 0.4, sort: "SORT1", quantity: 1 },
    ]);
    expect(merged.map((p) => `${p.lengthMFixed4}|${p.sort}|${p.quantity}`)).toEqual([
      "0.7361|SORT1|3",
      "0.5000|SORT1|1",
      "0.4000|SORT1|1",
    ]);
  });
});
