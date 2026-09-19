import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import {
  INVENTORY_DUAL_ACTIVE_UNSUPPORTED,
  INVENTORY_SHADOW_WRITER_NOT_CONNECTED,
  decideInventoryShadowSafety,
} from "@/server/internal/inventory-conduct";

describe("decideInventoryShadowSafety", () => {
  it("lets existing Inventory proceed when SHADOW is inactive", () => {
    expect(
      decideInventoryShadowSafety({ shadowWriteActive: false, costFlowActive: false }),
    ).toEqual({ action: "proceed" });
    expect(
      decideInventoryShadowSafety({ shadowWriteActive: false, costFlowActive: true }),
    ).toEqual({ action: "proceed" });
  });

  it("fails closed with INVENTORY_SHADOW_WRITER_NOT_CONNECTED when SHADOW is ACTIVE and cost-flow is not", () => {
    expect(
      decideInventoryShadowSafety({ shadowWriteActive: true, costFlowActive: false }),
    ).toEqual({ action: "fail", error: INVENTORY_SHADOW_WRITER_NOT_CONNECTED });
  });

  it("fails closed with INVENTORY_DUAL_ACTIVE_UNSUPPORTED when both gates are ACTIVE", () => {
    expect(
      decideInventoryShadowSafety({ shadowWriteActive: true, costFlowActive: true }),
    ).toEqual({ action: "fail", error: INVENTORY_DUAL_ACTIVE_UNSUPPORTED });
    expect(INVENTORY_DUAL_ACTIVE_UNSUPPORTED).not.toBe(INVENTORY_SHADOW_WRITER_NOT_CONNECTED);
  });
});

describe("Inventory USER actor seam", () => {
  it("retains authenticated User.id rather than a hardcoded Admin label", () => {
    const actor = userMovementActorFromAdmin({
      id: "user-inventory-actor",
      name: "Инвентаризатор",
    });
    expect(actor).toEqual({
      actorKind: "USER",
      userId: "user-inventory-actor",
      actorDisplaySnapshot: "Инвентаризатор",
    });
    expect(actor.actorKind).toBe("USER");
    expect(actor.actorDisplaySnapshot).not.toBe("Admin");
  });
});

describe("Inventory conduct SHADOW gate confinement", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

  it("uses only the writer-facing helper and does not call appendShadowInventoryMovements", () => {
    const src = readFileSync(path.join(root, "src/server/internal/inventory-conduct.ts"), "utf8");
    expect(src).toContain("isInventoryMovementShadowWriteActiveForWriter");
    expect(src).not.toContain("inventory_movement_shadow_write");
    expect(src).not.toContain("appendShadowInventoryMovements");
    expect(src).not.toContain("readInventoryMovementShadowWriteGate");
  });

  it("server action captures requireAdmin() before the transaction and passes the USER actor", () => {
    const src = readFileSync(path.join(root, "src/server/warehouse.ts"), "utf8");
    expect(src).toContain("const admin = await requireAdmin()");
    expect(src).toContain("userMovementActorFromAdmin(admin)");
    expect(src).toContain("conductInventoryInTransaction(tx, { docId, actor })");
    expect(src).not.toContain("appendShadowInventoryMovements");
    expect(src).not.toMatch(/await requireAdmin\(\);\s*\n\s*const updated = await prisma\.\$transaction/);
  });
});
