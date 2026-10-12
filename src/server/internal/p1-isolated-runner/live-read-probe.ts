import { Prisma, PrismaClient } from "@prisma/client";
import {
  FORBIDDEN_DATABASE_NAMES,
  FORBIDDEN_HOSTS,
  LOOPBACK_HOSTS,
  type RunnerVerdict,
} from "@/server/internal/p1-isolated-runner/contract";
import {
  classifyP1State,
  type Classification,
  type PrismaMigrationRow,
} from "@/server/internal/p1-isolated-runner/classify";
import {
  parseDisposableAttestation,
  type DisposableAttestation,
} from "@/server/internal/p1-isolated-runner/disposable-target";
import type { P1SchemaEvidence } from "@/server/internal/p1-isolated-runner/schema-contract";

/**
 * Read-only PostgreSQL evidence for the disposable P1 runner.
 * The session guard runs inside one repeatable-read transaction.
 * Effective read-only state, timeouts, database identity, and the nonce
 * are checked before history or catalog queries. A failed gate does not
 * issue the later queries. Structural classification stays on
 * `classification`. Container origin is not inspected, so the top-level
 * verdict cannot authorize apply.
 */

const CONTAINER_ORIGIN = {
  status: "NOT_ESTABLISHED" as const,
  reason: "This package does not inspect Docker or any external container runtime",
};

const FULL_AUTHENTICATION = {
  status: "NOT_CLAIMED" as const,
  reason: "Connection evidence and database identity do not establish container origin",
};

const STATEMENT_TIMEOUT_MS = 5_000;
const LOCK_TIMEOUT_MS = 2_000;

export const DISPOSABLE_SESSION_GUARD_SQL = `
SELECT
  pg_catalog.set_config('default_transaction_read_only', 'on', false) AS default_transaction_read_only,
  pg_catalog.set_config('transaction_read_only', 'on', true) AS transaction_read_only,
  pg_catalog.set_config('statement_timeout', '5000', false) AS statement_timeout,
  pg_catalog.set_config('lock_timeout', '2000', false) AS lock_timeout,
  pg_catalog.set_config('search_path', 'pg_catalog', false) AS search_path
`.trim();

const SESSION_SQL = `
SELECT
  pg_catalog.current_setting('transaction_read_only') AS transaction_read_only,
  pg_catalog.current_setting('default_transaction_read_only') AS default_transaction_read_only,
  pg_catalog.current_setting('statement_timeout') AS statement_timeout,
  pg_catalog.current_setting('lock_timeout') AS lock_timeout,
  pg_catalog.current_setting('search_path') AS search_path,
  pg_catalog.current_setting('transaction_isolation') AS transaction_isolation,
  pg_catalog.pg_backend_pid() AS backend_pid,
  CAST(pg_catalog.pg_current_snapshot() AS pg_catalog.text) AS snapshot_id
`.trim();

const CONNECTION_SQL = `
SELECT
  pg_catalog.current_database() AS current_database,
  pg_catalog.current_setting('server_version_num') AS server_version_num
`.trim();

const IDENTITY_SQL = `
SELECT run_id, nonce, container_id
FROM public.stell22_p1_disposable_identity
WHERE singleton = true
`.trim();

const HISTORY_SQL = `
SELECT
  migration_name,
  checksum,
  started_at,
  finished_at,
  rolled_back_at,
  applied_steps_count
FROM public."_prisma_migrations"
`.trim();

const COLUMN_SQL = `
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  t.typname AS udt_name,
  pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
  CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
  pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS column_default
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
`.trim();

const CHECK_SQL = `
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  con.conname AS constraint_name,
  pg_catalog.pg_get_constraintdef(con.oid, true) AS definition,
  con.convalidated AS validated
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'BatchCreationCommand'
  AND con.conname = 'BatchCreationCommand_receiptProvenanceSnapshot_shape'
  AND con.contype = 'c'
`.trim();

const FUNCTION_SQL = `
SELECT
  n.nspname AS schema_name,
  p.proname AS function_name,
  pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
  l.lanname AS language,
  p.prosecdef AS security_definer,
  pg_catalog.pg_get_functiondef(p.oid) AS definition
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
JOIN pg_catalog.pg_language l ON l.oid = p.prolang
WHERE n.nspname = 'public'
  AND p.proname = 'batch_creation_command_provenance_guard'
`.trim();

