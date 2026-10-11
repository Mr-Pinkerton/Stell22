import {
  EXPECTED_HISTORICAL_MIGRATION_COUNT,
  P1_MIGRATION_NAME,
  type RunnerVerdict,
} from "@/server/internal/p1-isolated-runner/contract";
import { PINNED_MIGRATION_FILES } from "@/server/internal/p1-isolated-runner/inventory";
import {
  classifySchemaShape,
  type P1SchemaEvidence,
} from "@/server/internal/p1-isolated-runner/schema-contract";

export type PrismaMigrationRow = {
  migrationName: string;
  checksum: string;
  startedAt: string | null;
  finishedAt: string | null;
  rolledBackAt: string | null;
  appliedStepsCount: number;
};

export type Classification = {
  verdict: RunnerVerdict;
  code: string;
};

const SQL_FILES = PINNED_MIGRATION_FILES.filter((entry) => entry.path.endsWith("/migration.sql"));

function migrationNameFromPath(path: string): string {
  const name = path.split("/")[2];
  if (!name) {
    throw new Error(`Unpinned migration path ${path}`);
  }
  return name;
}

const CHECKSUM_BY_NAME = new Map(
  SQL_FILES.map((entry) => [migrationNameFromPath(entry.path), entry.sha256]),
);

export const HISTORICAL_MIGRATION_NAMES = SQL_FILES.map((entry) =>
  migrationNameFromPath(entry.path),
).filter((name) => name !== P1_MIGRATION_NAME);

if (HISTORICAL_MIGRATION_NAMES.length !== EXPECTED_HISTORICAL_MIGRATION_COUNT) {
  throw new Error("Historical migration pin does not contain 45 names");
}

export function classifyP1State(input: {
  history: readonly PrismaMigrationRow[];
  schema: P1SchemaEvidence;
  preflight?: { expectedDigest: string; observedDigest: string };
  lockHeldByOther?: boolean;
}): Classification {
  if (input.preflight && input.preflight.expectedDigest !== input.preflight.observedDigest) {
    return { verdict: "STOP", code: "PREFLIGHT_DRIFT" };
  }
  if (input.lockHeldByOther) {
    return { verdict: "BLOCKED", code: "CONCURRENT_EXECUTION" };
  }

  const grouped = new Map<string, PrismaMigrationRow[]>();
  for (const row of input.history) {
    const rows = grouped.get(row.migrationName) ?? [];
    rows.push(row);
    grouped.set(row.migrationName, rows);
  }
  for (const rows of grouped.values()) {
    if (rows.length > 1) {
      return { verdict: "STOP", code: "DUPLICATE_HISTORY_ROW" };
    }
  }
  for (const name of grouped.keys()) {
    if (!CHECKSUM_BY_NAME.has(name)) {
      return { verdict: "STOP", code: "EXTRA_HISTORY_ROW" };
    }
  }
  for (const row of input.history) {
    if (row.checksum !== CHECKSUM_BY_NAME.get(row.migrationName)) {
      return { verdict: "STOP", code: "UNEXPECTED_CHECKSUM" };
    }
  }
  for (const row of input.history) {
    if (isBookkeepingAmbiguous(row)) {
      return { verdict: "BLOCKED", code: "BOOKKEEPING_AMBIGUOUS" };
    }
    if (row.rolledBackAt !== null) {
      return { verdict: "BLOCKED", code: "ROLLED_BACK_MIGRATION" };
    }
    if (isUnfinished(row) && row.migrationName !== P1_MIGRATION_NAME) {
      return { verdict: "BLOCKED", code: "FAILED_MIGRATION" };
    }
  }
  for (const name of HISTORICAL_MIGRATION_NAMES) {
    const row = grouped.get(name)?.[0];
    if (!row || row.finishedAt === null) {
      return { verdict: "STOP", code: "OTHER_PENDING_MIGRATION" };
    }
  }

  const p1 = grouped.get(P1_MIGRATION_NAME)?.[0] ?? null;
  const shape = classifySchemaShape(input.schema);
  if (p1 === null) {
    if (shape === "absent") return { verdict: "READY_FOR_DISPOSABLE_APPLY", code: "P1_ABSENT" };
    if (shape === "partial") return { verdict: "BLOCKED", code: "PARTIAL_OBJECT_SET" };
    if (shape === "altered") return { verdict: "STOP", code: "UNEXPECTED_ALTERATION" };
    return { verdict: "BLOCKED", code: "OBJECTS_WITHOUT_HISTORY" };
  }
  if (isUnfinished(p1)) {
    if (shape === "absent") return { verdict: "BLOCKED", code: "UNFINISHED_WITHOUT_OBJECTS" };
    return { verdict: "BLOCKED", code: "UNFINISHED_WITH_OBJECTS" };
  }
  if (shape === "match") return { verdict: "ALREADY_APPLIED", code: "P1_APPLIED" };
  if (shape === "mismatch") return { verdict: "STOP", code: "OBJECT_CONTRACT_MISMATCH" };
  if (shape === "altered") return { verdict: "STOP", code: "UNEXPECTED_ALTERATION" };
  if (shape === "partial" || shape === "absent") {
    return { verdict: "BLOCKED", code: "FINISHED_WITH_MISSING_OBJECTS" };
  }
  return { verdict: "BLOCKED", code: "PARTIAL_OBJECT_SET" };
}

function isUnfinished(row: PrismaMigrationRow): boolean {
  return row.finishedAt === null && row.rolledBackAt === null;
}

function isBookkeepingAmbiguous(row: PrismaMigrationRow): boolean {
  if (row.startedAt === "" || row.finishedAt === "" || row.rolledBackAt === "") return true;
  if (row.finishedAt !== null && row.rolledBackAt !== null) return true;
  if (row.finishedAt !== null && row.appliedStepsCount !== 1) return true;
  if (row.finishedAt !== null && row.startedAt === null) return true;
  return false;
}

export function successfulHistoricalRows(
  appliedAt = "2026-10-01T00:00:00.000Z",
): PrismaMigrationRow[] {
  return HISTORICAL_MIGRATION_NAMES.map((migrationName) => ({
    migrationName,
    checksum: CHECKSUM_BY_NAME.get(migrationName) ?? "",
    startedAt: appliedAt,
    finishedAt: appliedAt,
    rolledBackAt: null,
    appliedStepsCount: 1,
  }));
}

export function successfulP1Row(appliedAt = "2026-10-10T21:00:00.000Z"): PrismaMigrationRow {
  return {
    migrationName: P1_MIGRATION_NAME,
    checksum: CHECKSUM_BY_NAME.get(P1_MIGRATION_NAME) ?? "",
    startedAt: appliedAt,
    finishedAt: appliedAt,
    rolledBackAt: null,
    appliedStepsCount: 1,
  };
}
