import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INVENTORY_MOVEMENT_SHADOW_RESET_CONFIRM,
  evaluateInventoryMovementShadowReset,
} from "./inventory-movement-shadow-reset-policy";

describe("evaluateInventoryMovementShadowReset", () => {
  const allowedBase = {
    confirm: INVENTORY_MOVEMENT_SHADOW_RESET_CONFIRM,
    shadowWriteActive: false,
    authoritativeCount: 0,
  };

  it("refuses without explicit confirmation token", () => {
    const result = evaluateInventoryMovementShadowReset({
      ...allowedBase,
      confirm: undefined,
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected refusal");
    expect(result.code).toBe("CONFIRM_REQUIRED");
  });

  it("refuses a wrong confirmation token", () => {
    const result = evaluateInventoryMovementShadowReset({
      ...allowedBase,
      confirm: "yes",
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected refusal");
    expect(result.code).toBe("CONFIRM_REQUIRED");
  });

  it("refuses when SHADOW writing is active", () => {
    const result = evaluateInventoryMovementShadowReset({
      ...allowedBase,
      shadowWriteActive: true,
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected refusal");
    expect(result.code).toBe("SHADOW_WRITE_ACTIVE");
  });

  it("refuses when any AUTHORITATIVE row exists", () => {
    const result = evaluateInventoryMovementShadowReset({
      ...allowedBase,
      authoritativeCount: 1,
    });
    expect(result.allowed).toBe(false);
    if (result.allowed) throw new Error("expected refusal");
    expect(result.code).toBe("AUTHORITATIVE_PRESENT");
  });

  it("allows reset only when inactive, no AUTHORITATIVE rows, and confirmed", () => {
    expect(evaluateInventoryMovementShadowReset(allowedBase)).toEqual({ allowed: true });
  });
});

describe("R-10 SHADOW reset script SQL", () => {
  it("deletes only SHADOW rows and is never unrestricted", () => {
    const script = fs.readFileSync(
      path.join(process.cwd(), "scripts/reset-inventory-movement-shadow.ts"),
      "utf8",
    );
    expect(script).toContain(
      `DELETE FROM "InventoryMovement" WHERE "authority" = 'SHADOW'::"InventoryMovementAuthority"`,
    );
    expect(script).not.toMatch(/DELETE\s+FROM\s+"InventoryMovement"\s*;/i);
    const resetLockAt = script.indexOf("acquireInventoryMovementShadowControlLock");
    const gateReadAt = script.indexOf("readInventoryMovementShadowWriteGate");
    const deleteAt = script.indexOf(
      `DELETE FROM "InventoryMovement" WHERE "authority" = 'SHADOW'::"InventoryMovementAuthority"`,
    );
    expect(resetLockAt).toBeGreaterThan(-1);
    expect(gateReadAt).toBeGreaterThan(resetLockAt);
    expect(deleteAt).toBeGreaterThan(gateReadAt);
  });
});