const TRIGGER_SQL = `
SELECT
  tn.nspname AS schema_name,
  c.relname AS table_name,
  t.tgname AS trigger_name,
  t.tgenabled::text AS enabled,
  pg_catalog.pg_get_triggerdef(t.oid, true) AS definition,
  fn.nspname AS function_schema,
  fp.proname AS function_name,
  pg_catalog.pg_get_function_identity_arguments(fp.oid) AS function_identity_arguments
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace tn ON tn.oid = c.relnamespace
JOIN pg_catalog.pg_proc fp ON fp.oid = t.tgfoid
JOIN pg_catalog.pg_namespace fn ON fn.oid = fp.pronamespace
WHERE tn.nspname = 'public'
  AND c.relname = 'BatchCreationCommand'
  AND NOT t.tgisinternal
  AND t.tgname = 'batch_creation_command_provenance_guard'
`.trim();

const EXTRA_TRIGGER_SQL = `
SELECT t.tgname AS trigger_name
FROM pg_catalog.pg_trigger t
JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'BatchCreationCommand'
  AND NOT t.tgisinternal
  AND t.tgname <> 'batch_creation_command_provenance_guard'
`.trim();

const UNEXPECTED_SQL = `
SELECT n.nspname AS schema_name, p.proname AS object_name
FROM pg_catalog.pg_proc p
JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname <> 'batch_creation_command_provenance_guard'
  AND (p.proname LIKE '%provenance%' OR p.proname LIKE '%receipt%')
UNION ALL
SELECT n.nspname AS schema_name, con.conname AS object_name
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'BatchCreationCommand'
  AND con.contype = 'c'
  AND con.conname <> 'BatchCreationCommand_receiptProvenanceSnapshot_shape'
  AND (con.conname LIKE '%provenance%' OR con.conname LIKE '%receipt%')
`.trim();

const FOREIGN_KEY_SQL = `
SELECT count(*)::int AS foreign_key_count
FROM pg_catalog.pg_constraint con
JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname = 'BatchCreationCommand'
  AND con.contype = 'f'
`.trim();

export const DISPOSABLE_READ_SQL = {
  session: SESSION_SQL,
  connection: CONNECTION_SQL,
  identity: IDENTITY_SQL,
  history: HISTORY_SQL,
  column: COLUMN_SQL,
  check: CHECK_SQL,
  function: FUNCTION_SQL,
  trigger: TRIGGER_SQL,
  extraTriggers: EXTRA_TRIGGER_SQL,
  unexpectedObjects: UNEXPECTED_SQL,
  foreignKeys: FOREIGN_KEY_SQL,
} as const;

export type ProbeFailure = { failed: true; sqlState: string | null };
export type ProbeQuery = Record<string, unknown>[] | ProbeFailure;
export type ProbeBatch = Record<keyof typeof DISPOSABLE_READ_SQL, ProbeQuery>;

export type LiveEvidenceSource = "caller-supplied-rows" | "injected-connector" | "postgresql-query";

export type LiveReadReport = {
  evidenceSource: LiveEvidenceSource;
  connection: {
    status: "established" | "failed";
    currentDatabase: string | null;
    serverVersionNum: number | null;
  };
  postgresIdentity: {
    status: "row-read" | "query-failed" | "absent" | "not-run";
    runId: string | null;
    nonce: string | null;
    containerId: string | null;
    rowCount: number | null;
  };
  containerOrigin: typeof CONTAINER_ORIGIN;
  fullTargetAuthentication: typeof FULL_AUTHENTICATION;
  applyEnabled: false;
  classification: Classification | null;
  schema: P1SchemaEvidence | null;
  verdict: RunnerVerdict;
  code: string;
  failedQuery: keyof typeof DISPOSABLE_READ_SQL | null;
  message: string;
};

const CATALOG_QUERIES = [
  "column",
  "check",
  "function",
  "trigger",
  "extraTriggers",
  "unexpectedObjects",
  "foreignKeys",
] as const satisfies readonly (keyof typeof DISPOSABLE_READ_SQL)[];

const AUTHORIZATION_CODE = "CONTAINER_ORIGIN_NOT_ESTABLISHED";

type SessionProof = { backendPid: number; snapshotId: string };

export type ProbeSqlClient = {
  query(sql: string): Promise<unknown>;
  readOnlySnapshot<T>(fn: (query: (sql: string) => Promise<unknown>) => Promise<T>): Promise<T>;
  end(): Promise<void>;
};

