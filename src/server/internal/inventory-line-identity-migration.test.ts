import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260918130000_psr_p2_r06_inventory_line_identity/migration.sql",
);

describe("R-06 InventoryLine identity migration", () => {
  it("adds uniqueness only and does not rewrite history, stock, or InventoryMovement", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    const code = sql
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(code).toMatch(/CREATE UNIQUE INDEX "InventoryLine_inventoryId_refType_refId_key"/);
    expect(code).toMatch(/ON "InventoryLine"\("inventoryId", "refType", "refId"\)/);
    expect(code).toMatch(/^\s*BEGIN\s*;/m);
    expect(code).toMatch(/^\s*COMMIT\s*;/m);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+"/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/InventoryMovement/i);
    expect(code).not.toMatch(/BlankStock/i);
    expect(code).not.toMatch(/DetailStock/i);
    expect(code).not.toMatch(/ProductStock/i);
    expect(code).not.toMatch(/NomenclatureStock/i);
    expect(code).not.toMatch(/\bTRIGGER\b/i);
    expect(code).not.toMatch(/ON DELETE CASCADE/i);
    expect(code).not.toMatch(/REFERENCES /i);
  });
});
