import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_PHRASE, MIGRATION_NAME, MIGRATION_SHA256 } from "./decide.mjs";
import { evaluateAppOnlyStartup, type StartupRole } from "@/server/internal/p1-app-only-startup/gate";
import { readImageMigrations } from "@/server/internal/p1-app-only-startup/inventory";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";

function redact(text: string, secrets: readonly string[]) {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("REDACTED");
  }
  return out;
}

function run(command: string, args: readonly string[], input?: string) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    input,
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function must(command: string, args: readonly string[], secrets: readonly string[], input?: string) {
  const child = run(command, args, input);
  if (child.status !== 0) {
    throw new Error(redact(`${child.stdout}\n${child.stderr}`, secrets).slice(0, 800));
  }
  return child.stdout.trim();
}

function materialize(dir: string, includeTarget: boolean) {
  const listed = run("git", ["ls-files", "prisma"]);
  if (listed.status !== 0) throw new Error("git ls-files failed");
  for (const relative of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    if (relative !== "prisma/schema.prisma" && !relative.startsWith("prisma/migrations/")) continue;
    if (!includeTarget && relative.includes(MIGRATION_NAME)) continue;
    const shown = spawnSync("git", ["show", `HEAD:${relative}`], {
      cwd: process.cwd(),
      encoding: "buffer",
      windowsHide: true,
    });
    if (shown.status !== 0) throw new Error(`git show failed for ${relative}`);
    const target = path.join(dir, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, shown.stdout);
  }
}