export function assessDisposableRead(raw: unknown, batch: ProbeBatch): LiveReadReport {
  const attestation = parseDisposableAttestation(raw);
  const session = stopOnQuery(batch, "session");
  if (session.kind === "stop") return session.report;
  if (!sessionProtected(session.rows)) {
    return stop(
      "session",
      "SESSION_PROTECTION_FAILED",
      "Read-only session protection is not active",
    );
  }

  const connection = stopOnQuery(batch, "connection");
  if (connection.kind === "stop") return connection.report;
  const connected = readConnection(connection.rows);
  if (connected.kind === "malformed") {
    return stop("connection", "MALFORMED_CATALOG_RESULT", "Connection evidence is malformed");
  }
  const established = base(connected.value);
  if (
    connected.value.currentDatabase !== attestation.databaseName ||
    isForbiddenDatabase(connected.value.currentDatabase)
  ) {
    return {
      ...established,
      code: "WRONG_DATABASE_IDENTITY",
      verdict: "STOP",
      message: "Connected database is not this disposable run",
    };
  }
  if (connected.value.serverVersionNum < 170000 || connected.value.serverVersionNum >= 180000) {
    return {
      ...established,
      code: "WRONG_DATABASE_IDENTITY",
      verdict: "STOP",
      message: "Connected server is not PostgreSQL 17",
    };
  }

  const identity = stopOnQuery(batch, "identity", established);
  if (identity.kind === "stop") return identity.report;
  const identified = readIdentity(identity.rows, established);
  if (identified.kind === "stop") return identified.report;
  if (identified.row.nonce !== attestation.nonce) {
    return {
      ...identified.report,
      code: "DISPOSABLE_NONCE_MISMATCH",
      verdict: "STOP",
      message: "Database nonce does not match the attestation",
    };
  }
  if (
    identified.row.runId !== attestation.runId ||
    identified.row.containerId !== attestation.containerId
  ) {
    return {
      ...identified.report,
      code: "DISPOSABLE_IDENTITY_MISMATCH",
      verdict: "STOP",
      message: "Database run identity does not match the attestation",
    };
  }

  const history = stopOnQuery(batch, "history", identified.report);
  if (history.kind === "stop") return history.report;
  const mappedHistory = readHistory(history.rows);
  if (mappedHistory.kind === "malformed") {
    return stop(
      "history",
      "MALFORMED_CATALOG_RESULT",
      "Migration history rows are malformed",
      identified.report,
    );
  }

  const schema = readSchema(batch, identified.report);
  if (schema.kind === "stop") return schema.report;
  const classification = classifyP1State({
    history: mappedHistory.rows,
    schema: schema.value,
  });
  return sealAuthorization(identified.report, classification, schema.value);
}

export async function previewDisposableRead(
  raw: unknown,
  connect: (url: string) => Promise<ProbeSqlClient>,
): Promise<LiveReadReport> {
  return runRead(raw, connect, "injected-connector");
}

export async function readDisposablePostgreSql(raw: unknown): Promise<LiveReadReport> {
  return runRead(raw, connectPrisma, "postgresql-query");
}

async function runRead(
  raw: unknown,
  connect: (url: string) => Promise<ProbeSqlClient>,
  evidenceSource: "injected-connector" | "postgresql-query",
): Promise<LiveReadReport> {
  const attestation = parseDisposableAttestation(raw);
  const url = buildDisposableReadUrl(attestation);
  let client: ProbeSqlClient;
  try {
    client = await connect(url);
  } catch {
    return tag(
      stop(null, "CONNECTION_UNAVAILABLE", "Disposable PostgreSQL connection failed"),
      evidenceSource,
    );
  }
  try {
    if (typeof client.readOnlySnapshot !== "function") {
      return tag(
        stop(
          "session",
          "SESSION_PROTECTION_FAILED",
          "Read-only transaction protection is unavailable",
        ),
        evidenceSource,
      );
    }
    const report = await client.readOnlySnapshot((query) =>
      readInsideSnapshot(attestation, query),
    );
    return tag(report, evidenceSource);
  } catch {
    return tag(
      stop(null, "SNAPSHOT_NOT_PROVEN", "Read-only snapshot could not be proven"),
      evidenceSource,
    );
  } finally {
    await client.end();
  }
}

