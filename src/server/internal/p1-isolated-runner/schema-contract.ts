/**
 * Catalog contract for the P1 object set.
 * These statements are the contract for a future disposable session.
 * This candidate does not open a database connection to run them.
 *
 * Identity uses pg_namespace joins. Nothing here resolves through search_path.
 * A future reader must set matchCount to the number of rows and must not
 * keep an arbitrary first row when that count is not 1.
 *
 * ALREADY_APPLIED requires the structural checks below. Keyword presence is
 * not acceptance. Live PostgreSQL deparsing of pg_get_* is not executed here,
 * so an unqualified name or an unproven format stays a mismatch.
 */
export const P1_SCHEMA_PROBE_SQL = `
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  a.attname AS column_name,
  t.typname AS udt_name,
  CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
  pg_get_expr(ad.adbin, ad.adrelid) AS column_default
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE n.nspname = 'public'
  AND c.relname = 'BatchCreationCommand'
  AND a.attname = 'receiptProvenanceSnapshot'
  AND a.attnum > 0
  AND NOT a.attisdropped;

SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  con.conname AS constraint_name,
  pg_get_constraintdef(con.oid, true) AS definition,
  con.convalidated AS validated
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'BatchCreationCommand'
  AND con.conname = 'BatchCreationCommand_receiptProvenanceSnapshot_shape'
  AND con.contype = 'c';

SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  l.lanname AS language,
  p.prosecdef AS security_definer,
  pg_get_functiondef(p.oid) AS definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = 'public'
  AND p.proname = 'batch_creation_command_provenance_guard';

SELECT
  tn.nspname AS schema_name,
  c.relname AS table_name,
  t.tgname AS trigger_name,
  t.tgenabled::text AS enabled,
  pg_get_triggerdef(t.oid, true) AS definition,
  fn.nspname AS function_schema,
  fp.proname AS function_name,
  pg_get_function_identity_arguments(fp.oid) AS function_identity_arguments
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace tn ON tn.oid = c.relnamespace
JOIN pg_proc fp ON fp.oid = t.tgfoid
JOIN pg_namespace fn ON fn.oid = fp.pronamespace
WHERE tn.nspname = 'public'
  AND c.relname = 'BatchCreationCommand'
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
FROM public.stell22_p1_disposable_identity
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
FROM public."_prisma_migrations"
`.trim();

export type P1SchemaEvidence = {
  column: null | {
    schemaName: string;
    tableName: string;
    matchCount: number;
    dataType: string;
    udtName: string;
    isNullable: "YES" | "NO";
    columnDefault: string | null;
  };
  check: null | {
    schemaName: string;
    tableName: string;
    constraintName: string;
    matchCount: number;
    definition: string;
    validated: boolean;
  };
  functionDef: null | {
    schemaName: string;
    functionName: string;
    identityArguments: string;
    matchCount: number;
    language: string;
    definition: string;
    securityDefiner: boolean;
  };
  trigger: null | {
    schemaName: string;
    tableName: string;
    triggerName: string;
    matchCount: number;
    enabled: string;
    definition: string;
    functionSchema: string;
    functionName: string;
    functionIdentityArguments: string;
  };
  foreignKeyCount: number;
  extraTriggerNames: readonly string[];
  unexpectedObjects: readonly string[];
};

const GUARD = "batch_creation_command_provenance_guard";
const TABLE = "BatchCreationCommand";
const COLUMN = "receiptProvenanceSnapshot";

/** Body of the P1 function, whitespace-normalized. Comments are not part of it. */
export const P1_FUNCTION_BODY = normalizeSql(
  `
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."receiptProvenanceSnapshot" IS NOT NULL THEN
      RAISE EXCEPTION 'batch creation command provenance is retained';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."receiptProvenanceSnapshot" IS NULL THEN
    IF NEW."receiptProvenanceSnapshot" IS NOT NULL THEN
      RAISE EXCEPTION 'legacy batch creation command provenance cannot be filled';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."receiptProvenanceSnapshot" IS DISTINCT FROM OLD."receiptProvenanceSnapshot"
     OR NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."requestId" IS DISTINCT FROM OLD."requestId"
     OR NEW."batchId" IS DISTINCT FROM OLD."batchId" THEN
    RAISE EXCEPTION 'batch creation command provenance is immutable';
  END IF;
  RETURN NEW;
END;
`.trim(),
);

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
    column.schemaName === "public" &&
    column.tableName === TABLE &&
    column.matchCount === 1 &&
    column.dataType === "jsonb" &&
    column.udtName === "jsonb" &&
    column.isNullable === "YES" &&
    column.columnDefault === null
  );
}

