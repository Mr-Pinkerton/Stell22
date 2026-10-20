/**
 * Disposable PostgreSQL 17 measurements for privileged writer admission.
 * The coordinator state machine is not invoked.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reconfirm, roleName, type Cluster } from "@/server/internal/p1-write-freeze-coordinator/cluster";
import { BARRIER_ROLE, DUMP_ROLE, FLASH_ROLE, UNEXPECTED_ROLE } from "@/server/internal/p1-privileged-writer-barrier/contract";
import { isDefaultReject, permissiveTrustHba, restrictiveHba } from "@/server/internal/p1-privileged-writer-barrier/hba";
import { applyJournal, readJournal, reopenJournal, writeJournal } from "@/server/internal/p1-privileged-writer-barrier/journal";
import {
  pgDump,
  psql,
  publishedPorts,
  readHba,
  reloadConfig,
  restartContainer,
  serverLogs,
  siblingSql,
  startedAt,
  startScript,
  stopScripts,
  walDump,
  writeHba,
  type ProbeResult,
} from "@/server/internal/p1-privileged-writer-barrier/probe";
import {
  assessActors,
  failedPreconditions,
  judgeArchitectures,
  preconditionsFromFacts,
  privilegedWriterBarrierGate,
  type MeasuredFacts,
  type SqlMark,
} from "@/server/internal/p1-privileged-writer-barrier/verdict";

export type ProofReport = {
  facts: MeasuredFacts;
  gate: ReturnType<typeof privilegedWriterBarrierGate>;
  failed: string[];
  actors: ReturnType<typeof assessActors>;
  architectures: ReturnType<typeof judgeArchitectures>;
  identity: {
    version: string;
    imageId: string;
    containerId: string;
    daemonId: string;
    endpoint: string;
    startedAtBefore: string;
    startedAtAfter: string;
    systemIdentifier: string;
    baselineHba: string;
    restrictiveHbaSha256: string;
    reconfirmAfterRestart: string;
    dumpNote: string;
    walNote: string;
    logNote: string;
    rejectSqlstate: string;
  };
};

type Ctx = {
  cluster: Cluster;
  database: string;
  secrets: string[];
  barrierPassword: string;
  dumpPassword: string;
  unexpectedPassword: string;
  facts: MeasuredFacts;
  dumpNote: string;
  walNote: string;
  logNote: string;
  startedAtBefore: string;
  startedAtAfter: string;
  systemIdentifier: string;
  version: string;
  baselineHba: string;
  reconfirmAfterRestart: string;
  rejectInferred: boolean;
};

export function runDisposableProof(cluster: Cluster, database: string): ProofReport {
  const barrierPassword = randomBytes(24).toString("hex");
  const dumpPassword = randomBytes(24).toString("hex");
  const unexpectedPassword = randomBytes(24).toString("hex");
  const ctx: Ctx = {
    cluster,
    database,
    secrets: [...Object.values(cluster.passwords), barrierPassword, dumpPassword, unexpectedPassword],
    barrierPassword,
    dumpPassword,
    unexpectedPassword,
    facts: emptyFacts(),
    dumpNote: "",
    walNote: "",
    logNote: "",
    startedAtBefore: cluster.startedAt,
    startedAtAfter: "",
    systemIdentifier: "",
    version: "",
    baselineHba: "",
    reconfirmAfterRestart: "",
    rejectInferred: false,
  };
  try {
    measure(ctx);
  } finally {
    stopScripts();
    restoreQuietly(ctx);
  }
  const gate = privilegedWriterBarrierGate(preconditionsFromFacts(ctx.facts));
  return {
    facts: ctx.facts,
    gate,
    failed: failedPreconditions(preconditionsFromFacts(ctx.facts)),
    actors: assessActors(ctx.facts),
    architectures: judgeArchitectures(ctx.facts),
    identity: {
      version: ctx.version,
      imageId: cluster.imageId,
      containerId: cluster.containerId,
      daemonId: cluster.daemonId,
      endpoint: cluster.endpoint,
      startedAtBefore: ctx.startedAtBefore,
      startedAtAfter: ctx.startedAtAfter,
      systemIdentifier: ctx.systemIdentifier,
      baselineHba: ctx.baselineHba,
      restrictiveHbaSha256: sha(restrictiveHba(BARRIER_ROLE)),
      reconfirmAfterRestart: ctx.reconfirmAfterRestart,
      dumpNote: ctx.dumpNote,
      walNote: ctx.walNote,
      logNote: ctx.logNote,
      rejectSqlstate: ctx.rejectInferred ? "inferred-from-pg_hba-reject-text" : "printed",
    },
  };
}

function measure(ctx: Ctx): void {
  const boot = roleName(ctx.cluster, "bootstrap");
  ctx.version = scalar(ctx, boot, password(ctx, "bootstrap"), "SELECT current_setting('server_version_num');");
  ctx.systemIdentifier = scalar(ctx, boot, password(ctx, "bootstrap"), "SELECT system_identifier::text FROM pg_control_system();");
  ctx.baselineHba = readHba(ctx.cluster);
  const activeHba = ctx.baselineHba
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  console.log(`P1PB_BASELINE_HBA ${JSON.stringify(activeHba)}`);
  ctx.baselineHba = activeHba.join("\n");
  ctx.facts.dockerPublishedPort = publishedPorts(ctx.cluster);
  ctx.facts.siblingTcpBeforeHba = authMark(ctx, 
    siblingSql(ctx.cluster, ctx.secrets, boot, password(ctx, "bootstrap"), ctx.database, "SELECT 1;"),
  );
  if (ctx.facts.siblingTcpBeforeHba !== "ok") {
    throw new Error(`sibling connection before hba was ${ctx.facts.siblingTcpBeforeHba}`);
  }

  execOk(
    ctx,
    boot,
    password(ctx, "bootstrap"),
    `
CREATE ROLE ${BARRIER_ROLE} LOGIN SUPERUSER PASSWORD '${ctx.barrierPassword}';
CREATE ROLE ${DUMP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${ctx.dumpPassword}';
GRANT CONNECT ON DATABASE ${ctx.database} TO ${DUMP_ROLE};
GRANT USAGE ON SCHEMA public TO ${DUMP_ROLE};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${DUMP_ROLE};
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${DUMP_ROLE};
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${roleName(ctx.cluster, "app")};
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${roleName(ctx.cluster, "app")};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM ${roleName(ctx.cluster, "app")};
`,
  );

  ctx.facts.appPlainInsertAfterRevoke = writeMark(
    tcp(ctx, roleName(ctx.cluster, "app"), password(ctx, "app"), "INSERT INTO p1wc_inventory VALUES (40, 'plain', 1);"),
  );
  ctx.facts.appSetRoleMigratorInsert = writeMark(
    tcp(
      ctx,
      roleName(ctx.cluster, "app"),
      password(ctx, "app"),
      "SET ROLE p1wc_migrator; INSERT INTO p1wc_inventory VALUES (60, 'set-role', 1); RESET ROLE;",
    ),
  );
  ctx.facts.bootstrapInsertAfterRevoke = writeMark(
    tcp(ctx, boot, password(ctx, "bootstrap"), "INSERT INTO p1wc_inventory VALUES (53, 'bootstrap', 1);"),
  );
  ctx.facts.breakGlassInsertAfterRevoke = writeMark(
    tcp(ctx, roleName(ctx.cluster, "breakglass"), password(ctx, "breakglass"), "INSERT INTO p1wc_inventory VALUES (61, 'glass', 1);"),
  );
  ctx.facts.migratorInsertAfterRevoke = writeMark(
    tcp(ctx, roleName(ctx.cluster, "migrator"), password(ctx, "migrator"), "INSERT INTO p1wc_inventory VALUES (62, 'owner', 1);"),
  );

  startScript(
    ctx.cluster,
    ctx.secrets,
    boot,
    password(ctx, "bootstrap"),
    ctx.database,
    "BEGIN; INSERT INTO p1wc_inventory VALUES (51, 'die', 1); SELECT pg_sleep(20); -- p1pb-die\nCOMMIT;",
  );
  waitUntil(
    ctx,
    boot,
    password(ctx, "bootstrap"),
    "SELECT count(*)::text FROM pg_stat_activity WHERE query LIKE '%p1pb-die%' AND pid <> pg_backend_pid();",
    "1",
  );
  execOk(
    ctx,
    boot,
    password(ctx, "bootstrap"),
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%p1pb-die%' AND pid <> pg_backend_pid();",
  );
  waitUntil(ctx, boot, password(ctx, "bootstrap"), "SELECT count(*)::text FROM p1wc_inventory WHERE id = 51;", "0");
  ctx.facts.openPrivilegedInsertTerminated = "absent";
  stopScripts();

  startScript(
    ctx.cluster,
    ctx.secrets,
    boot,
    password(ctx, "bootstrap"),
    ctx.database,
    "SELECT pg_sleep(25); -- p1pb-boot\nINSERT INTO p1wc_inventory VALUES (70, 'after-reload', 1);\nSELECT pg_sleep(10); -- p1pb-boot",
  );
  startScript(
    ctx.cluster,
    ctx.secrets,
    roleName(ctx.cluster, "app"),
    password(ctx, "app"),
    ctx.database,
    "SELECT pg_sleep(25); -- p1pb-app\nSET ROLE p1wc_migrator; INSERT INTO p1wc_inventory VALUES (72, 'app-after', 1); RESET ROLE;",
  );
  waitUntil(
    ctx,
    boot,
    password(ctx, "bootstrap"),
    "SELECT count(*)::text FROM pg_stat_activity WHERE query LIKE '%p1pb-boot%' AND pid <> pg_backend_pid();",
    "1",
  );
  waitUntil(
    ctx,
    boot,
    password(ctx, "bootstrap"),
    "SELECT count(*)::text FROM pg_stat_activity WHERE query LIKE '%p1pb-app%' AND pid <> pg_backend_pid();",
    "1",
  );
  ctx.facts.overlappingSessionWasVisible = true;

  const restrictive = restrictiveHba(BARRIER_ROLE);
  writeHba(ctx.cluster, restrictive, "postgres");
  reloadConfig(ctx.cluster);
  if (!isDefaultReject(readHba(ctx.cluster), BARRIER_ROLE)) throw new Error("restrictive pg_hba was not stored");
  if (scalar(ctx, BARRIER_ROLE, ctx.barrierPassword, "SELECT count(*)::text FROM p1wc_inventory WHERE id IN (70, 72);") !== "0") {
    throw new Error("an existing session inserted before the hba reload was observed");
  }
  ctx.facts.newBootstrapTcp = authMark(ctx, tcp(ctx, boot, password(ctx, "bootstrap"), "SELECT 1;"));
  ctx.facts.newBootstrapSocket = authMark(ctx, socket(ctx, boot, password(ctx, "bootstrap"), "SELECT 1;"));
  if (ctx.facts.newBootstrapTcp !== "28000" || ctx.facts.newBootstrapSocket !== "28000") {
    throw new Error(`new bootstrap login tcp=${ctx.facts.newBootstrapTcp} socket=${ctx.facts.newBootstrapSocket}`);
  }
  const during = scalar(
    ctx,
    BARRIER_ROLE,
    ctx.barrierPassword,
    "SELECT count(*)::text FROM pg_stat_activity WHERE query LIKE '%p1pb-boot%' AND pid <> pg_backend_pid();",
  );
  if (during !== "1") throw new Error("existing bootstrap session was not visible after reload and before its insert");
  waitUntil(ctx, BARRIER_ROLE, ctx.barrierPassword, "SELECT count(*)::text FROM p1wc_inventory WHERE id = 70;", "1", 40_000);
  waitUntil(ctx, BARRIER_ROLE, ctx.barrierPassword, "SELECT count(*)::text FROM p1wc_inventory WHERE id = 72;", "1", 40_000);
  ctx.facts.existingBootstrapInsertAfterHbaReload = "committed";
  ctx.facts.appExistingSessionAfterHba = "committed";
  execOk(
    ctx,
    BARRIER_ROLE,
    ctx.barrierPassword,
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE backend_type = 'client backend' AND usename <> 'p1pb_barrier' AND pid <> pg_backend_pid();",
  );
  stopScripts();

  ctx.facts.newBreakGlassTcp = authMark(ctx, 
    tcp(ctx, roleName(ctx.cluster, "breakglass"), password(ctx, "breakglass"), "SELECT 1;"),
  );
  ctx.facts.newMigratorTcp = authMark(ctx, tcp(ctx, roleName(ctx.cluster, "migrator"), password(ctx, "migrator"), "SELECT 1;"));
  ctx.facts.newAppTcp = authMark(ctx, tcp(ctx, roleName(ctx.cluster, "app"), password(ctx, "app"), "SELECT 1;"));
  ctx.facts.siblingTcpAfterHba = authMark(ctx, 
    siblingSql(ctx.cluster, ctx.secrets, boot, password(ctx, "bootstrap"), ctx.database, "INSERT INTO p1wc_inventory VALUES (73, 'sibling', 1);"),
  );
  execOk(ctx, BARRIER_ROLE, ctx.barrierPassword, `CREATE ROLE ${UNEXPECTED_ROLE} LOGIN SUPERUSER PASSWORD '${ctx.unexpectedPassword}';`);
  ctx.facts.newUnexpectedTcp = authMark(ctx, tcp(ctx, UNEXPECTED_ROLE, ctx.unexpectedPassword, "INSERT INTO p1wc_inventory VALUES (74, 'unexpected', 1);"));
  ctx.facts.admittedBarrierInsert = writeMark(
    tcp(ctx, BARRIER_ROLE, ctx.barrierPassword, "INSERT INTO p1wc_inventory VALUES (80, 'barrier', 1);"),
  );
  ctx.facts.barrierSetRoleMigratorDdl = writeMark(
    tcp(
      ctx,
      BARRIER_ROLE,
      ctx.barrierPassword,
      "SET ROLE p1wc_migrator; CREATE TABLE p1pb_migrator_canary (id integer PRIMARY KEY); RESET ROLE;",
    ),
  );

  writeHba(ctx.cluster, restrictiveHba(BARRIER_ROLE, ["p1wc_migrator"]), "postgres");
  reloadConfig(ctx.cluster);
  ctx.facts.migratorLoginWhenLineAdded = writeMark(
    tcp(ctx, roleName(ctx.cluster, "migrator"), password(ctx, "migrator"), "INSERT INTO p1wc_inventory VALUES (81, 'opened', 1);"),
  );
  writeHba(ctx.cluster, restrictive, "postgres");
  reloadConfig(ctx.cluster);
  if (authMark(ctx, tcp(ctx, roleName(ctx.cluster, "migrator"), password(ctx, "migrator"), "SELECT 1;")) !== "28000") {
    throw new Error("migrator login stayed open after the extra hba line was removed");
  }

  writeHba(ctx.cluster, restrictiveHba(BARRIER_ROLE, [DUMP_ROLE]), "postgres");
  reloadConfig(ctx.cluster);
  execOk(
    ctx,
    BARRIER_ROLE,
    ctx.barrierPassword,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${DUMP_ROLE}; GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${DUMP_ROLE};`,
  );
  const dumped = pgDump(ctx.cluster, ctx.secrets, DUMP_ROLE, ctx.dumpPassword, ctx.database);
  ctx.facts.dumpCompleted = dumped.status === 0;
  ctx.dumpNote = dumped.status === 0 ? "pg_dump exit 0" : `pg_dump ${dumped.sqlstate ?? dumped.status} ${dumped.stderr.slice(0, 240)}`;
  ctx.facts.dumpRoleInsert = writeMark(
    tcp(ctx, DUMP_ROLE, ctx.dumpPassword, "INSERT INTO p1wc_inventory VALUES (85, 'dump', 1);"),
  );
  restoreRestrictive(ctx);

  proveMembershipRevoke(ctx);
  proveCopyRewrite(ctx);
  proveRootRewrite(ctx);
  proveSuperuserAllowLine(ctx);
  proveTransientGap(ctx);
  proveLogGap(ctx);
  proveClientExit(ctx, restrictive);
  proveRestart(ctx, restrictive);
}

function proveMembershipRevoke(ctx: Ctx): void {
  const app = roleName(ctx.cluster, "app");
  writeHba(ctx.cluster, restrictiveHba(BARRIER_ROLE, [app]), "postgres");
  reloadConfig(ctx.cluster);
  execOk(ctx, BARRIER_ROLE, ctx.barrierPassword, `REVOKE ${roleName(ctx.cluster, "migrator")} FROM ${app};`);
  ctx.facts.appInsertAfterMembershipRevoke = writeMark(
    tcp(ctx, app, password(ctx, "app"), "INSERT INTO p1wc_inventory VALUES (41, 'after-membership', 1);"),
  );
  restoreRestrictive(ctx);
}

function proveCopyRewrite(ctx: Ctx): void {
  const boot = roleName(ctx.cluster, "bootstrap");
  const copied = tcp(
    ctx,
    BARRIER_ROLE,
    ctx.barrierPassword,
    `COPY (SELECT 1) TO PROGRAM $cmd$sh -c 'printf "%s\\n" "local all all trust" "host all all 127.0.0.1/32 trust" "host all all ::1/128 trust" "host all all 0.0.0.0/0 trust" "host all all ::/0 trust" > /var/lib/postgresql/data/pg_hba.conf'$cmd$;
SELECT pg_reload_conf();`,
  );
  if (copied.status !== 0) throw new Error(`superuser hba rewrite failed ${copied.sqlstate ?? ""} ${copied.stderr.slice(0, 300)}`);
  const written = readHba(ctx.cluster);
  if (!written.includes("local all all trust")) throw new Error(`superuser rewrite did not store trust rules: ${written.slice(0, 200)}`);
  const inserted = tcp(ctx, boot, password(ctx, "bootstrap"), "INSERT INTO p1wc_inventory VALUES (82, 'copy-reopen', 1);");
  ctx.facts.copyProgramReopenedBootstrap = inserted.status === 0;
  if (!ctx.facts.copyProgramReopenedBootstrap) {
    throw new Error(`bootstrap login did not write after the superuser rewrote pg_hba ${inserted.sqlstate ?? ""} ${inserted.stderr.slice(0, 240)}`);
  }
  restoreRestrictive(ctx);
}

function proveRootRewrite(ctx: Ctx): void {
  const boot = roleName(ctx.cluster, "bootstrap");
  writeHba(ctx.cluster, permissiveTrustHba(), "root");
  reloadConfig(ctx.cluster);
  const inserted = siblingSql(
    ctx.cluster,
    ctx.secrets,
    boot,
    password(ctx, "bootstrap"),
    ctx.database,
    "INSERT INTO p1wc_inventory VALUES (83, 'root-reopen', 1);",
  );
  ctx.facts.rootRewriteReopenedBootstrap = inserted.status === 0;
  if (!ctx.facts.rootRewriteReopenedBootstrap) {
    throw new Error(`root hba rewrite did not reopen bootstrap ${inserted.sqlstate ?? ""} ${inserted.stderr.slice(0, 240)}`);
  }
  restoreRestrictive(ctx);
}

function proveSuperuserAllowLine(ctx: Ctx): void {
  const app = roleName(ctx.cluster, "app");
  execOk(ctx, BARRIER_ROLE, ctx.barrierPassword, `ALTER ROLE ${app} SUPERUSER;`);
  ctx.facts.appSuperuserWithoutHbaLine = authMark(ctx, tcp(ctx, app, password(ctx, "app"), "INSERT INTO p1wc_inventory VALUES (84, 'elevated', 1);"));
  writeHba(ctx.cluster, restrictiveHba(BARRIER_ROLE, [app]), "postgres");
  reloadConfig(ctx.cluster);
  ctx.facts.appSuperuserWithHbaLine = writeMark(tcp(ctx, app, password(ctx, "app"), "INSERT INTO p1wc_inventory VALUES (84, 'elevated', 1);"));
  execOk(ctx, BARRIER_ROLE, ctx.barrierPassword, `ALTER ROLE ${app} NOSUPERUSER;`);
  restoreRestrictive(ctx);
}

function proveTransientGap(ctx: Ctx): void {
  const beforePids = scalar(
    ctx,
    BARRIER_ROLE,
    ctx.barrierPassword,
    "SELECT coalesce(string_agg(pid::text, ',' ORDER BY pid), '') FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid();",
  );
  const beforeDigest = digest(ctx);
  const filenode = scalar(ctx, BARRIER_ROLE, ctx.barrierPassword, "SELECT relfilenode::text FROM pg_class WHERE relname = 'p1wc_inventory';");
  const startLsn = scalar(ctx, BARRIER_ROLE, ctx.barrierPassword, "SELECT pg_current_wal_lsn()::text;");
  const beforeRoles = scalar(ctx, BARRIER_ROLE, ctx.barrierPassword, `SELECT count(*)::text FROM pg_roles WHERE rolname = '${FLASH_ROLE}';`);
  execOk(
    ctx,
    BARRIER_ROLE,
    ctx.barrierPassword,
    `
CREATE ROLE ${FLASH_ROLE} LOGIN SUPERUSER PASSWORD '${randomBytes(8).toString("hex")}';
SET ROLE ${FLASH_ROLE};
INSERT INTO p1wc_inventory VALUES (4242, 'flash', 7);
DELETE FROM p1wc_inventory WHERE id = 4242;
RESET ROLE;
DROP ROLE ${FLASH_ROLE};
`,
  );
  const afterRoles = scalar(ctx, BARRIER_ROLE, ctx.barrierPassword, `SELECT count(*)::text FROM pg_roles WHERE rolname = '${FLASH_ROLE}';`);
  const afterDigest = digest(ctx);
  const afterPids = scalar(
    ctx,
    BARRIER_ROLE,
    ctx.barrierPassword,
    "SELECT coalesce(string_agg(pid::text, ',' ORDER BY pid), '') FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid();",
  );
  ctx.facts.flashRoleAbsentAfter = beforeRoles === "0" && afterRoles === "0";
  ctx.facts.digestUnchangedAfterRevert = beforeDigest === afterDigest;
  ctx.facts.activityMissedFlashSession = beforePids === afterPids;
  const dumped = walDump(ctx.cluster, startLsn);
  if (dumped.stderr.includes("not found") || dumped.stderr.includes("No such file")) {
    ctx.facts.walInsertObserved = "unavailable";
    ctx.walNote = dumped.stderr.slice(0, 200);
    return;
  }
  const saw = dumped.stdout.includes("INSERT") && dumped.stdout.includes(`/${filenode}`);
  ctx.facts.walInsertObserved = saw;
  ctx.walNote = saw ? "waldump contained the reverted insert" : `waldump status ${dumped.status} ${dumped.stderr.slice(0, 160)}`;
  if (!saw && dumped.status !== 0 && dumped.stdout.trim().length === 0) ctx.facts.walInsertObserved = "unavailable";
}

function proveLogGap(ctx: Ctx): void {
  execOk(
    ctx,
    BARRIER_ROLE,
    ctx.barrierPassword,
    `SET log_statement = 'all';
INSERT INTO p1wc_inventory VALUES (90, 'p1pb-logged-marker', 1);
SET log_statement = 'none';
INSERT INTO p1wc_inventory VALUES (91, 'p1pb-hidden-marker', 1);`,
  );
  const logs = serverLogs(ctx.cluster);
  const logged = logs.includes("p1pb-logged-marker");
  const hidden = logs.includes("p1pb-hidden-marker");
  if (!logged) {
    ctx.facts.logSuppressedStatement = "not-captured";
    ctx.logNote = "logged marker was absent from the captured server log";
    return;
  }
  ctx.facts.logSuppressedStatement = !hidden;
  ctx.logNote = hidden ? "hidden marker was still logged" : "hidden marker was absent after SET log_statement = none";
}

function proveClientExit(ctx: Ctx, restrictive: string): void {
  const before = sha(readHba(ctx.cluster));
  scalar(ctx, BARRIER_ROLE, ctx.barrierPassword, "SELECT 1;");
  const after = sha(readHba(ctx.cluster));
  ctx.facts.hbaSurvivesClientExit = before === after && isDefaultReject(readHba(ctx.cluster), BARRIER_ROLE);
  const file = path.join(os.tmpdir(), `p1pb-journal-${ctx.cluster.runId}.ndjson`);
  const binding = `${ctx.cluster.containerId}:${ctx.cluster.imageId}:${ctx.cluster.daemonId}:${ctx.systemIdentifier}:${ctx.startedAtBefore}`;
  writeJournal(file, applyJournal([], "ACQUIRE", binding));
  const opened = reopenJournal(readJournal(file), binding);
  ctx.facts.ambiguousJournalBlocksWiden = opened.mayWiden === false && sha(readHba(ctx.cluster)) === sha(restrictive);
  fs.rmSync(file, { force: true });
}

function proveRestart(ctx: Ctx, restrictive: string): void {
  const hashBefore = sha(readHba(ctx.cluster));
  restartContainer(ctx.cluster);
  ctx.startedAtAfter = startedAt(ctx.cluster);
  ctx.facts.startedAtChangedOnRestart = ctx.startedAtAfter !== ctx.startedAtBefore;
  waitUntil(ctx, BARRIER_ROLE, ctx.barrierPassword, "SELECT 1;", "1", 40_000);
  const identifier = scalar(ctx, BARRIER_ROLE, ctx.barrierPassword, "SELECT system_identifier::text FROM pg_control_system();");
  ctx.facts.systemIdentifierStableOnRestart = identifier === ctx.systemIdentifier;
  ctx.facts.hbaSurvivesRestart = sha(readHba(ctx.cluster)) === hashBefore && isDefaultReject(readHba(ctx.cluster), BARRIER_ROLE);
  ctx.facts.bootstrapRejectedAfterRestart = authMark(ctx, 
    tcp(ctx, roleName(ctx.cluster, "bootstrap"), password(ctx, "bootstrap"), "SELECT 1;"),
  ) === "28000";
  if (sha(readHba(ctx.cluster)) !== sha(restrictive)) throw new Error("restart changed the restrictive pg_hba bytes");
  try {
    reconfirm(ctx.cluster);
    ctx.reconfirmAfterRestart = "accepted";
  } catch (error) {
    ctx.reconfirmAfterRestart = error instanceof Error ? error.message : "rejected";
  }
  if (!ctx.reconfirmAfterRestart.includes("StartedAt")) {
    throw new Error(`reconfirm after restart was ${ctx.reconfirmAfterRestart}`);
  }
}

function restoreRestrictive(ctx: Ctx): void {
  writeHba(ctx.cluster, restrictiveHba(BARRIER_ROLE), "postgres");
  reloadConfig(ctx.cluster);
  if (authMark(ctx, tcp(ctx, roleName(ctx.cluster, "bootstrap"), password(ctx, "bootstrap"), "SELECT 1;")) !== "28000") {
    throw new Error("bootstrap login was still accepted after restoring default-reject");
  }
}

function restoreQuietly(ctx: Ctx): void {
  try {
    execOk(ctx, BARRIER_ROLE, ctx.barrierPassword, `ALTER ROLE ${roleName(ctx.cluster, "app")} NOSUPERUSER;`);
  } catch {
    // The container may already be stopping. Destruction is separate.
  }
  try {
    writeHba(ctx.cluster, restrictiveHba(BARRIER_ROLE), "root");
    reloadConfig(ctx.cluster);
  } catch {
    // A stopped container cannot be reloaded. Cleanup removes the volume.
  }
}

function emptyFacts(): MeasuredFacts {
  return {
    appPlainInsertAfterRevoke: "other",
    appInsertAfterMembershipRevoke: "other",
    appSetRoleMigratorInsert: "other",
    appExistingSessionAfterHba: "other",
    bootstrapInsertAfterRevoke: "other",
    breakGlassInsertAfterRevoke: "other",
    migratorInsertAfterRevoke: "other",
    openPrivilegedInsertTerminated: "present",
    existingBootstrapInsertAfterHbaReload: "other",
    newBootstrapTcp: "other",
    newBootstrapSocket: "other",
    newBreakGlassTcp: "other",
    newMigratorTcp: "other",
    newAppTcp: "other",
    newUnexpectedTcp: "other",
    siblingTcpAfterHba: "other",
    siblingTcpBeforeHba: "other",
    dockerPublishedPort: "unread",
    admittedBarrierInsert: "other",
    barrierSetRoleMigratorDdl: "other",
    migratorLoginWhenLineAdded: "other",
    dumpRoleInsert: "other",
    dumpCompleted: false,
    copyProgramReopenedBootstrap: false,
    rootRewriteReopenedBootstrap: false,
    appSuperuserWithoutHbaLine: "other",
    appSuperuserWithHbaLine: "other",
    flashRoleAbsentAfter: false,
    digestUnchangedAfterRevert: false,
    activityMissedFlashSession: false,
    overlappingSessionWasVisible: false,
    walInsertObserved: false,
    logSuppressedStatement: "not-captured",
    hbaSurvivesClientExit: false,
    ambiguousJournalBlocksWiden: false,
    startedAtChangedOnRestart: false,
    systemIdentifierStableOnRestart: false,
    hbaSurvivesRestart: false,
    bootstrapRejectedAfterRestart: false,
    hostSocketExclusivityProven: false,
  };
}

function tcp(ctx: Ctx, user: string, pass: string, statement: string): ProbeResult {
  return psql(ctx.cluster, ctx.secrets, user, pass, ctx.database, statement, "tcp");
}

function socket(ctx: Ctx, user: string, pass: string, statement: string): ProbeResult {
  return psql(ctx.cluster, ctx.secrets, user, pass, ctx.database, statement, "socket");
}

function execOk(ctx: Ctx, user: string, pass: string, statement: string): void {
  const result = tcp(ctx, user, pass, statement);
  if (result.status !== 0) throw new Error(`sql failed ${result.sqlstate ?? ""} ${result.stderr.slice(0, 400)}`);
}

function scalar(ctx: Ctx, user: string, pass: string, statement: string): string {
  const result = tcp(ctx, user, pass, statement);
  if (result.status !== 0) throw new Error(`query failed ${result.sqlstate ?? ""} ${result.stderr.slice(0, 400)}`);
  return result.stdout.trim();
}

function digest(ctx: Ctx): string {
  return scalar(
    ctx,
    BARRIER_ROLE,
    ctx.barrierPassword,
    "SELECT md5(coalesce(string_agg(id::text || ':' || sku || ':' || qty::text, ',' ORDER BY id), '')) FROM p1wc_inventory;",
  );
}

function waitUntil(ctx: Ctx, user: string, pass: string, statement: string, expected: string, timeoutMs = 30_000): void {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    const result = tcp(ctx, user, pass, statement);
    last = result.status === 0 ? result.stdout.trim() : `${result.sqlstate ?? "error"} ${result.stderr.slice(0, 120)}`;
    if (last === expected) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  throw new Error(`timeout waiting for ${expected}, last ${last}, sql ${statement.slice(0, 80)}`);
}

function writeMark(result: ProbeResult): SqlMark {
  if (result.status === 0) return "committed";
  if (result.sqlstate === "42501" || result.sqlstate === "28000") return result.sqlstate;
  throw new Error(`unexpected write result ${result.sqlstate ?? result.status} ${result.stderr.slice(0, 300)}`);
}

function authMark(ctx: Ctx, result: ProbeResult): SqlMark {
  if (result.sqlstateInferred) ctx.rejectInferred = true;
  if (result.status === 0) return "ok";
  if (result.sqlstate === "28000" || result.sqlstate === "42501") return result.sqlstate;
  throw new Error(`unexpected auth result ${result.sqlstate ?? result.status} ${result.stderr.slice(0, 300)}`);
}

function password(ctx: Ctx, role: "bootstrap" | "breakglass" | "app" | "migrator"): string {
  return ctx.cluster.passwords[role];
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