async function readInsideSnapshot(
  attestation: DisposableAttestation,
  query: (sql: string) => Promise<unknown>,
): Promise<LiveReadReport> {
  const client = { query };
  const guard = await readQuery(client, DISPOSABLE_SESSION_GUARD_SQL);
  if (!Array.isArray(guard)) {
    return stop(
      "session",
      codeForFailure("session", guard.sqlState),
      failureMessage("session", guard.sqlState),
    );
  }

  const established = await takeProof(query);
  if (established.kind === "stop") return established.report;
  const confirmed = await confirmProof(query, established.proof);
  if (confirmed.kind === "stop") return confirmed.report;

  const connection = await readQuery(client, DISPOSABLE_READ_SQL.connection);
  if (!Array.isArray(connection)) {
    return stop(
      "connection",
      codeForFailure("connection", connection.sqlState),
      failureMessage("connection", connection.sqlState),
    );
  }
  const connected = readConnection(connection);
  if (connected.kind === "malformed") {
    return stop("connection", "MALFORMED_CATALOG_RESULT", "Connection evidence is malformed");
  }
  const connectedReport = base(connected.value);
  if (
    connected.value.currentDatabase !== attestation.databaseName ||
    isForbiddenDatabase(connected.value.currentDatabase)
  ) {
    return {
      ...connectedReport,
      code: "WRONG_DATABASE_IDENTITY",
      verdict: "STOP",
      message: "Connected database is not this disposable run",
    };
  }
  if (connected.value.serverVersionNum < 170000 || connected.value.serverVersionNum >= 180000) {
    return {
      ...connectedReport,
      code: "WRONG_DATABASE_IDENTITY",
      verdict: "STOP",
      message: "Connected server is not PostgreSQL 17",
    };
  }

  const beforeIdentity = await confirmProof(query, established.proof, connectedReport);
  if (beforeIdentity.kind === "stop") return beforeIdentity.report;
  const identity = await readQuery(client, DISPOSABLE_READ_SQL.identity);
  if (!Array.isArray(identity)) {
    return stop(
      "identity",
      codeForFailure("identity", identity.sqlState),
      failureMessage("identity", identity.sqlState),
      connectedReport,
    );
  }
  const identified = readIdentity(identity, connectedReport);
  if (identified.kind === "stop") return identified.report;
  if (identified.row.nonce !== attestation.nonce) {
    return {
      ...identified.report,
      code: "DISPOSABLE_NONCE_MISMATCH",
      verdict: "STOP",
      message: "Database nonce does not match the attestation",
    };
  }
  if (
    identified.row.runId !== attestation.runId ||
    identified.row.containerId !== attestation.containerId
  ) {
    return {
      ...identified.report,
      code: "DISPOSABLE_IDENTITY_MISMATCH",
      verdict: "STOP",
      message: "Database run identity does not match the attestation",
    };
  }

  const beforeHistory = await confirmProof(query, established.proof, identified.report);
  if (beforeHistory.kind === "stop") return beforeHistory.report;
  const history = await readQuery(client, DISPOSABLE_READ_SQL.history);
  if (!Array.isArray(history)) {
    return stop(
      "history",
      codeForFailure("history", history.sqlState),
      failureMessage("history", history.sqlState),
      identified.report,
    );
  }
  if (readHistory(history).kind === "malformed") {
    return stop(
      "history",
      "MALFORMED_CATALOG_RESULT",
      "Migration history rows are malformed",
      identified.report,
    );
  }

  const beforeCatalog = await confirmProof(query, established.proof, identified.report);
  if (beforeCatalog.kind === "stop") return beforeCatalog.report;
  const batch = {
    session: established.rows,
    connection,
    identity,
    history,
  } as ProbeBatch;
  for (const name of CATALOG_QUERIES) {
    const result = await readQuery(client, DISPOSABLE_READ_SQL[name]);
    batch[name] = result;
    if (!Array.isArray(result)) {
      return stop(
        name,
        codeForFailure(name, result.sqlState),
        failureMessage(name, result.sqlState),
        identified.report,
      );
    }
  }
  const afterCatalog = await confirmProof(query, established.proof, identified.report);
  if (afterCatalog.kind === "stop") return afterCatalog.report;
  return assessDisposableRead(attestation, batch);
}

function buildDisposableReadUrl(attestation: DisposableAttestation): string {
  if (!isLoopback(attestation.host) || isForbiddenHost(attestation.host)) {
    throw new Error("Disposable read URL host is not loopback");
  }
  const url = new URL("postgresql://127.0.0.1");
  url.username = attestation.user;
  url.password = attestation.password;
  url.hostname = attestation.host;
  url.port = String(attestation.port);
  url.pathname = `/${attestation.databaseName}`;
  url.searchParams.set("connect_timeout", "5");
  url.searchParams.set("pool_timeout", "5");
  url.searchParams.set("socket_timeout", "5");
  url.searchParams.set("connection_limit", "1");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database !== attestation.databaseName || isForbiddenDatabase(database)) {
    throw new Error("Disposable read URL database is not the attested run");
  }
  return url.toString();
}

async function connectPrisma(url: string): Promise<ProbeSqlClient> {
  const prisma = new PrismaClient({ datasourceUrl: url });
  await prisma.$connect();
  return {
    query: (sql) => prisma.$queryRawUnsafe(sql),
    readOnlySnapshot: (fn) =>
      prisma.$transaction((tx) => fn((sql) => tx.$queryRawUnsafe(sql)), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 2_000,
        timeout: 15_000,
      }),
    end: () => prisma.$disconnect(),
  };
}

