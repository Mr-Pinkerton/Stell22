import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import { P1_MIGRATION_NAME, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import {
  defaultOriginRuntime,
  resolveLocalDockerEndpoint,
} from "@/server/internal/p1-isolated-runner/container-origin";
import { releaseAppOnly } from "@/server/internal/p1-app-only-startup/cleanup";
import {
  DISPOSABLE_ADMIN_ROLE,
  DISPOSABLE_APP_ROLE,
} from "@/server/internal/p1-role-split-disposable/topology";
import { realWorld } from "@/server/internal/p1-write-freeze-historical/runtime";
import {
  BACKUP_PROBE_VALUE,
  buildRehearsalImage,
  finishRehearsal,
  releaseRehearsalResources,
  runDisposableReleaseRehearsal,
  type RehearsalRun,
} from "@/server/internal/p1-disposable-release/rehearsal";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const buildId = randomBytes(4).toString("hex");
let imageTag = "";
let imageId = "";

describe.skipIf(!LIVE)("disposable release rehearsal on PostgreSQL 17", () => {
  afterAll(() => {
    if (!imageId.startsWith("sha256:") || !/^p1as-app:[0-9a-f]{8}$/.test(imageTag)) return;
    const daemon = spawnSync("docker", ["info", "--format", "{{.ID}}"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (daemon.status !== 0) return;
    releaseAppOnly(
      {
        binding: {
          endpoint: resolveLocalDockerEndpoint(defaultOriginRuntime()),
          daemonId: daemon.stdout.trim(),
          runId: buildId,
        },
        labelKey: "stell22.p1.disposable-release",
        database: null,
        application: null,
        volume: null,
        network: null,
        image: { tag: imageTag, id: imageId },
      },
      realWorld(),
    );
  }, 120_000);

  it("refuses a production database name before creating a container or applying P1", () => {
    const outcome = runDisposableReleaseRehearsal({ testFault: "production-database-name" });
    expect(outcome.report.failure).toMatchObject({
      stage: "A",
      code: "PRODUCTION_DATABASE_REFUSED",
    });
    expect(outcome.report.migrateSpawns).toBe(0);
    expect(outcome.report.databaseRollbackPerformed).toBe(false);
    expect(outcome.resources.database).toBeNull();
    expect(outcome.report.productionRelease).toBe("NO-GO");
    expect(outcome.report.freezePass).toBe("FORBIDDEN");
    finishRehearsal(outcome.resources);
  }, 120_000);

  it("refuses a superuser application role before P1", () => {
    const outcome = runDisposableReleaseRehearsal({ testFault: "superuser-app" });
    try {
      expect(outcome.report.failure).toMatchObject({ stage: "B", code: "ROLE_PRIVILEGE_REFUSED" });
      expect(outcome.report.migrateSpawns).toBe(0);
      expect(outcome.report.stages.find((stage) => stage.id === "G")?.result).toBe("NOT_RUN");
      expect(
        query(outcome, "SELECT rolsuper::text FROM pg_roles WHERE rolname = 'stell22_app'"),
      ).toBe("true");
      expect(
        query(outcome, "SELECT (to_regclass('public._prisma_migrations') IS NULL)::text"),
      ).toBe("true");
      expect(outcome.report.serverVersion?.startsWith("17")).toBe(true);
    } finally {
      finishRehearsal(outcome.resources);
    }
  }, 180_000);

  it("stops before P1 when migration history has a failed or pending row", () => {
    const image = sharedImage();
    const failed = runDisposableReleaseRehearsal({
      testFault: "failed-history",
      applicationImageTag: image,
    });
    try {
      expect(failed.report.failure).toMatchObject({ stage: "C", code: "FAILED_MIGRATION" });
      expect(failed.report.migrateSpawns).toBe(0);
      expect(failed.report.stages.find((stage) => stage.id === "G")?.result).toBe("NOT_RUN");
      expect(p1Absent(failed)).toBe(true);
      expect(
        query(
          failed,
          `SELECT (finished_at IS NULL)::text FROM public."_prisma_migrations" WHERE migration_name = '20260629154204_init'`,
        ),
      ).toBe("true");
    } finally {
      finishRehearsal(failed.resources);
    }
    const pending = runDisposableReleaseRehearsal({
      testFault: "pending-history",
      applicationImageTag: image,
    });
    try {
      expect(pending.report.failure).toMatchObject({ stage: "C", code: "PENDING_MIGRATION" });
      expect(pending.report.migrateSpawns).toBe(0);
      expect(p1Absent(pending)).toBe(true);
    } finally {
      finishRehearsal(pending.resources);
    }
  }, 900_000);

  it("stops before P1 when the backup cannot be restored", () => {
    const outcome = runDisposableReleaseRehearsal({
      testFault: "corrupt-backup",
      applicationImageTag: sharedImage(),
    });
    try {
      expect(outcome.report.failure).toMatchObject({
        stage: "E",
        code: "RESTORE_VERIFICATION_FAILED",
      });
      expect(outcome.report.failure?.nextAction).toMatch(
        /Do not restore an archive over the source/,
      );
      expect(outcome.report.migrateSpawns).toBe(0);
      expect(outcome.report.databaseRollbackPerformed).toBe(false);
      expect(outcome.report.stages.find((stage) => stage.id === "D")?.result).toBe("PASS");
      expect(outcome.report.stages.find((stage) => stage.id === "G")?.result).toBe("NOT_RUN");
      expect(p1Absent(outcome)).toBe(true);
      expect(history(outcome)).toBe(outcome.report.sourceHistoryMarker);
      expect(probeValue(outcome, outcome.report.databaseName)).toBe(BACKUP_PROBE_VALUE);
    } finally {
      finishRehearsal(outcome.resources);
    }
  }, 600_000);

  it("stops before P1 when the restored business record is missing or changed", () => {
    const image = sharedImage();
    for (const fault of ["missing-restore-business", "changed-restore-business"] as const) {
      const outcome = runDisposableReleaseRehearsal({
        testFault: fault,
        applicationImageTag: image,
      });
      try {
        expect(outcome.report.failure).toMatchObject({
          stage: "E",
          code: "RESTORE_VERIFICATION_FAILED",
        });
        expect(outcome.report.stages.find((stage) => stage.id === "G")?.result).toBe("NOT_RUN");
        expect(outcome.report.migrateSpawns).toBe(0);
        expect(outcome.report.restoreProbeMatched).toBe(false);
        expect(p1Absent(outcome)).toBe(true);
        expect(probeValue(outcome, outcome.report.databaseName)).toBe(BACKUP_PROBE_VALUE);
        const restored = probeValue(outcome, outcome.report.restoreDatabaseName ?? "");
        expect(restored).not.toBe(BACKUP_PROBE_VALUE);
        expect(outcome.report.databaseName).not.toBe(outcome.report.restoreDatabaseName);
      } finally {
        finishRehearsal(outcome.resources);
      }
    }
  }, 900_000);

  it("does not retry an ambiguous P1 execution or restore over that database", () => {
    const first = runDisposableReleaseRehearsal({
      testFault: "ambiguous-p1",
      applicationImageTag: sharedImage(),
    });
    try {
      expect(first.report.failure).toMatchObject({ stage: "G", code: "MIGRATION_UNCERTAIN" });
      expect(first.report.migrateSpawns).toBe(1);
      expect(first.report.retryAttempted).toBe(false);
      expect(first.report.automaticRetry).toBe(false);
      expect(first.report.databaseRollbackPerformed).toBe(false);
      expect(first.report.applicationRollbackRollsBackSchema).toBe(false);
      expect(first.report.failure?.nextAction).toMatch(/Do not retry/);
      expect(first.report.failure?.nextAction).toMatch(/would not roll back the database schema/);
      expect(first.resources.preserveDatabase).toBe(true);
      const name = `p1as-p1-${first.report.runId}`;
      const listed = spawnSync("docker", ["ps", "-aq", "--filter", `name=${name}`], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(listed.stdout.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
      const marker = first.report.markerPath;
      expect(marker).toMatch(/\.ambiguous-stop$/);
      const second = runDisposableReleaseRehearsal({ resumeMarkerPath: marker ?? "" });
      expect(second.report.failure).toMatchObject({ stage: "G", code: "AMBIGUOUS_COMPLETION" });
      expect(second.report.migrateSpawns).toBe(0);
      expect(second.report.retryAttempted).toBe(false);
      expect(second.resources.database).toBeNull();
      const again = spawnSync("docker", ["ps", "-aq", "--filter", `name=${name}`], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(again.stdout.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
      expect(query(first, "SELECT current_database()")).toBe(first.report.databaseName);
      const cleanup = releaseRehearsalResources(first.resources, realWorld());
      expect(cleanup.status).toBe("COMPLETE");
      expect(cleanup.failures).toEqual([]);
      expect(cleanup.removed).not.toContain(first.resources.database?.name);
      expect(cleanup.preserved).toContainEqual({
        resource: first.resources.database?.name,
        reason: "INTENTIONAL_PRESERVATION",
      });
      expect(cleanup.preserved).toContainEqual({
        resource: name,
        reason: "INTENTIONAL_PRESERVATION",
      });
      const kept = spawnSync("docker", ["ps", "-aq", "--filter", `name=${name}`], {
        encoding: "utf8",
        windowsHide: true,
      });
      expect(kept.stdout.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1);
    } finally {
      first.resources.preserveDatabase = false;
      finishRehearsal(first.resources);
    }
  }, 600_000);

  it("completes the rehearsal with a restricted application and an unchanged history after restart", () => {
    const outcome = runDisposableReleaseRehearsal({ applicationImageTag: sharedImage() });
    try {
      expect(outcome.report.failure).toBeNull();
      expect(outcome.report.stages.every((stage) => stage.result === "PASS")).toBe(true);
      expect(outcome.report.productionRelease).toBe("NO-GO");
      expect(outcome.report.freezePass).toBe("FORBIDDEN");
      expect(outcome.report.unauthorizedWritersExcluded).toBe("NOT_VERIFIED");
      expect(outcome.report.productionWriterExclusionProven).toBe(false);
      expect(outcome.report.databaseRollbackPerformed).toBe(false);
      expect(outcome.report.applicationRollbackRollsBackSchema).toBe(false);
      expect(outcome.report.retryAttempted).toBe(false);
      expect(outcome.report.health).toBe("200");
      expect(outcome.report.appLogin).toBe(DISPOSABLE_APP_ROLE);
      expect(outcome.report.serverVersion?.startsWith("17")).toBe(true);
      expect(outcome.report.restoreMatched).toBe(true);
      expect(outcome.report.p1Marker?.startsWith(`${P1_MIGRATION_NAME}|${P1_SHA256}|`)).toBe(true);
      expect(outcome.report.p1Marker?.endsWith("|1")).toBe(true);
      const app = outcome.resources.application?.name ?? "";
      const health = spawnSync(
        "docker",
        [
          "exec",
          app,
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        {
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
        },
      );
      expect(health.status).toBe(0);
      const login = spawnSync(
        "docker",
        [
          "exec",
          app,
          "node",
          "-e",
          "process.stdout.write(new URL(process.env.DATABASE_URL||'').username)",
        ],
        {
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
        },
      );
      expect(login.stdout).toBe(DISPOSABLE_APP_ROLE);
      expect(history(outcome)).toContain(`${P1_MIGRATION_NAME}|${P1_SHA256}|`);
      const logs = spawnSync("docker", ["logs", app], {
        encoding: "utf8",
        timeout: 20_000,
        windowsHide: true,
      });
      expect(`${logs.stdout}\n${logs.stderr}`).not.toMatch(/prisma\s+migrate\s+deploy/);
      expect(outcome.report.backupProbeKey).toBe(`p1rr_backup_${outcome.report.runId}`);
      expect(outcome.report.backupProbeValue).toBe(BACKUP_PROBE_VALUE);
      expect(outcome.report.restoreProbeMatched).toBe(true);
      expect(outcome.report.databaseName).not.toBe(outcome.report.restoreDatabaseName);
      expect(probeValue(outcome, outcome.report.databaseName)).toBe(BACKUP_PROBE_VALUE);
      expect(probeValue(outcome, outcome.report.restoreDatabaseName ?? "")).toBe(
        BACKUP_PROBE_VALUE,
      );
      expect(queryDatabase(outcome, outcome.report.databaseName, "SELECT current_database()")).toBe(
        outcome.report.databaseName,
      );
      expect(
        queryDatabase(
          outcome,
          outcome.report.restoreDatabaseName ?? "",
          "SELECT current_database()",
        ),
      ).toBe(outcome.report.restoreDatabaseName);
    } finally {
      finishRehearsal(outcome.resources);
    }
  }, 900_000);
});

function sharedImage(): string {
  if (imageTag.length > 0) return imageTag;
  const built = buildRehearsalImage(buildId);
  imageTag = built.tag;
  imageId = built.id;
  return imageTag;
}

function probeValue(outcome: RehearsalRun, database: string): string {
  const key = outcome.report.backupProbeKey ?? "";
  return queryDatabase(
    outcome,
    database,
    `SELECT COALESCE((SELECT value::text FROM public."Setting" WHERE key = '${key}'), '')`,
  );
}

function query(outcome: RehearsalRun, sql: string): string {
  return queryDatabase(outcome, outcome.report.databaseName, sql);
}

function queryDatabase(outcome: RehearsalRun, database: string, sql: string): string {
  const container = outcome.resources.database?.id ?? "";
  expect(database).toMatch(/^p1as_[0-9a-f]{8}$/);
  expect(database).not.toBe("stell22");
  const child = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-U",
      DISPOSABLE_ADMIN_ROLE,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    {
      input: sql,
      encoding: "utf8",
      timeout: 60_000,
      windowsHide: true,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  return child.stdout.trim();
}

function history(outcome: RehearsalRun): string {
  return query(
    outcome,
    `SELECT migration_name || '|' || checksum || '|' || COALESCE(finished_at::text,'') || '|' || COALESCE(rolled_back_at::text,'') || '|' || applied_steps_count::text FROM public."_prisma_migrations" ORDER BY migration_name`,
  );
}

function p1Absent(outcome: RehearsalRun): boolean {
  return (
    query(
      outcome,
      `SELECT count(*)::text FROM public."_prisma_migrations" WHERE migration_name = '${P1_MIGRATION_NAME}'`,
    ) === "0"
  );
}
