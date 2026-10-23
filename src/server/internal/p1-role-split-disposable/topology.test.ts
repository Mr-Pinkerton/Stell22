import { describe, expect, it } from "vitest";
import { evaluateMigratorPrivileges } from "@/server/internal/p1-production-adapter/migrator-privilege";
import { PRODUCTION_ROLE_NAME, PROPOSED_MIGRATOR_ROLE } from "@/server/internal/p1-production-adapter/contract";
import {
  DISPOSABLE_ADMIN_ROLE,
  DISPOSABLE_APP_ROLE,
  MIGRATOR_ROLE,
  migrationHistoryPrivilegesSql,
  roleTopologySql,
} from "@/server/internal/p1-role-split-disposable/topology";

const password = "ab".repeat(16);
const otherPassword = "cd".repeat(16);

describe("disposable role topology", () => {
  it("keeps the production login, the proposed migrator, and a separate application role", () => {
    expect(MIGRATOR_ROLE).toBe(PROPOSED_MIGRATOR_ROLE);
    expect(MIGRATOR_ROLE).toBe("stell22_migrator");
    expect(DISPOSABLE_APP_ROLE).toBe("stell22_app");
    expect(DISPOSABLE_ADMIN_ROLE).toBe("p1as_admin");
    expect(DISPOSABLE_APP_ROLE).not.toBe(PRODUCTION_ROLE_NAME);
    expect(MIGRATOR_ROLE).not.toBe(PRODUCTION_ROLE_NAME);
    expect(DISPOSABLE_ADMIN_ROLE).not.toBe(PRODUCTION_ROLE_NAME);
    expect(PRODUCTION_ROLE_NAME).toBe("stell22");
  });

  it("grants the migrator schema CREATE and withholds it from the application", () => {
    const sql = roleTopologySql({ databaseName: "p1as_abcdef01", appPassword: password, migratorPassword: otherPassword });
    expect(sql).toContain("REVOKE ALL ON DATABASE p1as_abcdef01 FROM PUBLIC");
    expect(sql).toContain("REVOKE CREATE ON SCHEMA public FROM PUBLIC");
    expect(sql).toContain("REVOKE USAGE ON SCHEMA public FROM PUBLIC");
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO stell22_app");
    expect(sql).toContain("GRANT USAGE, CREATE ON SCHEMA public TO stell22_migrator");
    expect(sql).not.toContain("GRANT CREATE ON SCHEMA public TO stell22_app");
    expect(sql).not.toContain("GRANT stell22_migrator TO stell22_app");
    expect(sql).not.toContain("GRANT stell22_app TO stell22_migrator");
    expect(sql).not.toContain("ALTER ROLE p1as_admin");
    expect(sql.match(/NOSUPERUSER/g)).toHaveLength(2);
    expect(sql).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE stell22_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stell22_app");
    expect(sql).toContain("GRANT USAGE, SELECT ON SEQUENCES TO stell22_app");
    expect(sql).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE stell22_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    expect(sql).not.toContain("IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    expect(sql).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE stell22_migrator IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO stell22_app");
    expect(sql).not.toContain("stell22;");
    expect(sql).not.toContain("DATABASE stell22");
  });

  it("lets the application read migration history without writing it", () => {
    const sql = migrationHistoryPrivilegesSql();
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public."_prisma_migrations" FROM stell22_app');
    expect(sql).toContain('GRANT SELECT ON TABLE public."_prisma_migrations" TO stell22_app');
    expect(sql).not.toContain("GRANT INSERT");
    expect(sql).not.toContain("GRANT UPDATE");
  });

  it("refuses a production database name or a shared credential", () => {
    expect(() => roleTopologySql({ databaseName: "stell22", appPassword: password, migratorPassword: otherPassword })).toThrow(/refused|not accepted/);
    expect(() => roleTopologySql({ databaseName: "p1as_abcdef01", appPassword: password, migratorPassword: password })).toThrow(/differ/);
    expect(() => roleTopologySql({ databaseName: "p1as_ABCDEF01", appPassword: password, migratorPassword: otherPassword })).toThrow(/not accepted/);
  });

  it("accepts the disposable privilege split and refuses application schema CREATE", () => {
    const accepted = evaluateMigratorPrivileges(report(false), { migratorRole: MIGRATOR_ROLE, bootstrapRole: DISPOSABLE_ADMIN_ROLE });
    expect(accepted).toEqual({ ok: true });
    const refused = evaluateMigratorPrivileges(report(true), { migratorRole: MIGRATOR_ROLE, bootstrapRole: DISPOSABLE_ADMIN_ROLE });
    expect(refused).toEqual({ ok: false, code: "MIGRATOR_PRIVILEGE_REFUSED" });
  });
});

function report(appSchemaCreate: boolean) {
  return {
    currentUser: MIGRATOR_ROLE,
    sessionUser: MIGRATOR_ROLE,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    rolcanlogin: true,
    rolinherit: false,
    memberships: [],
    batchOwner: MIGRATOR_ROLE,
    migrationInsert: true,
    migrationUpdate: true,
    schemaCreate: true,
    publicCreate: false,
    otherLogin: [{ name: DISPOSABLE_APP_ROLE, schemaCreate: appSchemaCreate, memberOfMigrator: false, superuser: false }],
  };
}
