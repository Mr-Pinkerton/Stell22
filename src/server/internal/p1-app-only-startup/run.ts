import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  checkMatchesContract,
  classifySchemaShape,
  columnMatchesContract,
  functionMatchesContract,
  triggerMatchesContract,
  type P1SchemaEvidence,
} from "@/server/internal/p1-isolated-runner/schema-contract";
import { evaluateAppOnlyStartup, type StartupHistoryRow, type StartupRole } from "@/server/internal/p1-app-only-startup/gate";
import { readImageMigrations } from "@/server/internal/p1-app-only-startup/inventory";
import { STARTUP_HISTORY_SQL, STARTUP_ROLE_SQL, STARTUP_SCHEMA_SQL } from "@/server/internal/p1-app-only-startup/probe";

const REPOSITORY_ROOT = process.env.APP_ONLY_REPOSITORY_ROOT ?? process.cwd();

class StartupRefusal extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function fail(code: string): never {
  throw new StartupRefusal(code);
}

function databaseTarget(raw: string): { database: string; user: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail("CONFIGURATION_INCOMPLETE");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, "").split("/")[0] ?? "");
  const user = decodeURIComponent(url.username);
  if (database.length === 0 || user.length === 0 || url.password.length === 0) fail("CONFIGURATION_INCOMPLETE");
  return { database, user };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("MIGRATION_HISTORY_UNVERIFIABLE");
  return value as Record<string, unknown>;
}

function asBoolean(value: unknown): boolean {
  if (typeof value !== "boolean") fail("MIGRATION_HISTORY_UNVERIFIABLE");
  return value;
}

function asCount(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
  if (typeof value === "bigint" && value >= BigInt(0) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  fail("MIGRATION_HISTORY_UNVERIFIABLE");
}

function asText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail("MIGRATION_HISTORY_UNVERIFIABLE");
  return value;
}

function asRows(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail("MIGRATION_HISTORY_UNVERIFIABLE");
  return value;
}

function stamp(value: unknown): string | null {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  fail("MIGRATION_HISTORY_UNVERIFIABLE");
}

function parseRole(value: unknown): StartupRole & { historyTable: boolean } {
  const row = asRecord(value);
  const memberships = asRows(row.memberships).map((item) => asText(item));
  return {
    currentUser: asText(row.currentUser),
    sessionUser: asText(row.sessionUser),
    databaseName: asText(row.databaseName),
    rolsuper: asBoolean(row.rolsuper),
    rolcreatedb: asBoolean(row.rolcreatedb),
    rolcreaterole: asBoolean(row.rolcreaterole),
    rolreplication: asBoolean(row.rolreplication),
    rolbypassrls: asBoolean(row.rolbypassrls),
    rolcanlogin: asBoolean(row.rolcanlogin),
    memberships,
    schemaUsage: asBoolean(row.schemaUsage),
    schemaCreate: asBoolean(row.schemaCreate),
    ownedTableCount: asCount(row.ownedTableCount),
    historyTable: asBoolean(row.historyTable),
  };
}

function parseHistory(value: unknown): StartupHistoryRow[] {
  return asRows(value).map((item) => {
    const row = asRecord(item);
    const steps = row.appliedStepsCount;
    if (typeof steps !== "number") fail("MIGRATION_HISTORY_UNVERIFIABLE");
    return {
      migrationName: asText(row.migrationName),
      checksum: asText(row.checksum),
      startedAt: stamp(row.startedAt),
      finishedAt: stamp(row.finishedAt),
      rolledBackAt: stamp(row.rolledBackAt),
      appliedStepsCount: steps,
    };
  });
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") fail("SCHEMA_NOT_READY");
  return value;
}

function evidence(value: unknown): P1SchemaEvidence {
  const row = asRecord(value);
  const column = asRows(row.column);
  const check = asRows(row.check);
  const fn = asRows(row.function);
  const trigger = asRows(row.trigger);
  return {
    column: column.length === 0 ? null : columnPart(column),
    check: check.length === 0 ? null : checkPart(check),
    functionDef: fn.length === 0 ? null : functionPart(fn),
    trigger: trigger.length === 0 ? null : triggerPart(trigger),
    foreignKeyCount: asCount(row.foreignKeyCount),
    extraTriggerNames: asRows(row.extraTriggers).map((item) => asText(item)),
    unexpectedObjects: asRows(row.unexpectedObjects).map((item) => asText(item)),
  };
}

function columnPart(rows: unknown[]): NonNullable<P1SchemaEvidence["column"]> {
  const row = asRecord(rows[0]);
  const nullable = asText(row.is_nullable);
  if (nullable !== "YES" && nullable !== "NO") fail("SCHEMA_NOT_READY");
  return {
    schemaName: asText(row.schema_name),
    tableName: asText(row.table_name),
    matchCount: rows.length,
    dataType: asText(row.data_type),
    udtName: asText(row.udt_name),
    isNullable: nullable,
    columnDefault: nullableText(row.column_default),
  };
}

