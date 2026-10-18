import { describe, expect, it } from "vitest";
import { evaluateMigratorPrivileges, decideMigratorProbe, migratorPrivilegeSql, migratorProbeArgv, parseMigratorPrivilegeReport, probeMigratorPrivileges, type MigratorPrivilegeReport } from "@/server/internal/p1-production-adapter/migrator-privilege";
import { PRODUCTION_POSTGRES_IMAGE, PROPOSED_MIGRATOR_ROLE } from "@/server/internal/p1-production-adapter/contract";

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
    const imageId = `sha256:${"ab".repeat(32)}`;
    const argv = migratorProbeArgv("/tmp/p1.env", "p1pa-net", "db", "p1pa_db", imageId);
    expect(argv).toContain("-i");
    expect(argv).toContain(imageId);
    expect(argv).not.toContain(PRODUCTION_POSTGRES_IMAGE);
    expect(argv).not.toContain("--privileged");
    expect(argv).not.toContain("-p");
    expect(parseMigratorPrivilegeReport(report()).rolsuper).toBe(false);
  });

  it("rejects a missing or non-boolean privilege flag", () => {
    const raw = report() as Record<string, unknown>;
    for (const key of ["rolsuper", "rolcreatedb", "rolcreaterole", "rolreplication", "rolbypassrls", "rolcanlogin", "rolinherit", "migrationInsert", "migrationUpdate", "schemaCreate", "publicCreate"]) {
      const missing = { ...raw };
      delete missing[key];
      expect(() => parseMigratorPrivilegeReport(missing)).toThrow(expect.objectContaining({ code: "MIGRATOR_PRIVILEGE_REFUSED" }));
      expect(() => parseMigratorPrivilegeReport({ ...raw, [key]: null })).toThrow(expect.objectContaining({ code: "MIGRATOR_PRIVILEGE_REFUSED" }));
      expect(() => parseMigratorPrivilegeReport({ ...raw, [key]: "false" })).toThrow(expect.objectContaining({ code: "MIGRATOR_PRIVILEGE_REFUSED" }));
    }
    expect(() => parseMigratorPrivilegeReport({ ...raw, memberships: [1] })).toThrow(expect.objectContaining({ code: "MIGRATOR_PRIVILEGE_REFUSED" }));
    expect(() => parseMigratorPrivilegeReport({ ...raw, otherLogin: [{ name: "p1pa_app" }] })).toThrow(expect.objectContaining({ code: "MIGRATOR_PRIVILEGE_REFUSED" }));
    expect(() => parseMigratorPrivilegeReport({ ...raw, otherLogin: [{ name: "p1pa_app", schemaCreate: false, memberOfMigrator: false }] })).toThrow(expect.objectContaining({ code: "MIGRATOR_PRIVILEGE_REFUSED" }));
  });

  it("does not launch a probe for a replaced tag, wrong digest, or drifted daemon", () => {
    const imageId = `sha256:${"cd".repeat(32)}`;
    const other = `sha256:${"ef".repeat(32)}`;
    const endpoint = "npipe:////./pipe/dockerDesktopLinuxEngine";
    const base = {
      endpoint,
      daemonId: "local-daemon",
      expectedEndpoint: endpoint,
      expectedDaemonId: "local-daemon",
      expectedImageId: imageId,
      tagImageId: imageId,
      digestImageId: imageId,
      networkName: "p1pa-net",
      expectedNetworkName: "p1pa-net",
      dnsAlias: "db",
    };
    expect(decideMigratorProbe(base).imageId).toBe(imageId);
    expect(() => decideMigratorProbe({ ...base, tagImageId: other })).toThrow(expect.objectContaining({ code: "PROBE_IMAGE_REPLACED" }));
    expect(() => decideMigratorProbe({ ...base, digestImageId: other })).toThrow(expect.objectContaining({ code: "PROBE_IMAGE_MISMATCH" }));
    expect(() => decideMigratorProbe({ ...base, tagImageId: null })).toThrow(expect.objectContaining({ code: "PROBE_IMAGE_MISSING" }));
    expect(() => decideMigratorProbe({ ...base, daemonId: "other-daemon" })).toThrow(expect.objectContaining({ code: "DAEMON_IDENTITY_CHANGED" }));
    expect(() => decideMigratorProbe({ ...base, endpoint: "tcp://127.0.0.1:2375" })).toThrow(expect.objectContaining({ code: "DOCKER_ENDPOINT_CHANGED" }));
    expect(() => decideMigratorProbe({ ...base, networkName: "other-net" })).toThrow(expect.objectContaining({ code: "PROBE_NETWORK_MISMATCH" }));
    expect(() => decideMigratorProbe({ ...base, dnsAlias: "postgres" })).toThrow(expect.objectContaining({ code: "PROBE_ALIAS_MISMATCH" }));

    let spawned = 0;
    expect(() =>
      probeMigratorPrivileges({
        session: { endpoint, daemonId: "local-daemon" },
        expectedEndpoint: endpoint,
        expectedDaemonId: "local-daemon",
        expectedImageId: imageId,
        networkName: "p1pa-net",
        database: "p1pa_db",
        credential: { role: PROPOSED_MIGRATOR_ROLE, database: "p1pa_db", password: "migrator-secret-value" },
        env: process.env,
        inspectImage: (ref) => (ref === PRODUCTION_POSTGRES_IMAGE ? other : imageId),
        spawn: () => {
          spawned += 1;
          return { status: 0, signal: null, stdout: "" };
        },
      }),
    ).toThrow(expect.objectContaining({ code: "PROBE_IMAGE_REPLACED" }));
    expect(spawned).toBe(0);
  });
});
