import type { PrismaMigrationRow } from "@/server/internal/p1-isolated-runner/classify";
import type { LogicalColumn, LogicalConstraint } from "@/server/internal/p1-isolated-runner/p1-release-gate";
import type { P1SchemaEvidence } from "@/server/internal/p1-isolated-runner/schema-contract";
import type { RecoverySnapshot, TableAggregate } from "@/server/internal/p1-production-adapter/recovery";

/**
 * One read-only catalog statement.
 * It does not create objects and it is not a migration.
 */
export const CATALOG_SQL = `
SELECT json_build_object(
  'session', json_build_object(
    'databaseName', current_database(),
    'roleName', current_user,
    'serverVersionNum', current_setting('server_version_num')::int
  ),
  'history', COALESCE((
    SELECT json_agg(json_build_object(
      'migrationName', migration_name,
      'checksum', checksum,
      'startedAt', started_at,
      'finishedAt', finished_at,
      'rolledBackAt', rolled_back_at,
      'appliedStepsCount', applied_steps_count
    ))
    FROM public."_prisma_migrations"
  ), '[]'::json),
  'column', COALESCE((
    SELECT json_agg(json_build_object(
      'schema_name', n.nspname,
      'table_name', c.relname,
      'udt_name', t.typname,
      'data_type', pg_catalog.format_type(a.atttypid, a.atttypmod),
      'is_nullable', CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,
      'column_default', pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)
    ))
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND a.attname = 'receiptProvenanceSnapshot'
      AND a.attnum > 0
      AND NOT a.attisdropped
  ), '[]'::json),
  'check', COALESCE((
    SELECT json_agg(json_build_object(
      'schema_name', n.nspname,
      'table_name', c.relname,
      'constraint_name', con.conname,
      'definition', pg_catalog.pg_get_constraintdef(con.oid, true),
      'validated', con.convalidated
    ))
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND con.conname = 'BatchCreationCommand_receiptProvenanceSnapshot_shape'
      AND con.contype = 'c'
  ), '[]'::json),
  'function', COALESCE((
    SELECT json_agg(json_build_object(
      'schema_name', n.nspname,
      'function_name', p.proname,
      'identity_arguments', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'language', l.lanname,
      'security_definer', p.prosecdef,
      'definition', pg_catalog.pg_get_functiondef(p.oid)
    ))
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE n.nspname = 'public'
      AND p.proname = 'batch_creation_command_provenance_guard'
  ), '[]'::json),
  'trigger', COALESCE((
    SELECT json_agg(json_build_object(
      'schema_name', tn.nspname,
      'table_name', c.relname,
      'trigger_name', t.tgname,
      'enabled', t.tgenabled::text,
      'definition', pg_catalog.pg_get_triggerdef(t.oid, true),
      'function_schema', fn.nspname,
      'function_name', fp.proname,
      'function_identity_arguments', pg_catalog.pg_get_function_identity_arguments(fp.oid)
    ))
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = c.relnamespace
    JOIN pg_catalog.pg_proc fp ON fp.oid = t.tgfoid
    JOIN pg_catalog.pg_namespace fn ON fn.oid = fp.pronamespace
    WHERE tn.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND NOT t.tgisinternal
      AND t.tgname = 'batch_creation_command_provenance_guard'
  ), '[]'::json),
  'extraTriggers', COALESCE((
    SELECT json_agg(t.tgname)
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND NOT t.tgisinternal
      AND t.tgname <> 'batch_creation_command_provenance_guard'
  ), '[]'::json),
  'unexpectedObjects', COALESCE((
    SELECT json_agg(n.nspname || '.' || p.proname)
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname <> 'batch_creation_command_provenance_guard'
      AND (p.proname LIKE '%provenance%' OR p.proname LIKE '%receipt%')
  ), '[]'::json),
  'foreignKeyCount', (
    SELECT count(*)::int
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'BatchCreationCommand'
      AND con.contype = 'f'
  ),
  'columns', COALESCE((
    SELECT json_agg(json_build_object(
      'schema', n.nspname,
      'table', c.relname,
      'column', a.attname,
      'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
      'nullable', CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END,
      'columnDefault', pg_catalog.pg_get_expr(ad.adbin, ad.adrelid),
      'identity', a.attidentity,
      'generated', a.attgenerated,
      'collation', CASE WHEN a.attcollation = 0 THEN NULL ELSE col.collname END
    ))
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
    LEFT JOIN pg_catalog.pg_collation col ON col.oid = a.attcollation
    WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r'
  ), '[]'::json),
  'constraints', COALESCE((
    SELECT json_agg(json_build_object(
      'schema', n.nspname,
      'table', c.relname,
      'name', con.conname,
      'type', con.contype::text,
      'validated', con.convalidated,
      'deferrable', con.condeferrable,
      'initiallyDeferred', con.condeferred,
      'definition', pg_catalog.pg_get_constraintdef(con.oid, true)
    ))
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  ), '[]'::json),
  'aggregates', COALESCE((
    SELECT json_agg(json_build_object('table', counted.relname, 'rowCount', counted.row_count) ORDER BY counted.relname)
    FROM (
      SELECT c.relname,
             (pg_catalog.xpath('//row/cnt/text()', pg_catalog.query_to_xml(
               format('select count(*)::text as cnt from %I.%I', n.nspname, c.relname),
               false, true, ''
             )))[1]::text::bigint AS row_count
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
    ) counted
  ), '[]'::json),
  'invalidIndexCount', (
    SELECT count(*)::int
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT i.indisvalid
  ),
  'notValidConstraintCount', (
    SELECT count(*)::int
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND NOT con.convalidated
  ),
  'publicTableCount', (
    SELECT count(*)::int
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  ),
  'userRowCount', (SELECT count(*)::int FROM public."User")
)
`.trim();