async function readQuery(
  client: { query(sql: string): Promise<unknown> },
  sql: string,
): Promise<ProbeQuery> {
  try {
    const result = await client.query(sql);
    if (isProbeFailure(result)) return result;
    if (!Array.isArray(result)) return { failed: true, sqlState: null };
    return result as Record<string, unknown>[];
  } catch (error) {
    return { failed: true, sqlState: readSqlState(error) };
  }
}

function isProbeFailure(value: unknown): value is ProbeFailure {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as { failed?: unknown; sqlState?: unknown };
  return (
    record.failed === true &&
    (record.sqlState === null ||
      (typeof record.sqlState === "string" && /^[0-9A-Z]{5}$/.test(record.sqlState)))
  );
}

function stopOnQuery(
  batch: ProbeBatch,
  name: keyof typeof DISPOSABLE_READ_SQL,
  prior: LiveReadReport = emptyReport(),
): { kind: "rows"; rows: Record<string, unknown>[] } | { kind: "stop"; report: LiveReadReport } {
  const query = batch[name];
  if (Array.isArray(query)) return { kind: "rows", rows: query };
  return {
    kind: "stop",
    report: stop(
      name,
      codeForFailure(name, query.sqlState),
      failureMessage(name, query.sqlState),
      prior,
    ),
  };
}

function codeForFailure(name: keyof typeof DISPOSABLE_READ_SQL, sqlState: string | null): string {
  if (sqlState === "57014") return "QUERY_TIMEOUT";
  if (sqlState === "42501") return "MISSING_PERMISSIONS";
  if (name === "identity" && sqlState === "42P01") return "MISSING_IDENTITY_TABLE";
  if (name === "session") return "SESSION_PROTECTION_FAILED";
  if (name === "connection" && sqlState === null) return "CONNECTION_UNAVAILABLE";
  return "QUERY_FAILED";
}

function failureMessage(name: keyof typeof DISPOSABLE_READ_SQL, sqlState: string | null): string {
  if (sqlState === "57014") return "PostgreSQL cancelled the disposable read";
  if (sqlState === "42501") return "PostgreSQL denied the disposable read";
  if (name === "identity" && sqlState === "42P01") return "Disposable identity table is absent";
  return `Disposable read query ${name} failed`;
}

function sessionProtected(rows: readonly Record<string, unknown>[]): boolean {
  const row = rows[0];
  if (rows.length !== 1 || !row) return false;
  return (
    row.transaction_read_only === "on" &&
    row.default_transaction_read_only === "on" &&
    row.search_path === "pg_catalog" &&
    row.transaction_isolation === "repeatable read" &&
    timeoutMs(row.statement_timeout) === STATEMENT_TIMEOUT_MS &&
    timeoutMs(row.lock_timeout) === LOCK_TIMEOUT_MS &&
    readSessionProof(rows) !== null
  );
}

function readSessionProof(rows: readonly Record<string, unknown>[]): SessionProof | null {
  const row = rows[0];
  if (!row || rows.length !== 1) return null;
  const backendPid = readInteger(row.backend_pid);
  if (backendPid === null || backendPid <= 0) return null;
  if (typeof row.snapshot_id !== "string" || !/^[0-9]+:[0-9]+:[0-9,]*$/.test(row.snapshot_id)) {
    return null;
  }
  return { backendPid, snapshotId: row.snapshot_id };
}

async function takeProof(
  query: (sql: string) => Promise<unknown>,
  prior: LiveReadReport = emptyReport(),
): Promise<
  | { kind: "ok"; proof: SessionProof; rows: Record<string, unknown>[] }
  | { kind: "stop"; report: LiveReadReport }
> {
  const result = await readQuery({ query }, DISPOSABLE_READ_SQL.session);
  if (!Array.isArray(result)) {
    return {
      kind: "stop",
      report: stop(
        "session",
        codeForFailure("session", result.sqlState),
        failureMessage("session", result.sqlState),
        prior,
      ),
    };
  }
  const proof = readSessionProof(result);
  if (!sessionProtected(result) || !proof) {
    return {
      kind: "stop",
      report: stop(
        "session",
        "SESSION_PROTECTION_FAILED",
        "Read-only session protection is not active",
        prior,
      ),
    };
  }
  return { kind: "ok", proof, rows: result };
}

