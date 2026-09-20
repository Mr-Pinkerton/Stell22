import { describe, expect, it } from "vitest";
import { canonicalizeMovementTarget, effectKeyV1 } from "@/server/internal/inventory-movement-identity";
import { systemMovementActor, userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import {
  RAW_PURCHASE_SHADOW_ACTOR_MISMATCH,
  RAW_PURCHASE_SHADOW_ACTOR_REQUIRED,
  RAW_PURCHASE_SHADOW_GATE_INVARIANT_VIOLATION,
  RAW_PURCHASE_SHADOW_INVALID_QUANTITY,
  assertRawPurchaseActorMatchesCommand,
  assertRawPurchaseShadowGatewayResult,
  batchCreateCausationSnapshotV1,
  batchCreateReceiptEffectKey,
  batchCreateReceiptEffects,
  batchWriteOffCausationSnapshotV1,
  batchWriteOffEffectKey,
  batchWriteOffMovementEffects,
  expectedRawPurchaseShadowInsertCount,
  requireRawPurchaseUserActor,
  simplePurchaseCausationSnapshotV1,
  simplePurchaseReceiptEffect,
  simplePurchaseReceiptEffectKey,
} from "@/server/internal/raw-purchase-shadow-write";

const MONEY_LEAK = /purchaseCost|totalCost|priceSort1|priceSort2|unitPrice|initialValue|remainingValue|₽|money/i;

describe("createBatch causation snapshot v1", () => {
  it("pins BATCH / command-id identity, sorted railLots, and no money", () => {
    const snapshot = batchCreateCausationSnapshotV1({
      commandId: "cmd-1",
      requestId: "req-1",
      batchId: "batch-1",
      railLots: [
        { railLotId: "lot-b", quantity: 2 },
        { railLotId: "lot-a", quantity: 1 },
      ],
    });
    expect(snapshot).toEqual({
      v: 1,
      d: "BATCH",
      type: "CREATE",
      commandId: "cmd-1",
      requestId: "req-1",
      batchId: "batch-1",
      railLots: [
        { railLotId: "lot-a", quantity: 1 },
        { railLotId: "lot-b", quantity: 2 },
      ],
    });
    expect(JSON.stringify(snapshot)).toBe(
      JSON.stringify({
        v: 1,
        d: "BATCH",
        type: "CREATE",
        commandId: "cmd-1",
        requestId: "req-1",
        batchId: "batch-1",
        railLots: [
          { railLotId: "lot-a", quantity: 1 },
          { railLotId: "lot-b", quantity: 2 },
        ],
      }),
    );
    expect(JSON.stringify(snapshot)).not.toMatch(MONEY_LEAK);
    expect(snapshot).not.toHaveProperty("purchaseDate");
    expect(snapshot).not.toHaveProperty("name");
  });
});

describe("createBatch receipt mapping", () => {
  it("emits one RAIL_LOT RECEIPT per positive lot and exact imfx1:receipt:<hash>", () => {
    const effects = batchCreateReceiptEffects([
      { id: "lot-2", quantity: 3 },
      { id: "lot-1", quantity: 0 },
      { id: "lot-3", quantity: 1 },
    ]);
    expect(effects).toEqual([
      {
        role: "receipt",
        kind: "RECEIPT",
        quantityDelta: 3,
        target: { stockDomain: "RAIL_LOT", railLotId: "lot-2" },
      },
      {
        role: "receipt",
        kind: "RECEIPT",
        quantityDelta: 1,
        target: { stockDomain: "RAIL_LOT", railLotId: "lot-3" },
      },
    ]);
    const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId: "lot-2" });
    expect(batchCreateReceiptEffectKey("lot-2")).toBe(effectKeyV1("receipt", canonical.targetHashV1));
    expect(batchCreateReceiptEffectKey("lot-2")).toBe(`imfx1:receipt:${canonical.targetHashV1}`);
    expect(expectedRawPurchaseShadowInsertCount(effects)).toBe(2);
  });

  it("fails closed if a negative RailLot quantity reaches the effect layer", () => {
    expect(() => batchCreateReceiptEffects([{ id: "lot-neg", quantity: -1 }])).toThrow(
      RAW_PURCHASE_SHADOW_INVALID_QUANTITY,
    );
  });
});

