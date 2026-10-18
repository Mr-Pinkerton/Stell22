import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { P1_GIT_BLOB, P1_MIGRATION_PATH, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { classifyFreeze, type FreezeEvidence } from "@/server/internal/p1-write-freeze-proof/classify";
import {
  containerIp,
  containerLogs,
  createCluster,
  destroyCluster,
  backgroundErrors,
  pgDump,
  roleName,
  sql,
  sqlBare,
  sqlWithPassword,
  startBackgroundSql,
  type Cluster,
  type SqlOutcome,
  type SqlRole,
} from "@/server/internal/p1-write-freeze-proof/cluster";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";

describe.skipIf(!LIVE)("disposable PostgreSQL 17 write-freeze proof", () => {
  let cluster: Cluster | undefined;

  afterAll(() => {
    if (cluster) destroyCluster(cluster);
  });

  it("proves role transactions, freeze windows, and migrator DDL on a test-owned cluster", () => {
    cluster = createCluster();
    const version = query(cluster, "bootstrap", "SELECT current_setting('server_version');");
    expect(version.startsWith("17.")).toBe(true);
    expect(query(cluster, "bootstrap", "SELECT current_user;")).toBe("stell22");
    expect(query(cluster, "bootstrap", "SELECT oid::text || '|' || rolsuper::text FROM pg_authid WHERE rolname = 'stell22';")).toBe(
      "10|true",
    );
    expect(query(cluster, "bootstrap", "SELECT rolname FROM pg_roles WHERE rolname = 'postgres';")).toBe("");
    expect(query(cluster, "bootstrap", "SELECT datname FROM pg_database WHERE datname IN ('postgres','template0','template1') ORDER BY 1;")).toBe(
      "postgres\ntemplate0\ntemplate1",
    );

    const demotion = sql(
      cluster,
      "bootstrap",
      "BEGIN; CREATE ROLE p1wf_demote_probe NOLOGIN; ALTER ROLE stell22 NOSUPERUSER; COMMIT;",
    );
    expect(seen(demotion)).toMatchObject({ status: 3, sqlstate: "0A000" });
    expect(demotion.stderr.toLowerCase()).toContain("bootstrap superuser");
    expect(query(cluster, "bootstrap", "SELECT rolsuper::text FROM pg_roles WHERE rolname = 'stell22';")).toBe("true");
    expect(query(cluster, "bootstrap", "SELECT rolname FROM pg_roles WHERE rolname = 'p1wf_demote_probe';")).toBe("");

    const rolled = sql(cluster, "bootstrap", "BEGIN; CREATE ROLE p1wf_rollback_role NOLOGIN; ROLLBACK;");
    expect(seen(rolled)).toMatchObject({ status: 0, sqlstate: null });
    expect(query(cluster, "bootstrap", "SELECT rolname FROM pg_roles WHERE rolname = 'p1wf_rollback_role';")).toBe("");

    expect(seen(sql(cluster, "bootstrap", "BEGIN; CREATE DATABASE p1wf_should_not_exist; COMMIT;"))).toMatchObject({
      status: 3,
      sqlstate: "25001",
    });
    expect(query(cluster, "bootstrap", "SELECT datname FROM pg_database WHERE datname = 'p1wf_should_not_exist';")).toBe("");

    const breakglass = roleName("breakglass");
    const app = roleName("app");
    const migrator = roleName("migrator");
    const created = sql(
      cluster,
      "bootstrap",
      `CREATE ROLE ${breakglass} LOGIN SUPERUSER PASSWORD '${cluster.passwords.breakglass}';`,
    );
    expect(seen(created)).toMatchObject({ status: 0, sqlstate: null });
    expect(query(cluster, "breakglass", "SELECT current_user || '|' || rolsuper::text FROM pg_roles WHERE rolname = current_user;")).toBe(
      `${breakglass}|true`,
    );
    expect(seen(sql(cluster, "breakglass", "CREATE ROLE p1wf_admin_probe NOLOGIN; DROP ROLE p1wf_admin_probe;"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    const hba = query(
      cluster,
      "bootstrap",
      "SELECT coalesce(address, '') || '|' || auth_method FROM pg_hba_file_rules ORDER BY line_number;",
    );
    expect(hba).toContain("127.0.0.1|trust");
    expect(hba).toContain("all|scram-sha-256");
    expect(seen(sqlBare(cluster, "bootstrap", "ALTER SYSTEM SET log_error_verbosity = 'verbose';"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(query(cluster, "bootstrap", "SELECT pg_reload_conf()::text;")).toBe("true");
    const bridge = containerIp(cluster);
    expect(seen(sqlWithPassword(cluster, "breakglass", cluster.passwords.breakglass, "SELECT current_user;", bridge))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    const wrongBridge = sqlWithPassword(cluster, "breakglass", "wrong-breakglass-secret", "SELECT 1;", bridge);
    expect(wrongBridge.status).not.toBe(0);
    expect(wrongBridge.stderr.toLowerCase()).toContain("password authentication failed");
    expect(containerLogs(cluster)).toContain("28P01");
    expect(seen(sqlWithPassword(cluster, "breakglass", "wrong-breakglass-secret", "SELECT 1;")).status).toBe(0);

    const atomic = sql(
      cluster,
      "breakglass",
      `
      BEGIN;
      CREATE ROLE p1wf_atomic NOLOGIN;
      ALTER ROLE p1wf_atomic LOGIN;
      CREATE TABLE public.p1wf_atomic (id integer PRIMARY KEY, note text);
      ALTER TABLE public.p1wf_atomic OWNER TO p1wf_atomic;
      GRANT SELECT ON TABLE public.p1wf_atomic TO ${breakglass};
      ALTER DEFAULT PRIVILEGES FOR ROLE p1wf_atomic IN SCHEMA public GRANT SELECT ON TABLES TO ${breakglass};
      COMMIT;
      `,
    );
    expect(seen(atomic)).toMatchObject({ status: 0, sqlstate: null });
    expect(query(cluster, "bootstrap", "SELECT rolcanlogin::text FROM pg_roles WHERE rolname = 'p1wf_atomic';")).toBe("true");
    expect(query(cluster, "bootstrap", "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'p1wf_atomic';")).toBe(
      "p1wf_atomic",
    );
    const defaultsRolled = sql(
      cluster,
      "breakglass",
      `
      BEGIN;
      CREATE TABLE public.p1wf_gone (id integer);
      ALTER TABLE public.p1wf_gone OWNER TO p1wf_atomic;
      REVOKE SELECT ON TABLE public.p1wf_atomic FROM ${breakglass};
      ALTER DEFAULT PRIVILEGES FOR ROLE p1wf_atomic IN SCHEMA public REVOKE SELECT ON TABLES FROM ${breakglass};
      ROLLBACK;
      `,
    );
    expect(seen(defaultsRolled)).toMatchObject({ status: 0, sqlstate: null });
    expect(query(cluster, "bootstrap", "SELECT relname FROM pg_class WHERE relname = 'p1wf_gone';")).toBe("");
    expect(
      query(
        cluster,
        "bootstrap",
        "SELECT privilege_type FROM information_schema.role_table_grants WHERE grantee = 'p1wf_breakglass' AND table_name = 'p1wf_atomic';",
      ),
    ).toBe("SELECT");

    expect(
      seen(
        sql(
          cluster,
          "breakglass",
          `
          CREATE ROLE ${app} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD '${cluster.passwords.app}';
          CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT PASSWORD '${cluster.passwords.migrator}';
          `,
        ),
      ),
    ).toMatchObject({ status: 0, sqlstate: null });
    const attributes = query(
      cluster,
      "bootstrap",
      `SELECT rolname || '|' || rolsuper::text || '|' || rolcreatedb::text || '|' || rolcreaterole::text || '|' || rolreplication::text || '|' || rolbypassrls::text || '|' || rolinherit::text FROM pg_roles WHERE rolname IN ('${app}', '${migrator}') ORDER BY rolname;`,
    );
    expect(attributes).toBe(`${app}|false|false|false|false|false|false\n${migrator}|false|false|false|false|false|false`);
    expect(
      query(
        cluster,
        "bootstrap",
        `SELECT member::regrole::text || '|' || roleid::regrole::text FROM pg_auth_members WHERE member::regrole::text IN ('${app}', '${migrator}', '${breakglass}');`,
      ),
    ).toBe("");

    const owned = sql(
      cluster,
      "breakglass",
      `
      BEGIN;
      ALTER DATABASE stell22 OWNER TO ${migrator};
      ALTER SCHEMA public OWNER TO ${migrator};
      CREATE TABLE public.p1wf_stock (id integer PRIMARY KEY, sku text NOT NULL, qty integer NOT NULL);
      CREATE SEQUENCE public.p1wf_stock_seq;
      INSERT INTO public.p1wf_stock (id, sku, qty) VALUES (1, 'rail', 10), (2, 'beam', 4);
      ALTER TABLE public.p1wf_stock OWNER TO ${migrator};
      ALTER SEQUENCE public.p1wf_stock_seq OWNER TO ${migrator};
      GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.p1wf_stock TO ${app};
      GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.p1wf_stock_seq TO ${app};
      ALTER DEFAULT PRIVILEGES FOR ROLE ${migrator} IN SCHEMA public GRANT SELECT ON TABLES TO ${app};
      COMMIT;
      `,
    );
    expect(seen(owned)).toMatchObject({ status: 0, sqlstate: null });
    expect(query(cluster, "bootstrap", "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'stell22';")).toBe(migrator);
    expect(query(cluster, "bootstrap", "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public';")).toBe(migrator);
    expect(seen(sql(cluster, "app", "SET ROLE p1wf_migrator;"))).toMatchObject({ status: 3, sqlstate: "42501" });
    expect(seen(sql(cluster, "app", `SET ROLE ${breakglass};`))).toMatchObject({ status: 3, sqlstate: "42501" });

    expect(seen(sql(cluster, "app", "INSERT INTO public.p1wf_stock (id, sku, qty) VALUES (3, 'committed-before', 1);"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    const beforeFreeze = snapshot(cluster, "app");
    expect(beforeFreeze).toBe("1|rail|10\n2|beam|4\n3|committed-before|1");

    startBackgroundSql(
      cluster,
      "app",
      "BEGIN; INSERT INTO public.p1wf_stock (id, sku, qty) VALUES (52, 'held-commit', 7); SELECT pg_sleep(20), 'p1wf_sleeper_token_commit'; COMMIT;",
    );
    expect(waitPid(cluster, "p1wf_sleeper_token_commit")).toMatch(/^[0-9]+$/);
    startBackgroundSql(
      cluster,
      "app",
      "BEGIN; INSERT INTO public.p1wf_stock (id, sku, qty) VALUES (51, 'held-term', 1); SELECT pg_sleep(40), 'p1wf_sleeper_token_term';",
    );
    const termPid = waitPid(cluster, "p1wf_sleeper_token_term");
    const revoke = sql(
      cluster,
      "breakglass",
      `
      BEGIN;
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.p1wf_stock FROM ${app};
      REVOKE USAGE, SELECT, UPDATE ON SEQUENCE public.p1wf_stock_seq FROM ${app};
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.p1wf_stock FROM PUBLIC;
      COMMIT;
      `,
    );
    expect(seen(revoke)).toMatchObject({ status: 0, sqlstate: null });
    expect(classifyFreeze(baseEvidence({ applicationBackendsRemaining: 1, canary: "not-run" })).state).toBe(
      "REVOKE_COMMITTED",
    );
    expect(waitForRow(cluster, "52|held-commit|7")).toBe(true);
    expect(count(cluster)).toBe("4");

    const terminated = query(cluster, "breakglass", `SELECT pg_terminate_backend(${termPid})::text;`);
    expect(terminated).toBe("true");
    expect(waitGone(cluster, termPid)).toBe(true);
    expect(snapshot(cluster, "app").includes("51|held-term|1")).toBe(false);

    const denied = sql(cluster, "app", "INSERT INTO public.p1wf_stock (id, sku, qty) VALUES (60, 'after', 1);");
    expect(seen(denied)).toMatchObject({ status: 3, sqlstate: "42501" });
    for (const statement of [
      "UPDATE public.p1wf_stock SET qty = 0 WHERE id = 1;",
      "DELETE FROM public.p1wf_stock WHERE id = 1;",
      "TRUNCATE public.p1wf_stock;",
      "SELECT nextval('public.p1wf_stock_seq');",
      "SELECT setval('public.p1wf_stock_seq', 1);",
      "CREATE TABLE public.p1wf_app_table (id integer);",
      "ALTER TABLE public.p1wf_stock ADD COLUMN extra integer;",
    ]) {
      expect(seen(sql(cluster, "app", statement)).sqlstate).toBe("42501");
    }
    expect(snapshot(cluster, "app")).toContain("1|rail|10");
    expect(classifyFreeze(baseEvidence()).state).toBe("FROZEN_VERIFIED");

    const wrongPassword = sqlWithPassword(cluster, "app", "not-the-app-password", "SELECT 1;", bridge);
    expect(wrongPassword.status).not.toBe(0);
    expect(wrongPassword.stderr.toLowerCase()).toContain("password authentication failed");
    expect(containerLogs(cluster)).toContain("28P01");
    expect(seen(sqlWithPassword(cluster, "app", cluster.passwords.app, "SELECT current_user;", bridge))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(classifyFreeze(baseEvidence({ canary: "authentication-failed" })).state).toBe("UNCERTAIN");

    const beforeSuperuser = snapshot(cluster, "migrator");
    expect(seen(sql(cluster, "bootstrap", "UPDATE public.p1wf_stock SET sku = 'rewritten' WHERE id = 1;"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    const afterSuperuser = snapshot(cluster, "migrator");
    expect(countRows(beforeSuperuser)).toBe(countRows(afterSuperuser));
    expect(afterSuperuser).not.toBe(beforeSuperuser);
    expect(classifyFreeze(baseEvidence({ unexpectedSuperuserSession: true })).state).toBe("UNCERTAIN");
    expect(seen(sql(cluster, "migrator", "UPDATE public.p1wf_stock SET sku = 'rail' WHERE id = 1;"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });

    expect(seen(sql(cluster, "breakglass", `GRANT UPDATE (qty) ON TABLE public.p1wf_stock TO ${app};`))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(seen(sql(cluster, "app", "UPDATE public.p1wf_stock SET qty = 11 WHERE id = 1;"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(seen(sql(cluster, "breakglass", `REVOKE UPDATE (qty) ON TABLE public.p1wf_stock FROM ${app};`))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(seen(sql(cluster, "migrator", "UPDATE public.p1wf_stock SET qty = 10 WHERE id = 1;"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(seen(sql(cluster, "app", "UPDATE public.p1wf_stock SET qty = 12 WHERE id = 1;")).sqlstate).toBe("42501");

    expect(seen(sql(cluster, "breakglass", `GRANT INSERT ON TABLE public.p1wf_stock TO PUBLIC;`))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(seen(sql(cluster, "app", "INSERT INTO public.p1wf_stock (id, sku, qty) VALUES (72, 'public-bypass', 1);"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(seen(sql(cluster, "breakglass", "REVOKE INSERT ON TABLE public.p1wf_stock FROM PUBLIC;"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(seen(sql(cluster, "migrator", "DELETE FROM public.p1wf_stock WHERE id = 72;"))).toMatchObject({ status: 0, sqlstate: null });

    expect(seen(sql(cluster, "breakglass", `GRANT ${migrator} TO ${app};`))).toMatchObject({ status: 0, sqlstate: null });
    expect(seen(sql(cluster, "app", `SET ROLE ${migrator}; INSERT INTO public.p1wf_stock (id, sku, qty) VALUES (73, 'member', 1);`))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(seen(sql(cluster, "breakglass", `REVOKE ${migrator} FROM ${app};`))).toMatchObject({ status: 0, sqlstate: null });
    expect(seen(sql(cluster, "migrator", "DELETE FROM public.p1wf_stock WHERE id = 73;"))).toMatchObject({ status: 0, sqlstate: null });
    expect(seen(sql(cluster, "app", `SET ROLE ${migrator};`)).sqlstate).toBe("42501");

    expect(
      seen(
        sql(
          cluster,
          "migrator",
          "CREATE FUNCTION public.p1wf_invoker_insert() RETURNS void LANGUAGE sql SECURITY INVOKER AS $$ INSERT INTO public.p1wf_stock (id, sku, qty) VALUES (71, 'invoker', 1) $$; GRANT EXECUTE ON FUNCTION public.p1wf_invoker_insert() TO p1wf_app;",
        ),
      ),
    ).toMatchObject({ status: 0, sqlstate: null });
    expect(seen(sql(cluster, "app", "SELECT public.p1wf_invoker_insert();")).sqlstate).toBe("42501");
    expect(
      seen(
        sql(
          cluster,
          "migrator",
          "CREATE FUNCTION public.p1wf_definer_insert() RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ INSERT INTO public.p1wf_stock (id, sku, qty) VALUES (70, 'definer', 1) $$; GRANT EXECUTE ON FUNCTION public.p1wf_definer_insert() TO p1wf_app;",
        ),
      ),
    ).toMatchObject({ status: 0, sqlstate: null });
    expect(seen(sql(cluster, "app", "SELECT public.p1wf_definer_insert();"))).toMatchObject({ status: 0, sqlstate: null });
    expect(snapshot(cluster, "migrator")).toContain("70|definer|1");
    expect(seen(sql(cluster, "migrator", "DROP FUNCTION public.p1wf_definer_insert(); DROP FUNCTION public.p1wf_invoker_insert(); DELETE FROM public.p1wf_stock WHERE id = 70;"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });

    const migrationSql = pinnedMigration();
    expect(
      seen(
        sql(
          cluster,
          "migrator",
          `CREATE TABLE public."BatchCreationCommand" (id uuid PRIMARY KEY, "requestId" text NOT NULL, "batchId" uuid NOT NULL);`,
        ),
      ),
    ).toMatchObject({ status: 0, sqlstate: null });
    expect(seen(sql(cluster, "app", migrationSql)).sqlstate).toBe("42501");
    expect(seen(sql(cluster, "migrator", migrationSql))).toMatchObject({ status: 0, sqlstate: null });
    expect(
      query(cluster, "migrator", `SELECT proname FROM pg_proc WHERE proname = 'batch_creation_command_provenance_guard';`),
    ).toBe("batch_creation_command_provenance_guard");
    expect(pinnedMigration()).toBe(migrationSql);

    expect(
      seen(
        sql(
          cluster,
          "migrator",
          `CREATE TABLE public."_prisma_migrations" (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0);`,
        ),
      ),
    ).toMatchObject({ status: 0, sqlstate: null });
    expect(
      seen(
        sql(
          cluster,
          "migrator",
          `INSERT INTO public."_prisma_migrations" (id, checksum, migration_name) VALUES ('p1wf', '${P1_SHA256}', 'fixture');`,
        ),
      ),
    ).toMatchObject({ status: 0, sqlstate: null });
    expect(
      seen(
        sql(
          cluster,
          "app",
          `INSERT INTO public."_prisma_migrations" (id, checksum, migration_name) VALUES ('app', '${P1_SHA256}', 'no');`,
        ),
      ).sqlstate,
    ).toBe("42501");

    const tableDump = pgDump(cluster, "app", ["--no-owner", "--no-acl", "--table=public.p1wf_stock"]);
    expect(tableDump.status).toBe(0);
    expect(tableDump.stdout).toContain("held-commit");
    const sequenceDump = pgDump(cluster, "app", ["--no-owner", "--no-acl", "--table=public.p1wf_stock_seq"]);
    expect(sequenceDump.status).not.toBe(0);
    expect(seen(sql(cluster, "bootstrap", "CREATE DATABASE p1wf_restore TEMPLATE template0;"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(seen(sql(cluster, "bootstrap", tableDump.stdout, "p1wf_restore"))).toMatchObject({ status: 0, sqlstate: null });
    expect(query(cluster, "bootstrap", "SELECT sku FROM public.p1wf_stock WHERE id = 52;", "p1wf_restore")).toBe("held-commit");

    const appAdmin = sql(cluster, "app", "CREATE ROLE p1wf_should_fail NOLOGIN;");
    expect(seen(appAdmin)).toMatchObject({ status: 3, sqlstate: "42501" });
    startBackgroundSql(cluster, "bootstrap", "SELECT pg_sleep(8), 'p1wf_super_sleep';");
    const superPid = waitPid(cluster, "p1wf_super_sleep");
    expect(seen(sql(cluster, "app", `SELECT pg_terminate_backend(${superPid});`)).sqlstate).toBe("42501");
    const lost = sqlWithPassword(cluster, "breakglass", "wrong-breakglass-secret", "SELECT 1;", bridge);
    expect(lost.status).not.toBe(0);
    expect(classifyFreeze(baseEvidence({ breakGlassLogin: false })).state).toBe("UNCERTAIN");
    expect(classifyFreeze(baseEvidence({ operatorInterrupted: true, applicationBackendsRemaining: 1, canary: "not-run" })).state).toBe(
      "UNCERTAIN",
    );
    expect(classifyFreeze(baseEvidence({ catalogReadable: false })).state).toBe("UNCERTAIN");
    expect(classifyFreeze(baseEvidence({ grantsAreFreeze: "unknown" })).state).toBe("UNCERTAIN");
    expect(classifyFreeze(baseEvidence({ canary: "write-succeeded" })).state).toBe("UNCERTAIN");

    expect(
      seen(
        sql(
          cluster,
          "breakglass",
          `GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.p1wf_stock TO ${app}; GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.p1wf_stock_seq TO ${app};`,
        ),
      ),
    ).toMatchObject({ status: 0, sqlstate: null });
    expect(seen(sql(cluster, "app", "INSERT INTO public.p1wf_stock (id, sku, qty) VALUES (80, 'unfrozen', 1);"))).toMatchObject({
      status: 0,
      sqlstate: null,
    });
    expect(query(cluster, "bootstrap", `SELECT rolsuper::text FROM pg_roles WHERE rolname = '${app}';`)).toBe("false");
    expect(query(cluster, "bootstrap", "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'p1wf_stock';")).toBe(migrator);
    expect(
      classifyFreeze(
        baseEvidence({
          unfreezeGrantsCommitted: true,
          postUnfreezeWrite: true,
          canary: "not-run",
          grantsAreFreeze: false,
        }),
      ).state,
    ).toBe("UNFREEZE_AUTHORIZED");
  }, 240_000);
});

function pinnedMigration(): string {
  const shown = spawnSync("git", ["show", `HEAD:${P1_MIGRATION_PATH}`], { encoding: "utf8" });
  expect(shown.status).toBe(0);
  const sql = shown.stdout ?? "";
  expect(createHash("sha256").update(sql).digest("hex")).toBe(P1_SHA256);
  const blob = spawnSync("git", ["hash-object", "--stdin"], { input: sql, encoding: "utf8" });
  expect(blob.stdout.trim()).toBe(P1_GIT_BLOB);
  return sql;
}

function baseEvidence(overrides: Partial<FreezeEvidence> = {}): FreezeEvidence {
  return {
    catalogReadable: true,
    breakGlassLogin: true,
    privilegeTransaction: "committed",
    grantsAreFreeze: true,
    applicationBackendsRemaining: 0,
    unexpectedSuperuserSession: false,
    operatorInterrupted: false,
    canary: "authenticated-write-denied",
    unfreezeGrantsCommitted: false,
    appStillNonSuperuser: true,
    ownershipStillMigrator: true,
    postUnfreezeWrite: false,
    ...overrides,
  };
}

function query(cluster: Cluster, role: SqlRole, statement: string, database = "stell22"): string {
  const result = sql(cluster, role, statement, database);
  expect(seen(result)).toMatchObject({ status: 0, sqlstate: null });
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "SET")
    .join("\n");
}

function snapshot(cluster: Cluster, role: SqlRole): string {
  return query(cluster, role, "SELECT id::text || '|' || sku || '|' || qty::text FROM public.p1wf_stock ORDER BY id;");
}

function count(cluster: Cluster): string {
  return query(cluster, "app", "SELECT count(*)::text FROM public.p1wf_stock;");
}

function countRows(snapshotText: string): number {
  return snapshotText.split("\n").filter((line) => line.length > 0).length;
}

function body(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "SET");
}

function seen(result: SqlOutcome): { status: number | null; sqlstate: string | null; signal: NodeJS.Signals | null } {
  return { status: result.status, sqlstate: result.sqlstate, signal: result.signal };
}

function activity(cluster: Cluster): string {
  const result = sql(
    cluster,
    "bootstrap",
    "SELECT coalesce(usename, '') || '|' || state || '|' || left(query, 180) FROM pg_stat_activity WHERE datname = 'stell22' AND backend_type = 'client backend';",
  );
  return result.status === 0 ? result.stdout.trim() : result.stderr.slice(0, 400);
}

function waitForRow(cluster: Cluster, fragment: string): boolean {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = sql(
      cluster,
      "app",
      "SELECT id::text || '|' || sku || '|' || qty::text FROM public.p1wf_stock ORDER BY id;",
    );
    if (result.status === 0 && result.stdout.includes(fragment)) return true;
    sleep(500);
  }
  return false;
}

function waitPid(cluster: Cluster, token: string): string {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = sql(
      cluster,
      "bootstrap",
      `SELECT pid::text FROM pg_stat_activity WHERE datname = 'stell22' AND query LIKE '%${token}%' AND pid <> pg_backend_pid();`,
    );
    const pid = body(result.stdout).join("");
    if (result.status === 0 && /^[0-9]+$/.test(pid)) return pid;
    sleep(250);
  }
  throw new Error(`fixture session did not appear for ${token}; activity=${activity(cluster)}; client=${backgroundErrors()}`);
}

function waitGone(cluster: Cluster, pid: string): boolean {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = sql(cluster, "bootstrap", `SELECT pid::text FROM pg_stat_activity WHERE pid = ${pid};`);
    if (result.status === 0 && body(result.stdout).length === 0) return true;
    sleep(250);
  }
  return false;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
