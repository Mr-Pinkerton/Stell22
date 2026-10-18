import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { P1_GIT_BLOB, P1_MIGRATION_PATH, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { classifyEntrypoint, classifyPool } from "@/server/internal/p1-write-freeze-historical/classify";
import type { AppExpectation } from "@/server/internal/p1-write-freeze-historical/identity";
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
  removeOwnedApp,
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
  let builtImage = "";

  afterAll(() => {
    if (cluster && appExpected) removeOwnedApp(appExpected, cluster.endpoint, cluster.daemonId, Object.values(cluster.passwords));
    if (cluster) destroyCluster(cluster);
    if (/^sha256:[0-9a-f]{64}$/.test(builtImage)) {
      spawnSync("docker", ["rmi", builtImage], { windowsHide: true, encoding: "utf8" });
    }
  }, 180_000);

  it("measures the historical image on a non-superuser role", async () => {
    const source = verifyHistoricalSource();
    ensureNodeBase();
    cluster = createCluster();
    const owned = cluster;
    const secrets = Object.values(owned.passwords);
    const tag = `stell22-p1wf-hist-${owned.runId}`;
    builtImage = await buildHistoricalImage(tag);
    expect(imageId(tag)).toBe(builtImage);

    const fileId = createStopped([
      "--name", `${owned.containerName}-file`,
      "--network", owned.networkName,
      "--label", appLabel(owned.runId),
      tag,
    ]);
    const copied = copyFromContainer(fileId, "/app/docker-entrypoint.sh");
    const fileExpected: AppExpectation = {
      containerId: fileId,
      containerName: `${owned.containerName}-file`,
      imageId: builtImage,
      imageRef: tag,
      networkName: owned.networkName,
      runId: owned.runId,
      purpose: "created",
    };
    expect(removeOwnedApp(fileExpected, owned.endpoint, owned.daemonId, secrets)).toBe("removed:REMOVED");
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

    const migrated = runOneShot(owned, tag, builtImage, "p1wf_migrator", `${owned.containerName}-migrate`);
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
      appId = runDetached([
        "--name", appName,
        "--network", owned.networkName,
        "--restart", "no",
        "--label", appLabel(owned.runId),
        "--env-file", appEnv,
        "-p", "127.0.0.1::3000",
        tag,
      ]);
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
    const started = await waitUntil(appId, 90_000);
    const entryLogs = redactedLogs(appId, secrets);
    const entrypoint = classifyEntrypoint({ migrateExit: started.running ? 0 : started.exitCode, serverRunning: started.running });
    if (entrypoint !== "PASS") {
      throw new Error(`ENTRYPOINT_FAIL exit=${started.exitCode} running=${started.running} logs=${entryLogs.slice(-1800)}`);
    }
    expect(entryLogs).toContain("No pending migrations to apply.");
    expect(entryLogs).toContain("Запускаю приложение");
    expect(entryLogs).not.toContain(owned.passwords.app);
    const port = loopbackPort(inspectDocument(appId));
    expect(await waitHealth(port)).toBe(200);
    copyProbe(appId, PROBE);
    const read = probeJson(appId, "read", secrets);
    expect(read).toMatchObject({ ok: true, marker: "baseline" });
    const wrote = probeJson(appId, "write", secrets);
    expect(wrote.ok).toBe(true);
    expect(seen(sql(owned, "app", "SET ROLE p1wf_migrator;"))).toMatchObject({ status: 3, sqlstate: "42501" });
    expect(seen(sql(owned, "app", "SET ROLE p1wf_breakglass;"))).toMatchObject({ status: 3, sqlstate: "42501" });
    const sequence = query(owned, "bootstrap", "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S' ORDER BY c.relname LIMIT 1;");
    if (sequence.length > 0) {
      expect(seen(sql(owned, "app", `SELECT nextval('public.${sequence}'::regclass);`)).status).toBe(0);
    }
    expect(await cron(port)).toBe(503);

    const holder = startProbe(appId, "hold");
    const heldPid = waitForQuery(owned, "p1wf_hold");
    const beforeFreeze = containerFacts(appId);
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
    const afterDrain = containerFacts(appId);
    expect(afterDrain.startedAt).toBe(beforeFreeze.startedAt);
    expect(afterDrain.pid).toBe(beforeFreeze.pid);
    expect(await waitHealth(port)).toBe(200);
    const frozenRead = probeJson(appId, "read", secrets);
    expect(frozenRead.ok).toBe(true);
    const frozenWrite = probeJson(appId, "frozen-write", secrets);
    expect(frozenWrite.ok).toBe(false);
    expect(seen(sql(owned, "app", `INSERT INTO "Setting" ("key", "value") VALUES ('p1wf_direct', '{"marker":"no"}'::json);`))).toMatchObject({
      status: 3,
      sqlstate: "42501",
    });
    const during = query(owned, "app", `SELECT "key" FROM "Setting" WHERE "key" LIKE 'p1wf%' ORDER BY "key";`);
    expect(during).toBe(before.split("\n").map((line) => line.split("|")[0]).join("\n") + "\np1wf_write");

    const afterPool = containerFacts(appId);
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
    const unfrozen = probeJson(appId, "rewrite", secrets);
    expect(unfrozen.ok).toBe(true);
    const unfrozenKey = sql(
      owned,
      "app",
      `INSERT INTO "Notification" ("id", "key", "title", "message", "tone", "isSystem") VALUES ('p1wf_unfreeze', 'p1wf-hist-unfreeze', 'fixture', 'fixture', 'INFO', false);`,
    );
    expect(seen(unfrozenKey)).toMatchObject({ status: 0, sqlstate: null });
    expect(containerFacts(appId).startedAt).toBe(beforeFreeze.startedAt);

    const pinned = gitShow(P1_MIGRATION_PATH);
    expect(sha256(pinned)).toBe(P1_SHA256);
    const applied = sql(owned, "migrator", pinned);
    expect(seen(applied)).toMatchObject({ status: 0, sqlstate: null });
    const restartBefore = containerFacts(appId);
    expect(spawnSync("docker", ["restart", appId], { windowsHide: true, encoding: "utf8", timeout: 120_000 }).status).toBe(0);
    const restarted = await waitRestarted(appId, restartBefore.startedAt, 120_000);
    const restartLogs = redactedLogs(appId, secrets);
    const afterP1 = classifyEntrypoint({ migrateExit: restarted.running ? 0 : restarted.exitCode, serverRunning: restarted.running });
    expect(containerFacts(appId).startedAt).not.toBe(restartBefore.startedAt);
    expect(afterP1).toBe("PASS");
    expect(restartLogs).not.toContain(owned.passwords.app);

    const appDump = pgDump(owned, "app", ["--no-owner", "--no-acl"]);
    const fullDump = pgDump(owned, "migrator", ["--no-owner", "--no-acl"]);
    expect(fullDump.status).toBe(0);
    expect(fullDump.stdout).toContain("p1wf_baseline");
    expect(sqlBare(owned, "bootstrap", "CREATE DATABASE p1wf_restore OWNER p1wf_migrator;").status).toBe(0);
    const restoredDump = sql(owned, "migrator", fullDump.stdout, "p1wf_restore");
    expect(seen(restoredDump).status).toBe(0);
    expect(query(owned, "migrator", `SELECT "value"->>'marker' FROM "Setting" WHERE "key" = 'p1wf_baseline';`, "p1wf_restore")).toBe("baseline");

    expect(redact(JSON.stringify({ source, builtImage, appId, entrypoint, afterP1, appDump: appDump.status, pool }), secrets)).not.toContain(owned.passwords.app);
    expect(source.commit).toBe("678cbc1d308ddfe568b901ebf53f7e05f9a8c014");
    expect(source.tree).toBe("502f5f5a3c7f2e4ec70427f935485e8184d7b984");
  }, 1_200_000);
});

