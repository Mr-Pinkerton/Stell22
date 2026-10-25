import { describe, expect, it } from "vitest";
import {
  CANCEL_REQUEST_ID_REUSE,
  STALE_OPERATION_CANCEL,
  assertCancellationPayloadMatch,
  cancellationPayloadMatches,
  productionCancelFingerprint,
  shouldRotateCancelRequestId,
} from "./production-operation-cancel";

const base = {
  operationId: "op-1",
  type: "TORCOVKA",
  isPaid: false,
  cancelledAt: null,
  railsTaken: 4,
  hours: null,
  productQty: null,
  lines: [
    { id: "b", quantity: 2 },
    { id: "a", quantity: 3 },
  ],
};

describe("production operation cancel identity", () => {
  it("fingerprint changes when quantity or payment state changes", () => {
    const first = productionCancelFingerprint(base);
    expect(productionCancelFingerprint(base)).toBe(first);
    expect(productionCancelFingerprint({ ...base, railsTaken: 3 })).not.toBe(first);
    expect(productionCancelFingerprint({ ...base, isPaid: true })).not.toBe(first);
    expect(productionCancelFingerprint({ ...base, lines: [{ id: "a", quantity: 4 }, { id: "b", quantity: 2 }] })).not.toBe(
      first,
    );
  });

  it("replays the same command and rejects a reused request with a different reason", () => {
    const stored = {
      operationId: "op-1",
      adminUserId: "admin",
      reason: "ошибка ввода",
      expectedStateFingerprint: "fp",
    };
    expect(cancellationPayloadMatches(stored, { ...stored })).toBe(true);
    expect(() =>
      assertCancellationPayloadMatch(stored, { ...stored, reason: "другая причина" }),
    ).toThrow(CANCEL_REQUEST_ID_REUSE);
  });

  it("rotates the request id after a stale or conflicting retry", () => {
    expect(shouldRotateCancelRequestId(STALE_OPERATION_CANCEL)).toBe(true);
    expect(shouldRotateCancelRequestId(CANCEL_REQUEST_ID_REUSE)).toBe(true);
    expect(shouldRotateCancelRequestId("Нельзя аннулировать — операция уже выплачена.")).toBe(false);
  });
});
