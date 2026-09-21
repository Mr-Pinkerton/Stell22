import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

function walkTs(relDir: string, acc: string[] = []): string[] {
  const abs = path.join(root, relDir);
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`.replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (entry.name === "integrity") continue;
      walkTs(rel, acc);
      continue;
    }
    if (!entry.isFile() || !/\.(ts|tsx)$/.test(entry.name)) continue;
    if (entry.name.includes(".test.")) continue;
    acc.push(rel);
  }
  return acc;
}

describe("Package 3 quantity-edit SHADOW writer confinement", () => {
  it("captures USER outside the TX and takes SHARED gate before request lock and physical writes", () => {
    const action = read("src/server/production.ts");
    const fn = action.slice(action.indexOf("export async function editProductionOperationQuantity"));
    expect(fn).toContain("const admin = await requireAdmin()");
    expect(fn).toContain("userMovementActorFromAdmin(admin)");
    expect(fn).toMatch(/isolationLevel:\s*Prisma\.TransactionIsolationLevel\.ReadCommitted/);
    expect(fn).toContain("editProductionOperationQuantityInTransaction");
    expect(fn).not.toContain("appendShadowInventoryMovements");
    expect(fn).not.toContain("inventory_movement_shadow_write");

    const tx = read("src/server/internal/production-quantity-edit-tx.ts");
    expect(tx).not.toContain("inventory_movement_shadow_write");
    expect(tx).not.toContain("appendShadowInventoryMovements");
    expect(tx).not.toContain("throw new Error(QUANTITY_EDIT_SHADOW_WRITER_NOT_READY)");
    const body = tx.slice(tx.indexOf("export async function editProductionOperationQuantityInTransaction"));
    const gateAt = body.indexOf("isInventoryMovementShadowWriteActiveForWriter");
    expect(gateAt).toBeGreaterThan(-1);
    expect(body.indexOf("acquireQuantityEditRequestLock")).toBeGreaterThan(gateAt);
    expect(body.indexOf("lockProductionOperations")).toBeGreaterThan(
      body.indexOf("acquireQuantityEditRequestLock"),
    );
    expect(body.indexOf("appendQuantityEditShadowMovements")).toBeGreaterThan(
      body.indexOf("productionOperationQuantityEdit.create"),
    );
    expect(body.indexOf("writeChangeLog")).toBeGreaterThan(body.indexOf("appendQuantityEditShadowMovements"));
  });

  it("routes InventoryMovement INSERT only through the Package 3 wrapper + approved gateway", () => {
    const wrapper = read("src/server/internal/production-quantity-edit-shadow-write.ts");
    expect(wrapper).toContain("appendShadowInventoryMovements");
    expect(wrapper).toContain("PRODUCTION_OPERATION_MUTATION");
    expect(wrapper).toContain("QUANTITY_EDIT");
    expect(wrapper).toContain("QUANTITY_EDIT_SHADOW_GATE_INVARIANT_VIOLATION");
    expect(wrapper).toContain("effectiveAt: input.quantityEdit.recordedAt");
    expect(wrapper).not.toContain("qualifier");
    expect(wrapper).not.toMatch(/INSERT\s+INTO\s+"InventoryMovement"/i);
    expect(wrapper).not.toContain("inventoryMovement.create");

    const production = read("src/server/production.ts");
    expect(production).not.toContain("appendQuantityEditShadowMovements");
    expect(production).not.toContain("appendShadowInventoryMovements");
  });

  it("runtime appendShadowInventoryMovements callers remain confined to approved writers", () => {
    const callers = walkTs("src").filter((rel) =>
      read(rel).includes("appendShadowInventoryMovements"),
    );
    expect(callers.sort()).toEqual([
      "src/server/internal/inventory-conduct.ts",
      "src/server/internal/inventory-movement-shadow-gateway.ts",
      "src/server/internal/production-quantity-edit-shadow-write.ts",
      "src/server/internal/production-shadow-write.ts",
      "src/server/internal/r05-correction-shadow-write.ts",
      "src/server/internal/raw-purchase-shadow-write.ts",
      "src/server/internal/supply-shadow-write.ts",
    ]);
  });
});