function checkPart(rows: unknown[]): NonNullable<P1SchemaEvidence["check"]> {
  const row = asRecord(rows[0]);
  return {
    schemaName: asText(row.schema_name),
    tableName: asText(row.table_name),
    constraintName: asText(row.constraint_name),
    matchCount: rows.length,
    definition: asText(row.definition),
    validated: asBoolean(row.validated),
  };
}

function functionPart(rows: unknown[]): NonNullable<P1SchemaEvidence["functionDef"]> {
  const row = asRecord(rows[0]);
  return {
    schemaName: asText(row.schema_name),
    functionName: asText(row.function_name),
    identityArguments: typeof row.identity_arguments === "string" ? row.identity_arguments : fail("SCHEMA_NOT_READY"),
    matchCount: rows.length,
    language: asText(row.language),
    definition: asText(row.definition),
    securityDefiner: asBoolean(row.security_definer),
  };
}

function triggerPart(rows: unknown[]): NonNullable<P1SchemaEvidence["trigger"]> {
  const row = asRecord(rows[0]);
  return {
    schemaName: asText(row.schema_name),
    tableName: asText(row.table_name),
    triggerName: asText(row.trigger_name),
    matchCount: rows.length,
    enabled: asText(row.enabled),
    definition: asText(row.definition),
    functionSchema: asText(row.function_schema),
    functionName: asText(row.function_name),
    functionIdentityArguments: typeof row.function_identity_arguments === "string" ? row.function_identity_arguments : fail("SCHEMA_NOT_READY"),
  };
}

async function main(): Promise<void> {
  const rawUrl = process.env.DATABASE_URL ?? "";
  if (rawUrl.length === 0) fail("CONFIGURATION_INCOMPLETE");
  const target = databaseTarget(rawUrl);
  if (!fs.existsSync(path.join(REPOSITORY_ROOT, "prisma", "schema.prisma"))) fail("CONFIGURATION_INCOMPLETE");
  const imageMigrations = readImageMigrations(REPOSITORY_ROOT);
  const prisma = new PrismaClient({ log: [] });
  try {
    const roleRows = await prisma.$queryRawUnsafe<Array<{ report: unknown }>>(STARTUP_ROLE_SQL);
    const role = parseRole(roleRows[0]?.report);
    const roleDecision = evaluateAppOnlyStartup({
      imageMigrations,
      history: null,
      schemaShape: "absent",
      role,
      urlDatabase: target.database,
      urlUser: target.user,
    });
    if (!roleDecision.ok && roleDecision.code !== "MIGRATION_HISTORY_MISSING") fail(roleDecision.code);
    const history = role.historyTable
      ? parseHistory((await prisma.$queryRawUnsafe<Array<{ report: unknown }>>(STARTUP_HISTORY_SQL))[0]?.report)
      : null;
    const schemaRows = await prisma.$queryRawUnsafe<Array<{ report: unknown }>>(STARTUP_SCHEMA_SQL);
    const schema = evidence(schemaRows[0]?.report);
    const schemaShape = classifySchemaShape(schema);
    const decision = evaluateAppOnlyStartup({
      imageMigrations,
      history,
      schemaShape,
      role,
      urlDatabase: target.database,
      urlUser: target.user,
    });
    if (!decision.ok) {
      if (decision.code === "SCHEMA_NOT_READY") {
        process.stderr.write(
          `APP_ONLY_STARTUP_DETAIL ${schemaShape} column=${schema.column === null ? "absent" : columnMatchesContract(schema.column)} check=${schema.check === null ? "absent" : checkMatchesContract(schema.check)} function=${schema.functionDef === null ? "absent" : functionMatchesContract(schema.functionDef)} trigger=${schema.trigger === null ? "absent" : triggerMatchesContract(schema.trigger)} fk=${schema.foreignKeyCount} extra=${schema.extraTriggerNames.length} unexpected=${schema.unexpectedObjects.length}\n`,
        );
      }
      fail(decision.code);
    }
  } catch (error) {
    if (error instanceof StartupRefusal) throw error;
    const message = error instanceof Error ? error.message : "";
    const code = /Code: `([0-9A-Z]{5})`/.exec(message)?.[1] ?? "QUERY";
    process.stderr.write(`APP_ONLY_STARTUP_QUERY ${code}\n`);
    fail("MIGRATION_HISTORY_UNVERIFIABLE");
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    const code = error instanceof StartupRefusal ? error.code : "MIGRATION_HISTORY_UNVERIFIABLE";
    process.stderr.write(`APP_ONLY_STARTUP ${code}\n`);
    process.exit(1);
  });
