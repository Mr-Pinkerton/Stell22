/**
 * Disposable release rehearsal.
 * One test-owned PostgreSQL 17 run. This does not deploy production
 * and does not restore over a migrated database.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  confirmOwnedContainer,
  releaseAppOnly,
  type AppOnlyRelease,
  type OwnedContainer,
} from "@/server/internal/p1-app-only-startup/cleanup";
import {
  ContainerOriginRefusal,
  defaultOriginRuntime,
  resolveLocalDockerEndpoint,
} from "@/server/internal/p1-isolated-runner/container-origin";
import {
  EXPECTED_HISTORICAL_MIGRATION_COUNT,
  EXPECTED_MIGRATION_SQL_COUNT,
  P1_MIGRATION_NAME,
  P1_SHA256,
} from "@/server/internal/p1-isolated-runner/contract";
import {
  evaluateMigratorPrivileges,
  migratorPrivilegeSql,
  parseMigratorPrivilegeReport,
} from "@/server/internal/p1-production-adapter/migrator-privilege";
import {
  DISPOSABLE_ADMIN_ROLE,
  DISPOSABLE_APP_ROLE,
  MIGRATOR_ROLE,
  migrationHistoryPrivilegesSql,
  roleTopologySql,
} from "@/server/internal/p1-role-split-disposable/topology";
import { copyMigrationsAfterPinnedP1, isMigrationAfterPinnedP1 } from "@/server/internal/p1-isolated-runner/later-migrations";
import { realWorld, redact } from "@/server/internal/p1-write-freeze-historical/runtime";
import type { InvocationBinding } from "@/server/internal/p1-write-freeze-historical/lifecycle";
import type { DockerWorld } from "@/server/internal/p1-write-freeze-proof/lifecycle";
import {
  assertRehearsalTarget,
  rehearsalIdentity,
  type RehearsalTarget,
} from "@/server/internal/p1-disposable-release/identity";
import {
  rehearsalReport,
  classifyCleanup,
  type RehearsalCleanup,
  type RehearsalReport,
  type StageId,
} from "@/server/internal/p1-disposable-release/report";

export type { RehearsalCleanup };

const LABEL = "stell22.p1.disposable-release";
export const BACKUP_PROBE_VALUE = '"p1rr-backup-probe-v1"';
const INIT_MIGRATION = "20260629154204_init";
const DATABASE_NAME = /^p1as_[0-9a-f]{8}$/;
const IMAGE_TAG = /^p1as-app:[0-9a-f]{8}$/;
const PRESERVE_DATABASE = new Set([
  "MIGRATION_UNCERTAIN",
  "AMBIGUOUS_COMPLETION",
  "MIGRATION_FAILED_NO_RETRY",
]);

export type RehearsalFault =
  | "production-database-name"
  | "superuser-app"
  | "failed-history"
  | "pending-history"
  | "corrupt-backup"
  | "missing-restore-business"
  | "changed-restore-business"
  | "ambiguous-p1";

export type RehearsalOptions = {
  applicationImageTag?: string;
  testFault?: RehearsalFault;
  resumeMarkerPath?: string;
};

export type RehearsalResources = {
  runId: string;
  binding: InvocationBinding | null;
  database: OwnedContainer | null;
  application: OwnedContainer | null;
  volume: { name: string; mountpoint: string } | null;
  network: { id: string; name: string } | null;
  image: { tag: string; id: string } | null;
  extraContainers: OwnedContainer[];
  migrationRoot: string | null;
  preserveDatabase: boolean;
  sharedImage: boolean;
};

export type RehearsalRun = {
  report: RehearsalReport;
  resources: RehearsalResources;
};

class Stop extends Error {
  constructor(
    readonly stage: StageId,
    readonly code: string,
    readonly detail: string | null = null,
  ) {
    super(code);
  }
}

type Evidence = {
  stage: StageId;
  runId: string;
  target: RehearsalTarget;
  endpoint: string;
  daemonId: string;
  secrets: string[];
  serverVersion: string | null;
  sourceHistoryMarker: string | null;
  backupProbeKey: string | null;
  backupProbeValue: string | null;
  p1Marker: string | null;
  archiveSha256: string | null;
  restoreMatched: boolean | null;
  restoreProbeMatched: boolean | null;
  health: string | null;
  appLogin: string | null;
  markerPath: string | null;
  migrateSpawns: number;
  databaseId: string;
  databaseImage: string;
  appImage: string;
  imageTag: string;
  passed: StageId[];
};

export function runDisposableReleaseRehearsal(options: RehearsalOptions = {}): RehearsalRun {
  const runId = randomBytes(4).toString("hex");
  const evidence = blankEvidence(runId);
  const resources = blankResources(runId);
  try {
    if (options.resumeMarkerPath !== undefined) {
      refuseAmbiguousRetry(options.resumeMarkerPath);
      evidence.markerPath = options.resumeMarkerPath;
      throw new Stop("G", "AMBIGUOUS_COMPLETION");
    }
    evidence.stage = "A";
    const endpoint = localEndpoint();
    evidence.endpoint = endpoint;
    evidence.daemonId = docker(["info", "--format", "{{.ID}}"], evidence.secrets);
    const target = rehearsalIdentity(runId);
    target.dockerEndpoint = endpoint;
    if (options.testFault === "production-database-name") target.databaseName = "stell22";
    target.releaseEnvironment = releaseEnvironment();
    const identity = assertRehearsalTarget(target);
    if (!identity.ok) throw new Stop("A", identity.code);
    evidence.target = target;
    assertWorktree();
    assertSameOrigin(evidence);
    ensurePostgresImage(evidence.secrets);
    resources.binding = { endpoint, daemonId: evidence.daemonId, runId };
    createCluster(evidence, resources);
    verifyLiveIdentity(evidence, resources);
    evidence.passed.push("A");

    evidence.stage = "B";
    const appPassword = randomBytes(16).toString("hex");
    const migratorPassword = randomBytes(16).toString("hex");
    evidence.secrets.push(appPassword, migratorPassword);
    const databaseName = target.databaseName;
    psql(
      resources,
      databaseName,
      DISPOSABLE_ADMIN_ROLE,
      roleTopologySql({ databaseName, appPassword, migratorPassword }),
      evidence,
    );
    if (options.testFault === "superuser-app") {
      psql(
        resources,
        databaseName,
        DISPOSABLE_ADMIN_ROLE,
        `ALTER ROLE ${DISPOSABLE_APP_ROLE} SUPERUSER`,
        evidence,
      );
    }
    verifyRoleSeparation(resources, databaseName, evidence);
    evidence.passed.push("B");

    evidence.stage = "C";
    const image = resolveImage(options, evidence);
    evidence.imageTag = image.tag;
    evidence.appImage = image.id;
    if (!options.applicationImageTag) resources.image = image;
    resources.sharedImage = options.applicationImageTag !== undefined;
    const migrationRoot = materializeMigrations();
    resources.migrationRoot = migrationRoot;
    const heldP1 = holdP1(migrationRoot);
    runMigrate(
      evidence,
      resources,
      `p1as-hist-${runId}`,
      migrationRoot,
      migratorUrl(migratorPassword, databaseName),
    );
    revealP1(heldP1, path.join(migrationRoot, "prisma", "migrations", P1_MIGRATION_NAME));
    psql(resources, databaseName, DISPOSABLE_ADMIN_ROLE, migrationHistoryPrivilegesSql(), evidence);
    if (options.testFault === "failed-history") {
      psql(
        resources,
        databaseName,
        DISPOSABLE_ADMIN_ROLE,
        `UPDATE public."_prisma_migrations" SET finished_at = NULL, applied_steps_count = 0 WHERE migration_name = '${INIT_MIGRATION}'`,
        evidence,
      );
    }
    if (options.testFault === "pending-history") {
      psql(
        resources,
        databaseName,
        DISPOSABLE_ADMIN_ROLE,
        `DELETE FROM public."_prisma_migrations" WHERE migration_name = '${INIT_MIGRATION}'`,
        evidence,
      );
    }
    verifyPreP1History(resources, databaseName, evidence);
    evidence.passed.push("C");

    evidence.stage = "D";
    seedBackupProbe(resources, databaseName, evidence);
    const archive = createBackup(
      resources,
      databaseName,
      evidence,
      options.testFault === "corrupt-backup",
    );
    evidence.passed.push("D");

    evidence.stage = "E";
    verifyRestore(
      resources,
      databaseName,
      target.restoreDatabaseName ?? "",
      archive,
      evidence,
      options.testFault,
    );
    evidence.passed.push("E");

    evidence.stage = "F";
    assertSameOrigin(evidence);
    verifyPrerequisites(resources, databaseName, migrationRoot, evidence);
    evidence.passed.push("F");

    evidence.stage = "G";
    const marker = markerPath(migrationRoot);
    evidence.markerPath = marker;
    applyPinnedP1(
      evidence,
      resources,
      marker,
      migratorUrl(migratorPassword, databaseName),
      migrationRoot,
      options.testFault === "ambiguous-p1",
    );
    evidence.passed.push("G");

    evidence.stage = "H";
    verifyAppliedSchema(resources, databaseName, evidence);
    evidence.passed.push("H");

    evidence.stage = "I";
    if (copyMigrationsAfterPinnedP1(migrationRoot) > 0) {
      runMigrate(
        evidence,
        resources,
        `p1as-later-${runId}`,
        migrationRoot,
        migratorUrl(migratorPassword, databaseName),
      );
    }
    const sessionSecret = randomBytes(24).toString("hex");
    evidence.secrets.push(sessionSecret);
    startApplication(evidence, resources, appUrl(appPassword, databaseName), sessionSecret);
    evidence.passed.push("I");

    evidence.stage = "J";
    evidence.health = waitHealth(resources.application?.name ?? "", evidence);
    runBusinessDml(evidence, resources, appUrl(appPassword, databaseName));
    evidence.passed.push("J");

    evidence.stage = "K";
    assertSameOrigin(evidence);
    restartAndConfirm(evidence, resources, databaseName);
    evidence.passed.push("K");
    return outcome(evidence, resources, null);
  } catch (error) {
    const stop =
      error instanceof Stop
        ? error
        : new Stop(evidence.stage, "UNEXPECTED_FAILURE", redactedError(error, evidence.secrets));
    if (
      PRESERVE_DATABASE.has(stop.code) ||
      evidence.migrateSpawns > 0 ||
      stop.stage === "H" ||
      stop.stage === "I" ||
      stop.stage === "J" ||
      stop.stage === "K"
    ) {
      resources.preserveDatabase = true;
    }
    return outcome(evidence, resources, stop);
  }
}

export function finishRehearsal(resources: RehearsalResources): RehearsalCleanup {
  return releaseRehearsalResources(resources, realWorld());
}

export function releaseRehearsalResources(
  resources: RehearsalResources,
  world: DockerWorld,
): RehearsalCleanup {
  const removed: string[] = [];
  const preserved: RehearsalCleanup["preserved"] = [];
  const failures: RehearsalCleanup["failures"] = [];
  const release = releaseInput(resources);
  if (resources.preserveDatabase) {
    for (const resource of preservedResources(resources)) {
      preserved.push({ resource, reason: "INTENTIONAL_PRESERVATION" });
    }
    release.database = null;
    release.volume = null;
    release.network = null;
  } else {
    for (const container of resources.extraContainers) {
      const ready = confirmOwnedContainer(release, container, world);
      if (!ready.ok) {
        preserved.push({ resource: container.name, reason: ready.reason });
        continue;
      }
      const deleted = world.exec(["rm", "-f", container.id]);
      if (deleted.status !== 0) {
        failures.push({ resource: container.name, reason: "REMOVAL_FAILED" });
      } else {
        removed.push(container.name);
      }
    }
  }
  if (resources.sharedImage && resources.image) {
    preserved.push({ resource: resources.image.tag, reason: "SHARED_IMAGE" });
    release.image = null;
  }
  const released = releaseAppOnly(release, world);
  for (const name of released.removed) {
    if (!removed.includes(name)) removed.push(name);
  }
  for (const item of released.preserved) {
    if (removed.includes(item.resource)) continue;
    if (preserved.some((row) => row.resource === item.resource)) continue;
    preserved.push(item);
  }
  for (const item of released.failures) {
    if (!failures.some((row) => row.resource === item.resource && row.reason === item.reason)) {
      failures.push(item);
    }
  }
  if (resources.migrationRoot) {
    if (resources.preserveDatabase) {
      preserved.push({ resource: resources.migrationRoot, reason: "INTENTIONAL_PRESERVATION" });
    } else {
      try {
        fs.rmSync(resources.migrationRoot, { recursive: true, force: true });
        removed.push(resources.migrationRoot);
      } catch {
        failures.push({ resource: resources.migrationRoot, reason: "REMOVAL_FAILED" });
      }
    }
  }
  const cleanup = {
    removed,
    preserved,
    failures,
    status: "COMPLETE" as const,
  };
  return { ...cleanup, status: classifyCleanup(cleanup) };
}

function preservedResources(resources: RehearsalResources): string[] {
  return [
    resources.database?.name,
    resources.volume?.name,
    resources.network?.name,
    ...resources.extraContainers.map((container) => container.name),
  ].filter((name): name is string => typeof name === "string" && name.length > 0);
}

export function buildRehearsalImage(runId: string): { tag: string; id: string } {
  if (!/^[0-9a-f]{8}$/.test(runId)) throw new Error("disposable rehearsal id is not 8 hex digits");
  const tag = `p1as-app:${runId}`;
  docker(["build", "-f", "Dockerfile", "-t", tag, "."], []);
  return inspectAppImage(tag, []);
}

function blankEvidence(runId: string): Evidence {
  const adminPassword = randomBytes(16).toString("hex");
  return {
    stage: "A",
    runId,
    target: rehearsalIdentity(runId),
    endpoint: "",
    daemonId: "",
    secrets: [adminPassword],
    serverVersion: null,
    sourceHistoryMarker: null,
    backupProbeKey: null,
    backupProbeValue: null,
    p1Marker: null,
    archiveSha256: null,
    restoreMatched: null,
    restoreProbeMatched: null,
    health: null,
    appLogin: null,
    markerPath: null,
    migrateSpawns: 0,
    databaseId: "",
    databaseImage: "",
    appImage: "",
    imageTag: "",
    passed: [],
  };
}

function blankResources(runId: string): RehearsalResources {
  return {
    runId,
    binding: null,
    database: null,
    application: null,
    volume: null,
    network: null,
    image: null,
    extraContainers: [],
    migrationRoot: null,
    preserveDatabase: false,
    sharedImage: false,
  };
}

function outcome(
  evidence: Evidence,
  resources: RehearsalResources,
  failure: Stop | null,
): RehearsalRun {
  const report = rehearsalReport({
    runId: evidence.runId,
    databaseName: evidence.target.databaseName,
    restoreDatabaseName: evidence.target.restoreDatabaseName,
    databaseContainerName: resources.database?.name ?? null,
    serverVersion: evidence.serverVersion,
    sourceHistoryMarker: evidence.sourceHistoryMarker,
    backupProbeKey: evidence.backupProbeKey,
    backupProbeValue: evidence.backupProbeValue,
    p1Marker: evidence.p1Marker,
    archiveSha256: evidence.archiveSha256,
    restoreMatched: evidence.restoreMatched,
    restoreProbeMatched: evidence.restoreProbeMatched,
    health: evidence.health,
    appLogin: evidence.appLogin,
    markerPath: evidence.markerPath,
    migrateSpawns: evidence.migrateSpawns,
    stages: (
      Object.keys({ A: 1, B: 1, C: 1, D: 1, E: 1, F: 1, G: 1, H: 1, I: 1, J: 1, K: 1 }) as StageId[]
    ).map((id) => ({
      id,
      result: failure?.stage === id ? "FAIL" : evidence.passed.includes(id) ? "PASS" : "NOT_RUN",
    })),
    failure:
      failure === null
        ? null
        : { stage: failure.stage, code: failure.code, detail: failure.detail },
  });
  return { report, resources };
}

function localEndpoint(): string {
  try {
    return resolveLocalDockerEndpoint(defaultOriginRuntime());
  } catch (error) {
    if (error instanceof ContainerOriginRefusal) {
      if (error.code === "DOCKER_ENDPOINT_AMBIGUOUS") throw new Stop("A", "AMBIGUOUS_IDENTITY");
      if (error.code === "DOCKER_ENDPOINT_REMOTE") throw new Stop("A", "PRODUCTION_SSH_REFUSED");
      throw new Stop("A", "UNSUPPORTED_IDENTITY");
    }
    throw error;
  }
}

function releaseEnvironment(): string {
  return process.env.GITHUB_ENVIRONMENT ?? process.env.STELL22_RELEASE_ENVIRONMENT ?? "TEST_OWNED";
}

function assertWorktree(): void {
  const paths = [
    "prisma/schema.prisma",
    "prisma/migrations",
    "Dockerfile",
    "docker-entrypoint-app-only.sh",
  ];
  const diff = spawnSync("git", ["diff", "--quiet", "HEAD", "--", ...paths], {
    encoding: "utf8",
    windowsHide: true,
  });
  const status = spawnSync("git", ["status", "--porcelain", "--", ...paths], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (diff.status !== 0 || status.status !== 0 || status.stdout.trim() !== "")
    throw new Stop("A", "WORKTREE_DRIFT");
}

function assertSameOrigin(evidence: Evidence): void {
  const endpoint = resolveLocalDockerEndpoint(defaultOriginRuntime());
  const daemon = docker(["info", "--format", "{{.ID}}"], evidence.secrets);
  if (endpoint !== evidence.endpoint || daemon !== evidence.daemonId)
    throw new Stop(evidence.stage, "DOCKER_ENDPOINT_CHANGED");
}

function createCluster(evidence: Evidence, resources: RehearsalResources): void {
  const names = namesFor(evidence.runId);
  const networkId = docker(
    ["network", "create", "--label", `${LABEL}=${evidence.runId}`, names.network],
    evidence.secrets,
  );
  if (!/^[0-9a-f]{64}$/.test(networkId)) throw new Stop("A", "AMBIGUOUS_IDENTITY");
  resources.network = { id: networkId, name: names.network };
  const volumeName = docker(
    ["volume", "create", "--label", `${LABEL}=${evidence.runId}`, names.volume],
    evidence.secrets,
  );
  if (volumeName !== names.volume) throw new Stop("A", "AMBIGUOUS_IDENTITY");
  const mountpoint = docker(
    ["volume", "inspect", "--format", "{{.Mountpoint}}", volumeName],
    evidence.secrets,
  );
  resources.volume = { name: volumeName, mountpoint };
  const adminPassword = evidence.secrets[0] ?? "";
  evidence.databaseId = docker(
    [
      "run",
      "-d",
      "--pull",
      "never",
      "--restart",
      "no",
      "--name",
      names.database,
      "--network",
      names.network,
      "--network-alias",
      "db",
      "--label",
      `${LABEL}=${evidence.runId}`,
      "--mount",
      `type=volume,source=${names.volume},target=/var/lib/postgresql/data`,
      "-e",
      `POSTGRES_USER=${DISPOSABLE_ADMIN_ROLE}`,
      "-e",
      `POSTGRES_PASSWORD=${adminPassword}`,
      "-e",
      `POSTGRES_DB=${evidence.target.databaseName}`,
      "postgres:17-alpine",
    ],
    evidence.secrets,
  );
  evidence.databaseImage = docker(
    ["inspect", "--format", "{{.Image}}", evidence.databaseId],
    evidence.secrets,
  );
  resources.database = {
    id: evidence.databaseId,
    name: names.database,
    imageId: evidence.databaseImage,
  };
  const published = docker(
    ["inspect", "--format", "{{json .NetworkSettings.Ports}}", evidence.databaseId],
    evidence.secrets,
  );
  if (published.includes("HostIp") || published.includes("HostPort"))
    throw new Stop("A", "UNSUPPORTED_IDENTITY");
  waitReady(resources, evidence.target.databaseName);
}

function verifyLiveIdentity(evidence: Evidence, resources: RehearsalResources): void {
  const databaseName = evidence.target.databaseName;
  evidence.serverVersion = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    "SELECT current_setting('server_version_num')",
    evidence,
  );
  if (!evidence.serverVersion.startsWith("17")) throw new Stop("A", "UNSUPPORTED_IDENTITY");
  const live = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    "SELECT current_database()",
    evidence,
  );
  if (live !== databaseName) throw new Stop("A", "AMBIGUOUS_IDENTITY");
}

function verifyRoleSeparation(
  resources: RehearsalResources,
  databaseName: string,
  evidence: Evidence,
): void {
  const admin = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    "SELECT current_user || '|' || rolsuper::text FROM pg_roles WHERE rolname = current_user",
    evidence,
  );
  if (admin !== `${DISPOSABLE_ADMIN_ROLE}|true`) throw new Stop("B", "ROLE_PRIVILEGE_REFUSED");
  const app = psql(
    resources,
    databaseName,
    DISPOSABLE_APP_ROLE,
    "SELECT current_user || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text FROM pg_roles WHERE rolname = current_user",
    evidence,
  );
  if (app !== `${DISPOSABLE_APP_ROLE}|false|false|false`)
    throw new Stop("B", "ROLE_PRIVILEGE_REFUSED");
  const migrator = psql(
    resources,
    databaseName,
    MIGRATOR_ROLE,
    "SELECT current_user || '|' || rolsuper::text || '|' || has_schema_privilege(current_user, 'public', 'CREATE')::text FROM pg_roles WHERE rolname = current_user",
    evidence,
  );
  if (migrator !== `${MIGRATOR_ROLE}|false|true`) throw new Stop("B", "ROLE_PRIVILEGE_REFUSED");
  if (
    psql(
      resources,
      databaseName,
      DISPOSABLE_APP_ROLE,
      "SELECT has_schema_privilege(current_user, 'public', 'CREATE')::text",
      evidence,
    ) !== "false"
  ) {
    throw new Stop("B", "ROLE_PRIVILEGE_REFUSED");
  }
  const members = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    `SELECT count(*)::text FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = '${DISPOSABLE_APP_ROLE}'`,
    evidence,
  );
  if (members !== "0") throw new Stop("B", "ROLE_PRIVILEGE_REFUSED");
  const created = psqlRaw(
    resources,
    databaseName,
    DISPOSABLE_APP_ROLE,
    "CREATE TABLE public.p1rr_denied (id integer)",
  );
  if (created.status === 0) throw new Stop("B", "ROLE_PRIVILEGE_REFUSED");
  const switched = psqlRaw(
    resources,
    databaseName,
    DISPOSABLE_APP_ROLE,
    `SET ROLE ${MIGRATOR_ROLE}`,
  );
  if (switched.status === 0) throw new Stop("B", "ROLE_PRIVILEGE_REFUSED");
}

function verifyPreP1History(
  resources: RehearsalResources,
  databaseName: string,
  evidence: Evidence,
): void {
  evidence.sourceHistoryMarker = historyMarker(resources, databaseName, evidence);
  evidence.p1Marker = p1Marker(resources, databaseName, evidence);
  if (evidence.sourceHistoryMarker === "ABSENT") throw new Stop("C", "PENDING_MIGRATION");
  const failed = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    `SELECT count(*)::text FROM public."_prisma_migrations" WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL OR applied_steps_count <> 1`,
    evidence,
  );
  if (failed !== "0") throw new Stop("C", "FAILED_MIGRATION");
  const count = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    `SELECT count(*)::text FROM public."_prisma_migrations"`,
    evidence,
  );
  if (count !== String(EXPECTED_HISTORICAL_MIGRATION_COUNT))
    throw new Stop("C", "PENDING_MIGRATION");
  if (evidence.p1Marker !== "ABSENT") throw new Stop("C", "PENDING_MIGRATION");
}

function seedBackupProbe(
  resources: RehearsalResources,
  databaseName: string,
  evidence: Evidence,
): void {
  const key = `p1rr_backup_${evidence.runId}`;
  psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    `INSERT INTO public."Setting" (key, value) VALUES ('${key}', '${BACKUP_PROBE_VALUE}'::jsonb)`,
    evidence,
  );
  const value = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    `SELECT value::text FROM public."Setting" WHERE key = '${key}'`,
    evidence,
  );
  if (value !== BACKUP_PROBE_VALUE)
    throw new Stop("D", "BACKUP_FAILED", "backup probe was not stored");
  evidence.backupProbeKey = key;
  evidence.backupProbeValue = value;
}

export type BackupProbeComparison = {
  sourceDatabase: string;
  restoreDatabase: string;
  sourceCurrentDatabase: string;
  restoreCurrentDatabase: string;
  capturedKey: string;
  capturedValue: string;
  sourceKey: string;
  sourceValue: string;
  restoredKey: string;
  restoredValue: string;
  sourceP1: string;
  restoredP1: string;
};

export function compareBackupProbe(
  input: BackupProbeComparison,
): { ok: true } | { ok: false; code: "RESTORE_VERIFICATION_FAILED" } {
  const separate =
    input.sourceDatabase !== input.restoreDatabase &&
    input.sourceCurrentDatabase === input.sourceDatabase &&
    input.restoreCurrentDatabase === input.restoreDatabase;
  const sourceIntact =
    input.sourceKey === input.capturedKey && input.sourceValue === input.capturedValue;
  const restoredExact =
    input.restoredKey === input.capturedKey &&
    input.restoredValue === input.capturedValue &&
    input.restoredValue.length > 0;
  const p1Absent = input.sourceP1 === "ABSENT" && input.restoredP1 === "ABSENT";
  if (!separate || !sourceIntact || !restoredExact || !p1Absent) {
    return { ok: false, code: "RESTORE_VERIFICATION_FAILED" };
  }
  return { ok: true };
}

function createBackup(
  resources: RehearsalResources,
  databaseName: string,
  evidence: Evidence,
  corrupt: boolean,
): Buffer {
  const container = resources.database?.id ?? "";
  const dumped = spawnSync(
    "docker",
    [
      "exec",
      container,
      "pg_dump",
      "-U",
      DISPOSABLE_ADMIN_ROLE,
      "--no-owner",
      "--no-acl",
      databaseName,
    ],
    {
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );
  if (dumped.status !== 0 || !dumped.stdout || dumped.stdout.length === 0)
    throw new Stop("D", "BACKUP_FAILED");
  const archive = Buffer.from(gzipSync(dumped.stdout));
  if (corrupt) archive[archive.length - 1] ^= 0xff;
  evidence.archiveSha256 = createHash("sha256").update(archive).digest("hex");
  return archive;
}

function verifyRestore(
  resources: RehearsalResources,
  sourceDatabase: string,
  restoreDatabase: string,
  archive: Buffer,
  evidence: Evidence,
  fault: RehearsalFault | undefined,
): void {
  if (sourceDatabase === restoreDatabase || !DATABASE_NAME.test(restoreDatabase))
    throw new Stop("E", "AMBIGUOUS_IDENTITY");
  psql(
    resources,
    sourceDatabase,
    DISPOSABLE_ADMIN_ROLE,
    `CREATE DATABASE ${restoreDatabase}`,
    evidence,
  );
  let sql: Buffer;
  try {
    sql = gunzipSync(archive);
  } catch {
    throw new Stop("E", "RESTORE_VERIFICATION_FAILED", "archive checksum did not restore");
  }
  const restored = psqlRaw(
    resources,
    restoreDatabase,
    DISPOSABLE_ADMIN_ROLE,
    stripSchemaBootstrap(sql),
  );
  if (restored.status !== 0)
    throw new Stop(
      "E",
      "RESTORE_VERIFICATION_FAILED",
      redact(restored.stderr.slice(-400), evidence.secrets),
    );
  const probeKey = evidence.backupProbeKey ?? "";
  if (fault === "missing-restore-business") {
    psql(
      resources,
      restoreDatabase,
      DISPOSABLE_ADMIN_ROLE,
      `DELETE FROM public."Setting" WHERE key = '${probeKey}'`,
      evidence,
    );
  }
  if (fault === "changed-restore-business") {
    psql(
      resources,
      restoreDatabase,
      DISPOSABLE_ADMIN_ROLE,
      `UPDATE public."Setting" SET value = '"changed"'::jsonb WHERE key = '${probeKey}'`,
      evidence,
    );
  }
  const sourceMarker = historyMarker(resources, sourceDatabase, evidence);
  const restoredMarker = historyMarker(resources, restoreDatabase, evidence);
  if (sourceMarker !== evidence.sourceHistoryMarker || restoredMarker !== sourceMarker) {
    throw new Stop("E", "RESTORE_VERIFICATION_FAILED");
  }
  const probe = compareBackupProbe({
    sourceDatabase,
    restoreDatabase,
    sourceCurrentDatabase: psql(
      resources,
      sourceDatabase,
      DISPOSABLE_ADMIN_ROLE,
      "SELECT current_database()",
      evidence,
    ),
    restoreCurrentDatabase: psql(
      resources,
      restoreDatabase,
      DISPOSABLE_ADMIN_ROLE,
      "SELECT current_database()",
      evidence,
    ),
    capturedKey: probeKey,
    capturedValue: evidence.backupProbeValue ?? "",
    sourceKey: settingText(resources, sourceDatabase, probeKey, "key", evidence),
    sourceValue: settingText(resources, sourceDatabase, probeKey, "value::text", evidence),
    restoredKey: settingText(resources, restoreDatabase, probeKey, "key", evidence),
    restoredValue: settingText(resources, restoreDatabase, probeKey, "value::text", evidence),
    sourceP1: p1Marker(resources, sourceDatabase, evidence),
    restoredP1: p1Marker(resources, restoreDatabase, evidence),
  });
  if (!probe.ok) {
    evidence.restoreProbeMatched = false;
    throw new Stop("E", probe.code, "business record did not match");
  }
  evidence.restoreMatched = true;
  evidence.restoreProbeMatched = true;
}

function settingText(
  resources: RehearsalResources,
  databaseName: string,
  key: string,
  column: "key" | "value::text",
  evidence: Evidence,
): string {
  return psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    `SELECT COALESCE((SELECT ${column} FROM public."Setting" WHERE key = '${key}'), '')`,
    evidence,
  );
}

function verifyPrerequisites(
  resources: RehearsalResources,
  databaseName: string,
  migrationRoot: string,
  evidence: Evidence,
): void {
  const entrypoint = docker(
    ["image", "inspect", "--format", "{{json .Config.Entrypoint}}", evidence.imageTag],
    evidence.secrets,
  );
  if (entrypoint !== '["./docker-entrypoint-app-only.sh"]')
    throw new Stop("F", "IMAGE_PREREQUISITE_FAILED");
  const sqlPath = path.join(
    migrationRoot,
    "prisma",
    "migrations",
    P1_MIGRATION_NAME,
    "migration.sql",
  );
  const digest = createHash("sha256").update(fs.readFileSync(sqlPath)).digest("hex");
  if (digest !== P1_SHA256) throw new Stop("F", "P1_CHECKSUM_MISMATCH");
  const raw = psql(resources, databaseName, MIGRATOR_ROLE, migratorPrivilegeSql(), evidence);
  const decision = evaluateMigratorPrivileges(parseMigratorPrivilegeReport(JSON.parse(raw)), {
    migratorRole: MIGRATOR_ROLE,
    bootstrapRole: DISPOSABLE_ADMIN_ROLE,
  });
  if (!decision.ok) throw new Stop("F", decision.code);
}

function applyPinnedP1(
  evidence: Evidence,
  resources: RehearsalResources,
  marker: string,
  databaseUrl: string,
  migrationRoot: string,
  ambiguous: boolean,
): void {
  if (fs.existsSync(marker)) throw new Stop("G", "AMBIGUOUS_COMPLETION");
  fs.writeFileSync(marker, `MIGRATION_UNCERTAIN\n${evidence.runId}\n`, { flag: "wx" });
  if (ambiguous) {
    evidence.migrateSpawns += 1;
    const killed = startMigrateContainer(evidence, resources, databaseUrl, migrationRoot);
    spawnSync("docker", ["kill", "-s", "KILL", killed.id], {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    spawnSync("docker", ["wait", killed.id], {
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    });
    throw new Stop("G", "MIGRATION_UNCERTAIN");
  }
  evidence.migrateSpawns += 1;
  const child = migrateChild(
    evidence,
    resources,
    `p1as-p1-${evidence.runId}`,
    databaseUrl,
    migrationRoot,
    true,
  );
  if (child.signal || child.status === null) throw new Stop("G", "MIGRATION_UNCERTAIN");
  if (child.status !== 0)
    throw new Stop(
      "G",
      "MIGRATION_FAILED_NO_RETRY",
      redact((child.stderr || child.stdout).slice(-500), evidence.secrets),
    );
  evidence.p1Marker = p1Marker(resources, evidence.target.databaseName, evidence);
  if (
    !evidence.p1Marker.startsWith(`${P1_MIGRATION_NAME}|${P1_SHA256}|`) ||
    !evidence.p1Marker.endsWith("|1")
  ) {
    throw new Stop("G", "MIGRATION_UNCERTAIN");
  }
  fs.rmSync(marker, { force: true });
  evidence.markerPath = null;
}

function verifyAppliedSchema(
  resources: RehearsalResources,
  databaseName: string,
  evidence: Evidence,
): void {
  const count = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    `SELECT count(*)::text FROM public."_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count = 1`,
    evidence,
  );
  if (count !== String(EXPECTED_MIGRATION_SQL_COUNT)) throw new Stop("H", "SCHEMA_NOT_READY");
  const present = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    "SELECT (to_regprocedure('public.batch_creation_command_provenance_guard()') IS NOT NULL)::text",
    evidence,
  );
  if (present !== "true") throw new Stop("H", "SCHEMA_NOT_READY");
  const publicExecute = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    "SELECT has_function_privilege('public', 'public.batch_creation_command_provenance_guard()', 'EXECUTE')::text",
    evidence,
  );
  const appExecute = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    `SELECT has_function_privilege('${DISPOSABLE_APP_ROLE}', 'public.batch_creation_command_provenance_guard()', 'EXECUTE')::text`,
    evidence,
  );
  if (publicExecute !== "false" || appExecute !== "true") throw new Stop("H", "SCHEMA_NOT_READY");
}

function startApplication(
  evidence: Evidence,
  resources: RehearsalResources,
  databaseUrl: string,
  sessionSecret: string,
): void {
  const name = namesFor(evidence.runId).application;
  const id = docker(
    [
      "run",
      "-d",
      "--pull",
      "never",
      "--restart",
      "no",
      "--name",
      name,
      "--network",
      namesFor(evidence.runId).network,
      "--label",
      `${LABEL}=${evidence.runId}`,
      "-e",
      `DATABASE_URL=${databaseUrl}`,
      "-e",
      `SESSION_SECRET=${sessionSecret}`,
      "-e",
      "PORT=3000",
      evidence.imageTag,
    ],
    evidence.secrets,
  );
  resources.application = { id, name, imageId: evidence.appImage };
  const entry = docker(
    ["inspect", "--format", "{{json .Config.Entrypoint}}", id],
    evidence.secrets,
  );
  if (entry !== '["./docker-entrypoint-app-only.sh"]') throw new Stop("I", "APP_ROLE_REFUSED");
  evidence.appLogin = docker(
    [
      "exec",
      id,
      "node",
      "-e",
      "const u=new URL(process.env.DATABASE_URL||''); if(!u.username) process.exit(2); process.stdout.write(u.username)",
    ],
    evidence.secrets,
  );
  if (evidence.appLogin !== DISPOSABLE_APP_ROLE) throw new Stop("I", "APP_ROLE_REFUSED");
}

function restartAndConfirm(
  evidence: Evidence,
  resources: RehearsalResources,
  databaseName: string,
): void {
  const application = resources.application;
  if (application === null) throw new Stop("K", "RESTART_NOT_OWNED");
  const beforeHistory = historyMarker(resources, databaseName, evidence);
  const beforeP1 = p1Marker(resources, databaseName, evidence);
  const ready = confirmOwnedContainer(releaseInput(resources), application, realWorld());
  if (!ready.ok) throw new Stop("K", "RESTART_NOT_OWNED", ready.reason);
  docker(["restart", application.id], evidence.secrets);
  waitHealth(application.name, evidence);
  if (
    historyMarker(resources, databaseName, evidence) !== beforeHistory ||
    p1Marker(resources, databaseName, evidence) !== beforeP1
  ) {
    throw new Stop("K", "RESTART_MIGRATED");
  }
  const logs = containerLogs(application.name, evidence);
  if (
    /prisma\s+migrate\s+deploy|Applying migration|prisma\s+db\s+push|prisma\s+migrate\s+reset/.test(
      logs,
    )
  ) {
    throw new Stop("K", "RESTART_MIGRATED");
  }
}

function runBusinessDml(
  evidence: Evidence,
  resources: RehearsalResources,
  databaseUrl: string,
): void {
  const script = [
    'const {PrismaClient}=require("@prisma/client");',
    "const prisma=new PrismaClient();",
    "const key='p1rr_'+process.env.P1RR_KEY;",
    'prisma.$queryRawUnsafe("SELECT current_user AS name").then((rows)=>{',
    `if(!rows[0]||rows[0].name!=='${DISPOSABLE_APP_ROLE}') throw new Error('LOGIN');`,
    "return prisma.setting.create({data:{key,value:{probe:true}}});",
    "}).then(()=>prisma.setting.findUnique({where:{key}})).then((row)=>{",
    "if(!row) throw new Error('READ_FAILED');",
    "return prisma.setting.update({where:{key},data:{value:{probe:false}}});",
    "}).then(()=>prisma.setting.delete({where:{key}})).then(()=>prisma.setting.findUnique({where:{key}})).then((left)=>{",
    "if(left) throw new Error('DELETE_FAILED');",
    "process.stdout.write('DML ok');",
    "return prisma.$disconnect();",
    "}).catch((error)=>{process.stderr.write(error instanceof Error?error.message:'DML_FAILED'); process.exit(1);});",
  ].join("");
  const child = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      namesFor(evidence.runId).network,
      "--label",
      `${LABEL}=${evidence.runId}`,
      "--name",
      `p1as-dml-${evidence.runId}`,
      "--entrypoint",
      "node",
      "-e",
      `DATABASE_URL=${databaseUrl}`,
      "-e",
      `P1RR_KEY=${evidence.runId}`,
      evidence.imageTag,
      "-e",
      script,
    ],
    { encoding: "utf8", timeout: 180_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
  );
  if (child.status !== 0 || !child.stdout.includes("DML ok")) {
    throw new Stop(
      "J",
      "BUSINESS_DML_FAILED",
      redact((child.stderr || child.stdout).slice(-400), evidence.secrets),
    );
  }
  const left = psql(
    resources,
    evidence.target.databaseName,
    DISPOSABLE_ADMIN_ROLE,
    `SELECT count(*)::text FROM public."Setting" WHERE key = 'p1rr_${evidence.runId}'`,
    evidence,
  );
  if (left !== "0") throw new Stop("J", "BUSINESS_DML_FAILED");
}

function runMigrate(
  evidence: Evidence,
  resources: RehearsalResources,
  name: string,
  migrationRoot: string,
  databaseUrl: string,
): void {
  const marker = path.join(migrationRoot, `${name}.ambiguous-stop`);
  if (fs.existsSync(marker)) throw new Stop(evidence.stage, "AMBIGUOUS_COMPLETION");
  fs.writeFileSync(marker, `MIGRATION_UNCERTAIN\n${evidence.runId}\n`, { flag: "wx" });
  const child = migrateChild(evidence, resources, name, databaseUrl, migrationRoot, true);
  if (child.signal || child.status === null) throw new Stop(evidence.stage, "MIGRATION_UNCERTAIN");
  if (child.status !== 0)
    throw new Stop(
      evidence.stage,
      "MIGRATION_FAILED_NO_RETRY",
      redact((child.stderr || child.stdout).slice(-500), evidence.secrets),
    );
  fs.rmSync(marker, { force: true });
}

function migrateChild(
  evidence: Evidence,
  resources: RehearsalResources,
  name: string,
  databaseUrl: string,
  migrationRoot: string,
  remove: boolean,
): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  const args = [
    "run",
    ...(remove ? ["--rm"] : []),
    "--pull",
    "never",
    "--network",
    namesFor(evidence.runId).network,
    "--label",
    `${LABEL}=${evidence.runId}`,
    "--name",
    name,
    "--entrypoint",
    "npx",
    "-e",
    `DATABASE_URL=${databaseUrl}`,
    "--mount",
    `type=bind,source=${migrationRoot.replace(/\\/g, "/")},target=/fixture,readonly`,
    evidence.imageTag,
    "prisma",
    "migrate",
    "deploy",
    "--schema",
    "/fixture/prisma/schema.prisma",
  ];
  const child = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (!remove && /^[0-9a-f]{64}$/.test(child.stdout.trim())) {
    resources.extraContainers.push({ id: child.stdout.trim(), name, imageId: evidence.appImage });
  }
  return {
    status: child.status,
    signal: child.signal,
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

function startMigrateContainer(
  evidence: Evidence,
  resources: RehearsalResources,
  databaseUrl: string,
  migrationRoot: string,
): OwnedContainer {
  const name = `p1as-p1-${evidence.runId}`;
  const id = docker(
    [
      "run",
      "-d",
      "--pull",
      "never",
      "--network",
      namesFor(evidence.runId).network,
      "--label",
      `${LABEL}=${evidence.runId}`,
      "--name",
      name,
      "--entrypoint",
      "npx",
      "-e",
      `DATABASE_URL=${databaseUrl}`,
      "--mount",
      `type=bind,source=${migrationRoot.replace(/\\/g, "/")},target=/fixture,readonly`,
      evidence.imageTag,
      "prisma",
      "migrate",
      "deploy",
      "--schema",
      "/fixture/prisma/schema.prisma",
    ],
    evidence.secrets,
  );
  const container = { id, name, imageId: evidence.appImage };
  resources.extraContainers.push(container);
  return container;
}

function resolveImage(options: RehearsalOptions, evidence: Evidence): { tag: string; id: string } {
  if (options.applicationImageTag !== undefined) {
    if (!IMAGE_TAG.test(options.applicationImageTag)) throw new Stop("C", "UNSUPPORTED_IDENTITY");
    return inspectAppImage(options.applicationImageTag, evidence.secrets);
  }
  return buildRehearsalImage(evidence.runId);
}

function inspectAppImage(tag: string, secrets: readonly string[]): { tag: string; id: string } {
  const id = docker(["image", "inspect", "--format", "{{.Id}}", tag], secrets);
  const entrypoint = docker(
    ["image", "inspect", "--format", "{{json .Config.Entrypoint}}", tag],
    secrets,
  );
  if (!id.startsWith("sha256:") || entrypoint !== '["./docker-entrypoint-app-only.sh"]') {
    throw new Stop("C", "IMAGE_PREREQUISITE_FAILED");
  }
  return { tag, id };
}

function materializeMigrations(): string {
  const destination = fs.mkdtempSync(path.join(process.cwd(), ".p1rr-migrate-"));
  const listed = spawnSync("git", ["ls-files", "prisma/schema.prisma", "prisma/migrations"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (listed.status !== 0) throw new Stop("C", "MIGRATION_SET_UNREADABLE");
  for (const relative of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    const migrationName = relative.split("/")[2] ?? "";
    if (isMigrationAfterPinnedP1(migrationName)) continue;
    const shown = spawnSync("git", ["show", `HEAD:${relative}`], {
      encoding: "buffer",
      windowsHide: true,
    });
    if (shown.status !== 0) throw new Stop("C", "MIGRATION_SET_UNREADABLE");
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, shown.stdout);
  }
  return destination;
}

function holdP1(migrationRoot: string): string {
  const source = path.join(migrationRoot, "prisma", "migrations", P1_MIGRATION_NAME);
  const held = path.join(migrationRoot, "p1-held");
  fs.renameSync(source, held);
  return held;
}

function revealP1(held: string, destination: string): void {
  fs.renameSync(held, destination);
}

function historyMarker(
  resources: RehearsalResources,
  databaseName: string,
  evidence: Evidence,
): string {
  const exists = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    "SELECT (to_regclass('public._prisma_migrations') IS NOT NULL)::text",
    evidence,
  );
  if (exists !== "true") return "ABSENT";
  return psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    `SELECT migration_name || '|' || checksum || '|' || COALESCE(finished_at::text,'') || '|' || COALESCE(rolled_back_at::text,'') || '|' || applied_steps_count::text FROM public."_prisma_migrations" ORDER BY migration_name`,
    evidence,
  );
}

function p1Marker(resources: RehearsalResources, databaseName: string, evidence: Evidence): string {
  const row = psql(
    resources,
    databaseName,
    DISPOSABLE_ADMIN_ROLE,
    `SELECT migration_name || '|' || checksum || '|' || COALESCE(finished_at::text,'') || '|' || applied_steps_count::text FROM public."_prisma_migrations" WHERE migration_name = '${P1_MIGRATION_NAME}'`,
    evidence,
  );
  return row.length === 0 ? "ABSENT" : row;
}

function markerPath(migrationRoot: string): string {
  return path.join(migrationRoot, ".ambiguous-stop");
}

function refuseAmbiguousRetry(marker: string): void {
  if (path.basename(marker) !== ".ambiguous-stop") throw new Stop("G", "AMBIGUOUS_IDENTITY");
  let text = "";
  try {
    text = fs.readFileSync(marker, "utf8");
  } catch {
    throw new Stop("G", "AMBIGUOUS_IDENTITY");
  }
  const [banner, runId] = text.split(/\r?\n/);
  if (banner !== "MIGRATION_UNCERTAIN" || !/^[0-9a-f]{8}$/.test(runId ?? ""))
    throw new Stop("G", "AMBIGUOUS_IDENTITY");
}

function namesFor(runId: string): {
  database: string;
  application: string;
  network: string;
  volume: string;
} {
  return {
    database: `p1as-db-${runId}`,
    application: `p1as-app-${runId}`,
    network: `p1as-net-${runId}`,
    volume: `p1as-vol-${runId}`,
  };
}

function releaseInput(resources: RehearsalResources): AppOnlyRelease {
  return {
    binding: resources.binding ?? { endpoint: "", daemonId: "", runId: resources.runId },
    labelKey: LABEL,
    database: resources.database,
    application: resources.application,
    volume: resources.volume,
    network: resources.network,
    image: resources.image,
  };
}

function ensurePostgresImage(secrets: readonly string[]): void {
  const present = spawnSync(
    "docker",
    ["image", "inspect", "--format", "{{.Id}}", "postgres:17-alpine"],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  if (present.status === 0 && present.stdout.trim().startsWith("sha256:")) return;
  const pulled = spawnSync("docker", ["pull", "postgres:17-alpine"], {
    encoding: "utf8",
    timeout: 300_000,
    windowsHide: true,
  });
  if (pulled.status !== 0)
    throw new Stop(
      "A",
      "UNSUPPORTED_IDENTITY",
      redact(pulled.stderr || pulled.stdout || "", secrets),
    );
}

function waitReady(resources: RehearsalResources, databaseName: string): void {
  const container = resources.database?.name ?? "";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const child = spawnSync(
      "docker",
      [
        "exec",
        container,
        "psql",
        "-U",
        DISPOSABLE_ADMIN_ROLE,
        "-d",
        databaseName,
        "-At",
        "-c",
        "SELECT 1",
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      },
    );
    if (child.status === 0 && child.stdout.trim() === "1") return;
    sleep();
  }
  throw new Stop("A", "DATABASE_NOT_READY");
}

function waitHealth(container: string, evidence: Evidence): string {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const child = spawnSync(
      "docker",
      [
        "exec",
        container,
        "node",
        "-e",
        "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      },
    );
    if (child.status === 0) return "200";
    const state = spawnSync("docker", ["inspect", "--format", "{{.State.Status}}", container], {
      encoding: "utf8",
      timeout: 15_000,
      windowsHide: true,
    });
    if (state.stdout.trim() === "exited") break;
    sleep();
  }
  throw new Stop(
    "J",
    "HEALTH_FAILED",
    redact(containerLogs(container, evidence).slice(-400), evidence.secrets),
  );
}

function psql(
  resources: RehearsalResources,
  databaseName: string,
  user: string,
  sql: string,
  evidence: Evidence,
): string {
  let result = psqlRaw(resources, databaseName, user, sql);
  for (
    let attempt = 0;
    attempt < 4 && result.status !== 0 && transientSql(result.stderr);
    attempt += 1
  ) {
    sleep();
    result = psqlRaw(resources, databaseName, user, sql);
  }
  if (result.status !== 0)
    throw new Stop(
      evidence.stage,
      "SQL_FAILED",
      redact((result.stderr || result.stdout).slice(0, 400), evidence.secrets),
    );
  return result.stdout.trim();
}

function transientSql(stderr: string): boolean {
  return /starting up|could not connect|Connection refused|server closed the connection|ETIMEDOUT|timed out/i.test(
    stderr,
  );
}

function psqlRaw(
  resources: RehearsalResources,
  databaseName: string,
  user: string,
  sql: string | Buffer,
): { status: number; stdout: string; stderr: string } {
  if (!DATABASE_NAME.test(databaseName))
    return { status: 1, stdout: "", stderr: "database name is not disposable" };
  const container = resources.database?.id ?? "";
  if (!/^[0-9a-f]{64}$/.test(container))
    return { status: 1, stdout: "", stderr: "database container is not owned" };
  const child = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      user,
      "-d",
      databaseName,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    {
      input: sql,
      encoding: "utf8",
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    },
  );
  return {
    status: child.status ?? 1,
    stdout: child.stdout ?? "",
    stderr: child.stderr || child.error?.message || "",
  };
}

function containerLogs(container: string, evidence: Evidence): string {
  const child = spawnSync("docker", ["logs", container], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  if (child.status !== 0)
    throw new Stop(
      evidence.stage,
      "LOG_UNREADABLE",
      redact((child.stderr || child.stdout || "").slice(-400), evidence.secrets),
    );
  return `${child.stdout}\n${child.stderr}`;
}

function docker(args: readonly string[], secrets: readonly string[]): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p1rr-docker-"));
  const stdoutPath = path.join(directory, "stdout");
  const stderrPath = path.join(directory, "stderr");
  const stdoutFd = fs.openSync(stdoutPath, "w");
  const stderrFd = fs.openSync(stderrPath, "w");
  try {
    const child = spawnSync("docker", [...args], {
      stdio: ["ignore", stdoutFd, stderrFd],
      windowsHide: true,
      timeout: 1_200_000,
    });
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    const stdout = fs.readFileSync(stdoutPath, "utf8");
    const stderr = fs.readFileSync(stderrPath, "utf8");
    if (child.status !== 0) {
      throw new Error(
        redact(
          `${args[0] ?? "docker"} failed: ${(stderr || stdout || child.error?.message || "").slice(-800)}`,
          secrets,
        ),
      );
    }
    return stdout.trim();
  } finally {
    try {
      fs.closeSync(stdoutFd);
    } catch {
      /* already closed */
    }
    try {
      fs.closeSync(stderrFd);
    } catch {
      /* already closed */
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function stripSchemaBootstrap(sql: Buffer): Buffer {
  const filtered = sql
    .toString("utf8")
    .split("\n")
    .filter(
      (line) =>
        !/^CREATE SCHEMA public;\s*$/.test(line) &&
        !/^DROP SCHEMA (IF EXISTS )?public\b.*;\s*$/.test(line),
    )
    .join("\n");
  return Buffer.from(filtered);
}

function redactedError(error: unknown, secrets: readonly string[]): string {
  const text = error instanceof Error ? error.message : "unexpected rehearsal failure";
  return redact(text, secrets).slice(0, 500);
}

function appUrl(password: string, databaseName: string): string {
  return `postgresql://${DISPOSABLE_APP_ROLE}:${password}@db:5432/${databaseName}?schema=public`;
}

function migratorUrl(password: string, databaseName: string): string {
  return `postgresql://${MIGRATOR_ROLE}:${password}@db:5432/${databaseName}?schema=public`;
}

function sleep(): void {
  spawnSync(
    process.execPath,
    ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);"],
    { windowsHide: true },
  );
}
