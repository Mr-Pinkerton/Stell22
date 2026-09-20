import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260920120000_psr_p2_raw_identity_prerequisite/migration.sql",
);

describe("PSR-P2 raw identity prerequisite migration", () => {
  it("creates empty identity tables with uniqueness/CHECKs and does not touch InventoryMovement", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(/CREATE TABLE "BatchCreationCommand"/);
    expect(sql).toMatch(/CREATE TABLE "BatchRemainderWriteOff"/);
    expect(sql).toMatch(/CREATE TABLE "SimplePurchaseCreationCommand"/);
    expect(sql).toMatch(/"recordedAt" TIMESTAMPTZ\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/BatchCreationCommand_requestId_key/);
    expect(sql).toMatch(/BatchCreationCommand_batchId_key/);
    expect(sql).toMatch(/BatchRemainderWriteOff_requestId_key/);
    expect(sql).toMatch(/BatchRemainderWriteOff_batchId_recordedAt_idx/);
    expect(sql).toMatch(/SimplePurchaseCreationCommand_requestId_key/);
    expect(sql).toMatch(/SimplePurchaseCreationCommand_simplePurchaseId_key/);
    expect(sql).toMatch(/BatchCreationCommand_requestId_nonblank/);
    expect(sql).toMatch(/BatchRemainderWriteOff_requestId_nonblank/);
    expect(sql).toMatch(/SimplePurchaseCreationCommand_requestId_nonblank/);
    expect(sql).toMatch(/BatchRemainderWriteOff_totalQuantity_positive/);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+"InventoryMovement"/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).not.toMatch(/REFERENCES /i);
  });
});
