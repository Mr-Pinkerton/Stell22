import { describe, expect, it } from "vitest";
import {
  PRODUCTION_SHADOW_GATE_INVARIANT_VIOLATION,
  assertProductionShadowGatewayResult,
  expectedProductionShadowInsertCount,
} from "@/server/internal/production-shadow-write";

describe("production SHADOW gateway result invariant", () => {
  it("counts only nonzero mapped movement effects as expected inserts", () => {
    expect(
      expectedProductionShadowInsertCount([
        { quantityDelta: -4 },
        { quantityDelta: 0 },
        { quantityDelta: 5 },
      ]),
    ).toBe(2);
    expect(expectedProductionShadowInsertCount([{ quantityDelta: 0 }])).toBe(0);
  });

  it("accepts matching ACTIVE gateway result including the zero-effect case", () => {
    expect(() =>
      assertProductionShadowGatewayResult({
        result: { gateActive: true, inserted: 2 },
        expectedInserted: 2,
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionShadowGatewayResult({
        result: { gateActive: true, inserted: 0 },
        expectedInserted: 0,
      }),
    ).not.toThrow();
  });

  it("fails closed when ACTIVE writer observes an inactive gateway result", () => {
    expect(() =>
      assertProductionShadowGatewayResult({
        result: { gateActive: false, inserted: 0 },
        expectedInserted: 1,
      }),
    ).toThrow(PRODUCTION_SHADOW_GATE_INVARIANT_VIOLATION);
  });

  it("fails closed when inserted count does not match expected effects", () => {
    expect(() =>
      assertProductionShadowGatewayResult({
        result: { gateActive: true, inserted: 1 },
        expectedInserted: 2,
      }),
    ).toThrow(PRODUCTION_SHADOW_GATE_INVARIANT_VIOLATION);
  });
});
