import { describe, expect, it } from "vitest";
import {
  formatSupplyPreflightMarkers,
  parseSupplyPreflightStdout,
  SUPPLY_PREFLIGHT_RESULT_PARSE_FAILED,
} from "./supply-production-preflight-parse";

describe("Supply production preflight parser", () => {
  it("extracts exactly one machine marker from BEGIN/COMMIT wrapper noise", () => {
    const stdout = [
      "BEGIN",
      "some harmless wrapper/noise",
      "SUPPLY_PREFLIGHT_RESULT=7,2,5,1",
      "COMMIT",
    ].join("\n");
    expect(parseSupplyPreflightStdout(stdout)).toEqual({
      total: 7,
      deducted_positive: 2,
      shortfall_only: 5,
      open_deducted_positive: 1,
    });
    expect(formatSupplyPreflightMarkers(parseSupplyPreflightStdout(stdout))).toBe(
      [
        "SUPPLY_PREFLIGHT_TOTAL=7",
        "SUPPLY_PREFLIGHT_DEDUCTED_POSITIVE=2",
        "SUPPLY_PREFLIGHT_SHORTFALL_ONLY=5",
        "SUPPLY_PREFLIGHT_OPEN_DEDUCTED_POSITIVE=1",
        "SUPPLY_DATA_BLOCKER=YES",
      ].join("\n"),
    );
  });

  it("fails closed when no valid marker is present", () => {
    expect(() => parseSupplyPreflightStdout("BEGIN\nCOMMIT\n")).toThrow(
      SUPPLY_PREFLIGHT_RESULT_PARSE_FAILED,
    );
  });

  it("fails closed on a malformed marker", () => {
    expect(() =>
      parseSupplyPreflightStdout("SUPPLY_PREFLIGHT_RESULT=7,2,x,1\n"),
    ).toThrow(SUPPLY_PREFLIGHT_RESULT_PARSE_FAILED);
  });

  it("fails closed when two valid markers are present", () => {
    expect(() =>
      parseSupplyPreflightStdout(
        "SUPPLY_PREFLIGHT_RESULT=7,2,5,1\nSUPPLY_PREFLIGHT_RESULT=0,0,0,0\n",
      ),
    ).toThrow(SUPPLY_PREFLIGHT_RESULT_PARSE_FAILED);
  });

  it("sets SUPPLY_DATA_BLOCKER=NO when open_deducted_positive is 0", () => {
    expect(
      formatSupplyPreflightMarkers({
        total: 3,
        deducted_positive: 1,
        shortfall_only: 2,
        open_deducted_positive: 0,
      }),
    ).toContain("SUPPLY_DATA_BLOCKER=NO");
  });
});
