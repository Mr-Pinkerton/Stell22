import { describe, expect, it } from "vitest";
import { evaluateMigratorPrivileges, migratorPrivilegeSql, migratorProbeArgv, parseMigratorPrivilegeReport, type MigratorPrivilegeReport } from "@/server/internal/p1-production-adapter/migrator-privilege";
import { PROPOSED_MIGRATOR_ROLE } from "@/server/internal/p1-production-adapter/contract";

function report(overrides: Partial<MigratorPrivilegeReport> = {}): MigratorPrivilegeReport {
  return {
    currentUser: PROPOSED_MIGRATOR_ROLE,
    sessionUser: PROPOSED_MIGRATOR_ROLE,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    rolcanlogin: true,
    rolinherit: false,
    memberships: [],
    batchOwner: PROPOSED_MIGRATOR_ROLE,
    migrationInsert: true,
    migrationUpdate: true,
    schemaCreate: true,
    publicCreate: false,
    otherLogin: [{ name: "p1pa_app", schemaCreate: false, memberOfMigrator: false, superuser: false }],
    ...overrides,
  };
}

describe("P1 migrator privileges", () => {
  it("accepts the dedicated non-superuser and refuses escalation", () => {
    const expected = { migratorRole: PROPOSED_MIGRATOR_ROLE, bootstrapRole: "p1pa" };
    expect(evaluateMigratorPrivileges(report(), expected)).toEqual({ ok: true });
    expect(evaluateMigratorPrivileges(report({ currentUser: "p1pa", sessionUser: "p1pa", batchOwner: "p1pa" }), expected).ok).toBe(false);
    expect(evaluateMigratorPrivileges(report({ rolsuper: true }), expected)).toMatchObject({ code: "MIGRATOR_ROLE_REFUSED" });
    expect(evaluateMigratorPrivileges(report({ rolinherit: true }), expected)).toMatchObject({ code: "MIGRATOR_ROLE_REFUSED" });
    expect(evaluateMigratorPrivileges(report({ memberships: ["p1pa"] }), expected)).toMatchObject({ code: "MIGRATOR_MEMBERSHIP_REFUSED" });
    expect(evaluateMigratorPrivileges(report({ batchOwner: "p1pa" }), expected)).toMatchObject({ code: "MIGRATOR_OWNERSHIP_REFUSED" });
    expect(evaluateMigratorPrivileges(report({ publicCreate: true }), expected)).toMatchObject({ code: "MIGRATOR_PRIVILEGE_REFUSED" });
    expect(evaluateMigratorPrivileges(report({ otherLogin: [] }), expected)).toMatchObject({ code: "APPLICATION_ROLE_UNBOUND" });
    expect(evaluateMigratorPrivileges(report({ otherLogin: [{ name: "p1pa_app", schemaCreate: true, memberOfMigrator: false, superuser: false }] }), expected)).toMatchObject({ code: "MIGRATOR_PRIVILEGE_REFUSED" });
    expect(migratorPrivilegeSql()).toContain("otherLogin");
    expect(migratorPrivilegeSql()).not.toContain("SET ROLE");
    expect(migratorProbeArgv("/tmp/p1.env", "p1pa-net", "db", "p1pa_db")).toContain("-i");
    expect(parseMigratorPrivilegeReport(report()).currentUser).toBe(PROPOSED_MIGRATOR_ROLE);
  });
});