export type CatalogBundle = {
  session: { databaseName: string; roleName: string; serverVersionNum: number };
  history: PrismaMigrationRow[];
  schema: P1SchemaEvidence;
  recovery: RecoverySnapshot;
};

export function parseCatalog(value: unknown): CatalogBundle {
  const record = objectOf(value);
  const session = objectOf(record.session);
  const historyRows = arrayOf(record.history).map(parseHistory);
  const successful = historyRows.filter(
    (row) => row.startedAt !== null && row.finishedAt !== null && row.rolledBackAt === null && row.appliedStepsCount === 1,
  );
  const failed = historyRows.length - successful.length;
  return {
    session: {
      databaseName: text(session.databaseName),
      roleName: text(session.roleName),
      serverVersionNum: integer(session.serverVersionNum),
    },
    history: historyRows,
    schema: {
      column: mapColumn(arrayOf(record.column)),
      check: mapCheck(arrayOf(record.check)),
      functionDef: mapFunction(arrayOf(record.function)),
      trigger: mapTrigger(arrayOf(record.trigger)),
      foreignKeyCount: integer(record.foreignKeyCount),
      extraTriggerNames: arrayOf(record.extraTriggers).map(text),
      unexpectedObjects: arrayOf(record.unexpectedObjects).map(text),
    },
    recovery: {
      migrations: historyRows.map((row) => ({
        name: row.migrationName,
        checksum: row.checksum,
        finished: row.finishedAt !== null,
        rolledBack: row.rolledBackAt !== null,
        steps: row.appliedStepsCount,
      })),
      columns: arrayOf(record.columns).map(parseColumn),
      constraints: arrayOf(record.constraints).map(parseConstraint),
      aggregates: arrayOf(record.aggregates).map(parseAggregate),
      invalidIndexCount: integer(record.invalidIndexCount),
      notValidConstraintCount: integer(record.notValidConstraintCount),
      publicTableCount: integer(record.publicTableCount),
      successfulMigrationCount: successful.length,
      failedMigrationCount: failed,
      userRowCount: integer(record.userRowCount),
    },
  };
}

function parseHistory(value: unknown): PrismaMigrationRow {
  const row = objectOf(value);
  return {
    migrationName: text(row.migrationName),
    checksum: text(row.checksum),
    startedAt: optionalText(row.startedAt),
    finishedAt: optionalText(row.finishedAt),
    rolledBackAt: optionalText(row.rolledBackAt),
    appliedStepsCount: integer(row.appliedStepsCount),
  };
}

function parseColumn(value: unknown): LogicalColumn {
  const row = objectOf(value);
  return {
    schema: text(row.schema),
    table: text(row.table),
    column: text(row.column),
    type: text(row.type),
    nullable: text(row.nullable),
    columnDefault: optionalText(row.columnDefault),
    identity: text(row.identity),
    generated: text(row.generated),
    collation: optionalText(row.collation),
  };
}

function parseConstraint(value: unknown): LogicalConstraint {
  const row = objectOf(value);
  return {
    schema: text(row.schema),
    table: text(row.table),
    name: text(row.name),
    type: text(row.type),
    validated: bool(row.validated),
    deferrable: bool(row.deferrable),
    initiallyDeferred: bool(row.initiallyDeferred),
    definition: text(row.definition),
  };
}

function parseAggregate(value: unknown): TableAggregate {
  const row = objectOf(value);
  return { table: text(row.table), rowCount: integer(row.rowCount) };
}

function mapColumn(rows: readonly unknown[]): P1SchemaEvidence["column"] {
  if (rows.length === 0) return null;
  const row = objectOf(rows[0]);
  const nullable = text(row.is_nullable);
  if (nullable !== "YES" && nullable !== "NO") throw new Error("malformed column");
  return {
    schemaName: text(row.schema_name),
    tableName: text(row.table_name),
    matchCount: rows.length,
    dataType: text(row.data_type),
    udtName: text(row.udt_name),
    isNullable: nullable,
    columnDefault: optionalText(row.column_default),
  };
}

function mapCheck(rows: readonly unknown[]): P1SchemaEvidence["check"] {
  if (rows.length === 0) return null;
  const row = objectOf(rows[0]);
  return {
    schemaName: text(row.schema_name),
    tableName: text(row.table_name),
    constraintName: text(row.constraint_name),
    matchCount: rows.length,
    definition: text(row.definition),
    validated: bool(row.validated),
  };
}

function mapFunction(rows: readonly unknown[]): P1SchemaEvidence["functionDef"] {
  if (rows.length === 0) return null;
  const row = objectOf(rows[0]);
  return {
    schemaName: text(row.schema_name),
    functionName: text(row.function_name),
    identityArguments: text(row.identity_arguments),
    matchCount: rows.length,
    language: text(row.language),
    definition: text(row.definition),
    securityDefiner: bool(row.security_definer),
  };
}

function mapTrigger(rows: readonly unknown[]): P1SchemaEvidence["trigger"] {
  if (rows.length === 0) return null;
  const row = objectOf(rows[0]);
  return {
    schemaName: text(row.schema_name),
    tableName: text(row.table_name),
    triggerName: text(row.trigger_name),
    matchCount: rows.length,
    enabled: text(row.enabled),
    definition: text(row.definition),
    functionSchema: text(row.function_schema),
    functionName: text(row.function_name),
    functionIdentityArguments: text(row.function_identity_arguments),
  };
}

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed catalog");
  return value as Record<string, unknown>;
}

function arrayOf(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("malformed catalog");
  return value;
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("malformed catalog");
  return value;
}

function optionalText(value: unknown): string | null {
  if (value === null) return null;
  return text(value);
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error("malformed catalog");
  return value;
}

function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("malformed catalog");
  return value;
}
