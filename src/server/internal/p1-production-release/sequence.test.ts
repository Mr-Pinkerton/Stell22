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
      code: "FORWARD_RECOVERY",
    });
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
