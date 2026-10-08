import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("upakovka recovery receipt migration", () => {
  const sql = readFileSync(
    path.join(root, "prisma/migrations/20261008120000_upakovka_recovery_receipt/migration.sql"),
    "utf8",
  );

  it("adds an empty unique ledger and does not touch existing operations", () => {
    expect(sql).toMatch(/CREATE TABLE "UpakovkaRecoveryReceipt"/);
    expect(sql).toMatch(/UpakovkaRecoveryReceipt_recordedRequestId_productId_key/);
    expect(sql).toMatch(/"recordedRequestId", "productId"/);
    expect(sql).toMatch(/UpakovkaRecoveryReceipt_quantity_positive/);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i);
    expect(sql).not.toMatch(/ALTER TABLE "ProductionOperation"/);
  });

  it("keeps recovery identity on the server, not in terminal memory", () => {
    const server = readFileSync(path.join(root, "src/server/terminal.ts"), "utf8");
    expect(server).toContain("upakovkaRecoveryReceipt.create");
    expect(server).not.toContain("separatelyPacked");
  });
});
