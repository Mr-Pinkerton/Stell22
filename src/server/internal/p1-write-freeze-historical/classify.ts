/**
 * Outcomes for one disposable historical-application rehearsal.
 * None of these grant privileges or restart a container.
 */

export type PoolClass =
  | "RECONNECTED"
  | "DATABASE_CONNECTION_FAILURE"
  | "APPLICATION_PROCESS_EXIT"
  | "APPLICATION_CONTAINER_RESTART";

export function classifyPool(input: {
  beforeId: string;
  afterId: string;
  beforeStartedAt: string;
  afterStartedAt: string;
  running: boolean;
  exitCode: number | null;
  healthStatus: number | null;
}): PoolClass {
  if (input.beforeId !== input.afterId || input.beforeStartedAt !== input.afterStartedAt) {
    return "APPLICATION_CONTAINER_RESTART";
  }
  if (!input.running || (input.exitCode !== null && input.exitCode !== 0)) return "APPLICATION_PROCESS_EXIT";
  if (input.healthStatus === 200) return "RECONNECTED";
  return "DATABASE_CONNECTION_FAILURE";
}

export type MigrateEvidence = number | "NOT_MEASURED";

export type EntrypointClass = "STARTUP_PROVEN" | "MIGRATE_MEASURED" | "FAIL";

/**
 * A running container is not a migrate exit code. STARTUP_PROVEN requires
 * the Prisma no-pending log, a running server, and health 200 while the
 * entrypoint command status stays NOT_MEASURED.
 */
export function classifyEntrypoint(input: {
  migrateExit: MigrateEvidence | null;
  serverRunning: boolean;
  healthStatus: number | null;
  noPendingLog: boolean;
}): EntrypointClass {
  if (!input.serverRunning || input.healthStatus !== 200 || !input.noPendingLog) return "FAIL";
  if (input.migrateExit === "NOT_MEASURED") return "STARTUP_PROVEN";
  if (input.migrateExit === 0) return "MIGRATE_MEASURED";
  return "FAIL";
}