describe.skipIf(!LIVE)("admin corrections disposable postgresql 17", () => {
  it(
    "applies only the accepted migration as stell22_migrator and then accepts the startup gate",
    () => {
      const runId = randomBytes(4).toString("hex");
      const bootPassword = randomBytes(18).toString("hex");
      const migratorPassword = randomBytes(18).toString("hex");
      const appPassword = randomBytes(18).toString("hex");
      const wrongPassword = randomBytes(18).toString("hex");
      const secrets = [bootPassword, migratorPassword, appPassword, wrongPassword];
      const database = `acrel_${runId}`;
      const container = `acrel-db-${runId}`;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "acrel-"));
      const historical = path.join(root, "historical");
      const full = path.join(root, "full");
      materialize(historical, false);
      materialize(full, true);
      let started = false;
      try {
        const image = run("docker", ["image", "inspect", "--format", "{{.Id}}", "postgres:17-alpine"]);
        if (image.status !== 0) must("docker", ["pull", "postgres:17-alpine"], secrets);
        must(
          "docker",
          [
            "run", "-d", "--pull", "never", "--restart", "no", "--name", container,
            "-p", "127.0.0.1::5432",
            "-e", "POSTGRES_USER=acrel_boot",
            "-e", `POSTGRES_PASSWORD=${bootPassword}`,
            "-e", `POSTGRES_DB=${database}`,
            "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
            "postgres:17-alpine",
          ],
          secrets,
        );
        started = true;
        const port = must("docker", ["inspect", "--format", "{{(index (index .NetworkSettings.Ports \"5432/tcp\") 0).HostPort}}", container], secrets);
        let version = "";
        for (let attempt = 0; attempt < 30 && version === ""; attempt += 1) {
          const probe = run("docker", ["exec", "-i", "-e", `PGPASSWORD=${bootPassword}`, container, "psql", "-X", "-U", "acrel_boot", "-d", database, "-q", "-At", "-c", "SELECT current_setting('server_version_num')"]);
          if (probe.status === 0 && probe.stdout.trim().startsWith("17")) version = probe.stdout.trim();
          else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        }
        if (!version.startsWith("17")) throw new Error("disposable postgres did not become ready");
        expect(version.startsWith("17")).toBe(true);
        process.stderr.write(`EVIDENCE pg=${version} container=${container}\n`);
        psql(
          container,
          database,
          bootPassword,
          [
            `CREATE ROLE stell22_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${migratorPassword}'`,
            `CREATE ROLE stell22_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${appPassword}'`,
            "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
            "GRANT USAGE, CREATE ON SCHEMA public TO stell22_migrator",
            "GRANT USAGE ON SCHEMA public TO stell22_app",
            `GRANT CONNECT ON DATABASE ${database} TO stell22_migrator`,
            `GRANT CONNECT ON DATABASE ${database} TO stell22_app`,
            "ALTER DEFAULT PRIVILEGES FOR ROLE stell22_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stell22_app",
          ].join(";\n"),
          secrets,
        );
        const migratorUrl = `postgresql://stell22_migrator:${migratorPassword}@127.0.0.1:${port}/${database}?schema=public`;
        deploy(historical, migratorUrl, secrets);
        const before = psql(container, database, bootPassword, 'SELECT count(*)::text FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL', secrets);
        expect(before).toBe("46");
        psql(
          container,
          database,
          bootPassword,
          'GRANT USAGE ON TYPE public."OperationType" TO stell22_app',
          secrets,
        );
        const urlFile = path.join(root, "migrator.url");
        fs.writeFileSync(urlFile, `DATABASE_URL=${migratorUrl}\n`);
        const wrongFile = path.join(root, "wrong.url");
        fs.writeFileSync(wrongFile, `DATABASE_URL=${migratorUrl.replace(migratorPassword, wrongPassword)}\n`);
        const sha = must("git", ["rev-parse", "HEAD"], secrets);
        const common = operatorEnv(database, container, bootPassword, full, sha);
        const wrong = operator(common, wrongFile, secrets);
        expect(wrong.status).not.toBe(0);
        expect(wrong.out).toContain("RESULT=STOP_MIGRATOR");
        expect(wrong.out).not.toContain(wrongPassword);
        expect(psql(container, database, bootPassword, 'SELECT count(*)::text FROM public."_prisma_migrations"', secrets)).toBe("46");
        psql(
          container,
          database,
          bootPassword,
          [
            'ALTER TYPE public."OperationType" OWNER TO acrel_boot',
            'REVOKE USAGE ON TYPE public."OperationType" FROM PUBLIC',
            'REVOKE USAGE ON TYPE public."OperationType" FROM stell22_migrator',
          ].join(";\n"),
          secrets,
        );
        const denied = operator(common, urlFile, secrets);
        expect(denied.status).not.toBe(0);
        expect(denied.out).toContain("RESULT=STOP_OPERATION_TYPE");
        expect(denied.out).not.toContain(migratorPassword);
        expect(psql(container, database, bootPassword, `SELECT to_regclass('public."BatchPackageEditCommand"') IS NULL`, secrets)).toBe("t");
        psql(
          container,
          database,
          bootPassword,
          [
            'ALTER TYPE public."OperationType" OWNER TO stell22_migrator',
            'GRANT USAGE ON TYPE public."OperationType" TO stell22_app',
            'GRANT USAGE ON TYPE public."OperationType" TO stell22_migrator',
          ].join(";\n"),
          secrets,
        );
        const applied = operator(common, urlFile, secrets);
        expect(applied.status, applied.out).toBe(0);
        expect(applied.out).toContain("RESULT=MIGRATION_VERIFIED");
        expect(applied.out).toContain("MIGRATION_APPLY=MIGRATOR");
        expect(applied.out).toContain("DATABASE_RESTORE=NO");
        expect(applied.out).toContain("RETRY_MIGRATION=NO");
        expect(applied.out).not.toContain(migratorPassword);
        const history = psql(
          container,
          database,
          bootPassword,
          `SELECT migration_name || '|' || checksum || '|' || (finished_at IS NOT NULL)::text || '|' || (rolled_back_at IS NULL)::text || '|' || applied_steps_count::text FROM public."_prisma_migrations" WHERE migration_name = '${MIGRATION_NAME}'`,
          secrets,
        );
        expect(history).toBe(`${MIGRATION_NAME}|${MIGRATION_SHA256}|true|true|1`);
        expect(psql(container, database, bootPassword, 'SELECT count(*)::text FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count = 1', secrets)).toBe("47");
        expect(psql(container, database, bootPassword, 'SELECT count(*)::text FROM public."_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL', secrets)).toBe("0");
        expect(psql(container, database, bootPassword, `SELECT attnotnull::text FROM pg_attribute WHERE attrelid = 'public."ProductionOperation"'::regclass AND attname = 'cancelledAt'`, secrets)).toBe("false");
        for (const index of [
          "ProductionOperation_cancelledAt_idx",
          "BatchPackageEditCommand_requestId_key",
          "BatchPackageEditCommand_batchId_recordedAt_idx",
          "ProductionOperationCancellation_requestId_key",
          "ProductionOperationCancellation_operationId_key",
          "ProductionOperationCancellation_operationId_recordedAt_idx",
        ]) {
          expect(psql(container, database, bootPassword, `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${index}'`, secrets)).toBe("1");
        }
        expect(psql(container, database, bootPassword, `SELECT has_table_privilege('stell22_app', 'public."BatchPackageEditCommand"', 'INSERT')::text`, secrets)).toBe("true");
        expect(psql(container, database, bootPassword, 'SELECT count(*)::text FROM public."ProductionOperation"', secrets)).toBe("0");
        const repeat = operator(common, urlFile, secrets);
        expect(repeat.status).not.toBe(0);
        expect(repeat.out).toContain("RESULT=STOP_ALREADY_APPLIED");
        const rows = psql(
          container,
          database,
          bootPassword,
          `SELECT migration_name || ' ' || checksum FROM public."_prisma_migrations" ORDER BY migration_name`,
          secrets,
        ).split(/\r?\n/).filter(Boolean);
        const imageMigrations = readImageMigrations(process.cwd());
        expect(rows).toHaveLength(47);
        const role: StartupRole = {
          currentUser: "stell22_app",
          sessionUser: "stell22_app",
          databaseName: "stell22",
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
        };
        expect(evaluateAppOnlyStartup({
          imageMigrations,
          history: imageMigrations.map((migration) => ({
            migrationName: migration.name,
            checksum: migration.sha256,
            startedAt: "2026-10-25T00:00:00.000Z",
            finishedAt: "2026-10-25T00:00:00.000Z",
            rolledBackAt: null,
            appliedStepsCount: 1,
          })),
          schemaShape: "match",
          role,
          urlDatabase: "stell22",
          urlUser: "stell22_app",
        })).toEqual({ ok: true });
        expect(rows.map((line) => line.split(" ")[1])).toEqual(imageMigrations.map((migration) => migration.sha256));
      } finally {
        if (started) run("docker", ["rm", "-f", container]);
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    300_000,
  );
});

