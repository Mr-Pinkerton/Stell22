import { describe, expect, it } from "vitest";
import {
  REQUEST_ID_REUSE,
  STALE_CORRECTION,
  assertCorrectionCommandIntegers,
  assertCorrectionPayloadMatch,
  canonicalCorrectionReason,
  correctionDeltaReturned,
  correctionPayloadMatches,
} from "./production-operation-correction";

const base = {
  operationId: "op-1",
  adminUserId: "admin-1",
  expectedOldRailsTaken: 10,
  newRailsTaken: 7,
  reason: "ошиблись количеством",
};

describe("R-05 correction command integers", () => {
  it("accepts 10 → 7", () => {
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 10, newRailsTaken: 7 }),
    ).not.toThrow();
  });

  it("rejects equal target", () => {
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 10, newRailsTaken: 10 }),
    ).toThrow("Можно только уменьшить количество фактически взятых реек");
  });

  it("rejects increase", () => {
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 7, newRailsTaken: 10 }),
    ).toThrow("Можно только уменьшить количество фактически взятых реек");
  });

  it("rejects zero and non-integers", () => {
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 10, newRailsTaken: 0 }),
    ).toThrow("Количество реек должно быть целым и больше нуля");
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 10, newRailsTaken: 7.5 }),
    ).toThrow("Количество реек должно быть целым и больше нуля");
    expect(() =>
      assertCorrectionCommandIntegers({ expectedOldRailsTaken: 0, newRailsTaken: -1 }),
    ).toThrow("Ожидаемое количество реек должно быть целым и больше нуля");
  });
});

describe("R-05 payload binding", () => {
  it("trims reason as audit metadata", () => {
    expect(canonicalCorrectionReason("  foo  ")).toBe("foo");
  });

  it("deltaReturned is expectedOld - new", () => {
    expect(correctionDeltaReturned(10, 7)).toBe(3);
  });

  it("matches identical command fields", () => {
    expect(correctionPayloadMatches(base, { ...base })).toBe(true);
  });

  it("rejects requestId reuse for a different target, old, operation, reason, or admin", () => {
    expect(correctionPayloadMatches(base, { ...base, newRailsTaken: 6 })).toBe(false);
    expect(correctionPayloadMatches(base, { ...base, expectedOldRailsTaken: 9 })).toBe(false);
    expect(correctionPayloadMatches(base, { ...base, operationId: "op-2" })).toBe(false);
    expect(correctionPayloadMatches(base, { ...base, reason: "другое" })).toBe(false);
    expect(correctionPayloadMatches(base, { ...base, adminUserId: "admin-2" })).toBe(false);
    expect(() => assertCorrectionPayloadMatch(base, { ...base, reason: "другое" })).toThrow(
      REQUEST_ID_REUSE,
    );
  });

  it("exposes stable stale/reuse codes", () => {
    expect(STALE_CORRECTION.startsWith("STALE_CORRECTION")).toBe(true);
    expect(REQUEST_ID_REUSE.startsWith("REQUEST_ID_REUSE")).toBe(true);
  });
});
