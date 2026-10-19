import { spawnSync } from "node:child_process";
import {
  containerStartedAt,
  createRestoreDatabase,
  dumpDatabase,
  restoreSql,
  sql,
  sqlOnRestore,
  type Cluster,
  type SqlOutcome,
  type SqlRole,
} from "@/server/internal/p1-write-freeze-coordinator/cluster";
import {
  CoordinatorFault,
  type ActivityRow,
  type BackupPort,
  type Binding,
  type CatalogPort,
  type Probe,
  type RestrictionReport,
  type UnfreezeFacts,
  type WriterRow,
} from "@/server/internal/p1-write-freeze-coordinator/contract";
import { canaryStatements, digestSql, freezeTransactionSql, unfreezeTransactionSql } from "@/server/internal/p1-write-freeze-coordinator/privileges";

const dumps = new Map<string, string>();

export function liveBackup(cluster: Cluster, port: CatalogPort): BackupPort {
  return {
    dump(source) {
      const dumped = dumpDatabase(cluster, source);
      if (dumped.status !== 0) return { ok: false, reason: dumped.sqlstate ?? "DUMP_FAILED" };
      const digest = port.logicalDigest();
      dumps.set(source, dumped.stdout);
      return { ok: true, digest };
    },
    restore(source, digest) {
      const script = dumps.get(source);
      if (script === undefined) return { ok: false, reason: "DUMP_MISSING" };
      const target = createRestoreDatabase(cluster, source);
      const restored = restoreSql(cluster, target, source, script);
      if (restored.status !== 0) return { ok: false, reason: restored.sqlstate ?? "RESTORE_FAILED" };
      const restoredDigest = one(sqlOnRestore(cluster, digestSql(), target, source));
      if (restoredDigest !== digest) return { ok: false, reason: "DIGEST" };
      return { ok: true, digest: restoredDigest };
    },
  };
}

export type LiveHandle = CatalogPort & BackupPort & { setFault(next: CoordinatorFault["point"] | null): void };

export function livePort(input: {
  cluster: Cluster;
  database: string;
  applicationPid: number;
  fault?: CoordinatorFault["point"] | null;
  missingAdministrator?: boolean;
}): LiveHandle {
  const { cluster, database, applicationPid } = input;
  let fault = input.fault ?? null;
  const seen = capture(cluster, database, applicationPid);
  const port: CatalogPort = {
    readIdentity: () => capture(cluster, database, applicationPid),
    administrator() {
      if (input.missingAdministrator) return { ok: false, sqlstate: rejectedLogin(cluster, database) };
      const result = sql(cluster, "breakglass", "SELECT current_user;", database);
      if (result.status !== 0) return { ok: false, sqlstate: result.sqlstate };
      return { ok: true, user: one(result) };
    },
    inventory: () => readInventory(cluster, database),
    commitFreeze() {
      if (fault === "before-commit") {
        sql(cluster, "breakglass", "BEGIN; SELECT 1; ROLLBACK;", database);
        throw new CoordinatorFault("before-commit");
      }
      const result = sql(cluster, "breakglass", freezeTransactionSql(database), database);
      if (result.status !== 0) return { ok: false, sqlstate: result.sqlstate, rolledBack: true };
      if (fault === "after-commit") throw new CoordinatorFault("after-commit");
      return { ok: true };
    },
    activity: () => readActivity(cluster, database),
    terminate(pids) {
      if (fault === "during-drain") throw new CoordinatorFault("during-drain");
      const terminated: number[] = [];
      for (const pid of pids) {
        const result = sql(cluster, "breakglass", `SELECT pg_terminate_backend(${pid})::text;`, database);
        if (result.status === 0 && one(result) === "true") terminated.push(pid);
      }
      const remaining = readActivity(cluster, database)
        .filter((row) => row.user === "p1wc_app")
        .map((row) => row.pid);
      return { terminated, remaining };
    },
    restrictions: () => readRestrictions(cluster, database),
    logicalDigest: () => one(sql(cluster, "breakglass", digestSql(), database)),
    grantsAreFreeze() {
      const result = sql(cluster, "breakglass", grantsSql(), database);
      if (result.status !== 0) return "unknown";
      return one(result) === "true";
    },
    unfreezePreconditions: () => readUnfreezeFacts(cluster, database, seen),
    commitUnfreeze() {
      const result = sql(cluster, "breakglass", unfreezeTransactionSql(database), database);
      if (result.status !== 0) return { ok: false, sqlstate: result.sqlstate };
      return { ok: true };
    },
    ordinaryWrite() {
      const result = sql(
        cluster,
        "app",
        "INSERT INTO p1wc_inventory (id, sku, qty) VALUES (9100, 'resumed', 1);",
        database,
      );
      return probe(result);
    },
    applyP1(script) {
      const result = sql(cluster, "migrator", script, database);
      if (result.status !== 0) return { outcome: "failed", sqlstate: result.sqlstate };
      if (fault === "after-p1-commit") throw new CoordinatorFault("after-p1-commit");
      return { outcome: "committed", sqlstate: null };
    },
    p1Visible() {
      const result = sql(
        cluster,
        "breakglass",
        `SELECT (
          EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'BatchCreationCommand' AND column_name = 'receiptProvenanceSnapshot')
          AND EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'batch_creation_command_provenance_guard')
          AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'batch_creation_command_provenance_guard')
        )::text;`,
        database,
      );
      if (result.status !== 0) return "unknown";
      return one(result) === "true";
    },
    applicationAlive() {
      try {
        process.kill(applicationPid, 0);
        return true;
      } catch {
        return false;
      }
    },
    containerUnchanged() {
      return cluster.containerId === seen.containerId && containerStartedAt(cluster) === seen.startedAt;
    },
    checkpoint(point) {
      if (fault === point) throw new CoordinatorFault(point);
    },
  };
  const backup = liveBackup(cluster, port);
  return { ...port, ...backup, setFault(next: CoordinatorFault["point"] | null) { fault = next; } };
}

