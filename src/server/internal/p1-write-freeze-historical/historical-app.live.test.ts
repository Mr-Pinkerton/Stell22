import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { P1_GIT_BLOB, P1_MIGRATION_PATH, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { classifyEntrypoint, classifyPool } from "@/server/internal/p1-write-freeze-historical/classify";
import type { AppExpectation } from "@/server/internal/p1-write-freeze-historical/identity";
import { bindingDrift, type InvocationBinding } from "@/server/internal/p1-write-freeze-historical/lifecycle";
import {
  appLabel,
  buildHistoricalImage,
  containerFacts,
  copyFromContainer,
  copyProbe,
  createStopped,
  ensureNodeBase,
  historicalFile,
  imageId,
  inspectDocument,
  redactedLogs,
  redact,
  realWorld,
  removeOwnedApp,
  removeOwnedImage,
  restartOwned,
  runDetached,
  runProbe,
  startProbe,
  verifyHistoricalSource,
  waitContainer,
  writeUrlFile,
} from "@/server/internal/p1-write-freeze-historical/runtime";
import {
  createCluster,
  destroyCluster,
  pgDump,
  proofExecArgs,
  sql,
  sqlBare,
  type Cluster,
  type SqlOutcome,
  type SqlRole,
} from "@/server/internal/p1-write-freeze-proof/cluster";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const PROBE = `
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
const mode = process.argv[2];
function send(value) { process.stdout.write(JSON.stringify(value)); }
async function main() {
  if (mode === "read") {
    const count = await prisma.notification.count();
    const marker = await prisma.setting.findUnique({ where: { key: "p1wf_baseline" } });
    send({ ok: true, count, marker: marker && marker.value ? marker.value.marker : null });
    return;
  }
  if (mode === "write") {
    await prisma.notification.create({ data: { key: "p1wf-hist-event", title: "fixture", message: "fixture", tone: "INFO", isSystem: false } });
    await prisma.setting.upsert({ where: { key: "p1wf_write" }, update: { value: { marker: "written" } }, create: { key: "p1wf_write", value: { marker: "written" } } });
    send({ ok: true });
    return;
  }
  if (mode === "rewrite") {
    await prisma.setting.upsert({ where: { key: "p1wf_rewrite" }, update: { value: { marker: "rewritten" } }, create: { key: "p1wf_rewrite", value: { marker: "rewritten" } } });
    send({ ok: true });
    return;
  }
  if (mode === "frozen-write") {
    await prisma.notification.create({ data: { key: "p1wf-hist-frozen", title: "no", message: "no", tone: "INFO", isSystem: false } });
    send({ ok: true });
    return;
  }
  if (mode === "hold") {
    await prisma.$transaction(async (tx) => {
      await tx.setting.upsert({ where: { key: "p1wf_hold" }, update: { value: { marker: "hold" } }, create: { key: "p1wf_hold", value: { marker: "hold" } } });
      await tx.$queryRawUnsafe("SELECT pg_sleep(25), 'p1wf_hold'");
    });
    send({ ok: true });
  }
}
main().then(() => prisma.$disconnect()).catch(async (error) => {
  send({ ok: false, code: error && error.code ? error.code : "UNKNOWN" });
  await prisma.$disconnect();
  process.exitCode = 1;
});
`;

describe.skipIf(!LIVE)("historical application write-freeze proof", () => {
  let cluster: Cluster | undefined;
  let appExpected: AppExpectation | undefined;
  let binding: InvocationBinding | undefined;
  let builtImage = "";

  afterAll(() => {
    const secrets = cluster ? Object.values(cluster.passwords) : [];
    if (cluster && appExpected && binding) removeOwnedApp(appExpected, binding, secrets);
    if (cluster) destroyCluster(cluster);
    if (binding && /^sha256:[0-9a-f]{64}$/.test(builtImage)) {
      removeOwnedImage(binding, `stell22-p1wf-hist-${binding.runId}`, builtImage, secrets);
    }
  }, 180_000);

  it("measures the historical image on a non-superuser role", async () => {
    const source = verifyHistoricalSource();
    cluster = createCluster();
    const owned = cluster;
    binding = { endpoint: owned.endpoint, daemonId: owned.daemonId, runId: owned.runId };
    const bound = binding;
    ensureNodeBase(bound);
    const secrets = Object.values(owned.passwords);
    const tag = `stell22-p1wf-hist-${owned.runId}`;
    builtImage = await buildHistoricalImage(tag, bound);
    expect(imageId(tag, bound)).toBe(builtImage);

    const fileId = createStopped(
      [
        "--name", `${owned.containerName}-file`,
        "--network", owned.networkName,
        "--label", appLabel(owned.runId),
        tag,
      ],
      bound,
    );
    const fileExpected: AppExpectation = {
      containerId: fileId,
      containerName: `${owned.containerName}-file`,
      imageId: builtImage,
      imageRef: tag,
      networkName: owned.networkName,
      runId: owned.runId,
      purpose: "created",
    };
    const copied = copyFromContainer(fileExpected, bound, "/app/docker-entrypoint.sh");
    expect(removeOwnedApp(fileExpected, bound, secrets)).toBe("removed:REMOVED");
    expect(copied.replace(/\r\n/g, "\n")).toBe(historicalFile(source.commit, "docker-entrypoint.sh").replace(/\r\n/g, "\n"));

    const roles = sql(
      owned,
      "bootstrap",
      `
      CREATE ROLE p1wf_breakglass LOGIN SUPERUSER PASSWORD '${owned.passwords.breakglass}';
      CREATE ROLE p1wf_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD '${owned.passwords.migrator}';
      CREATE ROLE p1wf_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD '${owned.passwords.app}';
      ALTER DATABASE stell22 OWNER TO p1wf_migrator;
      ALTER SCHEMA public OWNER TO p1wf_migrator;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT CONNECT ON DATABASE stell22 TO p1wf_app;
      GRANT USAGE ON SCHEMA public TO p1wf_app;
      GRANT CREATE ON SCHEMA public TO p1wf_migrator;
      `,
    );
    expect(seen(roles)).toMatchObject({ status: 0, sqlstate: null });
    expect(query(owned, "bootstrap", "SELECT rolname || '|' || rolsuper::text FROM pg_roles WHERE rolname IN ('p1wf_app', 'p1wf_migrator', 'p1wf_breakglass', 'stell22') ORDER BY rolname;")).toBe(
      "p1wf_app|false\np1wf_breakglass|true\np1wf_migrator|false\nstell22|true",
    );
    expect(query(owned, "bootstrap", "SELECT member::regrole::text || '|' || roleid::regrole::text FROM pg_auth_members WHERE member::regrole::text = 'p1wf_app';")).toBe("");

    const migrated = runOneShot(owned, bound, tag, builtImage, `${owned.containerName}-migrate`);
    expect(migrated.exit).toBe(0);
    const grants = sql(
      owned,
      "migrator",
      `
      GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO p1wf_app;
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "_prisma_migrations" FROM p1wf_app;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO p1wf_app;
      ALTER DEFAULT PRIVILEGES FOR ROLE p1wf_migrator IN SCHEMA public GRANT SELECT ON TABLES TO p1wf_app;
      `,
    );
    expect(seen(grants)).toMatchObject({ status: 0, sqlstate: null });
    expect(query(owned, "bootstrap", "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'stell22';")).toBe("p1wf_migrator");
    expect(query(owned, "bootstrap", "SELECT count(*)::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND pg_get_userbyid(c.relowner) <> 'p1wf_migrator';")).toBe("0");

    const baseline = sql(
      owned,
      "app",
      `INSERT INTO "Setting" ("key", "value") VALUES ('p1wf_baseline', '{"marker":"baseline"}'::json);`,
    );
    expect(seen(baseline)).toMatchObject({ status: 0, sqlstate: null });
    const before = query(owned, "app", `SELECT "key" || '|' || "value"::text FROM "Setting" WHERE "key" LIKE 'p1wf%' ORDER BY "key";`);

    const appName = `${owned.containerName}-app`;
    const appEnv = writeUrlFile("p1wf_app", owned.passwords.app, owned.containerName);
    let appId = "";
    try {
      appId = runDetached(
        [
          "--name", appName,
          "--network", owned.networkName,
          "--restart", "no",
          "--label", appLabel(owned.runId),
          "--env-file", appEnv,
          "-p", "127.0.0.1::3000",
          tag,
        ],
        bound,
      );
    } finally {
      fs.rmSync(appEnv, { force: true });
    }
    appExpected = {
      containerId: appId,
      containerName: appName,
      imageId: builtImage,
      imageRef: tag,
      networkName: owned.networkName,
      runId: owned.runId,
      purpose: "application",
    };
    const started = await waitUntil(appExpected, bound, 90_000);
    const entryLogs = redactedLogs(appExpected, bound, secrets);
    expect(entryLogs).toContain("No pending migrations to apply.");
    expect(entryLogs).toContain("Запускаю приложение");
    expect(entryLogs).not.toContain(owned.passwords.app);
    const port = loopbackPort(inspectDocument(appExpected, bound));
    const entryHealth = await waitHealth(port);
    const entrypoint = classifyEntrypoint({
      migrateExit: "NOT_MEASURED",
      serverRunning: started.running,
      healthStatus: entryHealth,
      noPendingLog: entryLogs.includes("No pending migrations to apply."),
    });
    if (entrypoint !== "STARTUP_PROVEN") {
      throw new Error(`ENTRYPOINT_FAIL exit=${started.exitCode} running=${started.running} health=${entryHealth} logs=${entryLogs.slice(-1800)}`);
    }
    copyProbe(appExpected, bound, PROBE);
    const read = probeJson(appExpected, bound, "read", secrets);
    expect(read).toMatchObject({ ok: true, marker: "baseline" });
    const wrote = probeJson(appExpected, bound, "write", secrets);
    expect(wrote.ok).toBe(true);
    expect(seen(sql(owned, "app", "SET ROLE p1wf_migrator;"))).toMatchObject({ status: 3, sqlstate: "42501" });
    expect(seen(sql(owned, "app", "SET ROLE p1wf_breakglass;"))).toMatchObject({ status: 3, sqlstate: "42501" });
    const sequence = query(owned, "bootstrap", "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY c.relname LIMIT 1;");
    if (sequence.length > 0) {
      expect(seen(sql(owned, "app", `SELECT nextval('public.${sequence}'::regclass);`)).status).toBe(0);
    }
    expect(await cron(port)).toBe(503);

    const holder = startProbe(appExpected, bound, "hold");
    const heldPid = waitForQuery(owned, "p1wf_hold");
    const beforeFreeze = containerFacts(appExpected, bound);
    const revoked = sql(
      owned,
      "breakglass",
      `
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM p1wf_app;
      REVOKE USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM p1wf_app;
      GRANT SELECT ON ALL TABLES IN SCHEMA public TO p1wf_app;
      `,
    );
    expect(seen(revoked)).toMatchObject({ status: 0, sqlstate: null });
    expect(query(owned, "breakglass", `SELECT pg_terminate_backend(${heldPid})::text;`)).toBe("true");
    holder.kill();
    const drained = sql(
      owned,
      "breakglass",
      "SELECT count(*)::text FROM pg_stat_activity WHERE usename = 'p1wf_app' AND pid <> pg_backend_pid();",
    );
    expect(seen(drained).status).toBe(0);
    for (const pid of activityPids(owned)) {
      sqlBare(owned, "breakglass", `SELECT pg_terminate_backend(${pid});`);
    }
    const afterDrain = containerFacts(appExpected, bound);
    expect(afterDrain.startedAt).toBe(beforeFreeze.startedAt);
    expect(afterDrain.pid).toBe(beforeFreeze.pid);
    expect(await waitHealth(port)).toBe(200);
    const frozenRead = probeJson(appExpected, bound, "read", secrets);
    expect(frozenRead.ok).toBe(true);
    const frozenWrite = probeJson(appExpected, bound, "frozen-write", secrets);
    expect(frozenWrite.ok).toBe(false);
    expect(seen(sql(owned, "app", `INSERT INTO "Setting" ("key", "value") VALUES ('p1wf_direct', '{"marker":"no"}'::json);`))).toMatchObject({
      status: 3,
      sqlstate: "42501",
    });
    const during = query(owned, "app", `SELECT "key" FROM "Setting" WHERE "key" LIKE 'p1wf%' ORDER BY "key";`);
    expect(during).toBe(before.split("\n").map((line) => line.split("|")[0]).join("\n") + "\np1wf_write");

    const afterPool = containerFacts(appExpected, bound);
    const pool = classifyPool({
      beforeId: appId,
      afterId: appId,
      beforeStartedAt: beforeFreeze.startedAt,
      afterStartedAt: afterPool.startedAt,
      running: afterPool.running,
      exitCode: afterPool.exitCode,
      healthStatus: afterPool.running ? await health(port) : null,
    });
    expect(pool === "RECONNECTED" || pool === "DATABASE_CONNECTION_FAILURE").toBe(true);
    expect(pool).not.toBe("APPLICATION_CONTAINER_RESTART");
    expect(query(owned, "bootstrap", `SELECT count(*)::text FROM "Setting" WHERE "key" = 'p1wf_hold';`)).toBe("0");
    expect(query(owned, "bootstrap", `SELECT "value"->>'marker' FROM "Setting" WHERE "key" = 'p1wf_baseline';`)).toBe("baseline");

    const restored = sql(
      owned,
      "breakglass",
      `
      GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO p1wf_app;
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "_prisma_migrations" FROM p1wf_app;
      GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO p1wf_app;
      `,
    );
    expect(seen(restored)).toMatchObject({ status: 0, sqlstate: null });
    expect(query(owned, "bootstrap", "SELECT rolsuper::text FROM pg_roles WHERE rolname = 'p1wf_app';")).toBe("false");
    expect(query(owned, "bootstrap", "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'Setting';")).toBe("p1wf_migrator");
    const unfrozen = probeJson(appExpected, bound, "rewrite", secrets);
    expect(unfrozen.ok).toBe(true);
    const unfrozenKey = sql(
      owned,
      "app",
      `INSERT INTO "Notification" ("id", "key", "title", "message", "tone", "isSystem") VALUES ('p1wf_unfreeze', 'p1wf-hist-unfreeze', 'fixture', 'fixture', 'INFO', false);`,
    );
    expect(seen(unfrozenKey)).toMatchObject({ status: 0, sqlstate: null });
    expect(containerFacts(appExpected, bound).startedAt).toBe(beforeFreeze.startedAt);

    const pinned = gitShow(P1_MIGRATION_PATH);
    expect(sha256(pinned)).toBe(P1_SHA256);
    const applied = sql(owned, "migrator", pinned);
    expect(seen(applied)).toMatchObject({ status: 0, sqlstate: null });
    const restartBefore = containerFacts(appExpected, bound);
    restartOwned(appExpected, bound);
    const restarted = await waitRestarted(appExpected, bound, restartBefore.startedAt, 120_000);
    const restartLogs = redactedLogs(appExpected, bound, secrets);
    const restartPort = loopbackPort(inspectDocument(appExpected, bound));
    const restartHealth = await waitHealth(restartPort, 90);
    const afterP1 = classifyEntrypoint({
      migrateExit: "NOT_MEASURED",
      serverRunning: restarted.running,
      healthStatus: restartHealth,
      noPendingLog: restartLogs.includes("No pending migrations to apply."),
    });
    expect(containerFacts(appExpected, bound).startedAt).not.toBe(restartBefore.startedAt);
    if (afterP1 !== "STARTUP_PROVEN") {
      throw new Error(
        `RESTART_FAIL running=${restarted.running} health=${restartHealth} pending=${restartLogs.includes("No pending migrations to apply.")} logs=${restartLogs.slice(-1800)}`,
      );
    }
    expect(restartLogs).not.toContain(owned.passwords.app);

    const appDump = pgDump(owned, "app", ["--no-owner", "--no-acl"]);
    const fullDump = pgDump(owned, "migrator", ["--no-owner", "--no-acl"]);
    expect(fullDump.status).toBe(0);
    expect(fullDump.stdout).toContain("p1wf_baseline");
    expect(sqlBare(owned, "bootstrap", "CREATE DATABASE p1wf_restore OWNER p1wf_migrator;").status).toBe(0);
    const restoredDump = restoreDump(owned, bound, fullDump.stdout);
    expect(restoredDump.status).toBe(0);
    expect(query(owned, "migrator", `SELECT "value"->>'marker' FROM "Setting" WHERE "key" = 'p1wf_baseline';`, "p1wf_restore")).toBe("baseline");

    expect(redact(JSON.stringify({ source, builtImage, appId, entrypoint, afterP1, appDump: appDump.status, pool }), secrets)).not.toContain(owned.passwords.app);
    expect(source.commit).toBe("678cbc1d308ddfe568b901ebf53f7e05f9a8c014");
    expect(source.tree).toBe("502f5f5a3c7f2e4ec70427f935485e8184d7b984");
  }, 1_200_000);
});

function runOneShot(
  cluster: Cluster,
  binding: InvocationBinding,
  tag: string,
  builtImage: string,
  name: string,
): { exit: number; logs: string } {
  const envFile = writeUrlFile("p1wf_migrator", cluster.passwords.migrator, cluster.containerName);
  let id = "";
  try {
    id = runDetached(
      [
        "--name", name,
        "--network", cluster.networkName,
        "--restart", "no",
        "--label", appLabel(cluster.runId),
        "--env-file", envFile,
        "--entrypoint", "npx",
        tag,
        "prisma",
        "migrate",
        "deploy",
      ],
      binding,
    );
  } finally {
    fs.rmSync(envFile, { force: true });
  }
  const expected: AppExpectation = {
    containerId: id,
    containerName: name,
    imageId: builtImage,
    imageRef: tag,
    networkName: cluster.networkName,
    runId: cluster.runId,
    purpose: "oneshot",
  };
  const exit = waitContainer(expected, binding, 180_000);
  const logs = redactedLogs(expected, binding, Object.values(cluster.passwords));
  const removed = removeOwnedApp(expected, binding, Object.values(cluster.passwords));
  if (removed !== "removed:REMOVED") throw new Error(removed);
  return { exit, logs };
}

function restoreDump(cluster: Cluster, binding: InvocationBinding, script: string): { status: number | null } {
  const drift = bindingDrift(binding, realWorld());
  if (drift !== null) throw new Error(drift);
  const file = path.join(os.tmpdir(), `p1wf-pg-${randomUUID()}`);
  fs.writeFileSync(file, `PGPASSWORD=${cluster.passwords.migrator}\n`, { mode: 0o600 });
  try {
    const child = spawnSync(
      "docker",
      proofExecArgs(
        file,
        cluster.containerId,
        ["psql", "-X", "-h", "127.0.0.1", "-U", "p1wf_migrator", "-d", "p1wf_restore", "-v", "ON_ERROR_STOP=1", "-f", "-"],
        true,
      ),
      { windowsHide: true, encoding: "utf8", input: script, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    if (child.status !== 0) {
      throw new Error(`restore status=${child.status ?? "null"} ${redact(child.stderr ?? "", Object.values(cluster.passwords)).slice(0, 400)}`);
    }
    return { status: child.status };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function query(cluster: Cluster, role: SqlRole, statement: string, database = "stell22"): string {
  const result = sql(cluster, role, statement, database);
  if (result.status !== 0) throw new Error(result.stderr.slice(0, 400));
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "SET")
    .join("\n");
}

function seen(result: SqlOutcome): { status: number | null; sqlstate: string | null } {
  return { status: result.status, sqlstate: result.sqlstate };
}

function activityPids(cluster: Cluster): string[] {
  const text = query(cluster, "breakglass", "SELECT pid::text FROM pg_stat_activity WHERE usename = 'p1wf_app' AND pid <> pg_backend_pid();");
  return text.length === 0 ? [] : text.split("\n");
}

function waitForQuery(cluster: Cluster, token: string): string {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const text = query(cluster, "breakglass", "SELECT pid::text || '|' || left(query, 160) FROM pg_stat_activity WHERE usename = 'p1wf_app' AND pid <> pg_backend_pid();");
    const line = text.split("\n").find((item) => item.includes(token));
    if (line) return line.split("|")[0] ?? "";
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error("held application statement did not appear");
}

async function waitRestarted(
  expected: AppExpectation,
  binding: InvocationBinding,
  previousStartedAt: string,
  timeoutMs: number,
): Promise<{ running: boolean; exitCode: number; startedAt: string }> {
  const started = Date.now();
  let latest = containerFacts(expected, binding);
  while (Date.now() - started < timeoutMs) {
    latest = containerFacts(expected, binding);
    if (latest.startedAt !== previousStartedAt && (!latest.running || latest.pid > 0)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return latest;
}

async function waitUntil(
  expected: AppExpectation,
  binding: InvocationBinding,
  timeoutMs: number,
): Promise<{ running: boolean; exitCode: number; startedAt: string }> {
  const started = Date.now();
  let latest = containerFacts(expected, binding);
  while (Date.now() - started < timeoutMs) {
    latest = containerFacts(expected, binding);
    if (!latest.running) return latest;
    if (latest.startedAt.length > 0 && redactedLogs(expected, binding, []).includes("Запускаю приложение")) return latest;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return latest;
}

async function health(port: string): Promise<number> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    return response.status;
  } catch {
    return 0;
  }
}

async function waitHealth(port: string, attempts = 30): Promise<number> {
  let status = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    status = await health(port);
    if (status === 200) return status;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return status;
}

function probeJson(
  expected: AppExpectation,
  binding: InvocationBinding,
  mode: string,
  secrets: readonly string[],
): { ok: boolean; marker?: string | null; code?: string } {
  const result = runProbe(expected, binding, mode, secrets);
  const line = result.text.split(/\r?\n/).find((item) => item.startsWith("{"));
  if (line === undefined) throw new Error(result.text.slice(0, 400));
  return JSON.parse(line) as { ok: boolean; marker?: string | null; code?: string };
}

async function cron(port: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/api/cron/fetch-statements`, { method: "POST" });
  return response.status;
}

function loopbackPort(document: unknown): string {
  const row = document as { NetworkSettings?: { Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }>> } };
  const binding = row.NetworkSettings?.Ports?.["3000/tcp"]?.[0];
  if (binding?.HostIp !== "127.0.0.1" || !binding.HostPort) throw new Error("application port is not loopback");
  return binding.HostPort;
}

function gitShow(file: string): string {
  const child = spawnSync("git", ["show", `HEAD:${file}`], { windowsHide: true, encoding: "utf8" });
  if (child.status !== 0) throw new Error("pinned migration bytes are unavailable");
  return child.stdout ?? "";
}

function sha256(text: string): string {
  const sum = createHash("sha256").update(text).digest("hex");
  if (sum !== P1_SHA256) {
    const blob = spawnSync("git", ["hash-object", "--stdin"], { windowsHide: true, encoding: "utf8", input: text });
    if ((blob.stdout ?? "").trim() !== P1_GIT_BLOB) throw new Error("pinned migration checksum drifted");
  }
  return sum;
}