export function checkMatchesContract(check: NonNullable<P1SchemaEvidence["check"]>): boolean {
  if (!identityOk(check.schemaName, check.tableName, check.matchCount)) return false;
  if (check.constraintName !== "BatchCreationCommand_receiptProvenanceSnapshot_shape") return false;
  if (check.validated !== true) return false;
  return checkExpressionMatches(check.definition);
}

export function functionMatchesContract(
  functionDef: NonNullable<P1SchemaEvidence["functionDef"]>,
): boolean {
  if (functionDef.schemaName !== "public" || functionDef.functionName !== GUARD) return false;
  if (functionDef.identityArguments !== "" || functionDef.matchCount !== 1) return false;
  if (functionDef.language !== "plpgsql" || functionDef.securityDefiner !== false) return false;
  const parts = splitFunction(functionDef.definition);
  if (!parts) return false;
  if (!functionHeaderMatches(parts.header)) return false;
  return normalizeSql(parts.body) === P1_FUNCTION_BODY;
}

export function triggerMatchesContract(trigger: NonNullable<P1SchemaEvidence["trigger"]>): boolean {
  if (!identityOk(trigger.schemaName, trigger.tableName, trigger.matchCount)) return false;
  if (trigger.triggerName !== GUARD || trigger.enabled !== "O") return false;
  if (trigger.functionSchema !== "public" || trigger.functionName !== GUARD) return false;
  if (trigger.functionIdentityArguments !== "") return false;
  return triggerDefinitionMatches(trigger.definition);
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

function identityOk(schemaName: string, tableName: string, matchCount: number): boolean {
  return schemaName === "public" && tableName === TABLE && matchCount === 1;
}

type Expr =
  | { kind: "isnull"; column: string }
  | { kind: "call"; name: string; args: Expr[] }
  | { kind: "eq"; left: Expr; right: Expr }
  | { kind: "or"; left: Expr; right: Expr }
  | { kind: "lit"; value: string; cast: string | null }
  | { kind: "other" };

type Tok = { kind: "id" | "qid" | "str" | "sym"; value: string };

function checkExpressionMatches(definition: string): boolean {
  const tokens = tokenize(stripComments(definition));
  let index = 0;
  if (takeId(tokens, index, "check") === null) return false;
  index = takeId(tokens, index, "check") as number;
  if (tokens[index]?.kind !== "sym" || tokens[index]?.value !== "(") return false;
  index += 1;
  const parsed = parseOr(tokens, index);
  if (!parsed) return false;
  index = parsed.index;
  if (tokens[index]?.kind !== "sym" || tokens[index]?.value !== ")") return false;
  index += 1;
  if (index !== tokens.length) return false;
  return isPinnedCheck(parsed.expr);
}

function isPinnedCheck(expr: Expr): boolean {
  return (
    expr.kind === "or" &&
    expr.left.kind === "isnull" &&
    expr.left.column === COLUMN &&
    expr.right.kind === "eq" &&
    expr.right.left.kind === "call" &&
    expr.right.left.name === "jsonb_typeof" &&
    expr.right.left.args.length === 1 &&
    quotedColumn(expr.right.left.args[0]) === COLUMN &&
    expr.right.right.kind === "lit" &&
    expr.right.right.value === "object" &&
    (expr.right.right.cast === null || expr.right.right.cast === "text")
  );
}

function quotedColumn(expr: Expr | undefined): string | null {
  if (!expr || expr.kind !== "call" || expr.args.length !== 0) return null;
  return expr.name;
}

function parseOr(tokens: Tok[], index: number): { expr: Expr; index: number } | null {
  let left = parseUnary(tokens, index);
  if (!left) return null;
  while (isId(tokens[left.index], "or")) {
    const right = parseUnary(tokens, left.index + 1);
    if (!right) return null;
    left = { expr: { kind: "or", left: left.expr, right: right.expr }, index: right.index };
  }
  return left;
}

function parseUnary(tokens: Tok[], index: number): { expr: Expr; index: number } | null {
  if (isId(tokens[index], "not") || isId(tokens[index], "and")) {
    return { expr: { kind: "other" }, index: tokens.length };
  }
  const current = parseAtom(tokens, index);
  if (!current) return null;
  if (isId(tokens[current.index], "is")) {
    let cursor = current.index + 1;
    let negated = false;
    if (isId(tokens[cursor], "not")) {
      negated = true;
      cursor += 1;
    }
    if (!isId(tokens[cursor], "null")) return null;
    if (negated || current.expr.kind !== "call") {
      return { expr: { kind: "other" }, index: tokens.length };
    }
    const column = current.expr.name;
    if (current.expr.args.length !== 0) return { expr: { kind: "other" }, index: tokens.length };
    return { expr: { kind: "isnull", column }, index: cursor + 1 };
  }
  if (tokens[current.index]?.kind === "sym" && tokens[current.index]?.value === "=") {
    const right = parseAtom(tokens, current.index + 1);
    if (!right) return null;
    return { expr: { kind: "eq", left: current.expr, right: right.expr }, index: right.index };
  }
  return current;
}

function parseAtom(tokens: Tok[], index: number): { expr: Expr; index: number } | null {
  const token = tokens[index];
  if (!token) return null;
  if (token.kind === "sym" && token.value === "(") {
    const inner = parseOr(tokens, index + 1);
    if (!inner) return null;
    if (tokens[inner.index]?.kind !== "sym" || tokens[inner.index]?.value !== ")") return null;
    return { expr: inner.expr, index: inner.index + 1 };
  }
  if (token.kind === "str") {
    let cursor = index + 1;
    let cast: string | null = null;
    if (tokens[cursor]?.kind === "sym" && tokens[cursor]?.value === "::") {
      const typeName = tokens[cursor + 1];
      if (!typeName || typeName.kind !== "id") return null;
      cast = typeName.value;
      cursor += 2;
    }
    return { expr: { kind: "lit", value: token.value, cast }, index: cursor };
  }
  if (token.kind !== "id" && token.kind !== "qid") return null;
  if (tokens[index + 1]?.kind === "sym" && tokens[index + 1]?.value === ".") return null;
  if (tokens[index + 1]?.kind === "sym" && tokens[index + 1]?.value === "(") {
    const args: Expr[] = [];
    let cursor = index + 2;
    if (!(tokens[cursor]?.kind === "sym" && tokens[cursor]?.value === ")")) {
      while (cursor < tokens.length) {
        const arg = parseOr(tokens, cursor);
        if (!arg) return null;
        args.push(arg.expr);
        cursor = arg.index;
        if (tokens[cursor]?.kind === "sym" && tokens[cursor]?.value === ",") {
          cursor += 1;
          continue;
        }
        break;
      }
    }
    if (!(tokens[cursor]?.kind === "sym" && tokens[cursor]?.value === ")")) return null;
    if (token.kind !== "id") return null;
    return { expr: { kind: "call", name: token.value, args }, index: cursor + 1 };
  }
  if (token.kind !== "qid") return { expr: { kind: "other" }, index: index + 1 };
  return { expr: { kind: "call", name: token.value, args: [] }, index: index + 1 };
}

function functionHeaderMatches(header: string): boolean {
  const text = normalizeSql(header);
  if (
    !text.toLowerCase().startsWith("create function") &&
    !text.toLowerCase().startsWith("create or replace function")
  ) {
    return false;
  }
  if (/\bsecurity\s+definer\b/i.test(text)) return false;
  const qualified = new RegExp(
    String.raw`\bfunction\s+public\.(?:"${GUARD}"|${GUARD})\s*\(\s*\)`,
    "i",
  );
  return (
    qualified.test(text) &&
    /\breturns\s+trigger\b/i.test(text) &&
    /\blanguage\s+plpgsql\b/i.test(text)
  );
}

function triggerDefinitionMatches(definition: string): boolean {
  const tokens = tokenize(stripComments(definition));
  let index = 0;
  const step = (kind: Tok["kind"], value: string): boolean => {
    const token = tokens[index];
    if (!token || token.kind !== kind || token.value.toLowerCase() !== value.toLowerCase())
      return false;
    index += 1;
    return true;
  };
  if (!step("id", "create") || !step("id", "trigger")) return false;
  if (readName(tokens, index) !== GUARD) return false;
  index += 1;
  if (!step("id", "before")) return false;
  const events: string[] = [];
  const first = readName(tokens, index);
  if (!first) return false;
  events.push(first.toUpperCase());
  index += 1;
  while (isId(tokens[index], "or")) {
    index += 1;
    const next = readName(tokens, index);
    if (!next) return false;
    events.push(next.toUpperCase());
    index += 1;
  }
  if (new Set(events).size !== 2 || !events.includes("UPDATE") || !events.includes("DELETE"))
    return false;
  if (!step("id", "on")) return false;
  const table = readQualified(tokens, index);
  if (!table || table.name !== `public.${TABLE}`) return false;
  index = table.index;
  if (!step("id", "for") || !step("id", "each") || !step("id", "row")) return false;
  if (!step("id", "execute") || !step("id", "function")) return false;
  const fn = readQualified(tokens, index);
  if (!fn || fn.name !== `public.${GUARD}`) return false;
  index = fn.index;
  if (!step("sym", "(") || !step("sym", ")")) return false;
  return index === tokens.length;
}

function readName(tokens: Tok[], index: number): string | null {
  const token = tokens[index];
  if (!token || (token.kind !== "id" && token.kind !== "qid")) return null;
  return token.value;
}

function readQualified(tokens: Tok[], index: number): { name: string; index: number } | null {
  const schema = readName(tokens, index);
  if (!schema) return null;
  if (tokens[index + 1]?.kind !== "sym" || tokens[index + 1]?.value !== ".") return null;
  const objectName = readName(tokens, index + 2);
  if (!objectName) return null;
  return { name: `${schema}.${objectName}`, index: index + 3 };
}

function splitFunction(definition: string): { header: string; body: string } | null {
  const text = definition;
  const marker = /\bas\s+(\$[A-Za-z0-9_]*\$)/i.exec(text);
  if (!marker || marker.index === undefined) return null;
  const tag = marker[1];
  if (!tag) return null;
  const bodyStart = marker.index + marker[0].length;
  const bodyEnd = text.indexOf(tag, bodyStart);
  if (bodyEnd < 0) return null;
  return { header: text.slice(0, marker.index), body: text.slice(bodyStart, bodyEnd) };
}

function normalizeSql(sql: string): string {
  return stripComments(sql).replace(/\s+/g, " ").trim();
}

function stripComments(sql: string): string {
  let out = "";
  let index = 0;
  while (index < sql.length) {
    const pair = sql.slice(index, index + 2);
    if (pair === "--") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (pair === "/*") {
      index += 2;
      while (index < sql.length && sql.slice(index, index + 2) !== "*/") index += 1;
      index += 2;
      continue;
    }
    if (sql[index] === "'") {
      out += sql[index];
      index += 1;
      while (index < sql.length) {
        out += sql[index];
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") {
            out += sql[index + 1];
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    out += sql[index];
    index += 1;
  }
  return out;
}

function tokenize(sql: string): Tok[] {
  const tokens: Tok[] = [];
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (!char || /\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'") {
      let value = "";
      index += 1;
      while (index < sql.length) {
        if (sql[index] === "'" && sql[index + 1] === "'") {
          value += "'";
          index += 2;
          continue;
        }
        if (sql[index] === "'") {
          index += 1;
          break;
        }
        value += sql[index];
        index += 1;
      }
      tokens.push({ kind: "str", value });
      continue;
    }
    if (char === '"') {
      let value = "";
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          value += '"';
          index += 2;
          continue;
        }
        if (sql[index] === '"') {
          index += 1;
          break;
        }
        value += sql[index];
        index += 1;
      }
      tokens.push({ kind: "qid", value });
      continue;
    }
    if (sql.startsWith("::", index)) {
      tokens.push({ kind: "sym", value: "::" });
      index += 2;
      continue;
    }
    if ("().,".includes(char)) {
      tokens.push({ kind: "sym", value: char });
      index += 1;
      continue;
    }
    if (char === "=") {
      tokens.push({ kind: "sym", value: "=" });
      index += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let value = "";
      while (index < sql.length && /[A-Za-z0-9_]/.test(sql[index] ?? "")) {
        value += sql[index];
        index += 1;
      }
      tokens.push({ kind: "id", value: value.toLowerCase() });
      continue;
    }
    return [];
  }
  return tokens;
}

function takeId(tokens: Tok[], index: number, value: string): number | null {
  return isId(tokens[index], value) ? index + 1 : null;
}

function isId(token: Tok | undefined, value: string): boolean {
  return token?.kind === "id" && token.value === value;
}
