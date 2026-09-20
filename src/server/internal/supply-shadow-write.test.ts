import { describe, expect, it } from "vitest";
import { canonicalizeMovementTarget, effectKeyV1 } from "@/server/internal/inventory-movement-identity";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import {
  SUPPLY_SHADOW_ACTOR_REQUIRED,
  SUPPLY_SHADOW_CONTEXT_REQUIRED,
  SUPPLY_SHADOW_GATE_INVARIANT_VIOLATION,
  assertSupplyShadowGatewayResult,
  requireSupplyShadowContext,
  requireSupplyUserActor,
  supplyConsumeCausationSnapshotV1,
  supplyConsumeEffectKey,
  supplyConsumeMovementEffect,
  supplyConsumeQualifier,
  supplyRestoreCausationSnapshotV1,
  supplyRestoreEffectKey,
  supplyRestoreMovementEffect,
  supplyRestoreQualifier,
} from "@/server/internal/supply-shadow-write";

const consumeFacts = {
  supplyId: "supply-1",
  marketplace: "OZON",
  externalId: "800001",
  sku: "OZ-SKU",
  productId: "product-1",
  stockAccountingGeneration: 1,
  processedQtyAfter: 10,
  deductedQtyAfter: 6,
  shortfallQtyAfter: 4,
  quantityDelta: -6,
};

const restoreFacts = {
  supplyId: "supply-1",
  marketplace: "OZON",
  externalId: "800001",
  sku: "OZ-SKU",
  productId: "product-1",
  stockAccountingGeneration: 1,
  deductedQtyBeforeClose: 7,
  shortfallQtyBeforeClose: 3,
  quantityDelta: 7,
};

describe("Supply consume causation snapshot v1", () => {
  it("pins the exact semantic shape without money or live display fields", () => {
    const snapshot = supplyConsumeCausationSnapshotV1(consumeFacts);
    expect(snapshot).toEqual({
      v: 1,
      d: "SUPPLY",
      type: "CONSUME",
      supplyId: "supply-1",
      marketplace: "OZON",
      externalId: "800001",
      sku: "OZ-SKU",
      productId: "product-1",
      stockAccountingGeneration: 1,
      processedQtyAfter: 10,
      deductedQtyAfter: 6,
      shortfallQtyAfter: 4,
      quantityDelta: -6,
    });
    expect(JSON.stringify(snapshot)).toBe(
      JSON.stringify({
        v: 1,
        d: "SUPPLY",
        type: "CONSUME",
        supplyId: "supply-1",
        marketplace: "OZON",
        externalId: "800001",
        sku: "OZ-SKU",
        productId: "product-1",
        stockAccountingGeneration: 1,
        processedQtyAfter: 10,
        deductedQtyAfter: 6,
        shortfallQtyAfter: 4,
        quantityDelta: -6,
      }),
    );
    expect(JSON.stringify(snapshot)).not.toMatch(/₽|cost|value|money|provider|changeLog/i);
    expect(snapshot).not.toHaveProperty("productName");
    expect(snapshot).not.toHaveProperty("accountedQtyAfter");
  });
});

describe("Supply consume effectKey", () => {
  it("uses imfx1:consume:<productTargetHashV1>:g=<generation>:w=<processedQtyAfter>", () => {
    const effect = supplyConsumeMovementEffect(consumeFacts);
    expect(effect).toEqual({
      role: "consume",
      kind: "CONSUMPTION",
      quantityDelta: -6,
      target: { stockDomain: "PRODUCT", productId: "product-1" },
      qualifier: "g=1:w=10",
    });
    const canonical = canonicalizeMovementTarget({
      stockDomain: "PRODUCT",
      productId: "product-1",
    });
    expect(supplyConsumeQualifier(1, 10)).toBe("g=1:w=10");
    expect(supplyConsumeEffectKey("product-1", 1, 10)).toBe(
      effectKeyV1("consume", canonical.targetHashV1, "g=1:w=10"),
    );
    expect(supplyConsumeEffectKey("product-1", 1, 15)).toBe(
      `imfx1:consume:${canonical.targetHashV1}:g=1:w=15`,
    );
    expect(supplyConsumeEffectKey("product-1", 1, 10)).not.toBe(
      supplyConsumeEffectKey("product-1", 1, 15),
    );
  });
});

describe("Supply restore causation snapshot v1", () => {
  it("pins the exact RESTORE shape without live SKU re-resolution", () => {
    const snapshot = supplyRestoreCausationSnapshotV1(restoreFacts);
    expect(snapshot).toEqual({
      v: 1,
      d: "SUPPLY",
      type: "RESTORE",
      supplyId: "supply-1",
      marketplace: "OZON",
      externalId: "800001",
      sku: "OZ-SKU",
      productId: "product-1",
      stockAccountingGeneration: 1,
      deductedQtyBeforeClose: 7,
      shortfallQtyBeforeClose: 3,
      quantityDelta: 7,
    });
    expect(JSON.stringify(snapshot)).toBe(
      JSON.stringify({
        v: 1,
        d: "SUPPLY",
        type: "RESTORE",
        supplyId: "supply-1",
        marketplace: "OZON",
        externalId: "800001",
        sku: "OZ-SKU",
        productId: "product-1",
        stockAccountingGeneration: 1,
        deductedQtyBeforeClose: 7,
        shortfallQtyBeforeClose: 3,
        quantityDelta: 7,
      }),
    );
    expect(JSON.stringify(snapshot)).not.toMatch(/₽|cost|value|money|reversal/i);
  });
});

