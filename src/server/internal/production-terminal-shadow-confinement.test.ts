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
    expect([...upak.matchAll(/isCostFlowActive/g)]).toHaveLength(1);
    expect(upak).toMatch(
      /applyUpakovkaPrepared\(\s*tx,\s*op\.id,\s*pick\.quantity,\s*prepared,\s*\{\s*costFlowActive\s*\}\s*\)/,
    );
    expect(upak.indexOf("lockUpakovkaPhysicalWriteSet")).toBeGreaterThan(upak.indexOf("isCostFlowActive"));

    const reversal = read("src/server/internal/production-reversal.ts");
    const applyFn = reversal.slice(reversal.indexOf("export async function applyUpakovkaPrepared"));
    expect(applyFn).toContain("options?: { costFlowActive: boolean }");
    expect(applyFn).toMatch(
      /const costFlowActive = options \? options\.costFlowActive : await isCostFlowActive\(tx\)/,
    );
    const pickFn = reversal.slice(
      reversal.indexOf("export async function applyUpakovkaPick"),
      reversal.indexOf("export async function applyUpakovkaPrepared"),
    );
    expect(pickFn).toMatch(
      /await applyUpakovkaPrepared\(\s*tx,\s*operationId,\s*quantity,\s*prepared\s*\)/,
    );
    expect(pickFn).not.toMatch(
      /applyUpakovkaPrepared\(\s*tx,\s*operationId,\s*quantity,\s*prepared,\s*\{/,
    );

    const production = read("src/server/production.ts");
    const qeditTx = read("src/server/internal/production-quantity-edit-tx.ts");
    expect(qeditTx).toMatch(/applyUpakovkaPrepared\(\s*tx,\s*id,\s*newQty,\s*prepared\.upakovka\s*\)/);
    expect(production).not.toContain("{ costFlowActive }");
    expect(qeditTx).not.toContain("{ costFlowActive }");
  });

  it("does not connect blocked admin edit/delete contours", () => {
    const production = read("src/server/production.ts");
    expect(production).not.toContain("appendProductionShadowMovements");
    expect(production).not.toContain("appendShadowInventoryMovements");
    expect(production).toContain("export async function updateProductionLineQuantity");
    expect(production).toContain("export async function editProductionOperationQuantity");
    expect(production).toContain("export async function deleteProductionOperation");
    const qty = production.slice(production.indexOf("export async function updateProductionLineQuantity"));
    const del = production.slice(production.indexOf("export async function deleteProductionOperation"));
    const qeditTx = read("src/server/internal/production-quantity-edit-tx.ts");
    expect(qty).not.toContain("appendR05CorrectionShadowMovement");
    expect(qty).not.toContain("appendShadowInventoryMovements");
    expect(qeditTx).not.toContain("appendShadowInventoryMovements");
    expect(qeditTx).not.toContain("appendProductionShadowMovements");
    const qeditFn = qeditTx.slice(qeditTx.indexOf("export async function editProductionOperationQuantityInTransaction"));
    expect(qeditFn).toContain("appendQuantityEditShadowMovements");
    expect(qeditFn.indexOf("appendQuantityEditShadowMovements")).toBeGreaterThan(
      qeditFn.indexOf("productionOperationQuantityEdit.create"),
    );
    expect(qeditFn.indexOf("writeChangeLog")).toBeGreaterThan(
      qeditFn.indexOf("appendQuantityEditShadowMovements"),
    );
    expect(del).not.toContain("appendR05CorrectionShadowMovement");
  });
});
