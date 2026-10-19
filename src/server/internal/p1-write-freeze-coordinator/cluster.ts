/**
 * One disposable PostgreSQL 17 cluster for the write-freeze coordinator.
 * The bootstrap database name is the image default. Coordinator operations
 * use only p1wc_ / p1wcr_ databases created by this invocation.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultOriginRuntime, resolveLocalDockerEndpoint } from "@/server/internal/p1-isolated-runner/container-origin";
import {
  formatCleanupReport,
  releaseInvocation,
  type DockerWorld,
  type ExecResult,
  type Invocation,
} from "@/server/internal/p1-write-freeze-coordinator/cleanup";
import { COORDINATOR_LABEL, IMAGE_REF } from "@/server/internal/p1-write-freeze-coordinator/contract";
import {
  assertCoordinatorDatabase,
  assertResourceName,
  assertRestoreDatabase,
  evaluateInspect,
  namesForRun,
  type OwnedExpectation,
} from "@/server/internal/p1-write-freeze-coordinator/identity";

export type SqlRole = "bootstrap" | "breakglass" | "app" | "migrator";

const held: ChildProcess[] = [];

export type Cluster = {
  runId: string;
  containerId: string;
  containerName: string;
  networkName: string;
  volumeName: string;
  imageId: string;
  daemonId: string;
  endpoint: string;
  startedAt: string;
  passwords: Record<SqlRole, string>;
};

export type SqlOutcome = {
  status: number | null;
  signal: NodeJS.Signals | null;
  sqlstate: string | null;
  stdout: string;
  stderr: string;
};

export function createCluster(): Cluster {
  const world = realWorld();
  const endpoint = world.endpoint();
  const image = world.exec(["image", "inspect", "--format", "{{.Id}}", IMAGE_REF]);
  const imageId = image.stdout.trim();
  if (image.status !== 0 || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new Error("postgres:17-alpine is not available locally");
  }
  const daemonId = world.daemonId();
  const names = namesForRun(randomUUID());
  assertResourceName(names.containerName);
  assertResourceName(names.networkName);
  assertResourceName(names.volumeName);
  const passwords = {
    bootstrap: secret(),
    breakglass: secret(),
    app: secret(),
    migrator: secret(),
  };
  const invocation: Invocation = {
    endpoint,
    daemonId,
    imageId,
    names,
    networkCreated: false,
    volumeCreated: false,
    containerId: null,
    containerPhase: "not-started",
  };
  const label = `${COORDINATOR_LABEL}=${names.runId}`;
  try {
    assertSameBinding(invocation, world);
    if (world.exec(["network", "create", "--label", label, names.networkName]).status !== 0) {
      throw new Error("docker network failed");
    }
    invocation.networkCreated = true;
    assertSameBinding(invocation, world);
    if (world.exec(["volume", "create", "--label", label, names.volumeName]).status !== 0) {
      throw new Error("docker volume failed");
    }
    invocation.volumeCreated = true;
    assertSameBinding(invocation, world);
    const envFile = writeEnvFile(passwords.bootstrap);
    let created: ExecResult;
    try {
      created = world.exec([
        "run",
        "-d",
        "--pull",
        "never",
        "--restart",
        "no",
        "--name",
        names.containerName,
        "--network",
        names.networkName,
        "--label",
        label,
        "--mount",
        `type=volume,source=${names.volumeName},target=/var/lib/postgresql/data`,
        "--env-file",
        envFile,
        IMAGE_REF,
      ]);
    } finally {
      fs.rmSync(envFile, { force: true });
    }
    if (created.status !== 0) {
      invocation.containerPhase = "ambiguous";
      throw new Error("docker run failed");
    }
    const containerId = created.stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(containerId)) {
      invocation.containerPhase = "ambiguous";
      throw new Error("docker did not return a container id");
    }
    invocation.containerId = containerId;
    invocation.containerPhase = "ambiguous";
    const inspected = world.exec(["inspect", containerId]);
    const document = parseOne(inspected);
    if (document === undefined) throw new Error("docker inspect failed");
    const owned = evaluateInspect(document, { ...names, containerId, imageId }, "mutate");
    if (!owned.ok) throw new Error(`refusing container: ${owned.code}`);
    invocation.containerPhase = "confirmed";
    const cluster: Cluster = { ...names, containerId, imageId, daemonId, endpoint, startedAt: "", passwords };
    cluster.startedAt = readStartedAt(cluster);
    waitReady(cluster);
    const marked = runSql(cluster, "bootstrap", `COMMENT ON DATABASE stell22 IS 'p1wc-run:${cluster.runId}';`, "stell22", true);
    if (marked.status !== 0) throw new Error(`identity comment failed ${marked.sqlstate ?? ""}`);
    reconfirm(cluster);
    createRoles(cluster);
    return cluster;
  } catch (error) {
    const report = releaseInvocation(invocation, world);
    const message = error instanceof Error ? error.message : "cluster creation failed";
    throw new Error(redact(`${message}; ${formatCleanupReport(report)}`, Object.values(passwords)));
  }
}

export function destroyCluster(cluster: Cluster): void {
  stopBackgroundSql();
  const report = releaseInvocation(invocationFrom(cluster), realWorld());
  if (report.preserved.length > 0 || report.failures.length > 0) {
    throw new Error(redact(formatCleanupReport(report), Object.values(cluster.passwords)));
  }
}

export function reconfirm(cluster: Cluster): void {
  const endpoint = resolveLocalDockerEndpoint(defaultOriginRuntime());
  if (endpoint !== cluster.endpoint) throw new Error("docker endpoint changed");
  const daemonId = docker(["info", "--format", "{{.ID}}"]).stdout.trim();
  if (daemonId !== cluster.daemonId) throw new Error("docker daemon changed");
  const inspected = parseOne(execRaw(["inspect", cluster.containerId]));
  if (inspected === undefined) throw new Error("docker inspect failed");
  const verdict = evaluateInspect(inspected, expectation(cluster), "mutate");
  if (!verdict.ok) throw new Error(`refusing container: ${verdict.code}`);
  if (readStartedAt(cluster) !== cluster.startedAt) throw new Error("container StartedAt changed");
}

export function sql(cluster: Cluster, role: SqlRole, statement: string, database: string): SqlOutcome {
  if (database !== "stell22") assertCoordinatorDatabase(database) ;
  reconfirm(cluster);
  return runSql(cluster, role, statement, database, false);
}

export function createBusinessDatabase(cluster: Cluster): string {
  const name = `p1wc_${randomBytes(4).toString("hex")}`;
  assertCoordinatorDatabase(name);
  const created = sql(cluster, "bootstrap", `CREATE DATABASE ${quoteIdent(name)};`, "stell22");
  if (created.status !== 0) throw new Error(`create database failed ${created.sqlstate ?? ""}`);
  const owned = sql(
    cluster,
    "bootstrap",
    `ALTER DATABASE ${quoteIdent(name)} OWNER TO p1wc_migrator; REVOKE CREATE ON DATABASE ${quoteIdent(name)} FROM PUBLIC;`,
    "stell22",
  );
  if (owned.status !== 0) throw new Error(`database owner change failed ${owned.sqlstate ?? ""}`);
  const provisioned = sql(cluster, "bootstrap", provisionSql(name), name);
  if (provisioned.status !== 0) {
    throw new Error(`provision failed ${provisioned.sqlstate ?? ""} ${provisioned.stderr.slice(0, 400)}`);
  }
  return name;
}

export function createRestoreDatabase(cluster: Cluster, source: string): string {
  const name = `p1wcr_${randomBytes(4).toString("hex")}`;
  assertRestoreDatabase(name, source);
  const created = sql(cluster, "bootstrap", `CREATE DATABASE ${quoteIdent(name)};`, "stell22");
  if (created.status !== 0) throw new Error(`create restore database failed ${created.sqlstate ?? ""}`);
  return name;
}

export function dumpDatabase(cluster: Cluster, database: string): SqlOutcome {
  assertCoordinatorDatabase(database);
  reconfirm(cluster);
  return withPasswordFile(cluster.passwords.breakglass, (envFile) => {
    const child = spawnSync(
      "docker",
      execArgs(envFile, cluster.containerId, [
        "pg_dump",
        "-h",
        "127.0.0.1",
        "-U",
        roleName(cluster, "breakglass"),
        "-d",
        database,
        "--no-owner",
        "--no-acl",
      ], false),
      { windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return outcome(child, Object.values(cluster.passwords));
  });
}

export function restoreSql(cluster: Cluster, database: string, source: string, script: string): SqlOutcome {
  assertRestoreDatabase(database, source);
  reconfirm(cluster);
  return runSql(cluster, "breakglass", script, database, true);
}

export function sqlOnRestore(cluster: Cluster, statement: string, database: string, source: string): SqlOutcome {
  assertRestoreDatabase(database, source);
  reconfirm(cluster);
  return runSql(cluster, "breakglass", statement, database, false);
}

export function startBackgroundSql(cluster: Cluster, role: SqlRole, database: string, statement: string): void {
  if (database !== "stell22") assertCoordinatorDatabase(database);
  reconfirm(cluster);
  const envFile = writePasswordFile(cluster.passwords[role]);
  const child = spawn(
    "docker",
    execArgs(envFile, cluster.containerId, [
      "psql",
      "-X",
      "-h",
      "127.0.0.1",
      "-U",
      roleName(cluster, role),
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ], false),
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.on("exit", () => {
    fs.rmSync(envFile, { force: true });
  });
  held.push(child);
}

export function stopBackgroundSql(): void {
  for (const child of held) {
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // Container removal ends the server session.
      }
    }
  }
  held.length = 0;
}

export function roleName(_cluster: Cluster, role: SqlRole): string {
  return ROLE[role];
}

function createRoles(cluster: Cluster): void {
  const sqlText = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p1wc_breakglass') THEN
    CREATE ROLE p1wc_breakglass LOGIN SUPERUSER PASSWORD '${cluster.passwords.breakglass}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p1wc_migrator') THEN
    CREATE ROLE p1wc_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${cluster.passwords.migrator}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'p1wc_app') THEN
    CREATE ROLE p1wc_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${cluster.passwords.app}';
  END IF;
END $$;`;
  const created = runSql(cluster, "bootstrap", sqlText, "stell22", true);
  if (created.status !== 0) throw new Error(`role creation failed ${created.sqlstate ?? ""} ${created.stderr.slice(0, 300)}`);
}

function provisionSql(database: string): string {
  const quoted = quoteIdent(database);
  return `
CREATE TABLE p1wc_inventory (id integer PRIMARY KEY, sku text NOT NULL, qty integer NOT NULL);
CREATE TABLE p1wc_production (id integer PRIMARY KEY, output_qty integer NOT NULL);
CREATE TABLE p1wc_purchase (id integer PRIMARY KEY, amount integer NOT NULL);
CREATE TABLE p1wc_cost (id integer PRIMARY KEY, amount integer NOT NULL);
CREATE TABLE p1wc_finance (id integer PRIMARY KEY, amount integer NOT NULL);
CREATE TABLE p1wc_notification (id integer PRIMARY KEY, body text NOT NULL);
CREATE TABLE p1wc_migration_history (id integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL);
CREATE SEQUENCE p1wc_business_seq;
CREATE TABLE "BatchCreationCommand" (
  id text PRIMARY KEY,
  "requestId" text NOT NULL,
  "batchId" text NOT NULL
);
INSERT INTO p1wc_inventory VALUES (1, 'rail', 4);
INSERT INTO p1wc_production VALUES (1, 2);
INSERT INTO p1wc_purchase VALUES (1, 100);
INSERT INTO p1wc_cost VALUES (1, 50);
INSERT INTO p1wc_finance VALUES (1, 20);
INSERT INTO p1wc_notification VALUES (1, 'ready');
INSERT INTO p1wc_migration_history VALUES (1, '0001_init', 'abc');
INSERT INTO "BatchCreationCommand" (id, "requestId", "batchId") VALUES ('cmd-1', 'req-1', 'batch-1');
ALTER TABLE p1wc_inventory OWNER TO p1wc_migrator;
ALTER TABLE p1wc_production OWNER TO p1wc_migrator;
ALTER TABLE p1wc_purchase OWNER TO p1wc_migrator;
ALTER TABLE p1wc_cost OWNER TO p1wc_migrator;
ALTER TABLE p1wc_finance OWNER TO p1wc_migrator;
ALTER TABLE p1wc_notification OWNER TO p1wc_migrator;
ALTER TABLE p1wc_migration_history OWNER TO p1wc_migrator;
ALTER TABLE "BatchCreationCommand" OWNER TO p1wc_migrator;
ALTER SEQUENCE p1wc_business_seq OWNER TO p1wc_migrator;
ALTER SCHEMA public OWNER TO p1wc_migrator;
GRANT USAGE ON SCHEMA public TO p1wc_app;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO p1wc_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO p1wc_app;
GRANT UPDATE (qty) ON p1wc_inventory TO p1wc_app;
GRANT INSERT ON p1wc_inventory TO PUBLIC;
GRANT CREATE ON SCHEMA public TO p1wc_app;
GRANT CREATE ON DATABASE ${quoted} TO p1wc_app;
GRANT p1wc_migrator TO p1wc_app;
CREATE FUNCTION p1wc_inventory_audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO p1wc_finance (id, amount) VALUES (NEW.id + 1000, NEW.qty);
  RETURN NEW;
END $fn$;
CREATE TRIGGER p1wc_inventory_audit BEFORE UPDATE ON p1wc_inventory
  FOR EACH ROW EXECUTE FUNCTION p1wc_inventory_audit();
ALTER FUNCTION p1wc_inventory_audit() OWNER TO p1wc_migrator;
CREATE FUNCTION p1wc_hidden_write() RETURNS void LANGUAGE sql SECURITY DEFINER AS $fn$
  INSERT INTO p1wc_finance (id, amount) VALUES (99, 1) $fn$;
ALTER FUNCTION p1wc_hidden_write() OWNER TO p1wc_migrator;
GRANT EXECUTE ON FUNCTION p1wc_hidden_write() TO p1wc_app;`.trim();
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const ROLE: Record<SqlRole, string> = {
  bootstrap: "stell22",
  breakglass: "p1wc_breakglass",
  app: "p1wc_app",
  migrator: "p1wc_migrator",
};

function runSql(cluster: Cluster, role: SqlRole, statement: string, database: string, probe: boolean): SqlOutcome {
  const script = probe ? statement : `SET statement_timeout = '8s';\nSET lock_timeout = '3s';\n${statement}`;
  return withPasswordFile(cluster.passwords[role], (envFile) => {
    const child = spawnSync(
      "docker",
      execArgs(envFile, cluster.containerId, [
        "psql",
        "-X",
        "-h",
        "127.0.0.1",
        "-U",
        ROLE[role],
        "-d",
        database,
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        "VERBOSITY=verbose",
        "-A",
        "-t",
        "-F",
        "|",
        "-f",
        "-",
      ], true),
      { windowsHide: true, encoding: "utf8", input: script, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return outcome(child, Object.values(cluster.passwords));
  });
}

function waitReady(cluster: Cluster): void {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const ready = spawnSync(
      "docker",
      ["exec", cluster.containerId, "pg_isready", "-h", "127.0.0.1", "-U", "stell22", "-d", "stell22"],
      { windowsHide: true, encoding: "utf8", timeout: 5_000 },
    );
    if (ready.status === 0) {
      const probe = runSql(cluster, "bootstrap", "SELECT 1;", "stell22", true);
      if (probe.status === 0) return;
    }
    sleep(500);
  }
  throw new Error("disposable postgres did not accept a TCP login");
}

export function containerStartedAt(cluster: Cluster): string {
  return readStartedAt(cluster);
}

function readStartedAt(cluster: Cluster): string {
  const result = docker(["inspect", "--format", "{{.State.StartedAt}}", cluster.containerId]);
  const startedAt = result.stdout.trim();
  if (startedAt.length < 20) throw new Error("container StartedAt is missing");
  return startedAt;
}

function expectation(cluster: Cluster): OwnedExpectation {
  return {
    runId: cluster.runId,
    containerId: cluster.containerId,
    containerName: cluster.containerName,
    networkName: cluster.networkName,
    volumeName: cluster.volumeName,
    imageId: cluster.imageId,
  };
}

function invocationFrom(cluster: Cluster): Invocation {
  return {
    endpoint: cluster.endpoint,
    daemonId: cluster.daemonId,
    imageId: cluster.imageId,
    names: {
      runId: cluster.runId,
      containerName: cluster.containerName,
      networkName: cluster.networkName,
      volumeName: cluster.volumeName,
    },
    networkCreated: true,
    volumeCreated: true,
    containerId: cluster.containerId,
    containerPhase: "confirmed",
  };
}

function execArgs(envFile: string, containerId: string, command: readonly string[], stdin: boolean): string[] {
  const args = ["exec"];
  if (stdin) args.push("-i");
  args.push("--env-file", envFile, containerId, ...command);
  return args;
}

function realWorld(): DockerWorld {
  return {
    endpoint: () => resolveLocalDockerEndpoint(defaultOriginRuntime()),
    daemonId: () => {
      const result = execRaw(["info", "--format", "{{.ID}}"]);
      const daemonId = result.stdout.trim();
      if (result.status !== 0 || daemonId.length < 8) throw new Error("docker daemon id is missing");
      return daemonId;
    },
    exec: (args) => execRaw(args),
  };
}

function execRaw(args: readonly string[]): ExecResult {
  const child = spawnSync("docker", [...args], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

function assertSameBinding(invocation: Invocation, world: DockerWorld): void {
  if (world.endpoint() !== invocation.endpoint) throw new Error("docker endpoint changed");
  if (world.daemonId() !== invocation.daemonId) throw new Error("docker daemon changed");
}

function docker(args: readonly string[]): { stdout: string } {
  const result = execRaw(args);
  if (result.status !== 0) throw new Error(`docker ${args[0] ?? "command"} failed`);
  return { stdout: result.stdout };
}

function parseOne(result: ExecResult | undefined): unknown | undefined {
  if (result === undefined || result.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
    return parsed[0];
  } catch {
    return undefined;
  }
}

function writeEnvFile(password: string): string {
  const file = path.join(os.tmpdir(), `p1wc-env-${randomUUID()}`);
  fs.writeFileSync(
    file,
    `POSTGRES_USER=stell22\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=stell22\nPOSTGRES_HOST_AUTH_METHOD=scram-sha-256\n`,
    { mode: 0o600 },
  );
  return file;
}

function writePasswordFile(password: string): string {
  const file = path.join(os.tmpdir(), `p1wc-pg-${randomUUID()}`);
  fs.writeFileSync(file, `PGPASSWORD=${password}\n`, { mode: 0o600 });
  return file;
}

function withPasswordFile<T>(password: string, fn: (envFile: string) => T): T {
  const file = writePasswordFile(password);
  try {
    return fn(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function secret(): string {
  return randomBytes(24).toString("hex");
}

function outcome(
  child: { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string },
  secretValues: string[],
): SqlOutcome {
  const stderr = redact(child.stderr ?? "", secretValues);
  return {
    status: child.status,
    signal: child.signal,
    sqlstate: parseSqlState(stderr),
    stdout: redact(child.stdout ?? "", secretValues),
    stderr,
  };
}

function parseSqlState(stderr: string): string | null {
  const match = stderr.match(/(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/);
  return match?.[1] ?? null;
}

function redact(text: string, secretValues: readonly string[]): string {
  let out = text;
  for (const secretValue of secretValues) {
    if (secretValue.length > 0) out = out.split(secretValue).join("[redacted]");
  }
  return out;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