describe("Supply restore effectKey", () => {
  it("uses imfx1:restore:<productTargetHashV1>:g=<generation>:w=<deductedQtyBeforeClose>", () => {
    const effect = supplyRestoreMovementEffect(restoreFacts);
    expect(effect).toEqual({
      role: "restore",
      kind: "ADJUSTMENT",
      quantityDelta: 7,
      target: { stockDomain: "PRODUCT", productId: "product-1" },
      qualifier: "g=1:w=7",
    });
    const canonical = canonicalizeMovementTarget({
      stockDomain: "PRODUCT",
      productId: "product-1",
    });
    expect(supplyRestoreQualifier(1, 7)).toBe("g=1:w=7");
    expect(supplyRestoreEffectKey("product-1", 1, 7)).toBe(
      effectKeyV1("restore", canonical.targetHashV1, "g=1:w=7"),
    );
    expect(supplyRestoreEffectKey("product-1", 1, 7)).toBe(
      `imfx1:restore:${canonical.targetHashV1}:g=1:w=7`,
    );
  });
});

describe("Supply USER actor seam", () => {
  it("retains authenticated admin User.id rather than a marketplace provider", () => {
    const actor = userMovementActorFromAdmin({ id: "admin-1", name: "Иван" });
    expect(requireSupplyUserActor(actor)).toEqual({
      actorKind: "USER",
      userId: "admin-1",
      actorDisplaySnapshot: "Иван",
    });
    expect(() =>
      requireSupplyUserActor({
        actorKind: "SYSTEM",
        systemActorKey: "marketplace-sync",
        actorDisplaySnapshot: "Ozon",
      }),
    ).toThrow(SUPPLY_SHADOW_ACTOR_REQUIRED);
    expect(() =>
      requireSupplyUserActor({
        actorKind: "EMPLOYEE",
        employeeId: "emp-1",
        actorDisplaySnapshot: "Работник",
      }),
    ).toThrow(SUPPLY_SHADOW_ACTOR_REQUIRED);
  });
});

describe("Supply SHADOW required context", () => {
  it("rejects omitted or malformed gate snapshots instead of treating them as OFF", () => {
    expect(SUPPLY_SHADOW_CONTEXT_REQUIRED).toBe("SUPPLY_SHADOW_CONTEXT_REQUIRED");
    expect(() => requireSupplyShadowContext(undefined)).toThrow(SUPPLY_SHADOW_CONTEXT_REQUIRED);
    expect(() => requireSupplyShadowContext(null)).toThrow(SUPPLY_SHADOW_CONTEXT_REQUIRED);
    expect(() => requireSupplyShadowContext({} as never)).toThrow(SUPPLY_SHADOW_CONTEXT_REQUIRED);
    expect(() =>
      requireSupplyShadowContext({
        actor: userMovementActorFromAdmin({ id: "u1", name: "Admin" }),
      } as never),
    ).toThrow(SUPPLY_SHADOW_CONTEXT_REQUIRED);
  });

  it("accepts an explicit ACTIVE or OFF decision with a USER actor", () => {
    const actor = userMovementActorFromAdmin({ id: "u1", name: "Admin" });
    expect(requireSupplyShadowContext({ active: false, actor })).toEqual({
      active: false,
      actor,
    });
    expect(requireSupplyShadowContext({ active: true, actor }).active).toBe(true);
  });
});

describe("Supply SHADOW gateway result invariant", () => {
  it("accepts exactly one ACTIVE insert", () => {
    expect(() =>
      assertSupplyShadowGatewayResult({ result: { gateActive: true, inserted: 1 } }),
    ).not.toThrow();
  });

  it("fails closed when ACTIVE writer observes an inactive gateway result", () => {
    expect(() =>
      assertSupplyShadowGatewayResult({ result: { gateActive: false, inserted: 0 } }),
    ).toThrow(SUPPLY_SHADOW_GATE_INVARIANT_VIOLATION);
    expect(SUPPLY_SHADOW_GATE_INVARIANT_VIOLATION).toBe(
      "SUPPLY_SHADOW_GATE_INVARIANT_VIOLATION",
    );
  });

  it("fails closed when inserted count is not 1", () => {
    expect(() =>
      assertSupplyShadowGatewayResult({ result: { gateActive: true, inserted: 0 } }),
    ).toThrow(SUPPLY_SHADOW_GATE_INVARIANT_VIOLATION);
    expect(() =>
      assertSupplyShadowGatewayResult({ result: { gateActive: true, inserted: 2 } }),
    ).toThrow(SUPPLY_SHADOW_GATE_INVARIANT_VIOLATION);
  });
});
