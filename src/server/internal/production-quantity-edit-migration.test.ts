import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260920180000_psr_p2_production_quantity_edit_identity/migration.sql",
);

describe("Package 2 ProductionOperationQuantityEdit migration", () => {
  it("creates empty table with uniqueness/CHECKs and does not touch InventoryMovement", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(/CREATE TABLE "ProductionOperationQuantityEdit"/);
    expect(sql).toMatch(/"recordedAt" TIMESTAMPTZ\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    expect(sql).toMatch(/ProductionOperationQuantityEdit_requestId_key/);
    expect(sql).toMatch(/ProductionOperationQuantityEdit_expectedOld_positive/);
    expect(sql).toMatch(/ProductionOperationQuantityEdit_new_positive/);
    expect(sql).toMatch(/ProductionOperationQuantityEdit_physical_type/);
    expect(sql).toMatch(/ProductionOperationQuantityEdit_target_by_type/);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+"InventoryMovement"/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).not.toMatch(/REFERENCES /i);
  });
});
