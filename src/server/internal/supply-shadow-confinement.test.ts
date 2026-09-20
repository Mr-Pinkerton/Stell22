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

describe("Supply SHADOW writer confinement", () => {
  it("captures USER outside the TX and takes SHARED gate before marketplace writes", () => {
    const action = read("src/server/marketplace.ts");
    const fn = action.slice(action.indexOf("export async function syncMarketplaces"));
    expect(fn).toContain("const admin = await requireAdmin()");
    expect(fn).toContain("userMovementActorFromAdmin(admin)");
    expect(fn).toContain("syncMarketplacesAsUserInternal(actor)");
    expect(fn).not.toContain("appendShadowInventoryMovements");
    expect(fn).not.toContain("inventory_movement_shadow_write");
    expect(fn).not.toContain("isInventoryMovementShadowWriteActiveForWriter");

    const sync = read("src/server/internal/marketplace-sync.ts");
    expect(sync).toContain("requireSupplyUserActor");
    expect(sync).not.toContain("appendShadowInventoryMovements");
    expect(sync).not.toContain("inventory_movement_shadow_write");
    const persist = sync.slice(sync.indexOf("export async function persistMarketplaceSyncInTransaction"));
    const gateAt = persist.indexOf("isInventoryMovementShadowWriteActiveForWriter(tx)");
    expect(gateAt).toBeGreaterThan(-1);
    expect(persist.indexOf("sale.upsert")).toBeGreaterThan(gateAt);
    expect(persist.indexOf("runSupplySyncAccounting")).toBeGreaterThan(persist.indexOf("sale.upsert"));
    expect(persist.indexOf("mpStock.deleteMany")).toBeGreaterThan(
      persist.indexOf("runSupplySyncAccounting"),
    );
    expect(persist.indexOf('entity: "MpStock"')).toBeGreaterThan(persist.indexOf("mpStock.deleteMany"));
    expect(persist.indexOf("lockSuppliesInOrder")).toBe(-1);
  });

  it("places consume/restore movements after ProductStock mutation and before accounting completion", () => {
    const deduct = read("src/server/internal/supply-deduct.ts");
    expect(deduct).not.toContain("appendShadowInventoryMovements");
    expect(deduct).not.toContain("inventory_movement_shadow_write");
    expect(deduct).not.toContain("isInventoryMovementShadowWriteActiveForWriter");

    const applyDeduct = deduct.slice(deduct.indexOf("export async function applySupplyDeduction"));
    const decrementAt = applyDeduct.indexOf("quantity: { decrement: toRemove }");
    const consumeAt = applyDeduct.indexOf("appendSupplyConsumeShadowMovement");
    const watermarkAt = applyDeduct.indexOf("deductedQty: newDeducted");
    expect(decrementAt).toBeGreaterThan(-1);
    expect(consumeAt).toBeGreaterThan(decrementAt);
    expect(watermarkAt).toBeGreaterThan(consumeAt);

    const applyCancel = deduct.slice(deduct.indexOf("export async function applyOzonSupplyCancellation"));
    const incrementAt = applyCancel.indexOf("quantity: { increment: decision.restoreQty }");
    const restoreAt = applyCancel.indexOf("appendSupplyRestoreShadowMovement");
    const resetAt = applyCancel.indexOf('status: "PENDING"');
    expect(incrementAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeGreaterThan(incrementAt);
    expect(resetAt).toBeGreaterThan(restoreAt);
  });

  it("routes InventoryMovement INSERT only through the Supply wrapper + approved gateway", () => {
    const wrapper = read("src/server/internal/supply-shadow-write.ts");
    expect(wrapper).toContain("appendShadowInventoryMovements");
    expect(wrapper).toContain("SUPPLY_SHADOW_GATE_INVARIANT_VIOLATION");
    expect(wrapper).toContain('causationKind: "SUPPLY"');
    expect(wrapper).toContain("effectiveAt: input.occurredAt");

    expect(read("src/server/purchases.ts")).not.toContain("appendSupplyConsumeShadowMovement");
    expect(read("src/server/warehouse.ts")).not.toContain("appendSupplyRestoreShadowMovement");
    expect(read("src/server/terminal.ts")).not.toContain("appendSupplyConsumeShadowMovement");
    expect(read("src/lib/marketplace-map.ts")).not.toContain("appendShadowInventoryMovements");
  });

  it("runtime appendShadowInventoryMovements callers remain confined to approved writers", () => {
    const callers = walkTs("src").filter((rel) =>
      read(rel).includes("appendShadowInventoryMovements"),
    );
    expect(callers.sort()).toEqual([
      "src/server/internal/inventory-conduct.ts",
      "src/server/internal/inventory-movement-shadow-gateway.ts",
      "src/server/internal/production-shadow-write.ts",
      "src/server/internal/r05-correction-shadow-write.ts",
      "src/server/internal/supply-shadow-write.ts",
    ]);
    expect(read("src/server/marketplace.ts")).not.toContain("appendShadowInventoryMovements");
    expect(read("src/server/purchases.ts")).not.toContain("appendShadowInventoryMovements");
    expect(read("src/server/warehouse.ts")).not.toContain("appendShadowInventoryMovements");
    expect(read("src/server/terminal.ts")).not.toContain("appendShadowInventoryMovements");
    expect(read("src/server/production.ts")).not.toContain("appendShadowInventoryMovements");
  });

  it("runtime Supply physical helpers stay behind persistMarketplaceSyncInTransaction", () => {
    const runtime = walkTs("src");
    expect(
      runtime.filter((rel) => read(rel).includes("runSupplySyncAccounting(")).sort(),
    ).toEqual([
      "src/server/internal/marketplace-sync.ts",
      "src/server/internal/supply-deduct.ts",
    ]);
    expect(
      runtime.filter((rel) => /applySupplyDeduction\s*\(/.test(read(rel))).sort(),
    ).toEqual(["src/server/internal/supply-deduct.ts"]);
    expect(
      runtime.filter((rel) => /applyOzonSupplyCancellation\s*\(/.test(read(rel))).sort(),
    ).toEqual(["src/server/internal/supply-deduct.ts"]);

    const persist = read("src/server/internal/marketplace-sync.ts").slice(
      read("src/server/internal/marketplace-sync.ts").indexOf(
        "export async function persistMarketplaceSyncInTransaction",
      ),
    );
    expect(persist).toContain("runSupplySyncAccounting(tx,");
    expect(persist).toContain("shadowWriteActive");
    expect(persist).toContain("actor");

    const deduct = read("src/server/internal/supply-deduct.ts");
    expect(deduct).toContain("shadow: SupplyShadowContext");
    expect(deduct).toContain("requireSupplyShadowContext");
    expect(deduct).not.toContain("shadowWriteActive?: boolean");
    expect(deduct).not.toContain("actor?: MovementActorSnapshot");
  });
});
