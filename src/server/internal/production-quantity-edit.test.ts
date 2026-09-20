import { describe, expect, it } from "vitest";
import {
  QEDIT_STATE_FINGERPRINT_VERSION,
  assertNoMoneyInQuantityEditContract,
  buildQuantityEditRequestSnapshot,
  buildTorcovkaStateCanonical,
  computeQuantityEditStateFingerprint,
  quantityEditStateFingerprint,
  QUANTITY_EDIT_BEFORE_SNAPSHOT_INCOMPLETE,
  derivePhysicalAdjustments,
  sortPhysicalAdjustments,
} from "./production-quantity-edit";

const torcLine = {
  id: "line-a",
  quantity: 4,
  detailId: null,
  blankLengthM: "1.8000",
  blankType: "POLKA" as const,
  blankSort: "SORT1" as const,
  blankMaterialId: "mat-1",
  prisadkaTorcevaya: false,
  prisadkaPloskost: false,
  sourceIsBlank: false,
  sourceTorcevayaDone: false,
  sourcePloskostDone: false,
};

describe("quantity-edit fingerprint v1", () => {
  it("is versioned SHA-256 lowercase hex and independent of object insertion order", () => {
    const left = computeQuantityEditStateFingerprint({
      operationId: "op-1",
      operationType: "TORCOVKA",
      line: torcLine,
    });
    const right = quantityEditStateFingerprint(
      buildTorcovkaStateCanonical({ operationId: "op-1", line: { ...torcLine } }),
    );
    expect(left).toBe(right);
    expect(left.startsWith(`${QEDIT_STATE_FINGERPRINT_VERSION}:`)).toBe(true);
    expect(left.slice(`${QEDIT_STATE_FINGERPRINT_VERSION}:`.length)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when quantity or blank spec changes", () => {
    const a = computeQuantityEditStateFingerprint({
      operationId: "op-1",
      operationType: "TORCOVKA",
      line: torcLine,
    });
    const b = computeQuantityEditStateFingerprint({
      operationId: "op-1",
      operationType: "TORCOVKA",
      line: { ...torcLine, quantity: 5 },
    });
    expect(a).not.toBe(b);
  });
});

describe("quantity-edit snapshots", () => {
  it("builds request v1 without actor or money", () => {
    const snap = buildQuantityEditRequestSnapshot({
      operationId: "op-1",
      targetLineId: "line-a",
      expectedOldQuantity: 4,
      newQuantity: 6,
      expectedStateFingerprint: "qedit-state-v1:abc",
    });
    expect(snap).toEqual({
      v: 1,
      operationId: "op-1",
      target: { kind: "LINE", lineId: "line-a" },
      expectedOldQuantity: 4,
      newQuantity: 6,
      expectedStateFingerprint: "qedit-state-v1:abc",
    });
    expect(() => assertNoMoneyInQuantityEditContract(snap)).not.toThrow();
  });

  it("derivePhysicalAdjustments fails closed when a before snapshot key is missing", () => {
    expect(() =>
      derivePhysicalAdjustments(
        [{ targetType: "PRODUCT", productId: "p1" }],
        new Map(),
        new Map([["PRODUCT|p1", 1]]),
      ),
    ).toThrow(QUANTITY_EDIT_BEFORE_SNAPSHOT_INCOMPLETE);
  });

  it("sorts physical adjustments by targetType then target key and omits zeros upstream", () => {
    const sorted = sortPhysicalAdjustments([
      { targetType: "PRODUCT", productId: "p2", quantityDelta: 1 },
      { targetType: "BLANK", materialId: "m", lengthM: "1.8000", detailType: "POLKA", sort: "SORT1", quantityDelta: -2 },
      { targetType: "DETAIL", detailId: "d", torcevayaDone: true, ploskostDone: false, quantityDelta: 2 },
    ]);
    expect(sorted.map((a) => a.targetType)).toEqual(["BLANK", "DETAIL", "PRODUCT"]);
  });

  it("rejects monetary fields in the contract", () => {
    expect(() =>
      assertNoMoneyInQuantityEditContract({ physicalAdjustments: [{ amount: 10 }] }),
    ).toThrow(/monetary field/);
  });
});
