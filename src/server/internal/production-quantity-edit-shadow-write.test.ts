import { describe, expect, it } from "vitest";
import { canonicalizeMovementTarget, effectKeyV1 } from "@/server/internal/inventory-movement-identity";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import {
  QUANTITY_EDIT_CAUSATION_DOMAIN,
  QUANTITY_EDIT_CAUSATION_TYPE,
  QUANTITY_EDIT_SHADOW_ACTOR_MISMATCH,
  QUANTITY_EDIT_SHADOW_GATE_INVARIANT_VIOLATION,
  QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID,
  assertQuantityEditShadowGatewayResult,
  parseQuantityEditPhysicalAdjustments,
  quantityEditCausationSnapshotV1,
  quantityEditEffectKey,
  quantityEditMovementEffect,
} from "@/server/internal/production-quantity-edit-shadow-write";

const row = {
  id: "qedit-1",
  requestId: "req-1",
  operationId: "op-1",
  adminUserId: "admin-1",
  actorDisplaySnapshot: "Admin",
  operationType: "TORCOVKA" as const,
  targetLineId: "line-1",
  expectedOldQuantity: 10,
  newQuantity: 12,
  recordedAt: new Date("2026-09-21T12:00:00.000Z"),
};

const blankAdj = {
  targetType: "BLANK" as const,
  materialId: "mat-1",
  lengthM: "1.8000",
  detailType: "POLKA" as const,
  sort: "SORT1" as const,
  quantityDelta: 2,
};

describe("Package 3 quantity-edit causation snapshot v1", () => {
  it("pins the exact semantic shape with shared R-05 domain marker", () => {
    expect(quantityEditCausationSnapshotV1(row)).toEqual({
      v: 1,
      d: "PRODUCTION_OPERATION_MUTATION",
      type: "QUANTITY_EDIT",
      quantityEditId: "qedit-1",
      requestId: "req-1",
      operationId: "op-1",
      operationType: "TORCOVKA",
      targetLineId: "line-1",
      expectedOldQuantity: 10,
      newQuantity: 12,
      effectSnapshotVersion: 1,
    });
    expect(QUANTITY_EDIT_CAUSATION_DOMAIN).toBe("PRODUCTION_OPERATION_MUTATION");
    expect(QUANTITY_EDIT_CAUSATION_TYPE).toBe("QUANTITY_EDIT");
    const snapshot = quantityEditCausationSnapshotV1({ ...row, targetLineId: null, operationType: "UPAKOVKA" });
    expect(snapshot.targetLineId).toBeNull();
    expect(snapshot.operationType).toBe("UPAKOVKA");
    expect(JSON.stringify(snapshot)).not.toMatch(/₽|cost|value|money|amount|price/i);
    expect(snapshot).not.toHaveProperty("adminUserId");
    expect(snapshot.d).not.toBe("PRODUCTION_QUANTITY_EDIT");
  });
});

describe("Package 3 quantity-edit movement effectKey", () => {
  it("uses imfx1:adjust:<targetHashV1> without qualifier", () => {
    const effect = quantityEditMovementEffect(blankAdj);
    expect(effect).toEqual({
      role: "adjust",
      kind: "ADJUSTMENT",
      quantityDelta: 2,
      target: {
        stockDomain: "BLANK",
        materialId: "mat-1",
        lengthM: "1.8000",
        detailType: "POLKA",
        sort: "SORT1",
      },
    });
    expect(effect).not.toHaveProperty("qualifier");
    const canonical = canonicalizeMovementTarget(effect.target);
    expect(quantityEditEffectKey(effect.target)).toBe(effectKeyV1("adjust", canonical.targetHashV1));
    expect(quantityEditEffectKey(effect.target)).toBe(`imfx1:adjust:${canonical.targetHashV1}`);
    expect(quantityEditEffectKey(effect.target)).not.toContain(":rails-taken");
  });
});

