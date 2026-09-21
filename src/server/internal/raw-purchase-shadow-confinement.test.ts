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

function fnSlice(src: string, exportName: string, nextExport?: string): string {
  const start = src.indexOf(`export async function ${exportName}`);
  const end = nextExport ? src.indexOf(`export async function ${nextExport}`, start + 1) : src.length;
  return src.slice(start, end === -1 ? src.length : end);
}

describe("raw purchase SHADOW writer confinement", () => {
  it("captures USER outside TX and takes SHARED gate before request and business locks", () => {
    const purchases = read("src/server/purchases.ts");
    for (const name of ["createBatch", "writeOffBatchRemainder", "createSimplePurchase"] as const) {
      const next =
        name === "createBatch"
          ? "updateBatch"
          : name === "writeOffBatchRemainder"
            ? "deleteBatch"
            : undefined;
      const fn = fnSlice(purchases, name, next);
      expect(fn).toContain("const admin = await requireAdmin()");
      expect(fn).toContain("userMovementActorFromAdmin(admin)");
      const gateAt = fn.indexOf("isInventoryMovementShadowWriteActiveForWriter(tx)");
      expect(gateAt).toBeGreaterThan(-1);
      expect(fn.indexOf("acquirePurchaseCommandRequestLock")).toBeGreaterThan(gateAt);
      expect(fn).not.toContain("appendShadowInventoryMovements");
      expect(fn).not.toContain("inventory_movement_shadow_write");
      expect(fn).not.toContain("readInventoryMovementShadowWriteGate");
    }

    const create = fnSlice(purchases, "createBatch", "updateBatch");
    expect(create.indexOf("appendBatchCreateShadowMovements")).toBeGreaterThan(
      create.indexOf("batchCreationCommand.create"),
    );
    expect(create.indexOf("writeChangeLog")).toBeGreaterThan(
      create.indexOf("appendBatchCreateShadowMovements"),
    );

    const writeOff = fnSlice(purchases, "writeOffBatchRemainder", "deleteBatch");
    expect(writeOff.indexOf("lockRailLots")).toBeGreaterThan(
      writeOff.indexOf("acquirePurchaseCommandRequestLock"),
    );
    expect(writeOff.indexOf("appendBatchWriteOffShadowMovements")).toBeGreaterThan(
      writeOff.indexOf("batchRemainderWriteOff.create"),
    );
    expect(writeOff.indexOf("writeChangeLog")).toBeGreaterThan(
      writeOff.indexOf("appendBatchWriteOffShadowMovements"),
    );

    const simple = fnSlice(purchases, "createSimplePurchase");
    expect(simple.indexOf("appendSimplePurchaseShadowMovement")).toBeGreaterThan(
      simple.indexOf("simplePurchaseCreationCommand.create"),
    );
    expect(simple.indexOf("writeChangeLog")).toBeGreaterThan(
      simple.indexOf("appendSimplePurchaseShadowMovement"),
    );
  });

  it("routes InventoryMovement INSERT only through the raw wrapper + approved gateway", () => {
    const wrapper = read("src/server/internal/raw-purchase-shadow-write.ts");
    expect(wrapper).toContain("appendShadowInventoryMovements");
    expect(wrapper).toContain("RAW_PURCHASE_SHADOW_GATE_INVARIANT_VIOLATION");
    expect(wrapper).toContain('causationKind: "BATCH"');
    expect(wrapper).toContain('causationKind: "SIMPLE_PURCHASE"');
    expect(wrapper).toContain("effectiveAt: input.command.recordedAt");
    expect(wrapper).not.toContain("inventoryMovement.create");
    expect(wrapper).not.toMatch(/INSERT\s+INTO\s+"InventoryMovement"/);

    const purchases = read("src/server/purchases.ts");
    expect(purchases).not.toContain("appendShadowInventoryMovements");
    expect(purchases).toContain("appendBatchCreateShadowMovements");
    expect(purchases).toContain("appendBatchWriteOffShadowMovements");
    expect(purchases).toContain("appendSimplePurchaseShadowMovement");
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
  });
});
