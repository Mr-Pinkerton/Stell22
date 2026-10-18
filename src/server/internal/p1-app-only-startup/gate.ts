import { FORBIDDEN_DATABASE_NAMES, P1_MIGRATION_NAME, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import type { SchemaShape } from "@/server/internal/p1-isolated-runner/schema-contract";
import type { ImageMigration } from "@/server/internal/p1-app-only-startup/inventory";

export type StartupHistoryRow = {
  migrationName: string;
  checksum: string;
  startedAt: string | null;
  finishedAt: string | null;
  rolledBackAt: string | null;
  appliedStepsCount: number;
};

export type StartupRole = {
  currentUser: string;
  sessionUser: string;
  databaseName: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
  memberships: readonly string[];
  schemaUsage: boolean;
  schemaCreate: boolean;
  ownedTableCount: number;
};

export type StartupDecision = { ok: true } | { ok: false; code: string };

const FORBIDDEN = new Set<string>(FORBIDDEN_DATABASE_NAMES);

export function evaluateAppOnlyStartup(input: {
  imageMigrations: readonly ImageMigration[];
  history: readonly StartupHistoryRow[] | null;
  schemaShape: SchemaShape;
  role: StartupRole;
  urlDatabase: string;
  urlUser: string;
}): StartupDecision {
  if (input.imageMigrations.length === 0) return refuse("MIGRATION_HISTORY_UNVERIFIABLE");
  if (!explicitRole(input.role)) return refuse("MIGRATION_HISTORY_UNVERIFIABLE");
  if (input.role.databaseName !== input.urlDatabase || FORBIDDEN.has(input.role.databaseName)) {
    return refuse("WRONG_DATABASE");
  }
  if (input.role.currentUser !== input.urlUser || input.role.sessionUser !== input.role.currentUser) {
    return refuse("ROLE_MISMATCH");
  }
  if (input.role.rolsuper) return refuse("BOOTSTRAP_SUPERUSER");
  if (
    !input.role.rolcanlogin ||
    input.role.rolcreatedb ||
    input.role.rolcreaterole ||
    input.role.rolreplication ||
    input.role.rolbypassrls ||
    input.role.memberships.length > 0 ||
    input.role.schemaCreate ||
    input.role.ownedTableCount !== 0 ||
    !input.role.schemaUsage
  ) {
    return refuse("APP_ROLE_REFUSED");
  }
  if (input.history === null) return refuse("MIGRATION_HISTORY_MISSING");

  const image = new Map(input.imageMigrations.map((migration) => [migration.name, migration.sha256]));
  const seen = new Map<string, StartupHistoryRow>();
  for (const row of input.history) {
    if (seen.has(row.migrationName)) return refuse("DUPLICATE_HISTORY");
    seen.set(row.migrationName, row);
  }
  for (const row of input.history) {
    if (row.rolledBackAt !== null || row.finishedAt === null || row.startedAt === null || row.appliedStepsCount !== 1) {
      return refuse(row.finishedAt === null ? "FAILED_MIGRATION" : "INCOMPLETE_MIGRATION");
    }
  }
  for (const [name, sha256] of image) {
    const row = seen.get(name);
    if (!row) return refuse("PENDING_MIGRATION");
    if (row.checksum !== sha256) return refuse("UNEXPECTED_CHECKSUM");
  }
  for (const row of input.history) {
    if (image.has(row.migrationName)) continue;
    const pinnedP1 =
      row.migrationName === P1_MIGRATION_NAME &&
      row.checksum === P1_SHA256 &&
      !image.has(P1_MIGRATION_NAME);
    if (!pinnedP1) return refuse("EXTRA_HISTORY");
  }
  const p1InImage = image.has(P1_MIGRATION_NAME);
  const p1InHistory = seen.has(P1_MIGRATION_NAME);
  if (p1InImage || p1InHistory) {
    if (input.schemaShape !== "match") return refuse("SCHEMA_NOT_READY");
  } else if (input.schemaShape !== "absent") {
    return refuse("SCHEMA_NOT_READY");
  }
  return { ok: true };
}

function explicitRole(role: StartupRole): boolean {
  const flags = [
    role.rolsuper,
    role.rolcreatedb,
    role.rolcreaterole,
    role.rolreplication,
    role.rolbypassrls,
    role.rolcanlogin,
    role.schemaUsage,
    role.schemaCreate,
  ];
  return flags.every((flag) => typeof flag === "boolean") && Array.isArray(role.memberships) && role.memberships.every((name) => typeof name === "string");
}

function refuse(code: string): StartupDecision {
  return { ok: false, code };
}
