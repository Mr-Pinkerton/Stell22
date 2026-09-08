import { describe, expect, it } from "vitest";
import { CostFlowConfigError, parseProductionCostFlowValue } from "./cost-flow-state";

describe("parseProductionCostFlowValue", () => {
  it("version=1 active=false is inactive", () => {
    expect(parseProductionCostFlowValue({ version: 1, active: false })).toEqual({ active: false });
  });

  it("version=1 active=true is active", () => {
    expect(parseProductionCostFlowValue({ version: 1, active: true })).toEqual({ active: true });
  });

  it("malformed JSON fails closed", () => {
    expect(() => parseProductionCostFlowValue("yes")).toThrow(CostFlowConfigError);
    expect(() => parseProductionCostFlowValue(null)).toThrow(CostFlowConfigError);
    expect(() => parseProductionCostFlowValue({ active: true })).toThrow(CostFlowConfigError);
    expect(() => parseProductionCostFlowValue({ version: 2, active: true })).toThrow(CostFlowConfigError);
    expect(() => parseProductionCostFlowValue({ version: 1, active: "true" })).toThrow(CostFlowConfigError);
  });
});
