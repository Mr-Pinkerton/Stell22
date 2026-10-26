import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_PHRASE, MIGRATION_NAME, MIGRATION_SHA256, readMigrationInventory } from "./decide.mjs";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const OLD_SHA = "4c2fe8e0c5746784e820a7a402a1fb4d2078e8d1";
const TARGET_SHA = "ea7c58f0598df9ea21ffe676a69e3348154e6520";

function run(command: string, args: readonly string[], cwd = process.cwd(), input?: Buffer | string) {
  return spawnSync(command, args, {
    cwd,
    encoding: input instanceof Buffer ? undefined : "utf8",
    input,
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function must(command: string, args: readonly string[], cwd = process.cwd(), input?: Buffer | string) {
  const child = run(command, args, cwd, input);
  if (child.status !== 0) {
    const stdout = Buffer.isBuffer(child.stdout) ? child.stdout.toString("utf8") : child.stdout;
    const stderr = Buffer.isBuffer(child.stderr) ? child.stderr.toString("utf8") : child.stderr;
    throw new Error(`${command} ${args.join(" ")}\n${stdout}\n${stderr}`.slice(0, 1200));
  }
  return Buffer.isBuffer(child.stdout) ? child.stdout.toString("utf8").trim() : child.stdout.trim();
}

function extract(sha: string, dest: string) {
  const listed = spawnSync("git", ["ls-tree", "-r", "--name-only", sha], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true,
  });
  if (listed.status !== 0) throw new Error(listed.stderr);
  for (const relative of listed.stdout.split(/\r?\n/).filter((line) => line === "prisma/schema.prisma" || line === "scripts/backup-db.sh" || line === "scripts/restore-db.sh" || line.startsWith("prisma/migrations/"))) {
    const shown = spawnSync("git", ["show", `${sha}:${relative}`], {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (shown.status !== 0 || !Buffer.isBuffer(shown.stdout)) throw new Error(`git show failed for ${relative}`);
    const target = path.join(dest, ...relative.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, shown.stdout);
  }
}

function commitAll(directory: string, message: string) {
  must("git", ["add", "-A"], directory);
  must("git", ["-c", "user.name=Stell22 Release Test", "-c", "user.email=release-test@example.invalid", "commit", "-m", message], directory);
  return must("git", ["rev-parse", "HEAD"], directory);
}

function syntheticCheckout(seed: string, mutate?: (directory: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-r3-repo-"));
  const bare = path.join(root, "origin.git");
  const server = path.join(root, "server");
  fs.mkdirSync(server);
  must("git", ["init", "-b", "main"], server);
  must("git", ["config", "--local", "core.autocrlf", "false"], server);
  extract(seed, server);
  const oldHead = commitAll(server, "old checkout");
  if (mutate) mutate(server);
  const target = mutate ? commitAll(server, "target checkout") : oldHead;
  must("git", ["init", "--bare", bare], root);
  must("git", ["remote", "add", "origin", bare], server);
  must("git", ["push", "origin", "main"], server);
  must("git", ["checkout", "--detach", oldHead], server);
  return { root, server, oldHead, target };
}

function disposableHistoricalMain() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-r3-repo-"));
  const bare = path.join(root, "origin.git");
  const server = path.join(root, "server");
  fs.mkdirSync(server);
  must("git", ["init", "-b", "main"], server);
  must("git", ["config", "--local", "core.autocrlf", "false"], server);
  extract(OLD_SHA, server);
  const oldHead = commitAll(server, "old checkout");
  extract(TARGET_SHA, server);
  const target = commitAll(server, "target checkout");
  must("git", ["init", "--bare", bare], root);
  must("git", ["remote", "add", "origin", bare], server);
  must("git", ["push", "origin", "main"], server);
  must("git", ["checkout", "--detach", oldHead], server);
  return { root, server, oldHead, target };
}

describe.skipIf(!LIVE)("admin corrections pinned migration inventory", () => {
  it(
    "reads the 47-migration target tree before switching a 46-migration checkout",
    () => {
      const runId = randomBytes(4).toString("hex");
      const bootPassword = randomBytes(18).toString("hex");
      const migratorPassword = randomBytes(18).toString("hex");
      const appPassword = randomBytes(18).toString("hex");
      const database = `acrel_${runId}`;
      const container = `acrel-db-${runId}`;
      const schemaDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-r3-schema-"));
      const cleanups: string[] = [schemaDir];
      let started = false;
      try {
        extract(OLD_SHA, schemaDir);
        const image = run("docker", ["image", "inspect", "--format", "{{.Id}}", "postgres:17-alpine"]);
        if (image.status !== 0) must("docker", ["pull", "postgres:17-alpine"]);
        must("docker", [
          "run", "-d", "--pull", "never", "--restart", "no", "--name", container,
          "-p", "127.0.0.1::5432",
          "-e", "POSTGRES_USER=acrel_boot",
          "-e", `POSTGRES_PASSWORD=${bootPassword}`,
          "-e", `POSTGRES_DB=${database}`,
          "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
          "postgres:17-alpine",
        ]);
        started = true;
        let version = "";
        for (let attempt = 0; attempt < 30 && version === ""; attempt += 1) {
          const probe = run("docker", ["exec", "-i", "-e", `PGPASSWORD=${bootPassword}`, container, "psql", "-X", "-U", "acrel_boot", "-d", database, "-q", "-At", "-c", "SELECT current_setting('server_version_num')"]);
          if (probe.status === 0 && String(probe.stdout).trim().startsWith("17")) version = String(probe.stdout).trim();
          else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
        }
        if (!version.startsWith("17")) throw new Error("disposable postgres did not become ready");
        const port = must("docker", ["inspect", "--format", "{{(index (index .NetworkSettings.Ports \"5432/tcp\") 0).HostPort}}", container]);
        psql(container, database, bootPassword, [
          `CREATE ROLE stell22_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${migratorPassword}'`,
          `CREATE ROLE stell22_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${appPassword}'`,
          "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
          "GRANT USAGE, CREATE ON SCHEMA public TO stell22_migrator",
          "GRANT USAGE ON SCHEMA public TO stell22_app",
          `GRANT CONNECT ON DATABASE ${database} TO stell22_migrator`,
          `GRANT CONNECT ON DATABASE ${database} TO stell22_app`,
          "ALTER DEFAULT PRIVILEGES FOR ROLE stell22_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stell22_app",
        ].join(";\n"));
        const migratorUrl = `postgresql://stell22_migrator:${migratorPassword}@127.0.0.1:${port}/${database}?schema=public`;
        deploy(schemaDir, migratorUrl);
        psql(container, database, bootPassword, [
          'ALTER TYPE public."OperationType" OWNER TO stell22_migrator',
          'GRANT USAGE ON TYPE public."OperationType" TO stell22_app',
          'GRANT USAGE ON TYPE public."OperationType" TO stell22_migrator',
        ].join(";\n"));
        expect(psql(container, database, bootPassword, 'SELECT count(*)::text FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).toBe("46");
        expect(readMigrationInventory(path.join(schemaDir, "prisma", "migrations"))).toHaveLength(46);

        const acceptedCheckout = disposableHistoricalMain();
        cleanups.push(acceptedCheckout.root);
        expect(must("git", ["rev-parse", "HEAD"], acceptedCheckout.server)).toBe(acceptedCheckout.oldHead);
        expect(must("git", ["rev-parse", "origin/main"], acceptedCheckout.server)).toBe(acceptedCheckout.target);
        expect(readMigrationInventory(path.join(acceptedCheckout.server, "prisma", "migrations"))).toHaveLength(46);

        const accepted = gate(acceptedCheckout.server, database, container, bootPassword, acceptedCheckout.target);
        expect(accepted.status, accepted.out).toBe(0);
        expect(accepted.out).toContain(`CHECKOUT_BEFORE=${acceptedCheckout.oldHead}`);
        expect(accepted.out).toContain(`CHECKOUT_AFTER=${acceptedCheckout.target}`);
        expect(accepted.out).toContain("PINNED_MIGRATIONS=47");
        expect(accepted.out).toContain("RESULT=GATE_ACCEPTED");
        expect(must("git", ["rev-parse", "HEAD"], acceptedCheckout.server)).toBe(acceptedCheckout.target);
        const pinned = readMigrationInventory(path.join(acceptedCheckout.server, "prisma", "migrations"));
        expect(pinned).toHaveLength(47);
        expect(pinned.find((row) => row.name === MIGRATION_NAME)?.sha256).toBe(MIGRATION_SHA256);
        expect(psql(container, database, bootPassword, 'SELECT count(*)::text FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')).toBe("46");

        const missing = syntheticCheckout(OLD_SHA);
        cleanups.push(missing.root);
        const missingResult = gate(missing.server, database, container, bootPassword, missing.target);
        expect(missingResult.status, missingResult.out).not.toBe(0);
        expect(missingResult.out).toContain("RESULT=STOP_PENDING");
        expect(missingResult.out).not.toContain("CHECKOUT=YES");
        expect(must("git", ["rev-parse", "HEAD"], missing.server)).toBe(missing.oldHead);

        const checksum = syntheticCheckout(TARGET_SHA, (directory) => {
          fs.appendFileSync(path.join(directory, "prisma", "migrations", MIGRATION_NAME, "migration.sql"), "\n-- changed\n");
        });
        cleanups.push(checksum.root);
        const checksumResult = gate(checksum.server, database, container, bootPassword, checksum.target);
        expect(checksumResult.status, checksumResult.out).not.toBe(0);
        expect(checksumResult.out).toContain("RESULT=STOP_CHECKSUM");
        expect(checksumResult.out).not.toContain("CHECKOUT=YES");
        expect(must("git", ["rev-parse", "HEAD"], checksum.server)).toBe(checksum.oldHead);

        const extra = syntheticCheckout(TARGET_SHA, (directory) => {
          const extraDir = path.join(directory, "prisma", "migrations", "20261025130100_other_pending");
          fs.mkdirSync(extraDir);
          fs.writeFileSync(path.join(extraDir, "migration.sql"), "-- other pending\n");
        });
        cleanups.push(extra.root);
        const extraResult = gate(extra.server, database, container, bootPassword, extra.target);
        expect(extraResult.status, extraResult.out).not.toBe(0);
        expect(extraResult.out).toContain("RESULT=STOP_PENDING");
        expect(extraResult.out).not.toContain("CHECKOUT=YES");
        expect(must("git", ["rev-parse", "HEAD"], extra.server)).toBe(extra.oldHead);

        const historical = syntheticCheckout(TARGET_SHA, (directory) => {
          fs.appendFileSync(path.join(directory, "prisma", "migrations", "20260629154204_init", "migration.sql"), "\n-- changed historical\n");
        });
        cleanups.push(historical.root);
        const historicalResult = gate(historical.server, database, container, bootPassword, historical.target);
        expect(historicalResult.status, historicalResult.out).not.toBe(0);
        expect(historicalResult.out).toContain("RESULT=STOP_CHECKSUM");
        expect(historicalResult.out).not.toContain("CHECKOUT=YES");
        expect(must("git", ["rev-parse", "HEAD"], historical.server)).toBe(historical.oldHead);

        const unreadable = syntheticCheckout(OLD_SHA, (directory) => {
          fs.rmSync(path.join(directory, "prisma"), { recursive: true, force: true });
        });
        cleanups.push(unreadable.root);
        const unreadableResult = gate(unreadable.server, database, container, bootPassword, unreadable.target);
        expect(unreadableResult.status, unreadableResult.out).not.toBe(0);
        expect(unreadableResult.out).toContain("RESULT=STOP_CHECKOUT");
        expect(unreadableResult.out).not.toContain("CHECKOUT=YES");
        expect(must("git", ["rev-parse", "HEAD"], unreadable.server)).toBe(unreadable.oldHead);
      } finally {
        if (started) run("docker", ["rm", "-f", container]);
        for (const directory of cleanups) fs.rmSync(directory, { recursive: true, force: true });
      }
    },
    420_000,
  );
});

function psql(container: string, database: string, password: string, sql: string) {
  const child = run("docker", ["exec", "-i", "-e", `PGPASSWORD=${password}`, container, "psql", "-X", "-U", "acrel_boot", "-d", database, "-q", "-v", "ON_ERROR_STOP=1", "-At"], process.cwd(), sql);
  if (child.status !== 0) throw new Error(`${child.stdout}\n${child.stderr}`.slice(0, 800));
  return String(child.stdout).trim();
}

function deploy(schemaDir: string, url: string) {
  const child = spawnSync(process.execPath, [path.join("node_modules", "prisma", "build", "index.js"), "migrate", "deploy", "--schema", path.join(schemaDir, "prisma", "schema.prisma")], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url },
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (child.status !== 0) throw new Error(`${child.stdout}\n${child.stderr}`.slice(0, 800));
}

function gate(server: string, database: string, container: string, inspectPassword: string, sha: string) {
  const child = spawnSync("sh", ["scripts/admin-corrections-release.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      COMSPEC: process.env.COMSPEC,
      NODE_ENV: process.env.NODE_ENV,
      SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
      STELL22_ADMIN_CORRECTIONS_DISPOSABLE: "1",
      STELL22_ADMIN_CORRECTIONS_EXECUTE: "1",
      STELL22_ADMIN_CORRECTIONS_MAINTENANCE: "1",
      STELL22_ADMIN_CORRECTIONS_AUTHORIZATION: AUTHORIZATION_PHRASE,
      STELL22_ADMIN_CORRECTIONS_CI: "1",
      STELL22_ADMIN_CORRECTIONS_SHA: sha,
      STELL22_AC_PHASE: "server-checkout",
      STELL22_AC_APP_DIR: server.replace(/\\/g, "/"),
      STELL22_AC_DATABASE: database,
      STELL22_AC_DB_CONTAINER: container,
      STELL22_AC_APP_CONTAINER: `acrel-app-${database.slice(-8)}`,
      STELL22_AC_INSPECT_USER: "acrel_boot",
      STELL22_AC_INSPECT_PASSWORD: inspectPassword,
      STELL22_AC_DECIDE: path.join(process.cwd(), "src/server/internal/admin-corrections-release/decide.mjs").replace(/\\/g, "/"),
      STELL22_AC_DIAGNOSTICS: path.join(process.cwd(), "scripts/release-diagnostics.sh").replace(/\\/g, "/"),
      STELL22_AC_CHECKOUT: path.join(process.cwd(), "scripts/release-checkout.sh").replace(/\\/g, "/"),
    },
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: child.status, out: `${child.stdout ?? ""}\n${child.stderr ?? ""}` };
}