async function confirmProof(
  query: (sql: string) => Promise<unknown>,
  expected: SessionProof,
  prior: LiveReadReport = emptyReport(),
): Promise<{ kind: "ok" } | { kind: "stop"; report: LiveReadReport }> {
  const taken = await takeProof(query, prior);
  if (taken.kind === "stop") return taken;
  if (taken.proof.backendPid !== expected.backendPid) {
    return {
      kind: "stop",
      report: stop(
        "session",
        "CONNECTION_CONTINUITY_FAILED",
        "PostgreSQL connection continuity is not proven",
        prior,
      ),
    };
  }
  if (taken.proof.snapshotId !== expected.snapshotId) {
    return {
      kind: "stop",
      report: stop(
        "session",
        "SNAPSHOT_NOT_PROVEN",
        "Read-only snapshot is not consistent",
        prior,
      ),
    };
  }
  return { kind: "ok" };
}

function timeoutMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)(ms|s|min|h)?$/.exec(value.trim());
  if (!match?.[1]) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return null;
  const unit = match[2] ?? "ms";
  const factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "min" ? 60_000 : 3_600_000;
  const total = amount * factor;
  return Number.isSafeInteger(total) ? total : null;
}

function sealAuthorization(
  prior: LiveReadReport,
  classification: Classification,
  schema: P1SchemaEvidence,
): LiveReadReport {
  const structuralAuthorization =
    classification.verdict === "READY_FOR_DISPOSABLE_APPLY" ||
    classification.verdict === "ALREADY_APPLIED";
  return {
    ...prior,
    classification,
    schema,
    containerOrigin: CONTAINER_ORIGIN,
    fullTargetAuthentication: FULL_AUTHENTICATION,
    applyEnabled: false,
    verdict: structuralAuthorization ? "BLOCKED" : classification.verdict,
    code: structuralAuthorization ? AUTHORIZATION_CODE : classification.code,
    failedQuery: null,
    message: structuralAuthorization
      ? "Container origin is unverified, so structural classification is not apply authorization"
      : "PostgreSQL rows were classified with the structural contract",
  };
}

function tag(report: LiveReadReport, evidenceSource: LiveEvidenceSource): LiveReadReport {
  return { ...report, evidenceSource };
}

function readConnection(
  rows: readonly Record<string, unknown>[],
):
  | { kind: "ok"; value: { currentDatabase: string; serverVersionNum: number } }
  | { kind: "malformed" } {
  const row = rows[0];
  if (rows.length !== 1 || !row || typeof row.current_database !== "string")
    return { kind: "malformed" };
  const serverVersionNum = readInteger(row.server_version_num);
  if (serverVersionNum === null) return { kind: "malformed" };
  return { kind: "ok", value: { currentDatabase: row.current_database, serverVersionNum } };
}

function readIdentity(
  rows: readonly Record<string, unknown>[],
  prior: LiveReadReport,
):
  | {
      kind: "ok";
      row: { runId: string; nonce: string; containerId: string };
      report: LiveReadReport;
    }
  | { kind: "stop"; report: LiveReadReport } {
  if (rows.length === 0) {
    return {
      kind: "stop",
      report: {
        ...prior,
        postgresIdentity: { ...prior.postgresIdentity, status: "absent", rowCount: 0 },
        code: "MISSING_DISPOSABLE_IDENTITY",
        verdict: "STOP",
        message: "Disposable identity row is absent",
      },
    };
  }
  if (rows.length !== 1) {
    return {
      kind: "stop",
      report: {
        ...prior,
        postgresIdentity: { ...prior.postgresIdentity, status: "row-read", rowCount: rows.length },
        code: "DUPLICATE_IDENTITY_ROW",
        verdict: "STOP",
        message: "Disposable identity row is not unique",
      },
    };
  }
  const row = rows[0];
  if (
    !row ||
    typeof row.run_id !== "string" ||
    typeof row.nonce !== "string" ||
    typeof row.container_id !== "string"
  ) {
    return {
      kind: "stop",
      report: stop(
        "identity",
        "MALFORMED_CATALOG_RESULT",
        "Disposable identity row is malformed",
        prior,
      ),
    };
  }
  return {
    kind: "ok",
    row: { runId: row.run_id, nonce: row.nonce, containerId: row.container_id },
    report: {
      ...prior,
      postgresIdentity: {
        status: "row-read",
        runId: row.run_id,
        nonce: row.nonce,
        containerId: row.container_id,
        rowCount: 1,
      },
    },
  };
}

