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

describe("R-05 correction SHADOW writer confinement", () => {
  it("captures USER outside the TX and takes SHARED gate before request lock and physical writes", () => {
    const action = read("src/server/production.ts");
    const fn = action.slice(action.indexOf("export async function correctTorcovkaRailsTaken"));
    expect(fn).toContain("const admin = await requireAdmin()");
    expect(fn).toContain("userMovementActorFromAdmin(admin)");
    expect(fn).toMatch(/isolationLevel:\s*Prisma\.TransactionIsolationLevel\.ReadCommitted/);
    expect(fn).toContain("correctTorcovkaRailsTakenInTransaction");
    expect(fn).not.toContain("appendShadowInventoryMovements");
    expect(fn).not.toContain('inventory_movement_shadow_write');

    const tx = read("src/server/internal/correct-torcovka-rails-taken-tx.ts");
    expect(tx).not.toContain('inventory_movement_shadow_write');
    expect(tx).not.toContain("appendShadowInventoryMovements");
    const body = tx.slice(tx.indexOf("export async function correctTorcovkaRailsTakenInTransaction"));
    const gateAt = body.indexOf("isInventoryMovementShadowWriteActiveForWriter");
    expect(gateAt).toBeGreaterThan(-1);
    expect(body.indexOf("acquireCorrectionRequestLock")).toBeGreaterThan(gateAt);
    expect(body.indexOf("lockProductionOperations")).toBeGreaterThan(
      body.indexOf("acquireCorrectionRequestLock"),
    );
    expect(body.indexOf("appendR05CorrectionShadowMovement")).toBeGreaterThan(
      body.indexOf("productionOperationCorrection.create"),
    );
    expect(body.indexOf("writeChangeLog")).toBeGreaterThan(body.indexOf("appendR05CorrectionShadowMovement"));
  });

  it("routes InventoryMovement INSERT only through the R-05 wrapper + approved gateway", () => {
    const wrapper = read("src/server/internal/r05-correction-shadow-write.ts");
    expect(wrapper).toContain("appendShadowInventoryMovements");
    expect(wrapper).toContain("PRODUCTION_OPERATION_MUTATION");
    expect(wrapper).toContain("rails-taken");
    expect(wrapper).toContain("R05_SHADOW_GATE_INVARIANT_VIOLATION");
    expect(wrapper).toContain("effectiveAt: input.correction.recordedAt");

    const purchases = read("src/server/purchases.ts");
    expect(purchases).not.toContain("appendShadowInventoryMovements");
    expect(purchases).not.toContain("appendR05CorrectionShadowMovement");
    expect(purchases).toContain("export async function createBatch");
    expect(purchases).toContain("export async function writeOffBatchRemainder");
    expect(purchases).toContain("export async function createSimplePurchase");

    const production = read("src/server/production.ts");
    const delStart = production.indexOf("export async function deleteProductionOperation");
    const corrStart = production.indexOf("export async function correctTorcovkaRailsTaken");
    const qtyFn = production.slice(
      production.indexOf("export async function updateProductionLineQuantity"),
      delStart,
    );
    const delFn = production.slice(delStart, corrStart);
    expect(production).toContain("export async function editProductionOperationQuantity");
    expect(qtyFn).not.toContain("appendR05CorrectionShadowMovement");
    expect(qtyFn).not.toContain("appendProductionShadowMovements");
    expect(qtyFn).not.toContain("appendShadowInventoryMovements");
    expect(delFn).not.toContain("appendR05CorrectionShadowMovement");
    expect(delFn).not.toContain("appendProductionShadowMovements");
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
    expect(read("src/server/purchases.ts")).not.toContain("appendShadowInventoryMovements");
    expect(read("src/server/warehouse.ts")).not.toContain("appendShadowInventoryMovements");
    expect(read("src/server/terminal.ts")).not.toContain("appendShadowInventoryMovements");
    expect(read("src/server/production.ts")).not.toContain("appendShadowInventoryMovements");
  });
});