function capture(cluster: Cluster, database: string, applicationPid: number): Binding {
  const row = one(
    sql(
      cluster,
      "breakglass",
      "SELECT current_database() || '|' || oid::text || '|' || current_setting('server_version_num') FROM pg_database WHERE datname = current_database();",
      database,
    ),
  );
  const [databaseName, databaseOid, serverVersionNum] = row.split("|");
  const systemIdentifier = one(sql(cluster, "breakglass", "SELECT system_identifier::text FROM pg_control_system();", database));
  if (!databaseName || !databaseOid || !serverVersionNum || !systemIdentifier) throw new Error("identity row is incomplete");
  return {
    scope: "TEST_OWNED",
    invocationId: cluster.runId,
    endpoint: cluster.endpoint,
    daemonId: cluster.daemonId,
    containerId: cluster.containerId,
    imageId: cluster.imageId,
    startedAt: cluster.startedAt,
    databaseName,
    databaseOid,
    systemIdentifier,
    serverVersionNum,
    applicationPid,
  };
}

function readInventory(cluster: Cluster, database: string): WriterRow[] {
  const result = sql(cluster, "breakglass", inventorySql(), database);
  if (result.status !== 0) throw new Error(`inventory failed ${result.sqlstate ?? ""}`);
  const parsed: unknown = JSON.parse(one(result) || "[]");
  if (!Array.isArray(parsed)) throw new Error("inventory is not a list");
  const rows = parsed.map((row) => asWriter(row));
  rows.push(publicWriter(cluster, database));
  return rows;
}

function readActivity(cluster: Cluster, database: string): ActivityRow[] {
  const result = sql(
    cluster,
    "breakglass",
    `SELECT coalesce(json_agg(json_build_object('pid', pid, 'user', usename, 'inTransaction', xact_start IS NOT NULL)), '[]'::json)::text
     FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename IS NOT NULL;`,
    database,
  );
  if (result.status !== 0) throw new Error(`activity failed ${result.sqlstate ?? ""}`);
  const parsed: unknown = JSON.parse(one(result) || "[]");
  if (!Array.isArray(parsed)) return [];
  return parsed.map((row) => {
    const record = asRecord(row);
    return { pid: Number(record.pid), user: String(record.user), inTransaction: record.inTransaction === true };
  });
}

function readRestrictions(cluster: Cluster, database: string): RestrictionReport {
  const statements = canaryStatements();
  const run = (role: SqlRole, statement: string) => probe(sql(cluster, role, `BEGIN;\n${statement}\nROLLBACK;`, database));
  return {
    setRoleInsert: run("breakglass", statements.setRoleInsert),
    loginSelect: run("app", statements.loginSelect),
    loginInsert: run("app", statements.loginInsert),
    loginUpdate: run("app", statements.loginUpdate),
    loginDelete: run("app", statements.loginDelete),
    loginTruncate: run("app", statements.loginTruncate),
    loginNextval: run("app", statements.loginNextval),
    loginSetval: run("app", statements.loginSetval),
    loginCreate: run("app", statements.loginCreate),
    loginSetRole: run("app", statements.loginSetRole),
    securityDefiner: run("app", statements.securityDefiner),
  };
}

