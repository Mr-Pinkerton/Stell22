import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(process.cwd());

function read(rel: string): string {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("PSR-P2 raw identity confinement", () => {
  it("purchases runtime does not import SHADOW writers or gate helpers", () => {
    const purchases = read("src/server/purchases.ts");
    expect(purchases).toContain("acquirePurchaseCommandRequestLock");
    expect(purchases).toContain("batchCreationCommand");
    expect(purchases).toContain("batchRemainderWriteOff");
    expect(purchases).toContain("simplePurchaseCreationCommand");
    expect(purchases).not.toMatch(/appendShadowInventoryMovements/);
    expect(purchases).not.toMatch(/isInventoryMovementShadowWriteActiveForWriter/);
    expect(purchases).not.toMatch(/supply-shadow-write/);
    expect(purchases).not.toMatch(/production-shadow-write/);
    expect(purchases).not.toMatch(/inventory-conduct/);
    expect(purchases).not.toMatch(/r05-correction-shadow-write/);
  });

  it("source connected InventoryMovement contours remain exactly 6", () => {
    const purchases = read("src/server/purchases.ts");
    expect(purchases).toContain("export async function createBatch");
    expect(purchases).toContain("export async function writeOffBatchRemainder");
    expect(purchases).toContain("export async function createSimplePurchase");
    expect(purchases).not.toMatch(/InventoryMovement/);
  });
});
