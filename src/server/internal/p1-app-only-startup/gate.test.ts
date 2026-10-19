import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { P1_MIGRATION_NAME, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { absentP1Schema, classifySchemaShape } from "@/server/internal/p1-isolated-runner/schema-contract";
import { appOnlyCleanupAllowed } from "@/server/internal/p1-app-only-startup/cleanup";
import { appDatabaseAllowed, evaluateAppOnlyStartup, type StartupRole } from "@/server/internal/p1-app-only-startup/gate";
import { migrationSha256, readImageMigrations, resolveInventoryRoot } from "@/server/internal/p1-app-only-startup/inventory";
import { STARTUP_HISTORY_SQL, STARTUP_ROLE_SQL, STARTUP_SCHEMA_SQL } from "@/server/internal/p1-app-only-startup/probe";

function role(overrides: Partial<StartupRole> = {}): StartupRole {
  return {
    currentUser: "p1as_app",
    sessionUser: "p1as_app",
    databaseName: "p1as_ab12cd34",
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    rolcanlogin: true,
    memberships: [],
    schemaUsage: true,
    schemaCreate: false,
    databaseCreate: false,
    databaseOwner: false,
    schemaOwner: false,
    ownedTableCount: 0,
    ownedSequenceCount: 0,
    ownedViewCount: 0,
    ownedOtherRelationCount: 0,
    ownedRoutineCount: 0,
    ...overrides,
  };
}

function row(name: string, sha256: string, overrides: Record<string, unknown> = {}) {
  return {
    migrationName: name,
    checksum: sha256,
    startedAt: "2026-10-01T00:00:00.000Z",
    finishedAt: "2026-10-01T00:00:00.000Z",
    rolledBackAt: null,
    appliedStepsCount: 1,
    ...overrides,
  };
}

const image = [
  { name: "20260629154204_init", sha256: "aa".repeat(32) },
  { name: P1_MIGRATION_NAME, sha256: P1_SHA256 },
];

describe("app-only startup gate", () => {
  it("keeps the production entrypoint, Dockerfile, and deploy script on migrate deploy", () => {
    const entry = fs.readFileSync("docker-entrypoint.sh", "utf8");
    expect(entry).toContain("npx prisma migrate deploy");
    expect(entry).not.toContain("app-only");
    const dockerfile = fs.readFileSync("Dockerfile", "utf8");
    expect(dockerfile).toContain('ENTRYPOINT ["./docker-entrypoint.sh"]');
    expect(dockerfile).not.toContain("docker-entrypoint-app-only.sh");
    expect(fs.readFileSync("docker-compose.prod.yml", "utf8")).not.toContain("app-only");
    expect(fs.readFileSync("scripts/deploy.sh", "utf8")).toContain("migrate deploy выполнит entrypoint");
    const candidate = fs.readFileSync("docker-entrypoint-app-only.sh", "utf8");
    expect(candidate).toContain("exec npm run start");
    expect(candidate).not.toContain("\r");
    expect(candidate).not.toContain("prisma migrate");
    expect(candidate).not.toContain("migrate deploy");
    expect(candidate).not.toContain("SKIP");
    expect(candidate).not.toContain("APP_ONLY_REPOSITORY_ROOT");
    expect(candidate).not.toContain("APP_ONLY_STARTUP_FIXTURE");
    expect(fs.readFileSync("docker/app-only-startup/Dockerfile", "utf8")).toContain("ENV NODE_ENV=production");
  });

  it("accepts a prepared image inventory and the pinned P1 row when that directory is absent", () => {
    const historical = image.filter((migration) => migration.name !== P1_MIGRATION_NAME);
    const prepared = historical.map((migration) => row(migration.name, migration.sha256));
    expect(
      evaluateAppOnlyStartup({
        imageMigrations: historical,
        history: prepared,
        schemaShape: "absent",
        role: role(),
        urlDatabase: "p1as_ab12cd34",
        urlUser: "p1as_app",
      }),
    ).toEqual({ ok: true });
    expect(
      evaluateAppOnlyStartup({
        imageMigrations: historical,
        history: [...prepared, row(P1_MIGRATION_NAME, P1_SHA256)],
        schemaShape: "match",
        role: role(),
        urlDatabase: "p1as_ab12cd34",
        urlUser: "p1as_app",
      }),
    ).toEqual({ ok: true });
    expect(
      evaluateAppOnlyStartup({
        imageMigrations: image,
        history: image.map((migration) => row(migration.name, migration.sha256)),
        schemaShape: "match",
        role: role(),
        urlDatabase: "p1as_ab12cd34",
        urlUser: "p1as_app",
      }),
    ).toEqual({ ok: true });
  });

  it("refuses missing, pending, failed, extra, and mismatched history", () => {
    const base = {
      imageMigrations: image,
      history: image.map((migration) => row(migration.name, migration.sha256)),
      schemaShape: "match" as const,
      role: role(),
      urlDatabase: "p1as_ab12cd34",
      urlUser: "p1as_app",
    };
    expect(evaluateAppOnlyStartup({ ...base, history: null })).toMatchObject({ code: "MIGRATION_HISTORY_MISSING" });
    expect(evaluateAppOnlyStartup({ ...base, history: [row(image[0].name, image[0].sha256)] })).toMatchObject({ code: "PENDING_MIGRATION" });
    expect(
      evaluateAppOnlyStartup({
        ...base,
        history: image.map((migration) => row(migration.name, migration.sha256, { finishedAt: null, appliedStepsCount: 0 })),
      }),
    ).toMatchObject({ code: "FAILED_MIGRATION" });
    expect(
      evaluateAppOnlyStartup({
        ...base,
        history: [...image.map((migration) => row(migration.name, migration.sha256)), row("20990101000000_extra", "bb".repeat(32))],
      }),
    ).toMatchObject({ code: "EXTRA_HISTORY" });
    expect(
      evaluateAppOnlyStartup({
        ...base,
        history: image.map((migration) => row(migration.name, "cc".repeat(32))),
      }),
    ).toMatchObject({ code: "UNEXPECTED_CHECKSUM" });
    expect(evaluateAppOnlyStartup({ ...base, schemaShape: "partial" })).toMatchObject({ code: "SCHEMA_NOT_READY" });
  });

  it("refuses the wrong database, a superuser, and a role that can create or own objects", () => {
    const ready = {
      imageMigrations: image,
      history: image.map((migration) => row(migration.name, migration.sha256)),
      schemaShape: "match" as const,
      role: role(),
      urlDatabase: "p1as_ab12cd34",
      urlUser: "p1as_app",
    };
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ databaseName: "stell22" }), urlDatabase: "stell22" })).toEqual({ ok: true });
    expect(appDatabaseAllowed("stell22")).toBe(true);
    expect(appDatabaseAllowed("p1as_ab12cd34")).toBe(true);
    for (const name of ["postgres", "template0", "template1", "stell22_integrity", "stell22_dev", "p1as_empty_abcd", "other"]) {
      expect(evaluateAppOnlyStartup({ ...ready, role: role({ databaseName: name }), urlDatabase: name })).toMatchObject({ code: "WRONG_DATABASE" });
    }
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ databaseName: "stell22" }), urlDatabase: "p1as_ab12cd34" })).toMatchObject({ code: "WRONG_DATABASE" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ rolsuper: true }) })).toMatchObject({ code: "BOOTSTRAP_SUPERUSER" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ sessionUser: "p1as_other" }) })).toMatchObject({ code: "ROLE_MISMATCH" });
    expect(evaluateAppOnlyStartup({ ...ready, urlUser: "p1as_other" })).toMatchObject({ code: "ROLE_MISMATCH" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ schemaCreate: true }) })).toMatchObject({ code: "APP_ROLE_REFUSED" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ databaseCreate: true }) })).toMatchObject({ code: "APP_ROLE_REFUSED" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ databaseOwner: true }) })).toMatchObject({ code: "APP_ROLE_REFUSED" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ schemaOwner: true }) })).toMatchObject({ code: "APP_ROLE_REFUSED" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ schemaUsage: false }) })).toMatchObject({ code: "APP_ROLE_REFUSED" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ ownedTableCount: 2 }) })).toMatchObject({ code: "APP_ROLE_REFUSED" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ ownedSequenceCount: 1 }) })).toMatchObject({ code: "APP_ROLE_REFUSED" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ ownedViewCount: 1 }) })).toMatchObject({ code: "APP_ROLE_REFUSED" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ ownedRoutineCount: 1 }) })).toMatchObject({ code: "APP_ROLE_REFUSED" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ ownedOtherRelationCount: 1 }) })).toMatchObject({ code: "APP_ROLE_REFUSED" });
    expect(evaluateAppOnlyStartup({ ...ready, role: role({ memberships: ["p1as_boot"] }) })).toMatchObject({ code: "APP_ROLE_REFUSED" });
    const missing = role();
    delete (missing as { ownedSequenceCount?: number }).ownedSequenceCount;
    expect(evaluateAppOnlyStartup({ ...ready, role: missing })).toMatchObject({ code: "MIGRATION_HISTORY_UNVERIFIABLE" });
  });

  it("normalizes CRLF pairs, rejects a standalone CR, and reads production migrations from /app", () => {
    const migrations = readImageMigrations(process.cwd());
    expect(migrations.map((migration) => migration.name)).toContain(P1_MIGRATION_NAME);
    expect(migrations.find((migration) => migration.name === P1_MIGRATION_NAME)?.sha256).toBe(P1_SHA256);
    const lf = Buffer.from("select 1;\n", "utf8");
    const crlf = Buffer.from("select 1;\r\n", "utf8");
    expect(migrationSha256(crlf)).toBe(migrationSha256(lf));
    expect(migrationSha256(Buffer.from("select 2;\n", "utf8"))).not.toBe(migrationSha256(lf));
    expect(() => migrationSha256(Buffer.from("select\r1;\n", "utf8"))).toThrow("STANDALONE_CR");
    expect(resolveInventoryRoot({ NODE_ENV: "production", APP_ONLY_REPOSITORY_ROOT: process.cwd() })).toEqual({
      ok: false,
      code: "MIGRATION_HISTORY_UNVERIFIABLE",
    });
    expect(resolveInventoryRoot({ NODE_ENV: "production" })).toEqual({ ok: true, root: "/app" });
    expect(resolveInventoryRoot({ NODE_ENV: "test", APP_ONLY_STARTUP_FIXTURE: "test", APP_ONLY_STARTUP_FIXTURE_ROOT: "/fixture" })).toEqual({
      ok: true,
      root: "/fixture",
    });
    expect(resolveInventoryRoot({ NODE_ENV: "test", APP_ONLY_REPOSITORY_ROOT: "/fixture" })).toEqual({
      ok: false,
      code: "MIGRATION_HISTORY_UNVERIFIABLE",
    });
    for (const sql of [STARTUP_ROLE_SQL, STARTUP_HISTORY_SQL, STARTUP_SCHEMA_SQL]) {
      expect(sql.toLowerCase()).not.toMatch(/^\s*(insert|update|delete|create|alter|drop|truncate|grant|revoke)\b/m);
    }
    expect(classifySchemaShape(absentP1Schema())).toBe("absent");
  });

  it("does not clean a production name, a compose project, or a changed image", () => {
    const base = {
      expectedId: "a".repeat(64),
      expectedName: "p1as-app-1",
      expectedImageId: "sha256:" + "b".repeat(64),
      runId: "run-1",
      labelKey: "stell22.p1.app-only-startup",
      name: "/p1as-app-1",
      id: "a".repeat(64),
      imageId: "sha256:" + "b".repeat(64),
      labels: { "stell22.p1.app-only-startup": "run-1" },
    };
    expect(appOnlyCleanupAllowed(base)).toEqual({ ok: true });
    expect(appOnlyCleanupAllowed({ ...base, name: "/stell22-app" })).toMatchObject({ code: "PRODUCTION_NAME" });
    expect(appOnlyCleanupAllowed({ ...base, name: "/stell22-db-prod", expectedName: "stell22-db-prod" })).toMatchObject({ code: "PRODUCTION_NAME" });
    expect(appOnlyCleanupAllowed({ ...base, imageId: "sha256:" + "c".repeat(64) })).toMatchObject({ code: "IMAGE_MISMATCH" });
    expect(appOnlyCleanupAllowed({ ...base, labels: { ...base.labels, "com.docker.compose.project": "stell22" } })).toMatchObject({ code: "COMPOSE_PROJECT" });
  });
});