function psql(container: string, database: string, password: string, sql: string, secrets: readonly string[]) {
  const child = run(
    "docker",
    ["exec", "-i", "-e", `PGPASSWORD=${password}`, container, "psql", "-X", "-U", "acrel_boot", "-d", database, "-q", "-v", "ON_ERROR_STOP=1", "-At"],
    sql,
  );
  if (child.status !== 0) throw new Error(redact(`${child.stdout}\n${child.stderr}`, secrets).slice(0, 800));
  return child.stdout.trim();
}

function deploy(schemaDir: string, url: string, secrets: readonly string[]) {
  const child = spawnSync(process.execPath, [path.join("node_modules", "prisma", "build", "index.js"), "migrate", "deploy", "--schema", path.join(schemaDir, "prisma", "schema.prisma")], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url },
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(redact(`${child.stdout}\n${child.stderr}`, secrets).slice(0, 800));
}

function operatorEnv(database: string, container: string, inspectPassword: string, schemaDir: string, sha: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    COMSPEC: process.env.COMSPEC,
    NODE_ENV: process.env.NODE_ENV,
    STELL22_ADMIN_CORRECTIONS_DISPOSABLE: "1",
    STELL22_ADMIN_CORRECTIONS_EXECUTE: "1",
    STELL22_ADMIN_CORRECTIONS_MAINTENANCE: "1",
    STELL22_ADMIN_CORRECTIONS_AUTHORIZATION: AUTHORIZATION_PHRASE,
    STELL22_ADMIN_CORRECTIONS_CI: "1",
    STELL22_ADMIN_CORRECTIONS_SHA: sha,
    STELL22_AC_PHASE: "migrate-only",
    STELL22_AC_DATABASE: database,
    STELL22_AC_DB_CONTAINER: container,
    STELL22_AC_APP_CONTAINER: `acrel-app-${database.slice(-8)}`,
    STELL22_AC_INSPECT_USER: "acrel_boot",
    STELL22_AC_INSPECT_PASSWORD: inspectPassword,
    STELL22_AC_SCHEMA_DIR: schemaDir,
    STELL22_AC_ORIGIN_MAIN: sha,
    STELL22_AC_HEAD: sha,
  };
}

function operator(env: NodeJS.ProcessEnv, urlFile: string, secrets: readonly string[]) {
  const child = spawnSync("sh", ["scripts/admin-corrections-release.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...env,
      STELL22_AC_SCHEMA_DIR: String(env.STELL22_AC_SCHEMA_DIR ?? "").replace(/\\/g, "/"),
      STELL22_AC_URL_FILE: urlFile.replace(/\\/g, "/"),
    },
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: child.status, out: redact(`${child.stdout ?? ""}${child.stderr ?? ""}`, secrets) };
}
