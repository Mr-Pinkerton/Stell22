import { describe, expect, it } from "vitest";
import {
  quantityEditCommandKey,
  quantityEditUiLocked,
  retainOrMintQuantityEditRequestId,
  shouldRotateQuantityEditRequestId,
} from "./production-quantity-edit-request";

describe("quantityEditCommandKey", () => {
  it("changes when stable target or CAS fields change", () => {
    const base = {
      operationId: "op-1",
      targetLineId: "line-1",
      expectedOldQuantity: 10,
      newQuantity: 12,
      expectedStateFingerprint: "qedit-state-v1:aaa",
    };
    expect(quantityEditCommandKey(base)).toBe(quantityEditCommandKey({ ...base }));
    expect(quantityEditCommandKey(base)).not.toBe(
      quantityEditCommandKey({ ...base, targetLineId: "line-2" }),
    );
    expect(quantityEditCommandKey(base)).not.toBe(
      quantityEditCommandKey({ ...base, expectedStateFingerprint: "qedit-state-v1:bbb" }),
    );
  });
});

describe("retainOrMintQuantityEditRequestId", () => {
  it("reuses the id for the same pending command", () => {
    const first = retainOrMintQuantityEditRequestId({
      requestId: null,
      boundKey: null,
      commandKey: "k",
    });
    const retry = retainOrMintQuantityEditRequestId({
      requestId: first.requestId,
      boundKey: first.boundKey,
      commandKey: "k",
    });
    expect(retry.requestId).toBe(first.requestId);
  });

  it("mints a new id when the command fields change", () => {
    const first = retainOrMintQuantityEditRequestId({
      requestId: "keep-me",
      boundKey: "old",
      commandKey: "new",
    });
    expect(first.requestId).not.toBe("keep-me");
    expect(first.boundKey).toBe("new");
  });
});

describe("quantityEditUiLocked", () => {
  it("blocks a second Save while one quantity-edit command is in flight", () => {
    expect(quantityEditUiLocked(false)).toBe(false);
    expect(quantityEditUiLocked(true)).toBe(true);
  });
});

describe("shouldRotateQuantityEditRequestId", () => {
  it("rotates after stale or requestId reuse, not after generic errors", () => {
    expect(shouldRotateQuantityEditRequestId("STALE_QUANTITY_EDIT: x")).toBe(true);
    expect(shouldRotateQuantityEditRequestId("REQUEST_ID_REUSE: x")).toBe(true);
    expect(shouldRotateQuantityEditRequestId("Нельзя изменить — операция уже выплачена")).toBe(
      false,
    );
  });
});