function readUnfreezeFacts(cluster: Cluster, database: string, seen: Binding): UnfreezeFacts | "unknown" {
  const result = sql(
    cluster,
    "breakglass",
    `SELECT pg_get_userbyid(datdba) || '|' ||
      (SELECT rolname FROM pg_roles WHERE rolname = 'p1wc_app') || '|' ||
      (SELECT rolsuper::text FROM pg_roles WHERE rolname = 'p1wc_app') || '|' ||
      has_schema_privilege('p1wc_app', 'public', 'CREATE')::text || '|' ||
      (SELECT rolsuper::text FROM pg_roles WHERE rolname = 'p1wc_migrator') || '|' ||
      has_schema_privilege('p1wc_migrator', 'public', 'CREATE')::text
     FROM pg_database WHERE datname = current_database();`,
    database,
  );
  if (result.status !== 0) return "unknown";
  const [databaseOwner, applicationRole, applicationSuperuser, applicationCreate, migratorSuperuser, migratorCreate] =
    one(result).split("|");
  if (!databaseOwner || !applicationRole) return "unknown";
  return {
    databaseOwner,
    applicationRole,
    applicationSuperuser: applicationSuperuser === "true",
    applicationCreate: applicationCreate === "true",
    migratorSuperuser: migratorSuperuser === "true",
    migratorCreate: migratorCreate === "true",
    containerId: seen.containerId,
    startedAt: seen.startedAt,
  };
}

function publicWriter(cluster: Cluster, database: string): WriterRow {
  const result = sql(cluster, "breakglass", publicSql(), database);
  if (result.status !== 0) throw new Error(`public inventory failed ${result.sqlstate ?? ""}`);
  const parsed: unknown = JSON.parse(one(result));
  return asWriter({ ...(asRecord(parsed)), name: "PUBLIC", canlogin: false, superuser: false });
}

function inventorySql(): string {
  return `
SELECT coalesce(json_agg(json_build_object(
  'name', r.rolname,
  'superuser', r.rolsuper,
  'createdb', r.rolcreatedb,
  'createrole', r.rolcreaterole,
  'replication', r.rolreplication,
  'bypassrls', r.rolbypassrls,
  'canlogin', r.rolcanlogin,
  'inherit', r.rolinherit,
  'memberships', COALESCE((SELECT json_agg(m.rolname ORDER BY m.rolname) FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.roleid WHERE am.member = r.oid), '[]'::json),
  'setRoles', COALESCE((SELECT json_agg(m.rolname ORDER BY m.rolname) FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.roleid WHERE am.member = r.oid AND am.set_option), '[]'::json),
  'databaseCreate', has_database_privilege(r.oid, current_database(), 'CREATE'),
  'schemaCreate', has_schema_privilege(r.oid, 'public', 'CREATE'),
  'databaseOwner', (SELECT datdba = r.oid FROM pg_database WHERE datname = current_database()),
  'tableWrite', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND (
      has_table_privilege(r.oid, c.oid, 'INSERT') OR has_table_privilege(r.oid, c.oid, 'UPDATE')
      OR has_table_privilege(r.oid, c.oid, 'DELETE') OR has_table_privilege(r.oid, c.oid, 'TRUNCATE')
      OR has_table_privilege(r.oid, c.oid, 'REFERENCES') OR has_table_privilege(r.oid, c.oid, 'TRIGGER')
    )
  ),
  'columnWrite', EXISTS (
    SELECT 1 FROM information_schema.column_privileges p
    WHERE p.table_schema = 'public' AND p.grantee = r.rolname AND p.privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
  ),
  'sequenceMutation', EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S' AND (
      has_sequence_privilege(r.oid, c.oid, 'USAGE') OR has_sequence_privilege(r.oid, c.oid, 'UPDATE')
    )
  ),
  'securityDefinerExecute', EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege(r.oid, p.oid, 'EXECUTE')
  ),
  'sessions', (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = current_database() AND a.usename = r.rolname AND a.pid <> pg_backend_pid()),
  'transactions', (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = current_database() AND a.usename = r.rolname AND a.pid <> pg_backend_pid() AND a.xact_start IS NOT NULL)
)), '[]'::json)::text
FROM pg_roles r
WHERE r.rolname IN ('p1wc_app', 'p1wc_migrator', 'p1wc_breakglass', 'stell22') OR r.rolcanlogin;`.trim();
}

