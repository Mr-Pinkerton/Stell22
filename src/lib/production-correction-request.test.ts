import { describe, expect, it } from "vitest";
import {
  correctionCommandKey,
  retainOrMintCorrectionRequestId,
  shouldRotateCorrectionRequestId,
} from "./production-correction-request";

describe("correctionCommandKey", () => {
  it("trims reason so whitespace-only retries bind the same command", () => {
    expect(
      correctionCommandKey({ expectedOldRailsTaken: 10, newRailsTaken: 7, reason: "  a  " }),
    ).toBe(correctionCommandKey({ expectedOldRailsTaken: 10, newRailsTaken: 7, reason: "a" }));
  });

  it("changes when target changes", () => {
    expect(
      correctionCommandKey({ expectedOldRailsTaken: 10, newRailsTaken: 7, reason: "a" }),
    ).not.toBe(correctionCommandKey({ expectedOldRailsTaken: 10, newRailsTaken: 6, reason: "a" }));
  });
});

describe("retainOrMintCorrectionRequestId", () => {
  it("reuses the id for the same pending command (retry / lost response)", () => {
    const first = retainOrMintCorrectionRequestId({
      requestId: null,
      boundKey: null,
      commandKey: "k",
    });
    const retry = retainOrMintCorrectionRequestId({
      requestId: first.requestId,
      boundKey: first.boundKey,
      commandKey: "k",
    });
    expect(retry.requestId).toBe(first.requestId);
  });

  it("mints a new id when the command fields change", () => {
    const first = retainOrMintCorrectionRequestId({
      requestId: "keep-me",
      boundKey: "old",
      commandKey: "new",
    });
    expect(first.requestId).not.toBe("keep-me");
    expect(first.boundKey).toBe("new");
  });
});

describe("shouldRotateCorrectionRequestId", () => {
  it("rotates after stale or requestId reuse, not after generic/network errors", () => {
    expect(shouldRotateCorrectionRequestId("STALE_CORRECTION: x")).toBe(true);
    expect(shouldRotateCorrectionRequestId("REQUEST_ID_REUSE: x")).toBe(true);
    expect(shouldRotateCorrectionRequestId("Нельзя исправить — операция уже выплачена")).toBe(false);
  });
});
