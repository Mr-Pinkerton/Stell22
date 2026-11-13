/**
 * Disposable checks for the 2026-10-28 role bootstrap.
 * Does not apply statement_period_coverage, compose, or production.
 * The archive success path runs only when STELL22_BOOTSTRAP_ARCHIVE_DIR is set.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = path.join(root, "scripts", "db-role-bootstrap.sh");
const restoreScript = path.join(root, "scripts", "production-backup-restore.sh");
const image =
  "postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb";
const confirm = "stell22-db-role-bootstrap-disposable-v1";
const containers = [];

function fail(message) {
  console.error(`[db-role-bootstrap-ci] ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: options.env ?? process.env,
    input: options.input,
  });
}

function field(text, key) {
  const match = String(text ?? "").match(new RegExp(`^${key}=(.*)$`, "m"));
  return match?.[1] ?? "";
}

function password() {
  return crypto.randomBytes(24).toString("hex");
}

function bootstrap(target, options = {}) {
  const secrets = options.secrets ?? [];
  const env = { ...options };
  delete env.secrets;
  const result = run("sh", [script, "apply", target], {
    env: {
      ...process.env,
      STELL22_DB_ROLE_BOOTSTRAP_SCOPE: "disposable",
      STELL22_DB_ROLE_BOOTSTRAP_CONFIRM: confirm,
      ...env,
    },
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  for (const secret of secrets) {
    if (secret && text.includes(secret)) fail("bootstrap printed a password");
  }
  return result;
}

function expectResult(result, expected) {
  const got = field(result.stdout ?? "", "RESULT");
  if (got !== expected) {
    const safe = (result.stdout ?? "")
      .split(/\r?\n/)
      .filter((line) => /^RESULT=/.test(line))
      .join("\n");
    console.error(safe || "no RESULT");
    fail(`expected ${expected} got ${got || "no RESULT"}`);
  }
}

function psql(container, database, sql, user = "stell22") {
  return run(
    "docker",
    ["exec", "-i", container, "psql", "-X", "-U", user, "-d", database, "-q", "-v", "ON_ERROR_STOP=1", "-At", "-f", "-"],
    { input: sql },
  );
}

function waitReady(container) {
  for (let i = 0; i < 40; i += 1) {
    const ready = run("docker", [
      "exec",
      container,
      "psql",
      "-X",
      "-U",
      "stell22",
      "-d",
      "stell22_pbr_admin",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      "SELECT 1",
    ]);
    if (ready.status === 0) return;
    run("sh", ["-c", "sleep 1"]);
  }
  fail("postgres did not become ready");
}

function startContainer() {
  const runId = `pbr${crypto.randomBytes(8).toString("hex")}`;
  const name = `stell22-pbr-${runId}`;
  const created = run("docker", [
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "none",
    "--label",
    `stell22.production-backup-restore=${runId}`,
    "--label",
    "stell22.pbr-owner=disposable",
    "--memory",
    "1073741824",
    "--memory-swap",
    "1073741824",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,size=1073741824",
    "--restart",
    "no",
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "-e",
    "POSTGRES_USER=stell22",
    "-e",
    "POSTGRES_PASSWORD=synthetic",
    "-e",
    "POSTGRES_DB=stell22_pbr_admin",
    image,
  ]);
  if (created.status !== 0) fail("disposable postgres was not created");
  const id = (created.stdout ?? "").trim();
  containers.push(id);
  waitReady(id);
  const database = psql(id, "stell22_pbr_admin", "CREATE DATABASE stell22_pbr_dst;\n");
  if (database.status !== 0) fail("destination database was not created");
  return id;
}

function cleanup() {
  for (const id of containers.splice(0, containers.length)) {
    run("docker", ["rm", "-f", id]);
  }
}

function staticContract() {
  const source = readFileSync(script, "utf8");
  if (!source.includes('RESULT=REFUSED_PRODUCTION_AUTHORIZATION')) fail("production authorization is not refused");
  if (source.includes("docker compose") || source.includes("prisma migrate")) fail("bootstrap invokes a forbidden entry point");
  if (source.includes("PASSWORD '") && /PASSWORD '[A-Za-z0-9]/.test(source)) fail("bootstrap contains a password literal");
  const compose = readFileSync(path.join(root, "docker-compose.prod.yml"), "utf8");
  if (!compose.includes("postgresql://stell22_app:${APP_DB_PASSWORD}@")) fail("app database url changed");
  if (compose.includes("MIGRATOR_DB_PASSWORD")) fail("migrator credential is in the app compose");
}

function refuseWrongState() {
  const id = startContainer();
  const refused = bootstrap(id, {});
  expectResult(refused, "REFUSED_STATE");
  const roles = psql(
    id,
    "stell22_pbr_admin",
    "SELECT count(*) FROM pg_roles WHERE rolname IN ('stell22_app', 'stell22_migrator');\n",
  );
  if (roles.status !== 0 || roles.stdout.trim() !== "0") fail("wrong state created roles");
}

function refusePartialLogin() {
  const id = startContainer();
  const seeded = psql(
    id,
    "stell22_pbr_admin",
    [
      "CREATE ROLE stell22_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT LOGIN NOREPLICATION NOBYPASSRLS;",
      "CREATE ROLE stell22_migrator NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOREPLICATION NOBYPASSRLS;",
      "",
    ].join("\n"),
  );
  if (seeded.status !== 0) fail("partial roles were not created");
  const refused = bootstrap(id, {});
  expectResult(refused, "REFUSED_STATE");
  const flags = psql(
    id,
    "stell22_pbr_admin",
    "SELECT rolname || ':' || rolcanlogin::text FROM pg_authid WHERE rolname IN ('stell22_app', 'stell22_migrator') ORDER BY rolname;\n",
  );
  if (flags.stdout.trim() !== "stell22_app:true\nstell22_migrator:false") {
    fail("partial state changed role login");
  }
}

function archiveSuccess() {
  const dir = process.env.STELL22_BOOTSTRAP_ARCHIVE_DIR ?? "";
  if (!dir) {
    if (process.env.STELL22_BOOTSTRAP_REQUIRE_ARCHIVE === "1") fail("archive directory is required");
    console.log("[db-role-bootstrap-ci] archive-success=skipped");
    return;
  }
  const name = "stell22_2026-10-28_03-00-01.sql.gz";
  const runId = `pbr${crypto.randomBytes(8).toString("hex")}`;
  const env = {
    ...process.env,
    STELL22_PBR_SHA256: "5c77d7e7191faf457baa757eedc640ffdaf2297e99a17e121bcca4a5ee66d5d3",
    STELL22_PBR_SELECTOR: "offhost281028a",
    STELL22_PBR_RUN: runId,
  };
  const restored = run("sh", [restoreScript, "run", `${dir}/${name}`, `${dir}/trust.txt`, `${dir}/control.txt`], { env });
  if (field(restored.stdout ?? "", "RESULT") !== "RESTORE_VERIFIED") fail("archive restore was not verified");
  const container = field(restored.stdout ?? "", "CONTAINER");
  const evidence = field(restored.stdout ?? "", "EVIDENCE_FILE");
  containers.push(container);
  const appPassword = password();
  const migratorPassword = password();
  const prepared = bootstrap(container, {
    STELL22_DB_ROLE_BOOTSTRAP_APP_PASSWORD: appPassword,
    STELL22_DB_ROLE_BOOTSTRAP_MIGRATOR_PASSWORD: migratorPassword,
    secrets: [appPassword, migratorPassword],
  });
  expectResult(prepared, "BOOTSTRAP_PREPARED");
  const inspect = run("docker", ["inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", container]);
  const envText = inspect.stdout ?? "";
  if (envText.includes(appPassword) || envText.includes(migratorPassword)) fail("password entered the container environment");

  const appDml = psql(
    container,
    "stell22_pbr_dst",
    'BEGIN; SELECT 1 FROM "Batch" WHERE false; UPDATE "Batch" SET id = id WHERE false; ROLLBACK;\n',
    "stell22_app",
  );
  if (appDml.status !== 0) fail("app could not read and update a restored table");
  const appDdl = psql(
    container,
    "stell22_pbr_dst",
    "CREATE TABLE stell22_bootstrap_probe (id integer);\n",
    "stell22_app",
  );
  if (appDdl.status === 0) fail("app executed DDL");
  const appHistory = psql(
    container,
    "stell22_pbr_dst",
    "INSERT INTO \"_prisma_migrations\" (id, checksum, migration_name, finished_at, applied_steps_count) VALUES ('bootstrap-probe', 'x', 'bootstrap-probe', NOW(), 1);\n",
    "stell22_app",
  );
  if (appHistory.status === 0) fail("app wrote migration history");
  const historyLeft = psql(
    container,
    "stell22_pbr_dst",
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = 'bootstrap-probe';\n",
  );
  if (historyLeft.stdout.trim() !== "0") fail("migration history changed");
  const migratorDdl = psql(
    container,
    "stell22_pbr_dst",
    "BEGIN; CREATE TABLE stell22_bootstrap_probe (id integer); DROP TABLE stell22_bootstrap_probe; ROLLBACK;\n",
    "stell22_migrator",
  );
  if (migratorDdl.status !== 0) fail("migrator could not create and drop a probe");
  const absent = psql(
    container,
    "stell22_pbr_dst",
    "SELECT count(*) FROM \"_prisma_migrations\" WHERE migration_name = '20261105120000_statement_period_coverage';\n",
  );
  if (absent.stdout.trim() !== "0") fail("coverage migration was applied");

  const again = bootstrap(container, {
    STELL22_DB_ROLE_BOOTSTRAP_APP_PASSWORD: password(),
    STELL22_DB_ROLE_BOOTSTRAP_MIGRATOR_PASSWORD: password(),
    secrets: [],
  });
  expectResult(again, "REFUSED_ALREADY_PREPARED");
  const still = psql(
    container,
    "stell22_pbr_admin",
    "SELECT rolname || ':' || rolcanlogin::text || ':' || rolsuper::text FROM pg_authid WHERE rolname IN ('stell22_app', 'stell22_migrator') ORDER BY rolname;\n",
  );
  if (still.stdout.trim() !== "stell22_app:true:false\nstell22_migrator:true:false") {
    fail("repeat changed role flags");
  }
  const appDdlAgain = psql(
    container,
    "stell22_pbr_dst",
    "CREATE TABLE stell22_bootstrap_probe (id integer);\n",
    "stell22_app",
  );
  if (appDdlAgain.status === 0) fail("repeat let the app execute DDL");

  const partial = psql(
    container,
    "stell22_pbr_admin",
    "ALTER ROLE stell22_migrator WITH NOLOGIN PASSWORD NULL;\n",
  );
  if (partial.status !== 0) fail("could not simulate partial preparation");
  const partialResult = bootstrap(container, {
    STELL22_DB_ROLE_BOOTSTRAP_APP_PASSWORD: password(),
    STELL22_DB_ROLE_BOOTSTRAP_MIGRATOR_PASSWORD: password(),
  });
  expectResult(partialResult, "REFUSED_STATE");
  const partialFlags = psql(
    container,
    "stell22_pbr_admin",
    "SELECT rolcanlogin::text FROM pg_authid WHERE rolname = 'stell22_migrator';\n",
  );
  if (partialFlags.stdout.trim() !== "false") fail("partial retry enabled the migrator");

  if (evidence) {
    const cleaned = run("sh", [restoreScript, "cleanup", evidence], { env });
    if (field(cleaned.stdout ?? "", "RESULT") !== "CLEANED") fail("restore cleanup failed");
  }
  console.log("[db-role-bootstrap-ci] archive-success=prepared");
}

try {
  staticContract();
  const production = bootstrap("stell22-db", {
    STELL22_DB_ROLE_BOOTSTRAP_SCOPE: "production",
    STELL22_DB_ROLE_BOOTSTRAP_CONFIRM: confirm,
  });
  expectResult(production, "REFUSED_PRODUCTION_AUTHORIZATION");
  const named = bootstrap("stell22-db", {});
  expectResult(named, "REFUSED_PRODUCTION_CONTAINER");
  refuseWrongState();
  refusePartialLogin();
  archiveSuccess();
  console.log("[db-role-bootstrap-ci] production-authorization=refused");
  console.log("[db-role-bootstrap-ci] wrong-state=refused");
  console.log("[db-role-bootstrap-ci] partial-login=unchanged");
} catch (error) {
  if (!process.exitCode) process.exitCode = 1;
  if (error instanceof Error && process.exitCode) {
    console.error(`[db-role-bootstrap-ci] ${error.message}`);
  }
} finally {
  cleanup();
}

if (process.exitCode) process.exit(process.exitCode);
