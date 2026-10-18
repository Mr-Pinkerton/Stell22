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

export type EntrypointClass = "PASS" | "FAIL";

export function classifyEntrypoint(input: { migrateExit: number | null; serverRunning: boolean }): EntrypointClass {
  if (input.migrateExit === 0 && input.serverRunning) return "PASS";
  return "FAIL";
}
