/**
 * Disposable planner for the legacy stell22-superuser ownership model.
 * It does not connect to PostgreSQL and it does not install roles in production.
 * Ownership changes are one statement per inventoried object. There is no REASSIGN OWNED.
 */

import { DISPOSABLE_APP_ROLE, MIGRATOR_ROLE } from "@/server/internal/p1-role-split-disposable/topology";
import {
  EXPECTED_HISTORICAL_MIGRATION_COUNT,
  FORBIDDEN_DATABASE_NAMES,
  P1_MIGRATION_NAME,
  P1_SHA256,
} from "@/server/internal/p1-isolated-runner/contract";
import { PINNED_MIGRATION_FILES } from "@/server/internal/p1-isolated-runner/inventory";

export const LEGACY_ADMIN_ROLE = "stell22" as const;
export const LEGACY_SCHEMA_OWNER = "pg_database_owner" as const;

const DISPOSABLE_DATABASE = /^p1as_[0-9a-f]{8}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ROUTINE_ARGUMENTS = /^[A-Za-z0-9_[\], ]*$/;
const PASSWORD = /^[0-9a-f]{32}$/;
const PRODUCTION_PASSWORD = /^[A-Za-z0-9+/=_-]{24,128}$/;
const RELATION_KIND = {
  r: "table",
  p: "table",
  S: "sequence",
  v: "view",
  m: "view",
} as const;

const HISTORICAL_CHECKSUMS = new Map(
  PINNED_MIGRATION_FILES.filter((entry) => entry.path.endsWith("/migration.sql") && !entry.path.includes(P1_MIGRATION_NAME)).map((entry) => {
    const name = entry.path.split("/")[2];
    if (!name) throw new Error("pinned historical migration path has no name");
    return [name, entry.sha256] as const;
  }),
);

if (HISTORICAL_CHECKSUMS.size !== EXPECTED_HISTORICAL_MIGRATION_COUNT) {
  throw new Error("pinned historical migration count is not 45");
}

export type DatabasePolicy = "disposable" | "production-candidate";

export type TransitionCode =
  | "PRODUCTION_DATABASE"
  | "DISPOSABLE_DATABASE_REFUSED"
  | "CREDENTIAL_REFUSED"
  | "UNEXPECTED_SCHEMA_OWNER"
  | "LEGACY_ADMIN_REFUSED"
  | "LEGACY_ROLE_PRESENT"
  | "REQUIRED_OBJECT_MISSING"
  | "LEGACY_OWNERSHIP_DIFFERS"
  | "UNSAFE_IDENTIFIER"
  | "MIGRATION_HISTORY_DIFFERS"
  | "P1_CHECKSUM_DIFFERS"
  | "APP_SCHEMA_CREATE"
  | "APP_INHERITS_MIGRATOR"
  | "APP_MIGRATION_PRIVILEGE"
  | "MIGRATOR_OWNERSHIP_MISSING"
  | "PRIVILEGED_APP_LOGIN"
  | "ADMIN_NOT_PRESERVED";

export type CatalogRelation = {
  name: string;
  kind: string;
  owner: string;
};

export type CatalogRoutine = {
  name: string;
  identityArguments: string;
  owner: string;
};

export type CatalogHistoryRow = {
  migrationName: string;
  checksum: string;
  finishedAt: string | null;
  rolledBackAt: string | null;
  appliedStepsCount: number;
};

export type LegacyCatalog = {
  databaseName: string;
  schemaOwner: string;
  adminSuperuser: boolean;
  adminLogin: boolean;
  appRoleExists: boolean;
  migratorRoleExists: boolean;
  relations: readonly CatalogRelation[];
  routines: readonly CatalogRoutine[];
  history: readonly CatalogHistoryRow[];
};

export type OwnershipItem = {
  key: string;
  statement: string;
};

