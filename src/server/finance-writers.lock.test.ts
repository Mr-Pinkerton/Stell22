import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

function extractFn(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}`);
  if (start < 0) throw new Error(`missing export async function ${name}`);
  const brace = src.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unclosed ${name}`);
}

function expectInsideTransaction(body: string, needle: string) {
  const tx = body.indexOf("$transaction");
  expect(tx, `${needle}: missing $transaction`).toBeGreaterThan(-1);
  expect(body.indexOf(needle), `${needle} must appear`).toBeGreaterThan(-1);
  expect(body.indexOf(needle), `${needle} must be inside $transaction`).toBeGreaterThan(tx);
}

describe("DI-013 finance writers wrap lock + sync inside source TX", () => {
  const finance = readFileSync(path.join(here, "finance.ts"), "utf8");
  const statementImport = readFileSync(
    path.join(here, "internal", "statement-import.ts"),
    "utf8",
  );

  it("CashFlow writers lock Account before Deal/Batch and sync inside the TX", () => {
    for (const name of [
      "createCashFlow",
      "createTransfer",
      "assignCashFlow",
      "deleteCashFlow",
      "convertCashFlowToTransfer",
      "reapplyAutoRules",
      "deleteStatement",
    ]) {
      const body = extractFn(finance, name);
      expect(body, name).toContain("lockAccountsThenDealsThenBatches");
      expect(body, name).not.toContain("syncDealAndEnqueue");
      expect(body, name).not.toContain("syncBatchAndEnqueue");
    }

    expectInsideTransaction(extractFn(finance, "createCashFlow"), "syncDealInternal");
    expectInsideTransaction(extractFn(finance, "assignCashFlow"), "syncDealInternal");
    expectInsideTransaction(extractFn(finance, "deleteCashFlow"), "syncDealInternal");
    expectInsideTransaction(extractFn(finance, "convertCashFlowToTransfer"), "syncDealInternal");
    expectInsideTransaction(extractFn(finance, "reapplyAutoRules"), "syncDealInternal");
    expectInsideTransaction(extractFn(finance, "deleteStatement"), "syncDealInternal");
    expectInsideTransaction(extractFn(finance, "createTransfer"), "lockAccountsThenDealsThenBatches");
  });

  it("Deal writers lock Deal→Batch (no Account) and sync inside the TX", () => {
    for (const name of ["createDeal", "updateDeal", "deleteDeal"]) {
      const body = extractFn(finance, name);
      expect(body, name).toContain("lockDealsThenBatches");
      expect(body, name).not.toContain("lockAccountsThenDealsThenBatches");
      expect(body, name).not.toContain("syncDealAndEnqueue");
      expect(body, name).not.toContain("syncBatchAndEnqueue");
    }
    expectInsideTransaction(extractFn(finance, "createDeal"), "syncDealInternal");
    expectInsideTransaction(extractFn(finance, "updateDeal"), "syncDealInternal");
    expectInsideTransaction(extractFn(finance, "deleteDeal"), "syncBatchTotalCostInternal");
  });

  it("importStatementInternal locks Account, then syncs deals inside the same TX", () => {
    const body = extractFn(statementImport, "importStatementInternal");
    expectInsideTransaction(body, "lockAccountsThenDealsThenBatches");
    expectInsideTransaction(body, "syncDealInternal");
    const afterTx = body.indexOf("const statementId = result.statementId");
    expect(afterTx).toBeGreaterThan(body.indexOf("syncDealInternal"));
    expect(body.slice(afterTx)).not.toContain("syncDealInternal");
  });
});
