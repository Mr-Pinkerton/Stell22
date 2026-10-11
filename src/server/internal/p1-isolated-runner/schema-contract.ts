/**
 * Catalog probes for the P1 object set.
 * These statements are the contract for a future disposable session.
 * This candidate does not open a database connection to run them.
 */
export const P1_SCHEMA_PROBE_SQL = `
SELECT
  c.udt_name,
  c.data_type,
  c.is_nullable,
  c.column_default
FROM information_schema.columns c
WHERE c.table_schema = 'public'
  AND c.table_name = 'BatchCreationCommand'
  AND c.column_name = 'receiptProvenanceSnapshot';

SELECT
  pg_get_constraintdef(oid) AS definition,
  convalidated AS validated
FROM pg_constraint
WHERE conrelid = '"BatchCreationCommand"'::regclass
  AND conname = 'BatchCreationCommand_receiptProvenanceSnapshot_shape'
  AND contype = 'c';

SELECT
  pg_get_functiondef(p.oid) AS definition,
  p.prosecdef AS security_definer
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname = 'batch_creation_command_provenance_guard';

SELECT
  t.tgenabled::text AS enabled,
  pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
WHERE t.tgrelid = '"BatchCreationCommand"'::regclass
  AND NOT t.tgisinternal
  AND t.tgname = 'batch_creation_command_provenance_guard';
`.trim();

export const P1_IDENTITY_PROBE_SQL = `
SELECT
  current_database() AS current_database,
  current_setting('server_version_num')::int AS server_version_num,
  run_id,
  nonce,
  container_id
FROM stell22_p1_disposable_identity
WHERE singleton = true
`.trim();

export const P1_HISTORY_PROBE_SQL = `
SELECT
  migration_name,
  checksum,
  started_at,
  finished_at,
  rolled_back_at,
  applied_steps_count
FROM "_prisma_migrations"
`.trim();

export type P1SchemaEvidence = {
  column: null | {
    dataType: string;
    isNullable: "YES" | "NO";
    columnDefault: string | null;
  };
  check: null | {
    definition: string;
    validated: boolean;
  };
  functionDef: null | {
    definition: string;
    securityDefiner: boolean;
  };
  trigger: null | {
    enabled: string;
    definition: string;
  };
  foreignKeyCount: number;
  extraTriggerNames: readonly string[];
  unexpectedObjects: readonly string[];
};

export function absentP1Schema(): P1SchemaEvidence {
  return {
    column: null,
    check: null,
    functionDef: null,
    trigger: null,
    foreignKeyCount: 0,
    extraTriggerNames: [],
    unexpectedObjects: [],
  };
}

export function columnMatchesContract(column: NonNullable<P1SchemaEvidence["column"]>): boolean {
  return (
    column.dataType === "jsonb" && column.isNullable === "YES" && column.columnDefault === null
  );
}

export function checkMatchesContract(check: NonNullable<P1SchemaEvidence["check"]>): boolean {
  const definition = check.definition;
  return (
    check.validated === true &&
    !/NOT VALID/i.test(definition) &&
    definition.includes("receiptProvenanceSnapshot") &&
    /IS NULL/i.test(definition) &&
    definition.includes("jsonb_typeof") &&
    definition.includes("object")
  );
}

export function functionMatchesContract(
  functionDef: NonNullable<P1SchemaEvidence["functionDef"]>,
): boolean {
  const definition = functionDef.definition;
  return (
    functionDef.securityDefiner === false &&
    !/SECURITY DEFINER/i.test(definition) &&
    definition.includes("legacy batch creation command provenance cannot be filled") &&
    definition.includes("batch creation command provenance is immutable") &&
    definition.includes("batch creation command provenance is retained")
  );
}

export function triggerMatchesContract(trigger: NonNullable<P1SchemaEvidence["trigger"]>): boolean {
  const definition = trigger.definition;
  return (
    trigger.enabled === "O" &&
    /BEFORE/i.test(definition) &&
    /\bUPDATE\b/.test(definition) &&
    /\bDELETE\b/.test(definition) &&
    !/\bINSERT\b/.test(definition) &&
    definition.includes("batch_creation_command_provenance_guard")
  );
}

export type SchemaShape = "absent" | "partial" | "match" | "mismatch" | "altered";

export function classifySchemaShape(schema: P1SchemaEvidence): SchemaShape {
  const present = [schema.column, schema.check, schema.functionDef, schema.trigger].filter(
    (part) => part !== null,
  ).length;
  const altered =
    schema.foreignKeyCount !== 0 ||
    schema.extraTriggerNames.length > 0 ||
    schema.unexpectedObjects.length > 0;
  if (present === 0 && !altered) return "absent";
  if (present === 0 && altered) return "altered";
  if (present < 4) return "partial";
  if (altered) return "altered";
  const matched =
    schema.column !== null &&
    schema.check !== null &&
    schema.functionDef !== null &&
    schema.trigger !== null &&
    columnMatchesContract(schema.column) &&
    checkMatchesContract(schema.check) &&
    functionMatchesContract(schema.functionDef) &&
    triggerMatchesContract(schema.trigger);
  return matched ? "match" : "mismatch";
}
