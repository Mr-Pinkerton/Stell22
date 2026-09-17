import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
  process.cwd(),
  "prisma/migrations/20260917180000_psr_p2_inventory_movement_recorded_at_timestamptz/migration.sql",
);

describe("R-07 recordedAt timestamptz migration", () => {
  it("guards against existing rows then alters recordedAt to TIMESTAMPTZ(3)", () => {
    const sql = fs.readFileSync(migrationPath, "utf8");
    expect(sql).toMatch(/IF EXISTS \(SELECT 1 FROM "InventoryMovement"\)/);
    expect(sql).toMatch(/RAISE EXCEPTION 'InventoryMovement contains rows; refusing recordedAt timestamp conversion'/);
    expect(sql).toMatch(/ALTER COLUMN "recordedAt" TYPE TIMESTAMPTZ\(3\)/);
    expect(sql).toMatch(/ALTER COLUMN "recordedAt" SET DEFAULT CURRENT_TIMESTAMP/);
    expect(sql).not.toMatch(/TYPE TIMESTAMPTZ\(3\)\s+USING/i);
  });
});

describe("InventoryMovement causal UNIQUE", () => {
  it("remains UNIQUE(causationKind, causationId, effectKey) without epochId", () => {
    const schema = fs.readFileSync(path.join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const model = schema.slice(schema.indexOf("model InventoryMovement"), schema.indexOf("model Account"));
    expect(model).toContain("@@unique([causationKind, causationId, effectKey])");
    expect(model).not.toMatch(/@@unique\(\[[^\]]*epochId/);
  });
});
