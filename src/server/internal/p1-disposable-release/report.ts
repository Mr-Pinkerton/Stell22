export const REHEARSAL_MODE = "DISPOSABLE_RELEASE_REHEARSAL" as const;

export const STAGE_NAMES = {
  A: "DISPOSABLE_DATABASE_IDENTITY",
  B: "ROLE_SEPARATION",
  C: "PRE_P1_MIGRATION_HISTORY",
  D: "DATABASE_BACKUP",
  E: "BACKUP_RESTORE_VERIFICATION",
  F: "PREREQUISITES",
  G: "PINNED_P1_APPLY",
  H: "MIGRATION_HISTORY_AND_SCHEMA",
  I: "APP_ONLY_START",
  J: "HEALTH_AND_BUSINESS_DML",
  K: "RESTART_DOES_NOT_MIGRATE",
  L: "RELEASE_REPORT",
} as const;

export type StageId = keyof typeof STAGE_NAMES;

export type StageResult = {
  id: StageId;
  name: (typeof STAGE_NAMES)[StageId];
  result: "PASS" | "FAIL" | "NOT_RUN";
};

export type RehearsalFailure = {
  stage: StageId;
  code: string;
  nextAction: string;
  detail: string | null;
};

export type RehearsalReport = {
  mode: typeof REHEARSAL_MODE;
  scope: "TEST_OWNED";
  productionRelease: "NO-GO";
  freezePass: "FORBIDDEN";
  unauthorizedWritersExcluded: "NOT_VERIFIED";
  productionWriterExclusionProven: false;
  databaseRollbackPerformed: false;
  applicationRollbackRollsBackSchema: false;
  automaticRetry: false;
  retryAttempted: false;
  migrateSpawns: number;
  runId: string;
  databaseName: string;
  restoreDatabaseName: string | null;
  databaseContainerName: string | null;
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
  stages: StageResult[];
  failure: RehearsalFailure | null;
};

export type RehearsalCleanup = {
  removed: string[];
  preserved: Array<{ resource: string; reason: string }>;
  failures: Array<{ resource: string; reason: string }>;
  status: "COMPLETE" | "FAILED";
};

export type PublishedRehearsalReport = RehearsalReport & {
  cleanup: RehearsalCleanup;
  commandResult: "SUCCESS" | "REHEARSAL_FAILED" | "CLEANUP_FAILED";
};

const STAGE_ORDER = Object.keys(STAGE_NAMES) as StageId[];

export function failureNextAction(stage: StageId, code: string): string {
  const lead = `Stage ${stage} failed (${code}).`;
  if (
    code === "MIGRATION_UNCERTAIN" ||
    code === "AMBIGUOUS_COMPLETION" ||
    code === "MIGRATION_FAILED_NO_RETRY"
  ) {
    return `${lead} Stop. Do not retry the migration. Do not restore an older database over this one. Application rollback would not roll back the database schema. Inspect this disposable database manually.`;
  }
  if (code === "RESTORE_VERIFICATION_FAILED" || code === "BACKUP_FAILED") {
    return `${lead} Stop before P1. Keep the source database. Do not restore an archive over the source database. Create a new disposable database before any later attempt.`;
  }
  if (
    code === "ROLE_PRIVILEGE_REFUSED" ||
    code === "MIGRATOR_PRIVILEGE_REFUSED" ||
    code.startsWith("MIGRATOR_") ||
    code === "APPLICATION_ROLE_UNBOUND"
  ) {
    return `${lead} Stop before P1. Leave the disposable database in place. Do not grant the application role migration rights. Do not retry the rehearsal against this database.`;
  }
  if (code === "FAILED_MIGRATION" || code === "PENDING_MIGRATION") {
    return `${lead} Stop before P1. Do not repair migration history automatically. Do not apply P1. Do not restore over this database.`;
  }
  if (stage === "H" || stage === "I" || stage === "J" || stage === "K") {
    return `${lead} Stop. The database was not rolled back. Do not restore an older database over the migrated database. Application rollback would not roll back the database schema. Do not retry the migration.`;
  }
  return `${lead} Stop. Do not apply P1. Do not use a production target. Start a new rehearsal only against a new test-owned database.`;
}

