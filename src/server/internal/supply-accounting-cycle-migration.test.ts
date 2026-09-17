import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260917200000_psr_p2_r04_supply_stock_accounting_cycle/migration.sql",
);

describe("R-04 Supply stock-accounting cycle migration", () => {
  it("adds generation/open, backfills watermarks only, and does not touch InventoryMovement", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(/ADD COLUMN "stockAccountingGeneration" INTEGER NOT NULL DEFAULT 0/);
    expect(sql).toMatch(/ADD COLUMN "stockAccountingOpen" BOOLEAN NOT NULL DEFAULT false/);
    expect(sql).toMatch(/WHERE "deductedQty" > 0\s+OR "shortfallQty" > 0/);
    expect(sql).toMatch(/stockAccountingGeneration" = 1/);
    expect(sql).toMatch(/stockAccountingOpen" = true/);
    expect(sql).toMatch(/Supply_stockAccountingGeneration_nonnegative/);
    expect(sql).toMatch(/Supply_stockAccountingOpen_generation/);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+"InventoryMovement"/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
  });
});
