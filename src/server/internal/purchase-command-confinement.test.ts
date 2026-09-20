import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd());

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("PSR-P2 raw identity confinement", () => {
  it("purchases runtime keeps retained identities and routes SHADOW only through the raw helper", () => {
    const purchases = read("src/server/purchases.ts");
    expect(purchases).toContain("acquirePurchaseCommandRequestLock");
    expect(purchases).toContain("batchCreationCommand");
    expect(purchases).toContain("batchRemainderWriteOff");
    expect(purchases).toContain("simplePurchaseCreationCommand");
    expect(purchases).toContain("isInventoryMovementShadowWriteActiveForWriter");
    expect(purchases).toContain("raw-purchase-shadow-write");
    expect(purchases).not.toMatch(/appendShadowInventoryMovements/);
    expect(purchases).not.toMatch(/supply-shadow-write/);
    expect(purchases).not.toMatch(/production-shadow-write/);
    expect(purchases).not.toMatch(/inventory-conduct/);
    expect(purchases).not.toMatch(/r05-correction-shadow-write/);
  });

  it("source feature connected InventoryMovement contours are exactly 9", () => {
    const purchases = read("src/server/purchases.ts");
    expect(purchases).toContain("export async function createBatch");
    expect(purchases).toContain("export async function writeOffBatchRemainder");
    expect(purchases).toContain("export async function createSimplePurchase");
    expect(purchases).toContain("appendBatchCreateShadowMovements");
    expect(purchases).toContain("appendBatchWriteOffShadowMovements");
    expect(purchases).toContain("appendSimplePurchaseShadowMovement");
    expect(purchases).not.toContain("appendShadowInventoryMovements");
  });
});
