import { describe, expect, it } from "vitest";
import { canonicalizeMovementTarget, effectKeyV1 } from "@/server/internal/inventory-movement-identity";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import {
  R05_CORRECTION_CAUSATION_DOMAIN,
  R05_CORRECTION_CAUSATION_TYPE,
  R05_CORRECTION_EFFECT_QUALIFIER,
  R05_SHADOW_GATE_INVARIANT_VIOLATION,
  assertR05ShadowGatewayResult,
  r05CorrectionCausationSnapshotV1,
  r05CorrectionEffectKey,
  r05CorrectionMovementEffect,
} from "@/server/internal/r05-correction-shadow-write";

const row = {
  id: "corr-1",
  requestId: "req-1",
  operationId: "op-1",
  adminUserId: "admin-1",
  railLotId: "lot-1",
  batchId: "batch-1",
  expectedOldRailsTaken: 10,
  newRailsTaken: 7,
  deltaReturned: 3,
  reason: "over-entered",
  recordedAt: new Date("2026-09-19T12:00:00.000Z"),
};

describe("R-05 correction causation snapshot v1", () => {
  it("pins the exact semantic shape without money or display labels", () => {
    expect(r05CorrectionCausationSnapshotV1(row)).toEqual({
      v: 1,
      d: "PRODUCTION_OPERATION_MUTATION",
      type: "R05_TORCOVKA_RAILS_TAKEN",
      correctionId: "corr-1",
      requestId: "req-1",
      operationId: "op-1",
      railLotId: "lot-1",
      batchId: "batch-1",
      expectedOldRailsTaken: 10,
      newRailsTaken: 7,
      deltaReturned: 3,
    });
    expect(R05_CORRECTION_CAUSATION_DOMAIN).toBe("PRODUCTION_OPERATION_MUTATION");
    expect(R05_CORRECTION_CAUSATION_TYPE).toBe("R05_TORCOVKA_RAILS_TAKEN");
    const snapshot = r05CorrectionCausationSnapshotV1(row);
    expect(JSON.stringify(snapshot)).not.toMatch(/₽|cost|value|money/i);
    expect(snapshot).not.toHaveProperty("reason");
    expect(snapshot).not.toHaveProperty("adminUserId");
  });
});

describe("R-05 correction movement effectKey", () => {
  it("uses imfx1:adjust:<railLotTargetHashV1>:rails-taken", () => {
    const effect = r05CorrectionMovementEffect(row);
    expect(effect).toEqual({
      role: "adjust",
      kind: "ADJUSTMENT",
      quantityDelta: 3,
      target: { stockDomain: "RAIL_LOT", railLotId: "lot-1" },
      qualifier: "rails-taken",
    });
    const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId: "lot-1" });
    expect(r05CorrectionEffectKey("lot-1")).toBe(
      effectKeyV1("adjust", canonical.targetHashV1, R05_CORRECTION_EFFECT_QUALIFIER),
    );
    expect(r05CorrectionEffectKey("lot-1")).toBe(`imfx1:adjust:${canonical.targetHashV1}:rails-taken`);
  });
});

describe("R-05 USER actor seam", () => {
  it("retains authenticated admin User.id rather than re-resolving inside the TX", () => {
    const actor = userMovementActorFromAdmin({ id: "admin-1", name: "Иван" });
    expect(actor).toEqual({
      actorKind: "USER",
      userId: "admin-1",
      actorDisplaySnapshot: "Иван",
    });
    expect(actor.actorKind).toBe("USER");
    if (actor.actorKind !== "USER") throw new Error("expected USER actor");
    expect(actor.userId).toBe(row.adminUserId);
  });
});

describe("R-05 SHADOW gateway result invariant", () => {
  it("accepts exactly one ACTIVE insert", () => {
    expect(() =>
      assertR05ShadowGatewayResult({ result: { gateActive: true, inserted: 1 } }),
    ).not.toThrow();
  });

  it("fails closed when ACTIVE writer observes an inactive gateway result", () => {
    expect(() =>
      assertR05ShadowGatewayResult({ result: { gateActive: false, inserted: 0 } }),
    ).toThrow(R05_SHADOW_GATE_INVARIANT_VIOLATION);
  });

  it("fails closed when inserted count is not 1", () => {
    expect(() =>
      assertR05ShadowGatewayResult({ result: { gateActive: true, inserted: 0 } }),
    ).toThrow(R05_SHADOW_GATE_INVARIANT_VIOLATION);
    expect(() =>
      assertR05ShadowGatewayResult({ result: { gateActive: true, inserted: 2 } }),
    ).toThrow(R05_SHADOW_GATE_INVARIANT_VIOLATION);
  });
});
