import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance/migration.sql",
);

describe("PSR-P3 Slice 2-B P1 provenance migration", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");

  it("adds one nullable JSONB column, a shape check, and an update/delete guard", () => {
    expect(sql).toMatch(/^BEGIN;\s/m);
    expect(sql).toMatch(/\nCOMMIT;\s*$/);
    expect(sql).toMatch(
      /ALTER TABLE "BatchCreationCommand"\s+ADD COLUMN "receiptProvenanceSnapshot" JSONB;/,
    );
    expect(sql).toMatch(
      /"receiptProvenanceSnapshot" IS NULL\s+OR jsonb_typeof\("receiptProvenanceSnapshot"\) = 'object'/,
    );
    expect(sql).toMatch(
      /CREATE TRIGGER "batch_creation_command_provenance_guard"\s+BEFORE UPDATE OR DELETE ON "BatchCreationCommand"/,
    );
    expect(sql).toMatch(/IS DISTINCT FROM/);
    expect(sql).not.toMatch(/SECURITY DEFINER/);
    expect(sql).not.toMatch(/ADD COLUMN "receiptProvenanceSnapshot" JSONB[^;]*DEFAULT/i);
    expect(sql).not.toMatch(/"receiptProvenanceSnapshot" JSONB NOT NULL/);
  });

  it("does not backfill, reference other tables, or touch InventoryMovement", () => {
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+"BatchCreationCommand"\s+SET\b/i);
    expect(sql).not.toMatch(/REFERENCES /i);
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
    expect(sql).not.toMatch(/"InventoryMovement"/);
    expect(sql).not.toMatch(/CREATE TABLE/i);
  });
});
