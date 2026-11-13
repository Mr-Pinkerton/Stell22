/**
 * Disposable entrypoint for one statement-period migration.
 * Refuses to start unless STELL22_STATEMENT_DISPOSABLE=1.
 * There is no production mode.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationInventory } from "../src/server/internal/statement-period-release/decide.mjs";
import {
  POSTGRES_IMAGE,
  assessDisposableIdentity,
  parseEvidence,
  parseHistoryText,
  runDisposableStatementMigration,
} from "../src/server/internal/statement-period-release/operator.mjs";

const PRISMA_IMAGE = "stell22-statement-disposable-prisma:6.19.3";
const HISTORY_SQL =
  "SELECT migration_name || '|' || checksum || '|' || (finished_at IS NOT NULL)::text || '|' || (rolled_back_at IS NOT NULL)::text || '|' || applied_steps_count::text FROM public.\"_prisma_migrations\" ORDER BY migration_name";

function say(code) {
  process.stdout.write(`RESULT=${code}\nRETRY_MIGRATION=NO\nSCHEMA_RESTORE=NO\nAPP_MIGRATED=no\n`);
}

function fail(code) {
  say(code);
  process.exitCode = 1;
}

function docker(args, options = {}) {
  return spawnSync("docker", args, { encoding: "utf8", windowsHide: true, ...options });
}

function publishedPorts(inspect) {
  const groups = [inspect?.HostConfig?.PortBindings, inspect?.NetworkSettings?.Ports];
  for (const group of groups) {
    if (!group || typeof group !== "object") continue;
    for (const value of Object.values(group)) {
      if (Array.isArray(value) && value.some((item) => item && item.HostPort)) return true;
    }
  }
  return false;
}

function productionContainersPresent() {
  const listed = docker(["ps", "-a", "--format", "{{.Names}}"]);
  if (listed.status !== 0) return true;
  const names = new Set(listed.stdout.split(/\r?\n/).map((name) => name.trim()).filter(Boolean));
  return names.has("stell22-db-prod") || names.has("stell22-app") || names.has("stell22-caddy");
}

function inspectContainer(containerId) {
  const inspected = docker(["inspect", containerId]);
  if (inspected.status !== 0) return null;
  const parsed = JSON.parse(inspected.stdout);
  const item = Array.isArray(parsed) ? parsed[0] : null;
  if (!item) return null;
  const expected = docker(["image", "inspect", "--format", "{{.Id}}", POSTGRES_IMAGE]);
  if (expected.status !== 0) return null;
  const imageId = String(item.Image ?? "").replace(/^sha256:/, "").toLowerCase();
  const expectedImageId = String(expected.stdout ?? "").replace(/^sha256:/, "").trim().toLowerCase();
  const compose = item.Config?.Labels?.["com.docker.compose.project"] ?? "";
  const mounts = Array.isArray(item.Mounts)
    ? item.Mounts.map((mount) => ({
        type: mount.Type ?? "",
        destination: mount.Destination ?? "",
        name: mount.Name ?? "",
      }))
    : [];
  const tmpfs = item.HostConfig?.Tmpfs ?? {};
  return {
    id: String(item.Id ?? "").toLowerCase(),
    name: String(item.Name ?? "").replace(/^\//, ""),
    networkMode: item.HostConfig?.NetworkMode ?? "",
    publishedPorts: publishedPorts(item),
    configImage: item.Config?.Image ?? "",
    imageId,
    expectedImageId,
    label: item.Config?.Labels?.["stell22.production-backup-restore"] ?? "",
    composeProject: compose === "<no value>" ? "" : compose,
    dataTmpfs: Object.prototype.hasOwnProperty.call(tmpfs, "/var/lib/postgresql/data"),
    mounts,
  };
}

function psql(containerId, database, sql) {
  const queried = docker([
    "exec",
    containerId,
    "psql",
    "-X",
    "-U",
    "stell22",
    "-d",
    database,
    "-q",
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
    "-c",
    sql,
  ]);
  if (queried.status !== 0) throw new Error("PSQL_FAILED");
  return queried.stdout;
}

function ensurePrismaImage() {
  const present = docker(["image", "inspect", PRISMA_IMAGE]);
  if (present.status === 0) return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stell22-statement-prisma-"));
  fs.writeFileSync(
    path.join(directory, "Dockerfile"),
    "FROM node:22-bookworm-slim\nRUN npm install -g prisma@6.19.3\n",
  );
  const log = path.join(os.tmpdir(), "stell22-statement-prisma-build.log");
  const built = docker(["build", "-t", PRISMA_IMAGE, directory], {
    stdio: ["ignore", fs.openSync(log, "w"), fs.openSync(log, "a")],
  });
  fs.rmSync(directory, { recursive: true, force: true });
  if (built.status !== 0) throw new Error("PRISMA_IMAGE_FAILED");
  fs.rmSync(log, { force: true });
}

function main() {
  if (process.env.STELL22_STATEMENT_DISPOSABLE !== "1") {
    fail("STOP_DISPOSABLE");
    return;
  }
  if ((process.env.STELL22_STATEMENT_PRODUCTION ?? "") !== "") {
    fail("STOP_PRODUCTION");
    return;
  }
  const containerId = process.env.STELL22_STATEMENT_CONTAINER ?? "";
  const evidencePath = process.env.STELL22_STATEMENT_EVIDENCE ?? "";
  const database = process.env.STELL22_STATEMENT_DATABASE ?? "";
  const password = process.env.STELL22_MIGRATOR_PASSWORD ?? "";
  if (containerId === "" || evidencePath === "" || database === "" || password.length < 24) {
    fail("STOP_IDENTITY");
    return;
  }
  const evidence = parseEvidence(fs.readFileSync(evidencePath, "utf8"));
  const inspect = inspectContainer(containerId);
  if (!inspect) {
    fail("STOP_IDENTITY");
    return;
  }
  const blocked = productionContainersPresent();
  const identity = assessDisposableIdentity({
    databaseName: database,
    productionContainersPresent: blocked,
    evidence,
    inspect,
  });
  if (!identity.ok) {
    const mounts = inspect.mounts.map((mount) => `${mount.type}:${mount.destination}`).join(",");
    process.stdout.write(`IDENTITY_DETAIL=${identity.code} tmpfs=${inspect.dataTmpfs} mounts=${mounts}\n`);
    fail(identity.code);
    return;
  }

  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const inventory = readMigrationInventory(path.join(repositoryRoot, "prisma", "migrations"));
  try {
    ensurePrismaImage();
  } catch {
    fail("STOP_UNCERTAIN");
    return;
  }
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stell22-statement-url-")), "migrator.env");
  fs.writeFileSync(envFile, `DATABASE_URL=postgresql://stell22_migrator:${password}@127.0.0.1:5432/${database}\n`, { mode: 0o600 });
  try {
    const result = runDisposableStatementMigration({
      identity: { databaseName: database, productionContainersPresent: blocked, evidence, inspect },
      inventory,
      readServerVersion: () => psql(containerId, database, "SHOW server_version_num").trim(),
      readHistory: () => parseHistoryText(psql(containerId, database, HISTORY_SQL)),
      confirmRole: () => {
        const queried = docker([
          "exec",
          "-e",
          `PGPASSWORD=${password}`,
          containerId,
          "psql",
          "-X",
          "-h",
          "127.0.0.1",
          "-U",
          "stell22_migrator",
          "-d",
          database,
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-At",
          "-c",
          "SELECT current_user",
        ]);
        if (queried.status !== 0) throw new Error("ROLE_UNCONFIRMED");
        return queried.stdout.trim();
      },
      migrate: () => {
        const prismaDir = path.join(repositoryRoot, "prisma").replaceAll("\\", "/");
        const migrated = docker(
          [
            "run",
            "--rm",
            "--network",
            `container:${containerId}`,
            "--env-file",
            envFile,
            "-v",
            `${prismaDir}:/app/prisma:ro`,
            "-w",
            "/app",
            PRISMA_IMAGE,
            "prisma",
            "migrate",
            "deploy",
            "--schema",
            "/app/prisma/schema.prisma",
          ],
          { maxBuffer: 8 * 1024 * 1024 },
        );
        if (migrated.status !== 0) {
          const redacted = `${migrated.stdout ?? ""}\n${migrated.stderr ?? ""}`.replace(
            /postgresql:\/\/[^@\s]+@/g,
            "postgresql://REDACTED@",
          );
          fs.writeFileSync(path.join(os.tmpdir(), "stell22-statement-migrate.err"), redacted.slice(-4000), { mode: 0o600 });
        }
        return { status: migrated.status };
      },
    });
    say(result.code);
    if (!result.ok) process.exitCode = 1;
  } finally {
    fs.rmSync(path.dirname(envFile), { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
