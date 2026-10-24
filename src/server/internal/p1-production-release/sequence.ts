/**
 * Production role-split release sequence.
 * This module does not open a database connection and does not deploy.
 * `stell22` stays the preserved superuser. `stell22_app` is the only application login.
 * `stell22_migrator` is the only role that may apply the pinned P1 migration.
 */

import { P1_MIGRATION_NAME, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { DISPOSABLE_APP_ROLE, MIGRATOR_ROLE } from "@/server/internal/p1-role-split-disposable/topology";

export const OWNER_AUTHORIZATION = "OWNER_AUTHORIZES_ROLE_SPLIT_RELEASE";
export const HOST_CPU = 2;
export const HOST_MEMORY_MIB = 4096;

export const COMPOSE_LIMITS = {
  dbMib: 1280,
  appMib: 1536,
  caddyMib: 192,
  dbCpu: 0.7,
  appCpu: 0.7,
  caddyCpu: 0.2,
} as const;

export const PROTECTED_PATHS = ["scripts/backup-db.sh", "scripts/restore-db.sh", "mail.log"] as const;

export const RELEASE_STEPS = [
  "OWNER_GATE",
  "PROTECTED_FILES",
  "RESOURCE_BUDGET",
  "IMAGE_BUILD",
  "NON_MUTATING_VALIDATION",
  "WRITE_FREEZE",
  "ROLE_TRANSITION",
  "WRITER_EXCLUSION",
  "PINNED_P1",
  "APP_START",
  "HEALTH",
] as const;

export type ReleaseStep = (typeof RELEASE_STEPS)[number];

export type ReleaseCode =
  | "STOP_LOCKED"
  | "STOP_PROTECTED_FILE"
  | "STOP_RESOURCES"
  | "STOP_WRITER"
  | "STOP_APP_ROLE"
  | "STOP_MIGRATOR"
  | "FORWARD_RECOVERY";

export type WriterExclusion = {
  appContainerStopped: boolean;
  competingWritersStopped: boolean;
  appLogin: string;
  appCanMigrate: boolean;
  appMigrationInsert: boolean;
  migratorLogin: string;
};

export function releaseResourceBudget(): { ok: true; cpu: number; memoryMib: number } | { ok: false; code: "STOP_RESOURCES" } {
  const cpu = COMPOSE_LIMITS.dbCpu + COMPOSE_LIMITS.appCpu + COMPOSE_LIMITS.caddyCpu;
  const memoryMib = COMPOSE_LIMITS.dbMib + COMPOSE_LIMITS.appMib + COMPOSE_LIMITS.caddyMib;
  if (cpu > HOST_CPU || memoryMib > HOST_MEMORY_MIB) return { ok: false, code: "STOP_RESOURCES" };
  return { ok: true, cpu, memoryMib };
}

export function assertOwnerGate(input: { execute: string | undefined; authorization: string | undefined }): { ok: true } | { ok: false; code: "STOP_LOCKED" } {
  if (input.execute !== "1" || input.authorization !== OWNER_AUTHORIZATION) return { ok: false, code: "STOP_LOCKED" };
  return { ok: true };
}

export function assertProtectedCheckout(commands: readonly string[]): { ok: true } | { ok: false; code: "STOP_PROTECTED_FILE" } {
  for (const command of commands) {
    if (/\bgit\s+reset\s+--hard\b/.test(command)) return { ok: false, code: "STOP_PROTECTED_FILE" };
    if (/\brestore-db\.sh\b/.test(command)) return { ok: false, code: "STOP_PROTECTED_FILE" };
    if (/\bgit\s+clean\b/.test(command)) return { ok: false, code: "STOP_PROTECTED_FILE" };
  }
  return { ok: true };
}

export function assertWriterExclusionBeforeP1(input: WriterExclusion): { ok: true } | { ok: false; code: "STOP_WRITER" | "STOP_APP_ROLE" | "STOP_MIGRATOR" } {
  if (!input.appContainerStopped || !input.competingWritersStopped) return { ok: false, code: "STOP_WRITER" };
  if (input.appLogin !== DISPOSABLE_APP_ROLE) return { ok: false, code: "STOP_APP_ROLE" };
  if (input.appCanMigrate || input.appMigrationInsert) return { ok: false, code: "STOP_APP_ROLE" };
  if (input.migratorLogin !== MIGRATOR_ROLE) return { ok: false, code: "STOP_MIGRATOR" };
  return { ok: true };
}

export function failureAfterMigration(): {
  action: "FORWARD_RECOVERY";
  databaseRestore: false;
  schemaRollback: false;
  restartLegacy: false;
  retryP1: false;
  code: "FORWARD_RECOVERY";
} {
  return {
    action: "FORWARD_RECOVERY",
    databaseRestore: false,
    schemaRollback: false,
    restartLegacy: false,
    retryP1: false,
    code: "FORWARD_RECOVERY",
  };
}

export type ReleaseBoundary = {
  code: "STOP_APP_START" | "STOP_ROLE_TRANSITION" | "STOP_WRITER" | "STOP_APP_ROLE" | "STOP_MIGRATOR" | "FORWARD_RECOVERY" | "LEGACY_RESTART" | "ADMITTED" | "RELEASE_APPLIED";
  restartLegacy: boolean;
  databaseRestore: false;
  schemaRollback: false;
  retryP1: false;
  terminateSessions: false;
  demoteSuperuser: false;
  futurePrivilegedWritesProvenImpossible: false;
  privilegedRolesRemain: readonly ["stell22", "stell22_migrator"];
  emptyActivityProvesFutureExclusion: false;
};

const CLOSED: Omit<ReleaseBoundary, "code" | "restartLegacy"> = {
  databaseRestore: false,
  schemaRollback: false,
  retryP1: false,
  terminateSessions: false,
  demoteSuperuser: false,
  futurePrivilegedWritesProvenImpossible: false,
  privilegedRolesRemain: ["stell22", "stell22_migrator"] as const,
  emptyActivityProvesFutureExclusion: false,
};

function closed(code: ReleaseBoundary["code"], restartLegacy: boolean): ReleaseBoundary {
  return { code, restartLegacy, ...CLOSED };
}

export type LegacyRestartFacts = {
  roleTransitionCommitted: boolean;
  p1Present: boolean;
  p1MigrationInLegacyImage: boolean;
  rolesAbsent: boolean;
  historyUnchanged: boolean;
  databaseStateKnown: boolean;
};

/** The deployed entrypoint runs migrate deploy. Restart it only while the original database and a P1-free image are both proven. */
export function decideLegacyRestart(facts: LegacyRestartFacts): ReleaseBoundary {
  const original =
    facts.databaseStateKnown &&
    !facts.roleTransitionCommitted &&
    !facts.p1Present &&
    !facts.p1MigrationInLegacyImage &&
    facts.rolesAbsent &&
    facts.historyUnchanged;
  if (!original) return closed(facts.roleTransitionCommitted || facts.p1Present ? "FORWARD_RECOVERY" : "STOP_ROLE_TRANSITION", false);
  return closed("LEGACY_RESTART", true);
}

export function decideImageBuildFailure(): ReleaseBoundary {
  return closed("STOP_APP_START", false);
}

export function decideImageIdentityAccepted(): ReleaseBoundary {
  return closed("ADMITTED", false);
}

export type WriterSession = {
  user: string;
  applicationName: string;
  backendType: string;
};

export type WriterAdmissionFacts = {
  maintenanceDeclared: boolean;
  appRunning: boolean;
  expectAppStopped: boolean;
  backupRunning: boolean;
  statementImportRunning: boolean;
  externalWriterCount: number;
  checkSessions: boolean;
  inspectionApp: string;
  sessions: readonly WriterSession[];
};

/** An empty session list is not proof that a superuser write cannot start later. */
export function decideWriterAdmission(facts: WriterAdmissionFacts): ReleaseBoundary {
  const unknown = unknownSessions(facts);
  const blocked =
    !facts.maintenanceDeclared ||
    facts.backupRunning ||
    facts.statementImportRunning ||
    facts.externalWriterCount > 0 ||
    (facts.expectAppStopped && facts.appRunning) ||
    (facts.checkSessions && (unknown > 0 || !inspectionSeen(facts)));
  if (blocked) return closed("STOP_WRITER", false);
  return closed("ADMITTED", false);
}

export function unknownSessions(facts: WriterAdmissionFacts): number {
  let count = 0;
  for (const session of facts.sessions) {
    if (session.backendType !== "client backend") continue;
    const inspection = session.user === "stell22" && session.applicationName === facts.inspectionApp && !session.user.includes("|");
    if (!inspection) count += 1;
  }
  return count;
}

function inspectionSeen(facts: WriterAdmissionFacts): boolean {
  return facts.sessions.some(
    (session) => session.backendType === "client backend" && session.applicationName === facts.inspectionApp && session.user === "stell22",
  );
}

export function decideAfterCommittedRoleChange(code: "STOP_WRITER" | "STOP_APP_ROLE" | "STOP_MIGRATOR"): ReleaseBoundary {
  return closed(code, false);
}

export function decideP1Uncertain(): ReleaseBoundary {
  return closed("FORWARD_RECOVERY", false);
}

export function decideAppUnhealthy(): ReleaseBoundary {
  return closed("FORWARD_RECOVERY", false);
}

export function decideReleaseApplied(): ReleaseBoundary {
  return closed("RELEASE_APPLIED", false);
}

export function appMayStart(input: { entrypoint: string; databaseUser: string; p1AppliedBy: string; p1Checksum: string }): { ok: true } | { ok: false; code: "STOP_APP_ROLE" | "STOP_MIGRATOR" } {
  if (input.entrypoint !== "./docker-entrypoint-app-only.sh") return { ok: false, code: "STOP_APP_ROLE" };
  if (input.databaseUser !== DISPOSABLE_APP_ROLE) return { ok: false, code: "STOP_APP_ROLE" };
  if (input.p1AppliedBy !== MIGRATOR_ROLE) return { ok: false, code: "STOP_MIGRATOR" };
  if (input.p1Checksum !== P1_SHA256) return { ok: false, code: "STOP_MIGRATOR" };
  return { ok: true };
}

export function releaseOrder(): readonly ReleaseStep[] {
  return RELEASE_STEPS;
}

export function pinnedMigrationName(): string {
  return P1_MIGRATION_NAME;
}
