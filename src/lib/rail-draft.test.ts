import { describe, expect, it } from "vitest";
import { evaluateRailAdd } from "@/lib/rail-draft";

describe("evaluateRailAdd", () => {
  const base = { quantityText: "10", rowsText: "", layersText: "" };

  it("commits comma and dot lengths, including four decimal places", () => {
    for (const lengthText of ["0,35", "0.35", "2,475", "0,0001"]) {
      const result = evaluateRailAdd({ ...base, lengthText });
      expect(result.ok, lengthText).toBe(true);
      if (result.ok) expect(result.quantity).toBe(10);
    }
    const fine = evaluateRailAdd({ ...base, lengthText: "0,0001" });
    expect(fine.ok && fine.lengthM).toBe(0.0001);
  });

  it("does not commit an unfinished separator, empty text, or extra precision", () => {
    expect(evaluateRailAdd({ ...base, lengthText: "0," }).ok).toBe(false);
    expect(evaluateRailAdd({ ...base, lengthText: "0." }).ok).toBe(false);
    expect(evaluateRailAdd({ ...base, lengthText: "" }).ok).toBe(false);
    expect(evaluateRailAdd({ ...base, lengthText: "1,23456" }).ok).toBe(false);
  });

  it("rejects a fractional rail count, row, or layer before the draft is added", () => {
    expect(evaluateRailAdd({ lengthText: "2,4", quantityText: "1,5", rowsText: "", layersText: "" }).ok).toBe(false);
    expect(evaluateRailAdd({ lengthText: "2.4", quantityText: "1.5", rowsText: "", layersText: "" }).ok).toBe(false);
    expect(evaluateRailAdd({ lengthText: "2,4", quantityText: "", rowsText: "1,5", layersText: "2" }).ok).toBe(false);
    expect(evaluateRailAdd({ lengthText: "2,4", quantityText: "", rowsText: "2", layersText: "1.5" }).ok).toBe(false);
  });

  it("uses integer rows times layers as the quantity", () => {
    const result = evaluateRailAdd({ lengthText: "2,4", quantityText: "9", rowsText: "3", layersText: "4" });
    expect(result).toMatchObject({ ok: true, quantity: 12, rows: 3, layers: 4, fromGrid: true });
  });
});