function runOneShot(cluster: Cluster, tag: string, builtImage: string, user: "p1wf_migrator", name: string): { exit: number; logs: string } {
  const envFile = writeUrlFile(user, cluster.passwords.migrator, cluster.containerName);
  let id = "";
  try {
    id = runDetached([
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
    ]);
  } finally {
    fs.rmSync(envFile, { force: true });
  }
  const exit = waitContainer(id, 180_000);
  const logs = redactedLogs(id, Object.values(cluster.passwords));
  const removed = removeOwnedApp(
    {
      containerId: id,
      containerName: name,
      imageId: builtImage,
      imageRef: tag,
      networkName: cluster.networkName,
      runId: cluster.runId,
      purpose: "oneshot",
    },
    cluster.endpoint,
    cluster.daemonId,
    Object.values(cluster.passwords),
  );
  if (removed !== "removed:REMOVED") throw new Error(removed);
  return { exit, logs };
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
  id: string,
  previousStartedAt: string,
  timeoutMs: number,
): Promise<{ running: boolean; exitCode: number; startedAt: string }> {
  const started = Date.now();
  let latest = containerFacts(id);
  while (Date.now() - started < timeoutMs) {
    latest = containerFacts(id);
    if (latest.startedAt !== previousStartedAt && (!latest.running || latest.pid > 0)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return latest;
}

async function waitUntil(id: string, timeoutMs: number): Promise<{ running: boolean; exitCode: number; startedAt: string }> {
  const started = Date.now();
  let latest = containerFacts(id);
  while (Date.now() - started < timeoutMs) {
    latest = containerFacts(id);
    if (!latest.running) return latest;
    if (latest.startedAt.length > 0 && redactedLogs(id, []).includes("Запускаю приложение")) return latest;
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

async function waitHealth(port: string): Promise<number> {
  let status = 0;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    status = await health(port);
    if (status === 200) return status;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return status;
}

function probeJson(containerId: string, mode: string, secrets: readonly string[]): { ok: boolean; marker?: string | null; code?: string } {
  const result = runProbe(containerId, mode, secrets);
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
