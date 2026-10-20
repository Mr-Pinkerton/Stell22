/**
 * Disposable offline-maintenance measurements.
 * Synthetic HTTP only. No Prisma, no production entrypoint, no daemon restart.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql, type Cluster, type SqlRole } from "@/server/internal/p1-write-freeze-coordinator/cluster";
import {
  containerGone,
  containerState,
  createAdmissionVolume,
  createWriterContainer,
  killWriter,
  publishedPorts,
  readAdmissionFile,
  requestProcessCrash,
  removeOwned,
  removeVolumeIfMatches,
  runningForeignCount,
  startWriter,
  stopWriter,
  writeAdmissionFile,
  writerLogs,
  type OwnedApp,
} from "@/server/internal/p1-offline-writer-admission/owned-resources";
import {
  sleep,
  startInProcessQueue,
  startSyntheticApp,
  startSyntheticProxy,
  writeAfterDelayWithRecheck,
  writeAfterDelayWithoutRecheck,
  type Listener,
} from "@/server/internal/p1-offline-writer-admission/synthetic-http";
import type { Admission } from "@/server/internal/p1-offline-writer-admission/contract";
import { readStartupFacts, startupBlocker } from "@/server/internal/p1-offline-writer-admission/startup-facts";
import { judgeOfflineAdmission, type OfflineFacts, type OfflineVerdict, type RowFate } from "@/server/internal/p1-offline-writer-admission/verdict";

export type OfflineReport = {
  identity: {
    context: string;
    endpoint: string;
    daemonId: string;
    imageId: string;
    postgresContainerId: string;
    postgresStartedAt: string;
    serverVersionNum: string;
    systemIdentifier: string;
    database: string;
    publishedPostgresPorts: string;
    writerContainerId: string;
    writerStartedAtBeforeCrash: string;
    writerStartedAtAfterCrash: string;
  };
  facts: OfflineFacts;
  verdict: OfflineVerdict;
  startupBlocker: string;
  daemonRestartBlocker: string;
  counts: {
    httpDirectBefore: number;
    httpProxyBefore: number;
    httpAttemptsDuring: number;
    httpRejectedDuring: number;
    blindRow: number;
    cooperativeRow: number;
    terminatedRow: number;
    pastCheckRow: number;
    restartLoop: number;
  };
  cleanup: {
    container: "removed" | "preserved";
    volume: "removed" | "preserved";
    containerGone: boolean;
    foreignRunningAtEnd: number;
  };
};

type Held = { done: Promise<number | null>; kill: () => void; output: () => string };

export async function runOfflineAdmissionProof(cluster: Cluster, database: string, root: string): Promise<OfflineReport> {
  if (!/^p1wc_[0-9a-f]{8}$/.test(database)) throw new Error("refusing database");
  if (publishedPorts(cluster.containerId) !== "") throw new Error("postgres container publishes a port");
  const proofId = randomUUID();
  const startup = readStartupFacts(root);
  const foreignAtStart = runningForeignCount([cluster.containerId]);
  if (foreignAtStart.foreign < 1) throw new Error("expected foreign containers to be visible before a daemon-restart decision");
  const daemonRestartBlocker = `NOT TESTED. ${foreignAtStart.foreign} running containers are not this proof, including ${foreignAtStart.sample.join(", ")}. The Docker daemon was not restarted.`;
  prepareTables(cluster, database);

  const admission: Admission = { app: "open", proxy: "open" };
  let nextId = 1;
  const write = async (channel: string): Promise<void> => {
    const id = nextId;
    nextId += 1;
    if (id >= 1000) throw new Error("synthetic id range exhausted");
    const inserted = insert(cluster, database, id, channel, "ok", "app");
    if (inserted.status !== 0) throw new Error(`synthetic insert failed ${inserted.sqlstate ?? ""} ${inserted.stderr.slice(0, 180)}`);
  };

  let app: Listener | undefined;
  let proxy: Listener | undefined;
  const held: Held[] = [];
  let volumeName: string | undefined;
  let owned: OwnedApp | undefined;
  let cleaned = false;
  const cleanupState: OfflineReport["cleanup"] = {
    container: "preserved",
    volume: "preserved",
    containerGone: false,
    foreignRunningAtEnd: -1,
  };
  const finishCleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const item of held) item.kill();
    if (owned) {
      const removed = removeOwned(cluster, owned);
      cleanupState.container = removed.container;
      cleanupState.volume = removed.volume;
      cleanupState.containerGone = containerGone(owned.containerId);
    } else if (volumeName) {
      cleanupState.volume = removeVolumeIfMatches(cluster, volumeName, proofId);
    }
    cleanupState.foreignRunningAtEnd = runningForeignCount([cluster.containerId]).foreign;
  };

  try {
    app = await startSyntheticApp(admission, write);
    proxy = await startSyntheticProxy(admission, app.port);
    if ((await post(app.port, "http-direct")) !== 200) throw new Error("direct write before isolation was rejected");
    if ((await post(proxy.port, "http-proxy")) !== 200) throw new Error("proxy write before isolation was rejected");
    admission.proxy = "closed";
    const directWhileProxyClosed = await post(app.port, "http-direct");
    const proxyWhileClosed = await post(proxy.port, "http-proxy");
    if (directWhileProxyClosed !== 200 || proxyWhileClosed !== 503) {
      throw new Error(`proxy-only close returned direct ${directWhileProxyClosed} proxy ${proxyWhileClosed}`);
    }

    const queue = startInProcessQueue(admission, write, 150);
    await sleep(450);
    const intervalBeforeClose = count(cluster, database, "bg-interval");
    if (intervalBeforeClose < 1) throw new Error("in-process queue did not insert before it was stopped");
    admission.app = "closed";
    queue.stop();
    await sleep(500);
    const intervalAfterClose = count(cluster, database, "bg-interval");
    const queueFailure = queue.failure();
    if (queueFailure) throw queueFailure;
    admission.app = "open";

    const blind = track(held, cluster, database, holdSql(1001, "inflight-blind", "p1owa-hold-blind", 20, false));
    const cooperative = track(held, cluster, database, holdSql(1002, "inflight-coop", "p1owa-hold-coop", 20, true));
    const terminated = track(held, cluster, database, holdSql(1003, "inflight-term", "p1owa-hold-term", 30, false));
    await sleep(1_500);
    const holdPids = await waitHoldPids(cluster, database);
    const blindPid = holdPids["p1owa-hold-blind"] ?? "";
    const coopPid = holdPids["p1owa-hold-coop"] ?? "";
    const termPid = holdPids["p1owa-hold-term"] ?? "";
    if (blindPid === "" || coopPid === "" || termPid === "") {
      throw new Error(`open transaction was not visible before FREEZE; activity=${JSON.stringify(holdPids)}; blind=${blind.output()}; coop=${cooperative.output()}; term=${terminated.output()}`);
    }

    const pastCheck = writeAfterDelayWithoutRecheck(admission, write, 400).catch(() => "skipped" as const);
    const scheduled = writeAfterDelayWithRecheck(admission, write, 400).catch(() => "skipped" as const);
    admission.app = "closed";
    const closedAdmission = sql(cluster, "bootstrap", "UPDATE p1owa_admission SET state = 'closed' WHERE id = 1;", database);
    if (closedAdmission.status !== 0) throw new Error("operator could not close the admission row");
    const terminatedResult = scalar(cluster, "bootstrap", database, `SELECT pg_terminate_backend(${termPid});`);
    if (terminatedResult.split(/\r?\n/).at(-1)?.trim() !== "t") {
      throw new Error(`operator terminate returned ${JSON.stringify(terminatedResult)}`);
    }

    const continuity = await sampleContinuity(app.port, proxy.port);
    await Promise.all([blind.done, cooperative.done, pastCheck, scheduled]);
    await Promise.race([terminated.done, sleep(2_000)]);
    terminated.kill();
    await sleep(300);

    let maxAppSessions = 0;
    for (let sample = 0; sample < 5; sample += 1) {
      maxAppSessions = Math.max(maxAppSessions, Number(scalar(cluster, "bootstrap", database, appSessionSql())));
      await sleep(200);
    }

    const late = insert(cluster, database, 9100, "app-sql-after-freeze", "late", "app");
    if (late.status !== 0) throw new Error(`new app sql after freeze failed ${late.sqlstate ?? ""}`);
    const sawLateSession = scalar(
      cluster,
      "bootstrap",
      database,
      "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE '%app-sql-after-freeze%';",
    );
    const operator = insert(cluster, database, 9001, "operator-bootstrap", "kept", "bootstrap");
    if (operator.status !== 0) throw new Error("bootstrap insert failed");
    const breakglass = insert(cluster, database, 9002, "operator-breakglass", "kept", "breakglass");
    if (breakglass.status !== 0) throw new Error("break-glass insert failed");
    const appUpdate = sql(cluster, "app", "UPDATE p1owa_admission SET state = 'open' WHERE id = 1;", database);
    const appCannotUpdateAdmission = appUpdate.status !== 0 && appUpdate.sqlstate === "42501";
    if (appUpdate.status === 0) {
      const restored = sql(cluster, "bootstrap", "UPDATE p1owa_admission SET state = 'closed' WHERE id = 1;", database);
      if (restored.status !== 0) throw new Error("operator could not restore the closed admission row");
    }

    let raceCommits = 0;
    const raceTrials = 4;
    for (let trial = 0; trial < raceTrials; trial += 1) {
      const id = 1100 + trial;
      const marker = `p1owa-race-${id}`;
      const race = track(held, cluster, database, holdSql(id, "race", marker, 1, false));
      await sleep(300);
      const pid = await waitPid(cluster, database, marker);
      if (/^[1-9][0-9]*$/.test(pid)) scalar(cluster, "bootstrap", database, `SELECT pg_terminate_backend(${pid});`);
      await Promise.race([race.done, sleep(2_000)]);
      race.kill();
      if (countId(cluster, database, id) > 0) raceCommits += 1;
    }

    volumeName = createAdmissionVolume(cluster, proofId);
    owned = createWriterContainer(cluster, proofId, volumeName, database, cluster.passwords.app);
    const restart = await measureRestart(cluster, database, owned);
    const migrations = scalar(cluster, "bootstrap", database, "SELECT to_regclass('public._prisma_migrations') IS NULL;");
    const writerContainerId = owned.containerId;
    const facts: OfflineFacts = {
      httpDirectBefore: "committed",
      httpProxyBefore: "committed",
      httpDirectDuring: continuity.direct,
      httpProxyDuring: continuity.proxy,
      directAcceptedWhileProxyClosed: true,
      continuitySamples: continuity.samples,
      continuityBreaks: continuity.breaks,
      blindCommitAfterDeclaration: fate(countId(cluster, database, 1001)),
      cooperativeRecheck: fate(countId(cluster, database, 1002)),
      terminatedBeforeCommit: fate(countId(cluster, database, 1003)),
      pastCheckCommitted: count(cluster, database, "bg-past-check") > 0,
      backgroundTicksAfterClose: intervalAfterClose - intervalBeforeClose,
      scheduledRecheckCommitted: count(cluster, database, "bg-recheck") > 0,
      maxAppSessionsDuringLatch: maxAppSessions,
      newAppSqlAfterHttpFreeze: "committed",
      postHocActivitySawThatSession: Number(sawLateSession) > 0,
      raceCommits,
      raceTrials,
      restartLoopWritesWhileOpen: restart.writesWhileOpen,
      restartLoopWritesWhileClosed: restart.writesWhileClosed,
      explicitStopStayedDown: restart.explicitStopStayedDown,
      crashRestartedByPolicy: restart.crashRestarted,
      crashWithOpenFileWroteAgain: restart.crashOpenWrote,
      crashWithClosedFileWrote: restart.crashClosedWrote,
      engineKillRestarted: restart.engineKillRestarted,
      operatorStartAfterStopWrote: restart.operatorStartWrote,
      daemonRestart: "not-tested",
      operatorBootstrapInsert: "committed",
      appCannotUpdateAdmission,
      prismaMigrationsRelation: migrations === "t" ? "absent" : "present",
      appOnlyIsProductionPath: startup.appOnlyIsProductionPath,
      serverActionsCovered: false,
      physicalDisconnectTested: false,
    };
    const verdict = judgeOfflineAdmission(facts);
    const reportIdentity = {
      context: spawnSyncOut(["context", "show"]).trim(),
      endpoint: cluster.endpoint,
      daemonId: cluster.daemonId,
      imageId: cluster.imageId,
      postgresContainerId: cluster.containerId,
      postgresStartedAt: cluster.startedAt,
      serverVersionNum: scalar(cluster, "bootstrap", database, "SELECT current_setting('server_version_num');"),
      systemIdentifier: scalar(cluster, "breakglass", database, "SELECT system_identifier::text FROM pg_control_system();"),
      database,
      publishedPostgresPorts: publishedPorts(cluster.containerId),
      writerContainerId,
      writerStartedAtBeforeCrash: restart.startedAtBefore,
      writerStartedAtAfterCrash: restart.startedAtAfter,
      engineKillStatus: restart.engineKillStatus,
      engineKillRestartCount: restart.engineKillRestartCount,
    };
    const counts = {
      httpDirectBefore: count(cluster, database, "http-direct"),
      httpProxyBefore: count(cluster, database, "http-proxy"),
      httpAttemptsDuring: continuity.samples * 2,
      httpRejectedDuring: continuity.rejected,
      blindRow: countId(cluster, database, 1001),
      cooperativeRow: countId(cluster, database, 1002),
      terminatedRow: countId(cluster, database, 1003),
      pastCheckRow: count(cluster, database, "bg-past-check"),
      restartLoop: count(cluster, database, "restart-loop"),
    };
    finishCleanup();
    return {
      identity: reportIdentity,
      facts,
      verdict,
      startupBlocker: startupBlocker(startup),
      daemonRestartBlocker,
      counts,
      cleanup: cleanupState,
    };
  } catch (error) {
    const logs = owned ? writerLogs(owned, [cluster.passwords.app]) : "";
    finishCleanup();
    const message = error instanceof Error ? error.message : "offline proof failed";
    throw new Error(logs.length > 0 ? `${message}; writer logs: ${logs}` : message);
  } finally {
    if (app) await closeListener(app);
    if (proxy) await closeListener(proxy);
    finishCleanup();
  }
}

async function measureRestart(cluster: Cluster, database: string, owned: OwnedApp): Promise<{
  writesWhileOpen: boolean;
  writesWhileClosed: boolean;
  explicitStopStayedDown: boolean;
  crashRestarted: boolean;
  crashOpenWrote: boolean;
  crashClosedWrote: boolean;
  engineKillRestarted: boolean;
  engineKillStatus: string;
  engineKillRestartCount: number;
  operatorStartWrote: boolean;
  startedAtBefore: string;
  startedAtAfter: string;
}> {
  const first = await waitForCount(cluster, database, 1);
  if (!first) {
    const visible = scalar(cluster, "bootstrap", database, "SELECT coalesce(string_agg(id::text || ':' || channel, ','), 'none') FROM p1owa_write;");
    throw new Error(`restart loop did not insert while open; visible=${visible}; ${writerLogs(owned, [cluster.passwords.app])}`);
  }
  writeAdmissionFile(cluster, owned, "closed");
  if (readAdmissionFile(cluster, owned) !== "closed") throw new Error("admission file was not closed");
  await sleep(1_500);
  const closedAt = count(cluster, database, "restart-loop");
  await sleep(1_500);
  const closedLater = count(cluster, database, "restart-loop");
  const beforeCrash = containerState(cluster, owned);
  requestProcessCrash(cluster, owned);
  const afterCrash = await waitRestart(cluster, owned, beforeCrash.restartCount, beforeCrash.startedAt);
  await sleep(1_500);
  const afterClosedCrash = count(cluster, database, "restart-loop");
  writeAdmissionFile(cluster, owned, "open");
  const opened = await waitForCount(cluster, database, closedLater + 1);
  if (!opened) throw new Error(`operator opening the admission file did not resume inserts; ${writerLogs(owned, [cluster.passwords.app])}`);
  const beforeOpenCrash = containerState(cluster, owned);
  const openCount = count(cluster, database, "restart-loop");
  requestProcessCrash(cluster, owned);
  await waitRestart(cluster, owned, beforeOpenCrash.restartCount, beforeOpenCrash.startedAt);
  const atOpenReturn = count(cluster, database, "restart-loop");
  const wroteAfterOpenCrash = await waitForCount(cluster, database, Math.max(openCount, atOpenReturn) + 1);
  stopWriter(cluster, owned);
  const countWhenStopped = count(cluster, database, "restart-loop");
  await sleep(3_000);
  const stopped = containerState(cluster, owned);
  const stoppedCount = count(cluster, database, "restart-loop");
  startWriter(cluster, owned);
  const resumed = await waitForCount(cluster, database, stoppedCount + 1);
  const engineKill = await observeEngineKill(cluster, owned);
  return {
    writesWhileOpen: true,
    writesWhileClosed: closedLater > closedAt,
    explicitStopStayedDown: !stopped.running && stopped.status === "exited" && stoppedCount === countWhenStopped,
    crashRestarted: afterCrash.restartCount > beforeCrash.restartCount || afterCrash.startedAt !== beforeCrash.startedAt,
    crashOpenWrote: wroteAfterOpenCrash,
    crashClosedWrote: afterClosedCrash > closedLater,
    engineKillRestarted: engineKill.restarted,
    engineKillStatus: engineKill.status,
    engineKillRestartCount: engineKill.restartCount,
    operatorStartWrote: resumed,
    startedAtBefore: beforeCrash.startedAt,
    startedAtAfter: afterCrash.startedAt,
  };
}

async function waitRestart(
  cluster: Cluster,
  owned: OwnedApp,
  previousCount: number,
  previousStartedAt: string,
): Promise<ReturnType<typeof containerState>> {
  let last = containerState(cluster, owned);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    last = containerState(cluster, owned);
    if (
      last.status === "running" &&
      last.running &&
      (last.restartCount > previousCount || last.startedAt !== previousStartedAt)
    ) {
      return last;
    }
    await sleep(500);
  }
  throw new Error(
    `writer process exit did not restart; status=${last.status} running=${last.running} count=${last.restartCount} started=${last.startedAt}; ${writerLogs(owned, [])}`,
  );
}

async function observeEngineKill(cluster: Cluster, owned: OwnedApp): Promise<{
  restarted: boolean;
  status: string;
  restartCount: number;
}> {
  const before = containerState(cluster, owned);
  if (!before.running) throw new Error(`engine kill not observed; status=${before.status}`);
  killWriter(cluster, owned);
  let last = before;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    last = containerState(cluster, owned);
    if (
      last.status === "running" &&
      last.running &&
      (last.restartCount > before.restartCount || last.startedAt !== before.startedAt)
    ) {
      return { restarted: true, status: last.status, restartCount: last.restartCount };
    }
    await sleep(500);
  }
  return { restarted: false, status: last.status, restartCount: last.restartCount };
}

async function waitForCount(cluster: Cluster, database: string, minimum: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (count(cluster, database, "restart-loop") >= minimum) return true;
    await sleep(250);
  }
  return false;
}

async function sampleContinuity(directPort: number, proxyPort: number): Promise<{
  direct: "rejected-all" | "accepted-some";
  proxy: "rejected-all" | "accepted-some";
  samples: number;
  breaks: number;
  rejected: number;
}> {
  let directBreaks = 0;
  let proxyBreaks = 0;
  let rejected = 0;
  const samples = 8;
  for (let sample = 0; sample < samples; sample += 1) {
    const direct = await post(directPort, "http-direct");
    const proxied = await post(proxyPort, "http-proxy");
    if (direct === 503) rejected += 1;
    else directBreaks += 1;
    if (proxied === 503) rejected += 1;
    else proxyBreaks += 1;
    await sleep(250);
  }
  return {
    direct: directBreaks === 0 ? "rejected-all" : "accepted-some",
    proxy: proxyBreaks === 0 ? "rejected-all" : "accepted-some",
    samples,
    breaks: directBreaks + proxyBreaks,
    rejected,
  };
}

function prepareTables(cluster: Cluster, database: string): void {
  const created = sql(
    cluster,
    "bootstrap",
    `CREATE TABLE p1owa_write (id integer PRIMARY KEY, channel text NOT NULL, marker text NOT NULL);
CREATE TABLE p1owa_admission (id integer PRIMARY KEY, state text NOT NULL);
INSERT INTO p1owa_admission (id, state) VALUES (1, 'open');
ALTER TABLE p1owa_write OWNER TO p1wc_migrator;
ALTER TABLE p1owa_admission OWNER TO p1wc_migrator;
REVOKE ALL ON TABLE p1owa_write FROM PUBLIC;
REVOKE ALL ON TABLE p1owa_admission FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE p1owa_write TO p1wc_app;
GRANT SELECT ON TABLE p1owa_admission TO p1wc_app;`,
    database,
  );
  if (created.status !== 0) throw new Error(`probe tables failed ${created.sqlstate ?? ""} ${created.stderr.slice(0, 240)}`);
}

function holdSql(id: number, channel: string, marker: string, seconds: number, recheck: boolean): string {
  if (!/^[a-z0-9-]{1,32}$/.test(marker)) throw new Error("refusing marker");
  const check = recheck
    ? "DO $$ BEGIN IF (SELECT state FROM p1owa_admission WHERE id = 1) IS DISTINCT FROM 'open' THEN RAISE EXCEPTION 'ADMISSION_CLOSED'; END IF; END $$;"
    : "";
  return `SET application_name = '${marker}'; BEGIN; INSERT INTO p1owa_write (id, channel, marker) VALUES (${id}, '${channel}', 'held'); SELECT pg_sleep(${seconds}); ${check} COMMIT;`;
}

function track(held: Held[], cluster: Cluster, database: string, statement: string): Held {
  const item = startHold(cluster, database, statement);
  held.push(item);
  return item;
}

function startHold(cluster: Cluster, database: string, statement: string): Held {
  const envFile = path.join(os.tmpdir(), `p1owa-pg-${randomBytes(8).toString("hex")}`);
  fs.writeFileSync(envFile, `PGPASSWORD=${cluster.passwords.app}\nPGCONNECT_TIMEOUT=5\n`, { mode: 0o600 });
  const child = spawn(
    "docker",
    [
      "exec",
      "--env-file",
      envFile,
      cluster.containerId,
      "psql",
      "-X",
      "-h",
      "127.0.0.1",
      "-U",
      "p1wc_app",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-500);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-500);
  });
  const done = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      fs.rmSync(envFile, { force: true });
      resolve(code);
    });
  });
  return {
    done,
    output: () => output,
    kill: () => {
      if (child.exitCode === null) child.kill();
    },
  };
}

async function waitHoldPids(cluster: Cluster, database: string): Promise<Record<string, string>> {
  const query = `SELECT application_name || '=' || pid::text FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE 'p1owa-hold-%' AND pid <> pg_backend_pid();`;
  let last = "";
  for (let attempt = 0; attempt < 8; attempt += 1) {
    last = scalar(cluster, "bootstrap", database, query);
    const found = parsePidLines(last);
    if (found["p1owa-hold-blind"] && found["p1owa-hold-coop"] && found["p1owa-hold-term"]) return found;
    await sleep(250);
  }
  return parsePidLines(last);
}

function parsePidLines(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const [name, pid] = line.trim().split("=");
    if (name && pid && /^[1-9][0-9]*$/.test(pid)) found[name] = pid;
  }
  return found;
}

async function waitPid(cluster: Cluster, database: string, marker: string): Promise<string> {
  if (!/^[a-z0-9-]{1,32}$/.test(marker)) throw new Error("refusing marker");
  const query = `SELECT COALESCE(min(pid)::text, '') FROM pg_stat_activity WHERE datname = current_database() AND application_name = '${marker}' AND pid <> pg_backend_pid();`;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const pid = scalar(cluster, "bootstrap", database, query);
    if (/^[1-9][0-9]*$/.test(pid)) return pid;
    await sleep(200);
  }
  return "";
}

function appSessionSql(): string {
  return "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND usename = 'p1wc_app' AND pid <> pg_backend_pid();";
}

function insert(cluster: Cluster, database: string, id: number, channel: string, marker: string, role: SqlRole) {
  if (!Number.isInteger(id) || id < 1 || id > 20000) throw new Error("refusing id");
  if (!/^[a-z0-9-]{1,32}$/.test(channel) || !/^[a-z0-9-]{1,32}$/.test(marker)) throw new Error("refusing marker");
  return sql(cluster, role, `INSERT INTO p1owa_write (id, channel, marker) VALUES (${id}, '${channel}', '${marker}');`, database);
}

function count(cluster: Cluster, database: string, channel: string): number {
  if (!/^[a-z0-9-]{1,32}$/.test(channel)) throw new Error("refusing channel");
  return Number(scalar(cluster, "bootstrap", database, `SELECT count(*) FROM p1owa_write WHERE channel = '${channel}';`));
}

function countId(cluster: Cluster, database: string, id: number): number {
  return Number(scalar(cluster, "bootstrap", database, `SELECT count(*) FROM p1owa_write WHERE id = ${id};`));
}

function scalar(cluster: Cluster, role: SqlRole, database: string, statement: string): string {
  const result = sql(cluster, role, statement, database);
  if (result.status !== 0) throw new Error(`sql failed ${result.sqlstate ?? ""} ${result.stderr.slice(0, 220)}`);
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "SET")
    .join("\n");
}

function fate(rows: number): RowFate {
  return rows > 0 ? "committed" : "absent";
}

async function post(port: number, channel: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/write`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel }),
  });
  return response.status;
}

async function closeListener(listener: Listener): Promise<void> {
  await listener.close();
}

function spawnSyncOut(args: readonly string[]): string {
  const child = spawnSync("docker", [...args], { windowsHide: true, encoding: "utf8", timeout: 15_000 });
  if (child.status !== 0) throw new Error(`docker ${args.join(" ")} failed`);
  return child.stdout ?? "";
}