function readHistory(
  rows: readonly Record<string, unknown>[],
): { kind: "ok"; rows: PrismaMigrationRow[] } | { kind: "malformed" } {
  const mapped: PrismaMigrationRow[] = [];
  for (const row of rows) {
    const startedAt = readTimestamp(row.started_at);
    const finishedAt = readTimestamp(row.finished_at);
    const rolledBackAt = readTimestamp(row.rolled_back_at);
    const appliedStepsCount = readInteger(row.applied_steps_count);
    if (
      typeof row.migration_name !== "string" ||
      typeof row.checksum !== "string" ||
      startedAt === undefined ||
      finishedAt === undefined ||
      rolledBackAt === undefined ||
      appliedStepsCount === null
    ) {
      return { kind: "malformed" };
    }
    mapped.push({
      migrationName: row.migration_name,
      checksum: row.checksum,
      startedAt,
      finishedAt,
      rolledBackAt,
      appliedStepsCount,
    });
  }
  return { kind: "ok", rows: mapped };
}

function readSchema(
  batch: ProbeBatch,
  prior: LiveReadReport,
): { kind: "ok"; value: P1SchemaEvidence } | { kind: "stop"; report: LiveReadReport } {
  const column = stopOnQuery(batch, "column", prior);
  if (column.kind === "stop") return column;
  const check = stopOnQuery(batch, "check", prior);
  if (check.kind === "stop") return check;
  const functionQuery = stopOnQuery(batch, "function", prior);
  if (functionQuery.kind === "stop") return functionQuery;
  const trigger = stopOnQuery(batch, "trigger", prior);
  if (trigger.kind === "stop") return trigger;
  const extraTriggers = stopOnQuery(batch, "extraTriggers", prior);
  if (extraTriggers.kind === "stop") return extraTriggers;
  const unexpected = stopOnQuery(batch, "unexpectedObjects", prior);
  if (unexpected.kind === "stop") return unexpected;
  const foreignKeys = stopOnQuery(batch, "foreignKeys", prior);
  if (foreignKeys.kind === "stop") return foreignKeys;

  const mappedColumn = mapColumn(column.rows);
  const mappedCheck = mapCheck(check.rows);
  const mappedFunction = mapFunction(functionQuery.rows);
  const mappedTrigger = mapTrigger(trigger.rows);
  const mappedExtra = mapNames(extraTriggers.rows, "trigger_name");
  const mappedUnexpected = mapQualified(unexpected.rows);
  const foreignKeyCount = mapForeignKeyCount(foreignKeys.rows);
  if (
    mappedColumn === "malformed" ||
    mappedCheck === "malformed" ||
    mappedFunction === "malformed" ||
    mappedTrigger === "malformed" ||
    mappedExtra === "malformed" ||
    mappedUnexpected === "malformed" ||
    foreignKeyCount === null
  ) {
    return {
      kind: "stop",
      report: stop("check", "MALFORMED_CATALOG_RESULT", "Catalog evidence is malformed", prior),
    };
  }
  return {
    kind: "ok",
    value: {
      column: mappedColumn,
      check: mappedCheck,
      functionDef: mappedFunction,
      trigger: mappedTrigger,
      foreignKeyCount,
      extraTriggerNames: mappedExtra,
      unexpectedObjects: mappedUnexpected,
    },
  };
}

function mapColumn(
  rows: readonly Record<string, unknown>[],
): P1SchemaEvidence["column"] | "malformed" {
  if (rows.length === 0) return null;
  const row = rows[0];
  if (
    !row ||
    typeof row.schema_name !== "string" ||
    typeof row.table_name !== "string" ||
    typeof row.udt_name !== "string" ||
    typeof row.data_type !== "string" ||
    (row.is_nullable !== "YES" && row.is_nullable !== "NO") ||
    (row.column_default !== null && typeof row.column_default !== "string")
  ) {
    return "malformed";
  }
  return {
    schemaName: row.schema_name,
    tableName: row.table_name,
    matchCount: rows.length,
    dataType: row.data_type,
    udtName: row.udt_name,
    isNullable: row.is_nullable,
    columnDefault: row.column_default,
  };
}

function mapCheck(
  rows: readonly Record<string, unknown>[],
): P1SchemaEvidence["check"] | "malformed" {
  if (rows.length === 0) return null;
  const row = rows[0];
  if (
    !row ||
    typeof row.schema_name !== "string" ||
    typeof row.table_name !== "string" ||
    typeof row.constraint_name !== "string" ||
    typeof row.definition !== "string" ||
    typeof row.validated !== "boolean"
  ) {
    return "malformed";
  }
  return {
    schemaName: row.schema_name,
    tableName: row.table_name,
    constraintName: row.constraint_name,
    matchCount: rows.length,
    definition: row.definition,
    validated: row.validated,
  };
}

