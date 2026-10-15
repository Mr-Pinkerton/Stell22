import { HISTORICAL_APPLICATION_COMMIT } from "@/server/internal/p1-isolated-runner/contract";
import {
  executeDisposableApply,
  type ApplyDependencies,
  type ApplyResult,
} from "@/server/internal/p1-isolated-runner/executor";

/**
 * Migration-only P1 path.
 * Disposable apply reuses the sealed executor. It does not start an application.
 * Production apply has no authenticated target in this package: a caller-supplied
 * checksum, restore word, or connection string is not that authentication.
 */
export const P1_ONLY_MODE = "MIGRATION_ONLY" as const;
export const PRODUCTION_P1_APPLY = "NOT_AUTHORIZED" as const;

export type P1OnlyMigrationResult = ApplyResult & {
  migrationOnly: true;
  appContainerReplaced: false;
  applicationSha: typeof HISTORICAL_APPLICATION_COMMIT;
};

export type ProductionP1OnlyDecision = {
  verdict: "STOP";
  code:
    | "DATABASE_URL_REJECTED"
    | "BACKUP_CHECKSUM_REQUIRED"
    | "RESTORE_NOT_VERIFIED"
    | "PRODUCTION_TARGET_UNAUTHENTICATED";
  spawned: false;
  retryAttempted: false;
  executionAuthorized: false;
  appContainerReplaced: false;
  migrationOnly: true;
};

export function executeP1OnlyMigration(
  rawAttestation: unknown,
  deps: ApplyDependencies,
): P1OnlyMigrationResult {
  const applied = executeDisposableApply(rawAttestation, deps);
  return {
    verdict: applied.verdict,
    code: applied.code,
    spawned: applied.spawned,
    retryAttempted: false,
    migrationOnly: true,
    appContainerReplaced: false,
    applicationSha: HISTORICAL_APPLICATION_COMMIT,
  };
}

export function assessProductionP1Only(input: unknown): ProductionP1OnlyDecision {
  if (containsConnectionString(input)) return productionStop("DATABASE_URL_REJECTED");
  if (!hasBackupChecksum(input)) return productionStop("BACKUP_CHECKSUM_REQUIRED");
  if (!claimsRestoreVerified(input)) return productionStop("RESTORE_NOT_VERIFIED");
  return productionStop("PRODUCTION_TARGET_UNAUTHENTICATED");
}

function productionStop(code: ProductionP1OnlyDecision["code"]): ProductionP1OnlyDecision {
  return {
    verdict: "STOP",
    code,
    spawned: false,
    retryAttempted: false,
    executionAuthorized: false,
    appContainerReplaced: false,
    migrationOnly: true,
  };
}

function containsConnectionString(value: unknown): boolean {
  if (typeof value === "string") return /postgres(?:ql)?:\/\//i.test(value);
  if (Array.isArray(value)) return value.some((item) => containsConnectionString(item));
  if (value === null || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    if (key === "DATABASE_URL" || key === "databaseUrl" || key === "connectionString") return true;
    if (containsConnectionString(item)) return true;
  }
  return false;
}

function hasBackupChecksum(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const checksum = (value as Record<string, unknown>).backupChecksum;
  return typeof checksum === "string" && /^[0-9a-f]{64}$/.test(checksum);
}

function claimsRestoreVerified(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return (value as Record<string, unknown>).restoreDrill === "RESTORE_VERIFIED";
}