function publicSql(): string {
  return `
SELECT json_build_object(
  'tableWrite', has_table_privilege('public', 'public.p1wc_inventory', 'INSERT')
    OR has_table_privilege('public', 'public.p1wc_inventory', 'UPDATE')
    OR has_table_privilege('public', 'public.p1wc_inventory', 'DELETE')
    OR has_table_privilege('public', 'public.p1wc_inventory', 'TRUNCATE'),
  'columnWrite', EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema = 'public' AND grantee = 'PUBLIC' AND privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
  ),
  'sequenceMutation', has_sequence_privilege('public', 'public.p1wc_business_seq', 'USAGE')
    OR has_sequence_privilege('public', 'public.p1wc_business_seq', 'UPDATE'),
  'schemaCreate', has_schema_privilege('public', 'public', 'CREATE'),
  'databaseCreate', has_database_privilege('public', current_database(), 'CREATE'),
  'securityDefinerExecute', has_function_privilege('public', 'p1wc_hidden_write()', 'EXECUTE')
)::text;`.trim();
}

function grantsSql(): string {
  return `
SELECT (NOT (
  has_table_privilege('p1wc_app', 'public.p1wc_inventory', 'INSERT')
  OR has_table_privilege('p1wc_app', 'public.p1wc_inventory', 'UPDATE')
  OR has_table_privilege('p1wc_app', 'public.p1wc_inventory', 'DELETE')
  OR has_table_privilege('p1wc_app', 'public.p1wc_inventory', 'TRUNCATE')
  OR has_sequence_privilege('p1wc_app', 'public.p1wc_business_seq', 'USAGE')
  OR has_sequence_privilege('p1wc_app', 'public.p1wc_business_seq', 'UPDATE')
  OR has_schema_privilege('p1wc_app', 'public', 'CREATE')
  OR has_database_privilege('p1wc_app', current_database(), 'CREATE')
  OR has_function_privilege('p1wc_app', 'p1wc_hidden_write()', 'EXECUTE')
  OR has_table_privilege('public', 'public.p1wc_inventory', 'INSERT')
  OR EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND grantee IN ('p1wc_app', 'PUBLIC')
      AND privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
  )
))::text;`.trim();
}

function rejectedLogin(cluster: Cluster, database: string): string | null {
  const child = spawnSync(
    "docker",
    [
      "exec",
      "-e",
      "PGPASSWORD=invalid",
      "-e",
      "PGVERBOSITY=verbose",
      cluster.containerId,
      "psql",
      "-X",
      "-h",
      "127.0.0.1",
      "-U",
      "p1wc_missing",
      "-d",
      database,
      "-c",
      "SELECT 1",
    ],
    { windowsHide: true, encoding: "utf8", timeout: 15_000 },
  );
  const text = `${child.stderr ?? ""}\n${child.stdout ?? ""}`;
  const match = text.match(/(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/);
  if (match?.[1]) return match[1];
  // libpq on this image prints the FATAL text without a SQLSTATE token.
  // 28000 is invalid_authorization_specification for a missing role.
  // 28P01 is invalid_password. These are not printed server codes.
  if (/role .* does not exist/i.test(text)) return "28000";
  if (/password authentication failed/i.test(text)) return "28P01";
  return null;
}

function asWriter(value: unknown): WriterRow {
  const row = asRecord(value);
  return {
    name: String(row.name ?? ""),
    superuser: row.superuser === true,
    createdb: row.createdb === true,
    createrole: row.createrole === true,
    replication: row.replication === true,
    bypassrls: row.bypassrls === true,
    canlogin: row.canlogin === true,
    inherit: row.inherit !== false,
    memberships: strings(row.memberships),
    setRoles: strings(row.setRoles),
    databaseCreate: row.databaseCreate === true,
    schemaCreate: row.schemaCreate === true,
    databaseOwner: row.databaseOwner === true,
    tableWrite: row.tableWrite === true,
    columnWrite: row.columnWrite === true,
    sequenceMutation: row.sequenceMutation === true,
    securityDefinerExecute: row.securityDefinerExecute === true,
    sessions: Number(row.sessions ?? 0),
    transactions: Number(row.transactions ?? 0),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function probe(result: SqlOutcome): Probe {
  return { ok: result.status === 0, sqlstate: result.sqlstate };
}

function one(result: SqlOutcome): string {
  if (result.status !== 0) throw new Error(`sql failed ${result.sqlstate ?? "none"} ${result.stderr.slice(0, 300)}`);
  const lines = result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "SET" && line !== "BEGIN" && line !== "COMMIT" && line !== "ROLLBACK");
  return lines[lines.length - 1] ?? "";
}

export type { SqlRole };
