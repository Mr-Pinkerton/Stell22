/**
 * Effective privileges of the dedicated P1 migrator.
 * A role name in a file is not enough. The connected session has to match.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  PRODUCTION_DNS_ALIAS,
  PRODUCTION_POSTGRES_IMAGE,
  PROPOSED_MIGRATOR_ROLE,
} from "@/server/internal/p1-production-adapter/contract";
import type { MigratorCredential } from "@/server/internal/p1-production-adapter/migrator-credential";
import { refusal, RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";

const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export type MigratorPrivilegeReport = {
  currentUser: string;
  sessionUser: string;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
  rolcanlogin: boolean;
  rolinherit: boolean;
  memberships: string[];
  batchOwner: string | null;
  migrationInsert: boolean;
  migrationUpdate: boolean;
  schemaCreate: boolean;
  publicCreate: boolean;
  otherLogin: Array<{ name: string; schemaCreate: boolean; memberOfMigrator: boolean; superuser: boolean }>;
};

export function migratorPrivilegeSql(): string {
  return `
SELECT json_build_object(
  'currentUser', current_user,
  'sessionUser', session_user,
  'rolsuper', r.rolsuper,
  'rolcreatedb', r.rolcreatedb,
  'rolcreaterole', r.rolcreaterole,
  'rolreplication', r.rolreplication,
  'rolbypassrls', r.rolbypassrls,
  'rolcanlogin', r.rolcanlogin,
  'rolinherit', r.rolinherit,
  'memberships', COALESCE((SELECT json_agg(m.roleid::regrole::text) FROM pg_auth_members m WHERE m.member = r.oid), '[]'::json),
  'batchOwner', (SELECT pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'BatchCreationCommand'),
  'migrationInsert', has_table_privilege(current_user, '"_prisma_migrations"'::regclass, 'INSERT'),
  'migrationUpdate', has_table_privilege(current_user, '"_prisma_migrations"'::regclass, 'UPDATE'),
  'schemaCreate', has_schema_privilege(current_user, 'public', 'CREATE'),
  'publicCreate', has_schema_privilege('public', 'public', 'CREATE'),
  'otherLogin', COALESCE((
    SELECT json_agg(json_build_object(
      'name', o.rolname,
      'schemaCreate', has_schema_privilege(o.oid, 'public', 'CREATE'),
      'memberOfMigrator', pg_has_role(o.oid, r.oid, 'member'),
      'superuser', o.rolsuper
    ))
    FROM pg_roles o
    WHERE o.rolcanlogin AND NOT o.rolsuper AND o.oid <> r.oid
  ), '[]'::json)
)
FROM pg_roles r
WHERE r.rolname = current_user
`.trim();
}

export function evaluateMigratorPrivileges(
  report: MigratorPrivilegeReport,
  expected: { migratorRole: string; bootstrapRole: string },
): { ok: true } | { ok: false; code: string } {
  if (
    report.currentUser !== expected.migratorRole ||
    report.sessionUser !== report.currentUser ||
    report.currentUser === expected.bootstrapRole ||
    report.rolsuper ||
    !report.rolcanlogin ||
    report.rolinherit ||
    report.rolcreatedb ||
    report.rolcreaterole ||
    report.rolreplication ||
    report.rolbypassrls
  ) {
    return { ok: false, code: "MIGRATOR_ROLE_REFUSED" };
  }
  if (report.memberships.length > 0) return { ok: false, code: "MIGRATOR_MEMBERSHIP_REFUSED" };
  if (report.batchOwner !== report.currentUser) return { ok: false, code: "MIGRATOR_OWNERSHIP_REFUSED" };
  if (report.otherLogin.length === 0) return { ok: false, code: "APPLICATION_ROLE_UNBOUND" };
  if (
    !report.migrationInsert ||
    !report.migrationUpdate ||
    !report.schemaCreate ||
    report.publicCreate ||
    report.otherLogin.some((role) => role.schemaCreate || role.memberOfMigrator || role.superuser)
  ) {
    return { ok: false, code: "MIGRATOR_PRIVILEGE_REFUSED" };
  }
  return { ok: true };
}

export function parseMigratorPrivilegeReport(value: unknown): MigratorPrivilegeReport {
  const row = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (row === null) throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator privilege report is missing");
  const memberships = Array.isArray(row.memberships) ? row.memberships.filter((item) => typeof item === "string") : null;
  const otherLogin = Array.isArray(row.otherLogin)
    ? row.otherLogin.flatMap((item) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
        const role = item as Record<string, unknown>;
        if (typeof role.name !== "string") return [];
        return [{
          name: role.name,
          schemaCreate: role.schemaCreate === true,
          memberOfMigrator: role.memberOfMigrator === true,
          superuser: role.superuser === true,
        }];
      })
    : null;
  if (
    typeof row.currentUser !== "string" ||
    typeof row.sessionUser !== "string" ||
    memberships === null ||
    memberships.length !== (row.memberships as unknown[]).length ||
    otherLogin === null ||
    otherLogin.length !== (row.otherLogin as unknown[]).length
  ) {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator privilege report is incomplete");
  }
  return {
    currentUser: row.currentUser,
    sessionUser: row.sessionUser,
    rolsuper: row.rolsuper === true,
    rolcreatedb: row.rolcreatedb === true,
    rolcreaterole: row.rolcreaterole === true,
    rolreplication: row.rolreplication === true,
    rolbypassrls: row.rolbypassrls === true,
    rolcanlogin: row.rolcanlogin === true,
    rolinherit: row.rolinherit === true,
    memberships,
    batchOwner: typeof row.batchOwner === "string" ? row.batchOwner : null,
    migrationInsert: row.migrationInsert === true,
    migrationUpdate: row.migrationUpdate === true,
    schemaCreate: row.schemaCreate === true,
    publicCreate: row.publicCreate === true,
    otherLogin,
  };
}

export function migratorProbeArgv(envFile: string, networkName: string, dnsAlias: string, database: string): string[] {
  if (dnsAlias !== PRODUCTION_DNS_ALIAS || !ROLE_NAME.test(database)) {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator probe target is not the database alias");
  }
  return [
    "run",
    "--rm",
    "-i",
    "--pull",
    "never",
    "--network",
    networkName,
    "--env-file",
    envFile,
    PRODUCTION_POSTGRES_IMAGE,
    "psql",
    "-h",
    dnsAlias,
    "-U",
    PROPOSED_MIGRATOR_ROLE,
    "-d",
    database,
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
  ];
}

export function probeMigratorPrivileges(input: {
  networkName: string;
  database: string;
  credential: MigratorCredential;
  env: NodeJS.ProcessEnv;
}): MigratorPrivilegeReport {
  if (input.credential.role !== PROPOSED_MIGRATOR_ROLE || input.credential.database !== input.database) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_MISMATCH", "P1 migrator probe is not bound to the migrator");
  }
  const envFile = path.join(os.tmpdir(), `p1-migrator-${randomUUID()}`);
  fs.writeFileSync(envFile, `PGPASSWORD=${input.credential.password}\n`, { mode: 0o600 });
  try {
    const argv = migratorProbeArgv(envFile, input.networkName, PRODUCTION_DNS_ALIAS, input.database);
    if (argv.some((arg) => arg.includes(input.credential.password) || arg.includes("PGPASSWORD=") || /postgres(?:ql)?:\/\//i.test(arg))) {
      throw refusal("STOP", "CREDENTIAL_LEAK", "P1 migrator probe command contains a credential");
    }
    const child = spawnSync("docker", argv, {
      input: migratorPrivilegeSql(),
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 1_000_000,
      env: input.env,
    });
    if (child.status !== 0 || child.signal) {
      throw refusal("STOP", "MIGRATOR_CREDENTIAL_MISMATCH", "P1 migrator credential was rejected by the database");
    }
    try {
      return parseMigratorPrivilegeReport(JSON.parse(child.stdout));
    } catch (error) {
      if (error instanceof RunnerRefusal) throw error;
      throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator privilege report is not catalog JSON");
    }
  } finally {
    fs.rmSync(envFile, { force: true });
  }
}
