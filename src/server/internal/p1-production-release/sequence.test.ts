import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { planLegacyTransition, type LegacyCatalog } from "@/server/internal/p1-legacy-role-transition/plan";
import { PINNED_MIGRATION_FILES } from "@/server/internal/p1-isolated-runner/inventory";
import { P1_MIGRATION_NAME } from "@/server/internal/p1-isolated-runner/contract";
import {
  COMPOSE_LIMITS,
  OWNER_AUTHORIZATION,
  PROTECTED_PATHS,
  appMayStart,
  assertOwnerGate,
  assertProtectedCheckout,
  assertWriterExclusionBeforeP1,
  decideAfterCommittedRoleChange,
  decideAppUnhealthy,
  decideImageBuildFailure,
  decideLegacyRestart,
  decideP1Uncertain,
  decideReleaseApplied,
  decideWriterAdmission,
  failureAfterMigration,
  releaseOrder,
  releaseResourceBudget,
} from "@/server/internal/p1-production-release/sequence";

describe("production release sequence", () => {
  it("keeps writer exclusion before pinned P1 and refuses a database restore afterward", () => {
    const order = releaseOrder();
    expect(order.indexOf("WRITER_EXCLUSION")).toBeLessThan(order.indexOf("PINNED_P1"));
    expect(order.indexOf("ROLE_TRANSITION")).toBeLessThan(order.indexOf("WRITER_EXCLUSION"));
    expect(order.indexOf("PINNED_P1")).toBeLessThan(order.indexOf("APP_START"));
    expect(assertWriterExclusionBeforeP1({
      appContainerStopped: true,
      competingWritersStopped: true,
      appLogin: "stell22_app",
      appCanMigrate: false,
      appMigrationInsert: false,
      migratorLogin: "stell22_migrator",
    })).toEqual({ ok: true });
    expect(assertWriterExclusionBeforeP1({
      appContainerStopped: false,
      competingWritersStopped: true,
      appLogin: "stell22_app",
      appCanMigrate: false,
      appMigrationInsert: false,
      migratorLogin: "stell22_migrator",
    }).ok).toBe(false);
    expect(assertWriterExclusionBeforeP1({
      appContainerStopped: true,
      competingWritersStopped: true,
      appLogin: "stell22",
      appCanMigrate: false,
      appMigrationInsert: false,
      migratorLogin: "stell22_migrator",
    })).toEqual({ ok: false, code: "STOP_APP_ROLE" });
    expect(failureAfterMigration()).toEqual({
      action: "FORWARD_RECOVERY",
      databaseRestore: false,
      schemaRollback: false,
      restartLegacy: false,
      retryP1: false,
      code: "FORWARD_RECOVERY",
    });
    expect(releaseOrder().indexOf("IMAGE_BUILD")).toBeLessThan(releaseOrder().indexOf("WRITE_FREEZE"));
    expect(releaseOrder().indexOf("NON_MUTATING_VALIDATION")).toBeLessThan(releaseOrder().indexOf("WRITE_FREEZE"));
  });

  it("accepts the production database only on the production-candidate policy", () => {
    const disposable = planLegacyTransition({
      catalog: catalog("stell22"),
      appPassword: "a".repeat(32),
      migratorPassword: "b".repeat(32),
      p1Checksum: P1_SHA256,
    });
    expect(disposable.ok).toBe(false);
    const production = planLegacyTransition({
      catalog: catalog("stell22"),
      appPassword: "a".repeat(32),
      migratorPassword: "b".repeat(32),
      p1Checksum: P1_SHA256,
      databasePolicy: "production-candidate",
    });
    expect(production.ok).toBe(true);
    if (!production.ok) return;
    expect(production.sql).toContain("REVOKE ALL ON DATABASE stell22 FROM PUBLIC");
    expect(production.sql).toContain("CREATE ROLE stell22_app");
    expect(production.sql).toContain("CREATE ROLE stell22_migrator");
    expect(production.sql.toUpperCase()).not.toContain("REASSIGN OWNED");
    expect(production.sql).not.toContain("stell22_app LOGIN SUPERUSER");
    expect(appMayStart({
      entrypoint: "./docker-entrypoint-app-only.sh",
      databaseUser: "stell22_app",
      p1AppliedBy: "stell22_migrator",
      p1Checksum: P1_SHA256,
    })).toEqual({ ok: true });
    expect(appMayStart({
      entrypoint: "./docker-entrypoint.sh",
      databaseUser: "stell22_app",
      p1AppliedBy: "stell22_migrator",
      p1Checksum: P1_SHA256,
    }).ok).toBe(false);
  });

  it("fits the 2 CPU and 4 GB host and locks checkout", () => {
    const budget = releaseResourceBudget();
    expect(budget.ok).toBe(true);
    if (!budget.ok) return;
    expect(budget.cpu).toBeLessThanOrEqual(2);
    expect(budget.memoryMib).toBeLessThanOrEqual(4096);
    expect(budget.memoryMib).toBe(COMPOSE_LIMITS.dbMib + COMPOSE_LIMITS.appMib + COMPOSE_LIMITS.caddyMib);
    const compose = fs.readFileSync("docker-compose.prod.yml", "utf8");
    expect(compose).toContain("mem_limit: 1280m");
    expect(compose).toContain("mem_limit: 1536m");
    expect(compose).toContain("mem_limit: 192m");
    expect(compose).toContain("postgresql://stell22_app:");
    expect(compose).not.toContain("MIGRATOR_DB_PASSWORD");
    expect(assertOwnerGate({ execute: undefined, authorization: undefined })).toEqual({ ok: false, code: "STOP_LOCKED" });
    expect(assertOwnerGate({ execute: "1", authorization: OWNER_AUTHORIZATION })).toEqual({ ok: true });
    expect(assertProtectedCheckout(["git reset --hard abc"]).ok).toBe(false);
    expect(assertProtectedCheckout(["sh scripts/restore-db.sh archive.sql.gz"]).ok).toBe(false);
    expect(assertProtectedCheckout([`git checkout --detach abc :(exclude)${PROTECTED_PATHS[0]}`])).toEqual({ ok: true });
    const locked = spawnSync("sh", ["scripts/release-role-split.sh"], { encoding: "utf8" });
    expect(locked.status).not.toBe(0);
    expect(locked.stdout).toContain("RESULT=STOP_LOCKED");
    expect(locked.stdout).not.toContain("RESTORE_VERIFIED");
    const releaseScript = fs.readFileSync("scripts/release-role-split.sh", "utf8");
    const stopAt = releaseScript.indexOf("docker stop stell22-app");
    expect(releaseScript.indexOf("docker compose -f docker-compose.prod.yml build app")).toBeLessThan(stopAt);
    expect(releaseScript.indexOf("stell22-release-legacy:hold")).toBeLessThan(releaseScript.indexOf("docker compose -f docker-compose.prod.yml build app"));
    expect(releaseScript.indexOf("scripts/release-built-image-id.sh")).toBeLessThan(stopAt);
    expect(releaseScript.indexOf("image-identity")).toBeLessThan(stopAt);
    expect(releaseScript.indexOf("scripts/release-url-password.sh")).toBeLessThan(releaseScript.indexOf("docker compose -f docker-compose.prod.yml build app"));
    expect(releaseScript).not.toContain("docker compose -f docker-compose.prod.yml images");
    expect(releaseScript).not.toContain("pg_terminate_backend");
    expect(releaseScript).not.toContain("git reset --hard");
    expect(releaseScript).not.toContain("git stash");
    expect(releaseScript).not.toContain("restore-db.sh");
    expect(releaseScript.indexOf("git rev-parse origin/main")).toBeLessThan(releaseScript.indexOf("sh scripts/release-checkout.sh"));
    expect(releaseScript.indexOf("RESULT=STOP_HEALTH")).toBeLessThan(releaseScript.indexOf("sh scripts/release-checkout.sh"));
    expect(releaseScript.indexOf("/api/health")).toBeLessThan(releaseScript.indexOf("sh scripts/release-checkout.sh"));
    expect(releaseScript.indexOf("BEGIN TRANSACTION READ ONLY")).toBeLessThan(releaseScript.indexOf("sh scripts/release-checkout.sh"));
    expect(releaseScript).toContain("trap on_signal HUP INT TERM");
    expect(releaseScript).toContain("RESULT=STOP_SIGNAL");
    expect(releaseScript).toContain("image-build.log");
    expect(releaseScript).toContain("p1-migrate.log");
    expect(releaseScript).toContain("app-start.log");
    expect(releaseScript.match(/prisma migrate deploy/g)).toEqual(["prisma migrate deploy"]);
    const checkoutScript = fs.readFileSync("scripts/release-checkout.sh", "utf8");
    expect(checkoutScript).not.toContain("git stash");
    expect(checkoutScript).not.toContain("git reset --hard");
    expect(checkoutScript).not.toContain("git clean");
    expect(checkoutScript).toContain("--recover");
    const workflow = fs.readFileSync(".github/workflows/release-role-split.yml", "utf8");
    const sshAt = workflow.indexOf("appleboy/ssh-action");
    expect(workflow.indexOf("actions: read")).toBeGreaterThan(-1);
    expect(workflow.indexOf('name == "CI"')).toBeLessThan(sshAt);
    expect(workflow.indexOf("git rev-parse origin/main")).toBeLessThan(sshAt);
    const remote = workflow.slice(workflow.indexOf("script: |"));
    expect(remote.indexOf('"$origin_main" != "$EXPECTED_SHA"')).toBeLessThan(remote.indexOf("release-checkout.sh"));
    expect(releaseScript).not.toContain("prisma migrate deploy --schema /app/prisma/schema.prisma >/dev/null 2>&1 || app_migrate");
    const source = catalog("stell22");
    const text = [
      `database ${source.databaseName}`,
      `schemaOwner ${source.schemaOwner}`,
      `admin ${source.adminSuperuser}|${source.adminLogin}`,
      `roles ${source.appRoleExists}|${source.migratorRoleExists}`,
      ...source.relations.map((relation) => `relation ${relation.name}|${relation.kind}|${relation.owner}`),
      ...source.history.map((row) => `history ${row.migrationName}|${row.checksum}|${row.finishedAt ?? ""}|${row.rolledBackAt ?? ""}|${row.appliedStepsCount}`),
    ].join("\n");
    const file = path.join(os.tmpdir(), `stell22-release-plan-${process.pid}.txt`);
    fs.writeFileSync(file, text);
    const planned = planLegacyTransition({
      catalog: source,
      appPassword: "a".repeat(32),
      migratorPassword: "b".repeat(32),
      p1Checksum: P1_SHA256,
      databasePolicy: "production-candidate",
    });
    const bundled = spawnSync(process.execPath, ["scripts/release-plan.cjs", file], {
      encoding: "utf8",
      env: { ...process.env, APP_DB_PASSWORD: "a".repeat(32), MIGRATOR_DB_PASSWORD: "b".repeat(32) },
    });
    fs.rmSync(file, { force: true });
    expect(planned.ok).toBe(true);
    expect(bundled.status).toBe(0);
    if (!planned.ok) return;
    expect(bundled.stdout).toBe(planned.sql);
  });
});