export function planLegacyTransition(input: {
  catalog: LegacyCatalog;
  appPassword: string;
  migratorPassword: string;
  p1Checksum: string;
  databasePolicy?: DatabasePolicy;
}): { ok: true; inventory: OwnershipItem[]; sql: string } | { ok: false; code: TransitionCode } {
  const policy = input.databasePolicy ?? "disposable";
  const database = input.catalog.databaseName;
  if (policy === "production-candidate") {
    if (database !== LEGACY_ADMIN_ROLE) return refuse("PRODUCTION_DATABASE");
  } else {
    if (FORBIDDEN_DATABASE_NAMES.some((name) => name === database.toLowerCase())) {
      return refuse("PRODUCTION_DATABASE");
    }
    if (!DISPOSABLE_DATABASE.test(database)) return refuse("DISPOSABLE_DATABASE_REFUSED");
  }
  if (!passwordAccepted(policy, input.appPassword) || !passwordAccepted(policy, input.migratorPassword) || input.appPassword === input.migratorPassword) {
    return refuse("CREDENTIAL_REFUSED");
  }
  if (input.catalog.schemaOwner !== LEGACY_SCHEMA_OWNER) return refuse("UNEXPECTED_SCHEMA_OWNER");
  if (!input.catalog.adminSuperuser || !input.catalog.adminLogin) return refuse("LEGACY_ADMIN_REFUSED");
  if (input.catalog.appRoleExists || input.catalog.migratorRoleExists) return refuse("LEGACY_ROLE_PRESENT");

  const batch = input.catalog.relations.find((relation) => relation.name === "BatchCreationCommand" && relation.kind === "r");
  const migrations = input.catalog.relations.find((relation) => relation.name === "_prisma_migrations" && relation.kind === "r");
  if (!batch || !migrations) return refuse("REQUIRED_OBJECT_MISSING");

  const inventory: OwnershipItem[] = [];
  const relations = [...input.catalog.relations].sort((left, right) => compareText(relationSort(left), relationSort(right)) || compareText(left.name, right.name));
  for (const relation of relations) {
    if (relation.owner !== LEGACY_ADMIN_ROLE) return refuse("LEGACY_OWNERSHIP_DIFFERS");
    const kind = RELATION_KIND[relation.kind as keyof typeof RELATION_KIND];
    if (!kind || !IDENTIFIER.test(relation.name)) return refuse("UNSAFE_IDENTIFIER");
    const quoted = quoteIdent(relation.name);
    const verb = kind === "sequence" ? "SEQUENCE" : kind === "view" ? "VIEW" : "TABLE";
    inventory.push({
      key: `${kind}:${relation.name}`,
      statement: `ALTER ${verb} public.${quoted} OWNER TO ${MIGRATOR_ROLE}`,
    });
  }
  const routines = [...input.catalog.routines].sort((left, right) => compareText(left.name, right.name) || compareText(left.identityArguments, right.identityArguments));
  for (const routine of routines) {
    if (routine.owner !== LEGACY_ADMIN_ROLE) return refuse("LEGACY_OWNERSHIP_DIFFERS");
    if (!IDENTIFIER.test(routine.name) || !ROUTINE_ARGUMENTS.test(routine.identityArguments)) return refuse("UNSAFE_IDENTIFIER");
    inventory.push({
      key: `routine:${routine.name}:${routine.identityArguments}`,
      statement: `ALTER FUNCTION public.${quoteIdent(routine.name)}(${routine.identityArguments}) OWNER TO ${MIGRATOR_ROLE}`,
    });
  }

  const history = checkHistory(input.catalog.history);
  if (!history.ok) return history;
  if (input.p1Checksum !== P1_SHA256) return refuse("P1_CHECKSUM_DIFFERS");

  const statements = [
    "BEGIN",
    `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    "REVOKE USAGE ON SCHEMA public FROM PUBLIC",
    `CREATE ROLE ${DISPOSABLE_APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${input.appPassword}'`,
    `CREATE ROLE ${MIGRATOR_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${input.migratorPassword}'`,
    `GRANT CONNECT ON DATABASE ${database} TO ${DISPOSABLE_APP_ROLE}`,
    `GRANT CONNECT ON DATABASE ${database} TO ${MIGRATOR_ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${DISPOSABLE_APP_ROLE}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATOR_ROLE}`,
    ...inventory.map((item) => item.statement),
    ...grantStatements(relations),
    ...routines.map((routine) => `GRANT EXECUTE ON FUNCTION public.${quoteIdent(routine.name)}(${routine.identityArguments}) TO ${DISPOSABLE_APP_ROLE}`),
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public."_prisma_migrations" FROM ${DISPOSABLE_APP_ROLE}`,
    `GRANT SELECT ON TABLE public."_prisma_migrations" TO ${DISPOSABLE_APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${DISPOSABLE_APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${DISPOSABLE_APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${DISPOSABLE_APP_ROLE}`,
    "COMMIT",
  ];
  return { ok: true, inventory, sql: statements.map((statement) => `${statement};`).join("\n") };
}

export function verifyTransferredOwnership(input: {
  inventory: readonly OwnershipItem[];
  owners: Readonly<Record<string, string>>;
}): { ok: true } | { ok: false; code: "MIGRATOR_OWNERSHIP_MISSING" } {
  for (const item of input.inventory) {
    if (input.owners[item.key] !== MIGRATOR_ROLE) return { ok: false, code: "MIGRATOR_OWNERSHIP_MISSING" };
  }
  return { ok: true };
}

export function verifyAppRestrictions(input: {
  schemaCreate: boolean;
  memberOfMigrator: boolean;
  migrationSelect: boolean;
  migrationInsert: boolean;
  migrationUpdate: boolean;
  migrationDelete: boolean;
}): { ok: true } | { ok: false; code: "APP_SCHEMA_CREATE" | "APP_INHERITS_MIGRATOR" | "APP_MIGRATION_PRIVILEGE" } {
  if (input.schemaCreate) return { ok: false, code: "APP_SCHEMA_CREATE" };
  if (input.memberOfMigrator) return { ok: false, code: "APP_INHERITS_MIGRATOR" };
  if (!input.migrationSelect || input.migrationInsert || input.migrationUpdate || input.migrationDelete) {
    return { ok: false, code: "APP_MIGRATION_PRIVILEGE" };
  }
  return { ok: true };
}

export function verifyPrivilegedAppLogin(input: { login: string; superuser: boolean }): { ok: true } | { ok: false; code: "PRIVILEGED_APP_LOGIN" } {
  if (input.superuser || input.login !== DISPOSABLE_APP_ROLE) return { ok: false, code: "PRIVILEGED_APP_LOGIN" };
  return { ok: true };
}

export function verifyAdminPreserved(input: { superuser: boolean; login: boolean }): { ok: true } | { ok: false; code: "ADMIN_NOT_PRESERVED" } {
  if (!input.superuser || !input.login) return { ok: false, code: "ADMIN_NOT_PRESERVED" };
  return { ok: true };
}

function checkHistory(history: readonly CatalogHistoryRow[]): { ok: true } | { ok: false; code: "MIGRATION_HISTORY_DIFFERS" } {
  if (history.length !== HISTORICAL_CHECKSUMS.size) return refuse("MIGRATION_HISTORY_DIFFERS");
  const seen = new Set<string>();
  for (const row of history) {
    if (seen.has(row.migrationName)) return refuse("MIGRATION_HISTORY_DIFFERS");
    seen.add(row.migrationName);
    if (HISTORICAL_CHECKSUMS.get(row.migrationName) !== row.checksum) return refuse("MIGRATION_HISTORY_DIFFERS");
    if (row.finishedAt === null || row.finishedAt.length === 0 || row.rolledBackAt !== null || row.appliedStepsCount !== 1) {
      return refuse("MIGRATION_HISTORY_DIFFERS");
    }
  }
  return { ok: true };
}

function grantStatements(relations: readonly CatalogRelation[]): string[] {
  const statements: string[] = [];
  for (const relation of relations) {
    const kind = RELATION_KIND[relation.kind as keyof typeof RELATION_KIND];
    const quoted = `public.${quoteIdent(relation.name)}`;
    if (relation.name === "_prisma_migrations") continue;
    if (kind === "table") statements.push(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${quoted} TO ${DISPOSABLE_APP_ROLE}`);
    if (kind === "view") statements.push(`GRANT SELECT ON TABLE ${quoted} TO ${DISPOSABLE_APP_ROLE}`);
    if (kind === "sequence") statements.push(`GRANT USAGE, SELECT ON SEQUENCE ${quoted} TO ${DISPOSABLE_APP_ROLE}`);
  }
  return statements;
}

function relationSort(relation: CatalogRelation): string {
  const kind = RELATION_KIND[relation.kind as keyof typeof RELATION_KIND];
  if (kind === "table") return "1";
  if (kind === "sequence") return "2";
  return "3";
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function passwordAccepted(policy: DatabasePolicy, value: string): boolean {
  return policy === "production-candidate" ? PRODUCTION_PASSWORD.test(value) : PASSWORD.test(value);
}

function refuse<Code extends TransitionCode>(code: Code): { ok: false; code: Code } {
  return { ok: false, code };
}
