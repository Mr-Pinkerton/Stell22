import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function read(rel: string): string {
  return readFileSync(path.join(root, rel), "utf8");
}

describe("terminal production SHADOW writer confinement", () => {
  it("captures EMPLOYEE outside the TX and takes SHARED gate before physical writes", () => {
    const src = read("src/server/terminal.ts");
    expect(src).toContain("employeeMovementActor(employee)");
    expect(src).not.toContain('inventory_movement_shadow_write');
    expect(src).toContain("isInventoryMovementShadowWriteActiveForWriter");
    expect(src).toContain("appendProductionShadowMovements");
    expect(src).not.toContain("appendShadowInventoryMovements");
    expect(src).toContain("submitTorcovkaInTransaction");

    const torc = read("src/server/internal/submit-torcovka-tx.ts");
    expect(torc).not.toContain('inventory_movement_shadow_write');
    expect(torc).not.toContain("appendShadowInventoryMovements");
    const torcFn = torc.slice(torc.indexOf("export async function submitTorcovkaInTransaction"));
    const torcGate = torcFn.indexOf("isInventoryMovementShadowWriteActiveForWriter");
    expect(torcGate).toBeGreaterThan(-1);
    expect(torcFn.indexOf("productionOperation.create")).toBeGreaterThan(torcGate);
    expect(torcFn.indexOf("lockRailLots")).toBeGreaterThan(torcGate);
    expect(torcFn.indexOf("appendProductionShadowMovements")).toBeGreaterThan(
      torcFn.indexOf('planProductionShadowMovements({ kind: "TORCOVKA"'),
    );

    const pris = src.slice(src.indexOf("export async function submitPrisadka"));
    const prisGate = pris.indexOf("isInventoryMovementShadowWriteActiveForWriter");
    expect(pris.indexOf("productionOperation.create")).toBeGreaterThan(prisGate);
    expect(pris.indexOf("applyPrisadkaPicks")).toBeGreaterThan(prisGate);
    expect(pris.indexOf("appendProductionShadowMovements")).toBeGreaterThan(
      pris.indexOf("applyPrisadkaPicks"),
    );

    const upak = src.slice(src.indexOf("export async function submitUpakovka"));
    const upakGate = upak.indexOf("isInventoryMovementShadowWriteActiveForWriter");
    expect(upak.indexOf("lockUpakovkaPhysicalWriteSet")).toBeGreaterThan(upakGate);
    expect(upak.indexOf("applyUpakovkaPrepared")).toBeGreaterThan(
      upak.indexOf("lockUpakovkaPhysicalWriteSet"),
    );
    expect(upak.indexOf("appendProductionShadowMovements")).toBeGreaterThan(
      upak.indexOf("applyUpakovkaPrepared"),
    );
  });

  it("does not connect blocked admin/edit/delete/R-05 contours", () => {
    const production = read("src/server/production.ts");
    expect(production).not.toContain("appendProductionShadowMovements");
    expect(production).not.toContain("appendShadowInventoryMovements");
    expect(production).toContain("export async function updateProductionLineQuantity");
    expect(production).toContain("export async function deleteProductionOperation");
    expect(production).toContain("export async function correctTorcovkaRailsTaken");
  });
});