describe("release failure boundaries", () => {
  const original = {
    roleTransitionCommitted: false,
    p1Present: false,
    p1MigrationInLegacyImage: false,
    rolesAbsent: true,
    historyUnchanged: true,
    databaseStateKnown: true,
  };

  it("stops an image build before the freeze and leaves the legacy app running", () => {
    const decision = decideImageBuildFailure();
    expect(decision.code).toBe("STOP_APP_START");
    expect(decision.restartLegacy).toBe(false);
    expect(decision.databaseRestore).toBe(false);
  });

  it("restarts the legacy image only when the original database and a P1-free image are proven", () => {
    expect(decideLegacyRestart(original).code).toBe("LEGACY_RESTART");
    expect(decideLegacyRestart(original).restartLegacy).toBe(true);
    expect(decideLegacyRestart({ ...original, databaseStateKnown: false }).restartLegacy).toBe(false);
    expect(decideLegacyRestart({ ...original, p1MigrationInLegacyImage: true }).restartLegacy).toBe(false);
    expect(decideLegacyRestart({ ...original, rolesAbsent: false }).restartLegacy).toBe(false);
    expect(decideLegacyRestart({ ...original, historyUnchanged: false }).restartLegacy).toBe(false);
    expect(decideLegacyRestart({ ...original, p1Present: true })).toMatchObject({ code: "FORWARD_RECOVERY", restartLegacy: false, retryP1: false });
  });

  it("does not restart the legacy image after the role transaction commits", () => {
    expect(decideLegacyRestart({ ...original, roleTransitionCommitted: true }).restartLegacy).toBe(false);
    expect(decideAfterCommittedRoleChange("STOP_WRITER")).toMatchObject({ restartLegacy: false, databaseRestore: false, retryP1: false, demoteSuperuser: false });
    expect(decideAfterCommittedRoleChange("STOP_APP_ROLE").restartLegacy).toBe(false);
  });

  it("stops on an unknown writer and does not treat an empty snapshot as future exclusion", () => {
    const admitted = decideWriterAdmission({
      maintenanceDeclared: true,
      appRunning: false,
      expectAppStopped: true,
      backupRunning: false,
      statementImportRunning: false,
      externalWriterCount: 0,
      checkSessions: true,
      inspectionApp: "stell22-release-inspect",
      sessions: [{ user: "stell22", applicationName: "stell22-release-inspect", backendType: "client backend" }],
    });
    expect(admitted.code).toBe("ADMITTED");
    expect(admitted.futurePrivilegedWritesProvenImpossible).toBe(false);
    expect(admitted.emptyActivityProvesFutureExclusion).toBe(false);
    expect(admitted.terminateSessions).toBe(false);
    expect(admitted.privilegedRolesRemain).toEqual(["stell22", "stell22_migrator"]);
    const unknown = decideWriterAdmission({
      maintenanceDeclared: true,
      appRunning: false,
      expectAppStopped: true,
      backupRunning: false,
      statementImportRunning: false,
      externalWriterCount: 0,
      checkSessions: true,
      inspectionApp: "stell22-release-inspect",
      sessions: [
        { user: "stell22", applicationName: "stell22-release-inspect", backendType: "client backend" },
        { user: "stell22", applicationName: "psql", backendType: "client backend" },
      ],
    });
    expect(unknown.code).toBe("STOP_WRITER");
    expect(unknown.terminateSessions).toBe(false);
    expect(decideWriterAdmission({
      maintenanceDeclared: true,
      appRunning: false,
      expectAppStopped: true,
      backupRunning: true,
      statementImportRunning: false,
      externalWriterCount: 0,
      checkSessions: false,
      inspectionApp: "stell22-release-inspect",
      sessions: [],
    }).code).toBe("STOP_WRITER");
    expect(decideWriterAdmission({
      maintenanceDeclared: false,
      appRunning: true,
      expectAppStopped: false,
      backupRunning: false,
      statementImportRunning: false,
      externalWriterCount: 0,
      checkSessions: false,
      inspectionApp: "stell22-release-inspect",
      sessions: [],
    }).code).toBe("STOP_WRITER");
    expect(decideWriterAdmission({
      maintenanceDeclared: true,
      appRunning: false,
      expectAppStopped: true,
      backupRunning: false,
      statementImportRunning: false,
      externalWriterCount: 0,
      checkSessions: true,
      inspectionApp: "stell22-release-inspect",
      sessions: [],
    }).code).toBe("STOP_WRITER");
  });

  it("keeps pinned P1 failure and an unhealthy app on forward recovery", () => {
    expect(decideP1Uncertain()).toMatchObject({ code: "FORWARD_RECOVERY", restartLegacy: false, retryP1: false, databaseRestore: false });
    expect(decideAppUnhealthy()).toMatchObject({ code: "FORWARD_RECOVERY", restartLegacy: false, databaseRestore: false });
    expect(decideReleaseApplied()).toMatchObject({ code: "RELEASE_APPLIED", restartLegacy: false });
    const facts = path.join(os.tmpdir(), `stell22-release-boundary-${process.pid}.txt`);
    fs.writeFileSync(facts, [
      "roleTransitionCommitted=1",
      "p1Present=0",
      "p1MigrationInLegacyImage=0",
      "rolesAbsent=0",
      "historyUnchanged=1",
      "databaseStateKnown=1",
    ].join("\n"));
    const cli = spawnSync(process.execPath, ["scripts/release-decision.cjs", "legacy-restart", facts], { encoding: "utf8" });
    fs.rmSync(facts, { force: true });
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("CODE=FORWARD_RECOVERY");
    expect(cli.stdout).toContain("RESTART_LEGACY=NO");
    expect(cli.stdout).toContain("FUTURE_PRIVILEGED_WRITES_PROVEN_IMPOSSIBLE=NO");
    expect(cli.stdout).not.toContain("a".repeat(32));
  });
});

function catalog(databaseName: string): LegacyCatalog {
  const history = PINNED_MIGRATION_FILES.filter((entry) => entry.path.endsWith("/migration.sql") && !entry.path.includes(P1_MIGRATION_NAME)).map((entry) => ({
    migrationName: entry.path.split("/")[2] ?? "",
    checksum: entry.sha256,
    finishedAt: "2026-10-08T17:35:32.000Z",
    rolledBackAt: null,
    appliedStepsCount: 1,
  }));
  return {
    databaseName,
    schemaOwner: "pg_database_owner",
    adminSuperuser: true,
    adminLogin: true,
    appRoleExists: false,
    migratorRoleExists: false,
    relations: [
      { name: "BatchCreationCommand", kind: "r", owner: "stell22" },
      { name: "_prisma_migrations", kind: "r", owner: "stell22" },
    ],
    routines: [],
    history,
  };
}