describe("Package 3 retained effectSnapshot parser", () => {
  it("accepts a valid v1 net adjustment set", () => {
    expect(
      parseQuantityEditPhysicalAdjustments({
        v: 1,
        before: {},
        after: {},
        physicalAdjustments: [
          blankAdj,
          {
            targetType: "DETAIL",
            detailId: "det-1",
            torcevayaDone: true,
            ploskostDone: false,
            quantityDelta: -2,
          },
          { targetType: "NOMENCLATURE", nomenclatureId: "nom-1", quantityDelta: -1 },
          { targetType: "PRODUCT", productId: "prod-1", quantityDelta: 1 },
        ],
      }),
    ).toHaveLength(4);
  });

  it("fails closed on malformed version, unsupported type, zero, non-integer, and duplicate target", () => {
    expect(() => parseQuantityEditPhysicalAdjustments(null)).toThrow(QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID);
    expect(() => parseQuantityEditPhysicalAdjustments({ v: 2, physicalAdjustments: [] })).toThrow(
      QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID,
    );
    expect(() =>
      parseQuantityEditPhysicalAdjustments({
        v: 1,
        physicalAdjustments: [{ targetType: "RAIL_LOT", railLotId: "lot-1", quantityDelta: 1 }],
      }),
    ).toThrow(QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID);
    expect(() =>
      parseQuantityEditPhysicalAdjustments({
        v: 1,
        physicalAdjustments: [{ ...blankAdj, quantityDelta: 0 }],
      }),
    ).toThrow(QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID);
    expect(() =>
      parseQuantityEditPhysicalAdjustments({
        v: 1,
        physicalAdjustments: [{ ...blankAdj, quantityDelta: 1.5 }],
      }),
    ).toThrow(QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID);
    expect(() =>
      parseQuantityEditPhysicalAdjustments({
        v: 1,
        physicalAdjustments: [
          blankAdj,
          { ...blankAdj, quantityDelta: -1 },
        ],
      }),
    ).toThrow(QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID);
    expect(() =>
      parseQuantityEditPhysicalAdjustments({
        v: 1,
        physicalAdjustments: [{ targetType: "BLANK", materialId: "mat-1", quantityDelta: 1 }],
      }),
    ).toThrow(QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID);
  });
});

describe("Package 3 USER actor seam", () => {
  it("retains authenticated admin User.id rather than re-resolving inside the TX", () => {
    const actor = userMovementActorFromAdmin({ id: "admin-1", name: "Иван" });
    expect(actor).toEqual({
      actorKind: "USER",
      userId: "admin-1",
      actorDisplaySnapshot: "Иван",
    });
    expect(QUANTITY_EDIT_SHADOW_ACTOR_MISMATCH).toBe("QUANTITY_EDIT_SHADOW_ACTOR_MISMATCH");
  });
});

describe("Package 3 SHADOW gateway result invariant", () => {
  it("accepts ACTIVE insert count equal to retained nonzero adjustments", () => {
    expect(() =>
      assertQuantityEditShadowGatewayResult({ result: { gateActive: true, inserted: 2 }, expectedInserted: 2 }),
    ).not.toThrow();
    expect(() =>
      assertQuantityEditShadowGatewayResult({ result: { gateActive: true, inserted: 0 }, expectedInserted: 0 }),
    ).not.toThrow();
  });

  it("fails closed when ACTIVE writer observes inactive or mismatched gateway result", () => {
    expect(() =>
      assertQuantityEditShadowGatewayResult({ result: { gateActive: false, inserted: 0 }, expectedInserted: 1 }),
    ).toThrow(QUANTITY_EDIT_SHADOW_GATE_INVARIANT_VIOLATION);
    expect(() =>
      assertQuantityEditShadowGatewayResult({ result: { gateActive: true, inserted: 0 }, expectedInserted: 1 }),
    ).toThrow(QUANTITY_EDIT_SHADOW_GATE_INVARIANT_VIOLATION);
    expect(() =>
      assertQuantityEditShadowGatewayResult({ result: { gateActive: true, inserted: 2 }, expectedInserted: 1 }),
    ).toThrow(QUANTITY_EDIT_SHADOW_GATE_INVARIANT_VIOLATION);
  });
});
