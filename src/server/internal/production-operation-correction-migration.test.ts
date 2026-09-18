import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260918120000_psr_p2_r05_production_operation_correction/migration.sql",
);

describe("R-05 ProductionOperationCorrection migration", () => {
  it("creates empty table with uniqueness/CHECKs and does not touch InventoryMovement", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(/CREATE TABLE "ProductionOperationCorrection"/);
    expect(sql).toMatch(/"recordedAt" TIMESTAMPTZ\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/ProductionOperationCorrection_requestId_key/);
    expect(sql).toMatch(/ProductionOperationCorrection_expectedOld_positive/);
    expect(sql).toMatch(/ProductionOperationCorrection_new_positive/);
    expect(sql).toMatch(/ProductionOperationCorrection_expected_gt_new/);
    expect(sql).toMatch(/ProductionOperationCorrection_delta_positive/);
    expect(sql).toMatch(/ProductionOperationCorrection_delta_identity/);
    expect(sql).toMatch(/ProductionOperationCorrection_reason_nonblank/);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+"InventoryMovement"/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).not.toMatch(/REFERENCES /i);
  });
});
