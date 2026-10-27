import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATION_NAME, MIGRATION_SHA256 } from "../admin-corrections-release/decide.mjs";

const sql = fs.readFileSync(path.join(process.cwd(), "scripts", "p1-writer-preflight.sql"), "utf8");

describe("p1 writer preflight inventory file", () => {
  it("names the admin-corrections migration and its checksum in both expected lists", () => {
    const tuple = `('${MIGRATION_NAME}', '${MIGRATION_SHA256}')`;
    expect(sql.split(tuple)).toHaveLength(3);
    expect(sql).toContain(") AS expected(migration_name, checksum)) = 47");
    expect(sql).toContain('SELECT count(*) FROM public."_prisma_migrations"');
    expect(sql).toContain(") = 47");
    expect(sql).not.toContain("checksum)) = 46");
    expect(sql).not.toContain("\n  ) = 46\n");
    expect(sql).toContain("pg_get_functiondef");
    expect(sql).toContain("pg_get_triggerdef");
    expect(sql).toContain("batch_creation_command_provenance_guard");
  });
});
