import { describe, expect, it } from "vitest";
import { P1_MIGRATION_NAME, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { PINNED_MIGRATION_FILES } from "@/server/internal/p1-isolated-runner/inventory";
import {
  LEGACY_ADMIN_ROLE,
  planLegacyTransition,
  productionDatabaseUrl,
  verifyAdminPreserved,
  verifyAppRestrictions,
  verifyPrivilegedAppLogin,
  verifyTransferredOwnership,
  type LegacyCatalog,
} from "@/server/internal/p1-legacy-role-transition/plan";

const APP_PASSWORD = "a".repeat(32);
const MIGRATOR_PASSWORD = "b".repeat(32);

describe("legacy role transition plan", () => {
  it("transfers an explicit inventory and keeps the legacy superuser", () => {
    const plan = planLegacyTransition(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.inventory.map((item) => item.key)).toEqual([
      "table:BatchCreationCommand",
      "table:Setting",
      "table:_prisma_migrations",
      "sequence:Setting_id_seq",
      "routine:example_fn:",
    ]);
    expect(plan.sql).toContain('ALTER TABLE public."BatchCreationCommand" OWNER TO stell22_migrator');
    expect(plan.sql).toContain('ALTER TABLE public."_prisma_migrations" OWNER TO stell22_migrator');
    expect(plan.sql).toContain('ALTER SEQUENCE public."Setting_id_seq" OWNER TO stell22_migrator');
    expect(plan.sql).toContain('ALTER FUNCTION public."example_fn"() OWNER TO stell22_migrator');
    expect(plan.sql).toContain("CREATE ROLE stell22_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT");
    expect(plan.sql).toContain("CREATE ROLE stell22_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT");
    expect(plan.sql).toContain("GRANT USAGE, CREATE ON SCHEMA public TO stell22_migrator");
    expect(plan.sql).not.toContain("GRANT CREATE ON SCHEMA public TO stell22_app");
    expect(plan.sql).not.toContain("GRANT stell22_migrator TO stell22_app");
    expect(plan.sql).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."Setting" TO stell22_app');
    expect(plan.sql).not.toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public."_prisma_migrations" TO stell22_app');
    expect(plan.sql).toContain('GRANT SELECT ON TABLE public."_prisma_migrations" TO stell22_app');
    expect(plan.sql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public."_prisma_migrations" FROM stell22_app');
    expect(plan.sql).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE stell22_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stell22_app");
    expect(plan.sql).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE stell22_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO stell22_app");
    expect(plan.sql).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE stell22_migrator REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    expect(plan.sql).toContain("ALTER DEFAULT PRIVILEGES FOR ROLE stell22_migrator IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO stell22_app");
    expect(plan.sql.toUpperCase()).not.toContain("REASSIGN OWNED");
    expect(plan.sql).not.toMatch(/ALTER ROLE stell22\b/);
    expect(plan.sql).not.toContain("DROP ROLE stell22");
    expect(plan.sql.startsWith("BEGIN;")).toBe(true);
    expect(plan.sql.endsWith("COMMIT;")).toBe(true);
  });

  it("refuses an unexpected schema owner", () => {
    expect(planLegacyTransition(input({ schemaOwner: "stell22" })).ok).toBe(false);
    expect(code(input({ schemaOwner: "stell22" }))).toBe("UNEXPECTED_SCHEMA_OWNER");
  });

  it("refuses a missing required object", () => {
    const catalog = baseCatalog();
    catalog.relations = catalog.relations.filter((relation) => relation.name !== "BatchCreationCommand");
    expect(code({ catalog })).toBe("REQUIRED_OBJECT_MISSING");
  });

  it("refuses a different migration history", () => {
    const catalog = baseCatalog();
    catalog.history = catalog.history.slice(1);
    expect(code({ catalog })).toBe("MIGRATION_HISTORY_DIFFERS");
    const checksum = baseCatalog();
    checksum.history = checksum.history.map((row, index) => index === 0 ? { ...row, checksum: "0".repeat(64) } : row);
    expect(code({ catalog: checksum })).toBe("MIGRATION_HISTORY_DIFFERS");
    const applied = baseCatalog();
    applied.history = [...applied.history, {
      migrationName: P1_MIGRATION_NAME,
      checksum: P1_SHA256,
      finishedAt: "2026-10-22T00:00:00.000Z",
      rolledBackAt: null,
      appliedStepsCount: 1,
    }];
    expect(code({ catalog: applied })).toBe("MIGRATION_HISTORY_DIFFERS");
  });

  it("refuses when the migrator does not own the inventory", () => {
    const plan = planLegacyTransition(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const owners = Object.fromEntries(plan.inventory.map((item) => [item.key, "stell22_migrator"]));
    expect(verifyTransferredOwnership({ inventory: plan.inventory, owners })).toEqual({ ok: true });
    owners["table:BatchCreationCommand"] = "stell22";
    expect(verifyTransferredOwnership({ inventory: plan.inventory, owners })).toEqual({
      ok: false,
      code: "MIGRATOR_OWNERSHIP_MISSING",
    });
  });

  it("refuses schema create and inherited migrator privileges for the app", () => {
    expect(verifyAppRestrictions({
      schemaCreate: true,
      memberOfMigrator: false,
      migrationSelect: true,
      migrationInsert: false,
      migrationUpdate: false,
      migrationDelete: false,
    })).toEqual({ ok: false, code: "APP_SCHEMA_CREATE" });
    expect(verifyAppRestrictions({
      schemaCreate: false,
      memberOfMigrator: true,
      migrationSelect: true,
      migrationInsert: false,
      migrationUpdate: false,
      migrationDelete: false,
    })).toEqual({ ok: false, code: "APP_INHERITS_MIGRATOR" });
    expect(verifyAppRestrictions({
      schemaCreate: false,
      memberOfMigrator: false,
      migrationSelect: true,
      migrationInsert: true,
      migrationUpdate: false,
      migrationDelete: false,
    })).toEqual({ ok: false, code: "APP_MIGRATION_PRIVILEGE" });
  });

  it("refuses a different P1 checksum", () => {
    expect(code(input(), "f".repeat(64))).toBe("P1_CHECKSUM_DIFFERS");
  });

  it("refuses a privileged login for normal app startup", () => {
    expect(verifyPrivilegedAppLogin({ login: LEGACY_ADMIN_ROLE, superuser: true })).toEqual({
      ok: false,
      code: "PRIVILEGED_APP_LOGIN",
    });
    expect(verifyPrivilegedAppLogin({ login: "stell22_migrator", superuser: false })).toEqual({
      ok: false,
      code: "PRIVILEGED_APP_LOGIN",
    });
    expect(verifyPrivilegedAppLogin({ login: "stell22_app", superuser: false })).toEqual({ ok: true });
  });

  it("does not report a preserved administrator when stell22 is no longer superuser", () => {
    expect(verifyAdminPreserved({ superuser: false, login: true })).toEqual({ ok: false, code: "ADMIN_NOT_PRESERVED" });
    expect(verifyAdminPreserved({ superuser: true, login: true })).toEqual({ ok: true });
  });

  it("keeps the role password identical to the database URL password", () => {
    const plan = planLegacyTransition(input());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const appUrl = productionDatabaseUrl({ user: "stell22_app", password: APP_PASSWORD, host: "db" });
    const migratorUrl = productionDatabaseUrl({ user: "stell22_migrator", password: MIGRATOR_PASSWORD, host: "127.0.0.1" });
    expect(appUrl.ok).toBe(true);
    expect(migratorUrl.ok).toBe(true);
    if (!appUrl.ok || !migratorUrl.ok) return;
    expect(new URL(appUrl.url).password).toBe(APP_PASSWORD);
    expect(new URL(migratorUrl.url).password).toBe(MIGRATOR_PASSWORD);
    expect(plan.sql).toContain(`PASSWORD '${APP_PASSWORD}'`);
    expect(plan.sql).toContain(`PASSWORD '${MIGRATOR_PASSWORD}'`);
    for (const mark of ["+", "/", "="]) {
      const password = `${"a".repeat(23)}${mark}`;
      expect(productionDatabaseUrl({ user: "stell22_app", password, host: "db" })).toEqual({ ok: false, code: "CREDENTIAL_REFUSED" });
      const catalog = baseCatalog();
      catalog.databaseName = "stell22";
      expect(planLegacyTransition({
        catalog,
        appPassword: password,
        migratorPassword: MIGRATOR_PASSWORD,
        p1Checksum: P1_SHA256,
        databasePolicy: "production-candidate",
      })).toEqual({ ok: false, code: "CREDENTIAL_REFUSED" });
    }
  });

  it("refuses the production database name", () => {
    const catalog = baseCatalog();
    catalog.databaseName = "stell22";
    expect(code({ catalog })).toBe("PRODUCTION_DATABASE");
  });
});

function code(value: { catalog?: LegacyCatalog }, p1Checksum = P1_SHA256) {
  const result = planLegacyTransition({
    catalog: value.catalog ?? baseCatalog(),
    appPassword: APP_PASSWORD,
    migratorPassword: MIGRATOR_PASSWORD,
    p1Checksum,
  });
  return result.ok ? "PASS" : result.code;
}

function input(patch: Partial<LegacyCatalog> = {}) {
  return {
    catalog: { ...baseCatalog(), ...patch },
    appPassword: APP_PASSWORD,
    migratorPassword: MIGRATOR_PASSWORD,
    p1Checksum: P1_SHA256,
  };
}

function baseCatalog(): LegacyCatalog {
  const history = PINNED_MIGRATION_FILES.filter((entry) => entry.path.endsWith("/migration.sql") && !entry.path.includes(P1_MIGRATION_NAME)).map((entry) => ({
    migrationName: entry.path.split("/")[2] ?? "",
    checksum: entry.sha256,
    finishedAt: "2026-10-08T17:35:32.000Z",
    rolledBackAt: null,
    appliedStepsCount: 1,
  }));
  return {
    databaseName: "p1as_0123abcd",
    schemaOwner: "pg_database_owner",
    adminSuperuser: true,
    adminLogin: true,
    appRoleExists: false,
    migratorRoleExists: false,
    relations: [
      { name: "BatchCreationCommand", kind: "r", owner: "stell22" },
      { name: "_prisma_migrations", kind: "r", owner: "stell22" },
      { name: "Setting", kind: "r", owner: "stell22" },
      { name: "Setting_id_seq", kind: "S", owner: "stell22" },
    ],
    routines: [{ name: "example_fn", identityArguments: "", owner: "stell22" }],
    history,
  };
}