function mapFunction(
  rows: readonly Record<string, unknown>[],
): P1SchemaEvidence["functionDef"] | "malformed" {
  if (rows.length === 0) return null;
  const row = rows[0];
  if (
    !row ||
    typeof row.schema_name !== "string" ||
    typeof row.function_name !== "string" ||
    typeof row.identity_arguments !== "string" ||
    typeof row.language !== "string" ||
    typeof row.definition !== "string" ||
    typeof row.security_definer !== "boolean"
  ) {
    return "malformed";
  }
  return {
    schemaName: row.schema_name,
    functionName: row.function_name,
    identityArguments: row.identity_arguments,
    matchCount: rows.length,
    language: row.language,
    definition: row.definition,
    securityDefiner: row.security_definer,
  };
}

function mapTrigger(
  rows: readonly Record<string, unknown>[],
): P1SchemaEvidence["trigger"] | "malformed" {
  if (rows.length === 0) return null;
  const row = rows[0];
  if (
    !row ||
    typeof row.schema_name !== "string" ||
    typeof row.table_name !== "string" ||
    typeof row.trigger_name !== "string" ||
    typeof row.enabled !== "string" ||
    typeof row.definition !== "string" ||
    typeof row.function_schema !== "string" ||
    typeof row.function_name !== "string" ||
    typeof row.function_identity_arguments !== "string"
  ) {
    return "malformed";
  }
  return {
    schemaName: row.schema_name,
    tableName: row.table_name,
    triggerName: row.trigger_name,
    matchCount: rows.length,
    enabled: row.enabled,
    definition: row.definition,
    functionSchema: row.function_schema,
    functionName: row.function_name,
    functionIdentityArguments: row.function_identity_arguments,
  };
}

function mapNames(rows: readonly Record<string, unknown>[], key: string): string[] | "malformed" {
  const names: string[] = [];
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "string" || value.length === 0) return "malformed";
    names.push(value);
  }
  return names;
}

function mapQualified(rows: readonly Record<string, unknown>[]): string[] | "malformed" {
  const names: string[] = [];
  for (const row of rows) {
    if (typeof row.schema_name !== "string" || typeof row.object_name !== "string")
      return "malformed";
    names.push(`${row.schema_name}.${row.object_name}`);
  }
  return names;
}

function mapForeignKeyCount(rows: readonly Record<string, unknown>[]): number | null {
  const row = rows[0];
  if (rows.length !== 1 || !row) return null;
  return readInteger(row.foreign_key_count);
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (
    typeof value === "bigint" &&
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return Number(value);
  return null;
}

function readTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function readSqlState(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const meta = (error as { meta?: { code?: unknown } }).meta;
  if (typeof meta?.code === "string" && /^[0-9A-Z]{5}$/.test(meta.code)) return meta.code;
  return null;
}

function emptyReport(): LiveReadReport {
  return {
    evidenceSource: "caller-supplied-rows",
    connection: { status: "failed", currentDatabase: null, serverVersionNum: null },
    postgresIdentity: {
      status: "not-run",
      runId: null,
      nonce: null,
      containerId: null,
      rowCount: null,
    },
    containerOrigin: CONTAINER_ORIGIN,
    fullTargetAuthentication: FULL_AUTHENTICATION,
    applyEnabled: false,
    classification: null,
    schema: null,
    verdict: "STOP",
    code: "QUERY_FAILED",
    failedQuery: null,
    message: "Disposable read did not complete",
  };
}

function base(connection: { currentDatabase: string; serverVersionNum: number }): LiveReadReport {
  return {
    ...emptyReport(),
    connection: { status: "established", ...connection },
  };
}

function stop(
  failedQuery: keyof typeof DISPOSABLE_READ_SQL | null,
  code: string,
  message: string,
  prior: LiveReadReport = emptyReport(),
): LiveReadReport {
  const verdict: RunnerVerdict = "STOP";
  return {
    ...prior,
    evidenceSource: "caller-supplied-rows",
    classification: null,
    schema: null,
    verdict,
    code,
    failedQuery,
    message,
    postgresIdentity:
      failedQuery === "identity"
        ? { ...prior.postgresIdentity, status: "query-failed" }
        : prior.postgresIdentity,
  };
}

function isForbiddenDatabase(name: string): boolean {
  return FORBIDDEN_DATABASE_NAMES.includes(
    name.toLowerCase() as (typeof FORBIDDEN_DATABASE_NAMES)[number],
  );
}

function isForbiddenHost(host: string): boolean {
  return FORBIDDEN_HOSTS.includes(host.toLowerCase() as (typeof FORBIDDEN_HOSTS)[number]);
}

function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.includes(host.toLowerCase() as (typeof LOOPBACK_HOSTS)[number]);
}
