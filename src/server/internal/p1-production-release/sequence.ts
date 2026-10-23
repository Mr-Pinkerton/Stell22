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
  code: "FORWARD_RECOVERY";
} {
  return {
    action: "FORWARD_RECOVERY",
    databaseRestore: false,
    schemaRollback: false,
    code: "FORWARD_RECOVERY",
  };
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