export function rehearsalReport(input: {
  runId: string;
  databaseName: string;
  restoreDatabaseName?: string | null;
  databaseContainerName?: string | null;
  serverVersion?: string | null;
  sourceHistoryMarker?: string | null;
  backupProbeKey?: string | null;
  backupProbeValue?: string | null;
  p1Marker?: string | null;
  archiveSha256?: string | null;
  restoreMatched?: boolean | null;
  restoreProbeMatched?: boolean | null;
  health?: string | null;
  appLogin?: string | null;
  markerPath?: string | null;
  migrateSpawns?: number;
  stages: ReadonlyArray<{ id: StageId; result: StageResult["result"] }>;
  failure: { stage: StageId; code: string; detail?: string | null } | null;
}): RehearsalReport {
  const seen = new Map(input.stages.map((stage) => [stage.id, stage.result]));
  return {
    mode: REHEARSAL_MODE,
    scope: "TEST_OWNED",
    productionRelease: "NO-GO",
    freezePass: "FORBIDDEN",
    unauthorizedWritersExcluded: "NOT_VERIFIED",
    productionWriterExclusionProven: false,
    databaseRollbackPerformed: false,
    applicationRollbackRollsBackSchema: false,
    automaticRetry: false,
    retryAttempted: false,
    migrateSpawns: input.migrateSpawns ?? 0,
    runId: input.runId,
    databaseName: input.databaseName,
    restoreDatabaseName: input.restoreDatabaseName ?? null,
    databaseContainerName: input.databaseContainerName ?? null,
    serverVersion: input.serverVersion ?? null,
    sourceHistoryMarker: input.sourceHistoryMarker ?? null,
    backupProbeKey: input.backupProbeKey ?? null,
    backupProbeValue: input.backupProbeValue ?? null,
    p1Marker: input.p1Marker ?? null,
    archiveSha256: input.archiveSha256 ?? null,
    restoreMatched: input.restoreMatched ?? null,
    restoreProbeMatched: input.restoreProbeMatched ?? null,
    health: input.health ?? null,
    appLogin: input.appLogin ?? null,
    markerPath: input.markerPath ?? null,
    stages: STAGE_ORDER.map((id) => ({
      id,
      name: STAGE_NAMES[id],
      result: seen.get(id) ?? (id === "L" && input.failure?.stage !== "L" ? "PASS" : "NOT_RUN"),
    })),
    failure:
      input.failure === null
        ? null
        : {
            stage: input.failure.stage,
            code: input.failure.code,
            nextAction: failureNextAction(input.failure.stage, input.failure.code),
            detail: input.failure.detail ?? null,
          },
  };
}

const EXPECTED_PRESERVATION = new Set(["INTENTIONAL_PRESERVATION", "SHARED_IMAGE"]);

export function classifyCleanup(cleanup: RehearsalCleanup): RehearsalCleanup["status"] {
  if (cleanup.status === "FAILED" || cleanup.failures.length > 0) return "FAILED";
  if (cleanup.preserved.some((item) => !EXPECTED_PRESERVATION.has(item.reason))) return "FAILED";
  return "COMPLETE";
}

export function publishRehearsalReport(
  report: RehearsalReport,
  cleanup: RehearsalCleanup,
): PublishedRehearsalReport {
  const status = classifyCleanup(cleanup);
  const stages =
    report.failure === null && status === "FAILED"
      ? report.stages.map((stage) =>
          stage.id === "L" ? { ...stage, result: "FAIL" as const } : stage,
        )
      : report.stages;
  return {
    ...report,
    stages,
    cleanup: { ...cleanup, status },
    commandResult:
      report.failure !== null
        ? "REHEARSAL_FAILED"
        : status === "FAILED"
          ? "CLEANUP_FAILED"
          : "SUCCESS",
  };
}
