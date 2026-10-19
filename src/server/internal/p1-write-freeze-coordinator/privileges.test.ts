import { describe, expect, it } from "vitest";
import { freezeTransactionSql, unfreezeTransactionSql } from "@/server/internal/p1-write-freeze-coordinator/privileges";

describe("privilege scripts", () => {
  it("revokes application writes in one transaction and does not use NOLOGIN", () => {
    const sql = freezeTransactionSql("p1wc_abcdef12");
    expect(sql.startsWith("BEGIN;")).toBe(true);
    expect(sql.endsWith("COMMIT;")).toBe(true);
    expect(sql.match(/BEGIN;/g)).toHaveLength(1);
    expect(sql).toContain("REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ALL TABLES");
    expect(sql).toContain("FROM p1wc_app, PUBLIC");
    expect(sql).toContain("REVOKE ALL PRIVILEGES ON ALL SEQUENCES");
    expect(sql).toContain("REVOKE CREATE ON SCHEMA public");
    expect(sql).toContain('REVOKE CREATE ON DATABASE "p1wc_abcdef12"');
    expect(sql).toContain("column_privileges");
    expect(sql).toContain("prosecdef");
    expect(sql).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE p1wc_migrator");
    expect(sql).not.toContain("NOLOGIN");
    expect(sql).not.toContain("default_transaction_read_only");
    expect(() => freezeTransactionSql("stell22")).toThrow(/database name/);
  });

  it("restores DML without granting schema CREATE", () => {
    const sql = unfreezeTransactionSql("p1wc_abcdef12");
    expect(sql).toContain("GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES");
    expect(sql).toContain("GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES");
    expect(sql).not.toContain("CREATE ON SCHEMA");
    expect(sql).not.toContain("CREATE ON DATABASE");
  });
});