describe("write-off causation snapshot v1", () => {
  it("pins BATCH / write-off-id identity, retained effects, and no money", () => {
    const snapshot = batchWriteOffCausationSnapshotV1({
      commandId: "wo-1",
      requestId: "req-wo",
      batchId: "batch-1",
      totalQuantity: 6,
      effects: [
        { railLotId: "lot-b", quantityBefore: 2, quantityDelta: -2 },
        { railLotId: "lot-a", quantityBefore: 4, quantityDelta: -4 },
      ],
    });
    expect(snapshot).toEqual({
      v: 1,
      d: "BATCH",
      type: "REMAINDER_WRITEOFF",
      commandId: "wo-1",
      requestId: "req-wo",
      batchId: "batch-1",
      totalQuantity: 6,
      effects: [
        { railLotId: "lot-a", quantityBefore: 4, quantityDelta: -4 },
        { railLotId: "lot-b", quantityBefore: 2, quantityDelta: -2 },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(MONEY_LEAK);
  });
});

describe("write-off retained-effect mapping", () => {
  it("uses retained negative deltas and imfx1:writeoff:<railLotTargetHashV1>", () => {
    const effects = batchWriteOffMovementEffects([
      { railLotId: "lot-1", quantityBefore: 6, quantityDelta: -6 },
    ]);
    expect(effects).toEqual([
      {
        role: "writeoff",
        kind: "ADJUSTMENT",
        quantityDelta: -6,
        target: { stockDomain: "RAIL_LOT", railLotId: "lot-1" },
      },
    ]);
    const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId: "lot-1" });
    expect(batchWriteOffEffectKey("lot-1")).toBe(effectKeyV1("writeoff", canonical.targetHashV1));
    expect(batchWriteOffEffectKey("lot-1")).toBe(`imfx1:writeoff:${canonical.targetHashV1}`);
  });

  it("fails closed if a non-negative write-off delta reaches the effect layer", () => {
    expect(() =>
      batchWriteOffMovementEffects([{ railLotId: "lot-1", quantityBefore: 1, quantityDelta: 1 }]),
    ).toThrow(RAW_PURCHASE_SHADOW_INVALID_QUANTITY);
    expect(() =>
      batchWriteOffMovementEffects([{ railLotId: "lot-1", quantityBefore: 0, quantityDelta: 0 }]),
    ).toThrow(RAW_PURCHASE_SHADOW_INVALID_QUANTITY);
  });
});

describe("SimplePurchase causation snapshot v1", () => {
  it("uses SimplePurchase.id as causation identity and omits unitPrice", () => {
    const snapshot = simplePurchaseCausationSnapshotV1({
      commandId: "spc-1",
      requestId: "req-sp",
      simplePurchaseId: "sp-1",
      nomenclatureId: "nom-1",
      quantity: 1,
    });
    expect(snapshot).toEqual({
      v: 1,
      d: "SIMPLE_PURCHASE",
      type: "CREATE",
      commandId: "spc-1",
      requestId: "req-sp",
      simplePurchaseId: "sp-1",
      nomenclatureId: "nom-1",
      quantity: 1,
    });
    expect(snapshot).not.toHaveProperty("unitPrice");
    expect(JSON.stringify(snapshot)).not.toMatch(MONEY_LEAK);
  });
});

describe("SimplePurchase receipt mapping", () => {
  it("emits one NOMENCLATURE RECEIPT and exact imfx1:receipt:<nomenclatureTargetHashV1>", () => {
    const effect = simplePurchaseReceiptEffect({ nomenclatureId: "nom-1", quantity: 4 });
    expect(effect).toEqual({
      role: "receipt",
      kind: "RECEIPT",
      quantityDelta: 4,
      target: { stockDomain: "NOMENCLATURE", nomenclatureId: "nom-1" },
    });
    const canonical = canonicalizeMovementTarget({
      stockDomain: "NOMENCLATURE",
      nomenclatureId: "nom-1",
    });
    expect(simplePurchaseReceiptEffectKey("nom-1")).toBe(
      effectKeyV1("receipt", canonical.targetHashV1),
    );
    expect(simplePurchaseReceiptEffectKey("nom-1")).toBe(`imfx1:receipt:${canonical.targetHashV1}`);
  });

  it("fails closed on non-positive SimplePurchase quantity", () => {
    expect(() => simplePurchaseReceiptEffect({ nomenclatureId: "nom-1", quantity: 0 })).toThrow(
      RAW_PURCHASE_SHADOW_INVALID_QUANTITY,
    );
    expect(() => simplePurchaseReceiptEffect({ nomenclatureId: "nom-1", quantity: -2 })).toThrow(
      RAW_PURCHASE_SHADOW_INVALID_QUANTITY,
    );
  });
});

describe("raw purchase USER actor seam", () => {
  it("requires USER and fails closed on retained-command admin mismatch", () => {
    const actor = userMovementActorFromAdmin({ id: "admin-1", name: "Иван" });
    expect(requireRawPurchaseUserActor(actor)).toEqual({
      actorKind: "USER",
      userId: "admin-1",
      actorDisplaySnapshot: "Иван",
    });
    expect(() =>
      requireRawPurchaseUserActor(
        systemMovementActor({ systemActorKey: "sys", actorDisplaySnapshot: "System" }),
      ),
    ).toThrow(RAW_PURCHASE_SHADOW_ACTOR_REQUIRED);
    expect(() =>
      assertRawPurchaseActorMatchesCommand({ actor, adminUserId: "other-admin" }),
    ).toThrow(RAW_PURCHASE_SHADOW_ACTOR_MISMATCH);
    expect(() =>
      assertRawPurchaseActorMatchesCommand({ actor, adminUserId: "admin-1" }),
    ).not.toThrow();
  });
});

describe("raw purchase SHADOW gateway result invariant", () => {
  it("accepts ACTIVE + expected nonzero insert count", () => {
    expect(() =>
      assertRawPurchaseShadowGatewayResult({
        result: { gateActive: true, inserted: 2 },
        expectedInserted: 2,
      }),
    ).not.toThrow();
  });

  it("fails closed when outer ACTIVE observes an inactive gateway", () => {
    expect(() =>
      assertRawPurchaseShadowGatewayResult({
        result: { gateActive: false, inserted: 0 },
        expectedInserted: 1,
      }),
    ).toThrow(RAW_PURCHASE_SHADOW_GATE_INVARIANT_VIOLATION);
  });

  it("fails closed when inserted count differs from the nonzero effect set", () => {
    expect(() =>
      assertRawPurchaseShadowGatewayResult({
        result: { gateActive: true, inserted: 0 },
        expectedInserted: 1,
      }),
    ).toThrow(RAW_PURCHASE_SHADOW_GATE_INVARIANT_VIOLATION);
    expect(() =>
      assertRawPurchaseShadowGatewayResult({
        result: { gateActive: true, inserted: 3 },
        expectedInserted: 2,
      }),
    ).toThrow(RAW_PURCHASE_SHADOW_GATE_INVARIANT_VIOLATION);
  });
});
