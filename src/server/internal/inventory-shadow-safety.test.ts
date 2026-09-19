import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import {
  INVENTORY_DUAL_ACTIVE_UNSUPPORTED,
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

  it("lets Inventory proceed when SHADOW is ACTIVE and cost-flow is inactive (writer connected)", () => {
    expect(
      decideInventoryShadowSafety({ shadowWriteActive: true, costFlowActive: false }),
    ).toEqual({ action: "proceed" });
  });

  it("fails closed with INVENTORY_DUAL_ACTIVE_UNSUPPORTED when both gates are ACTIVE", () => {
    expect(
      decideInventoryShadowSafety({ shadowWriteActive: true, costFlowActive: true }),
    ).toEqual({ action: "fail", error: INVENTORY_DUAL_ACTIVE_UNSUPPORTED });
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

  it("uses only the writer-facing helper and calls appendShadowInventoryMovements after projection", () => {
    const src = readFileSync(path.join(root, "src/server/internal/inventory-conduct.ts"), "utf8");
    expect(src).toContain("isInventoryMovementShadowWriteActiveForWriter");
    expect(src).not.toContain("inventory_movement_shadow_write");
    expect(src).toContain("appendShadowInventoryMovements");
    expect(src).not.toContain("readInventoryMovementShadowWriteGate");
    expect(src).not.toContain("INVENTORY_SHADOW_WRITER_NOT_CONNECTED");
    const applyIdx = src.indexOf("applyInactiveInventoryPhysicalEffects");
    const appendIdx = src.indexOf("appendShadowInventoryMovements");
    const flipIdx = src.indexOf("status: \"CONDUCTED\"");
    expect(applyIdx).toBeGreaterThan(-1);
    expect(appendIdx).toBeGreaterThan(applyIdx);
    expect(flipIdx).toBeGreaterThan(appendIdx);
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
