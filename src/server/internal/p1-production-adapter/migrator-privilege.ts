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
  DAEMON_ID,
  IMAGE_ID,
  PRODUCTION_DNS_ALIAS,
  PRODUCTION_POSTGRES_IMAGE,
  PROPOSED_MIGRATOR_ROLE,
} from "@/server/internal/p1-production-adapter/contract";
import type { MigratorCredential } from "@/server/internal/p1-production-adapter/migrator-credential";
import { refusal, RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";

const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const LOCAL_ENDPOINTS = new Set([
  "unix:///var/run/docker.sock",
  "npipe:////./pipe/docker_engine",
  "npipe:////./pipe/dockerDesktopLinuxEngine",
]);
const PRIVILEGE_BOOLEANS = [
  "rolsuper",
  "rolcreatedb",
  "rolcreaterole",
  "rolreplication",
  "rolbypassrls",
  "rolcanlogin",
  "rolinherit",
  "migrationInsert",
  "migrationUpdate",
  "schemaCreate",
  "publicCreate",
] as const;
const REPORT_KEYS = [
  "batchOwner",
  "currentUser",
  "memberships",
  "otherLogin",
  "sessionUser",
  ...PRIVILEGE_BOOLEANS,
].sort();
const LOGIN_KEYS = ["memberOfMigrator", "name", "schemaCreate", "superuser"];

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
  if (row === null || Object.keys(row).sort().join(",") !== REPORT_KEYS.join(",")) {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator privilege report is incomplete");
  }
  if (typeof row.currentUser !== "string" || typeof row.sessionUser !== "string" || row.currentUser.length === 0) {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator privilege report identity is incomplete");
  }
  if (!Array.isArray(row.memberships) || row.memberships.some((item) => typeof item !== "string")) {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator membership list is malformed");
  }
  if (row.batchOwner !== null && typeof row.batchOwner !== "string") {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator ownership report is malformed");
  }
  const flags = {} as Record<(typeof PRIVILEGE_BOOLEANS)[number], boolean>;
  for (const key of PRIVILEGE_BOOLEANS) {
    if (typeof row[key] !== "boolean") {
      throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator privilege flag is not an explicit boolean");
    }
    flags[key] = row[key];
  }
  if (!Array.isArray(row.otherLogin)) {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator login report is malformed");
  }
  const otherLogin = row.otherLogin.map((item) => parseOtherLogin(item));
  return {
    currentUser: row.currentUser,
    sessionUser: row.sessionUser,
    ...flags,
    memberships: row.memberships,
    batchOwner: row.batchOwner,
    otherLogin,
  };
}

function parseOtherLogin(value: unknown): MigratorPrivilegeReport["otherLogin"][number] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator login entry is incomplete");
  }
  const role = value as Record<string, unknown>;
  if (Object.keys(role).sort().join(",") !== LOGIN_KEYS.join(",")) {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator login entry is incomplete");
  }
  if (typeof role.name !== "string" || role.name.length === 0) {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator login entry is incomplete");
  }
  if (typeof role.schemaCreate !== "boolean" || typeof role.memberOfMigrator !== "boolean" || typeof role.superuser !== "boolean") {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator login flag is not an explicit boolean");
  }
  return {
    name: role.name,
    schemaCreate: role.schemaCreate,
    memberOfMigrator: role.memberOfMigrator,
    superuser: role.superuser,
  };
}

export function decideMigratorProbe(input: {
  endpoint: string;
  daemonId: string;
  expectedEndpoint: string;
  expectedDaemonId: string;
  expectedImageId: string;
  tagImageId: string | null;
  digestImageId: string | null;
  networkName: string;
  expectedNetworkName: string;
  dnsAlias: string;
}): { imageId: string } {
  if (!LOCAL_ENDPOINTS.has(input.endpoint) || input.endpoint !== input.expectedEndpoint) {
    throw refusal("STOP", "DOCKER_ENDPOINT_CHANGED", "P1 migrator probe Docker endpoint is not the authenticated daemon");
  }
  if (input.daemonId !== input.expectedDaemonId || !DAEMON_ID.test(input.daemonId)) {
    throw refusal("STOP", "DAEMON_IDENTITY_CHANGED", "P1 migrator probe daemon is not the authenticated daemon");
  }
  if (!IMAGE_ID.test(input.expectedImageId)) {
    throw refusal("STOP", "PROBE_IMAGE_MISMATCH", "P1 migrator probe image id is not a Docker digest");
  }
  if (input.tagImageId === null || input.digestImageId === null) {
    throw refusal("STOP", "PROBE_IMAGE_MISSING", "P1 migrator probe image is not present");
  }
  if (input.tagImageId !== input.expectedImageId) {
    throw refusal("STOP", "PROBE_IMAGE_REPLACED", "P1 migrator probe tag does not match the authenticated database image");
  }
  if (input.digestImageId !== input.expectedImageId) {
    throw refusal("STOP", "PROBE_IMAGE_MISMATCH", "P1 migrator probe digest does not match the authenticated database image");
  }
  if (input.networkName !== input.expectedNetworkName || input.networkName.length === 0 || input.networkName === "host" || /\s/.test(input.networkName)) {
    throw refusal("STOP", "PROBE_NETWORK_MISMATCH", "P1 migrator probe network is not the authenticated database network");
  }
  if (input.dnsAlias !== PRODUCTION_DNS_ALIAS) {
    throw refusal("STOP", "PROBE_ALIAS_MISMATCH", "P1 migrator probe hostname is not the database alias");
  }
  return { imageId: input.expectedImageId };
}

export function migratorProbeArgv(envFile: string, networkName: string, dnsAlias: string, database: string, imageId: string): string[] {
  if (dnsAlias !== PRODUCTION_DNS_ALIAS || !ROLE_NAME.test(database) || !IMAGE_ID.test(imageId)) {
    throw refusal("STOP", "MIGRATOR_PRIVILEGE_REFUSED", "P1 migrator probe target is not the authenticated database");
  }
  const argv = [
    "run",
    "--rm",
    "-i",
    "--pull",
    "never",
    "--network",
    networkName,
    "--env-file",
    envFile,
    imageId,
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
  assertProbeArgv(argv, imageId);
  return argv;
}

export function assertProbeArgv(argv: readonly string[], imageId: string): void {
  const forbidden = ["--privileged", "--cap-add", "--publish", "-p", "--user", "--pid", "--network=host", PRODUCTION_POSTGRES_IMAGE];
  if (argv.some((arg) => forbidden.includes(arg) || arg.startsWith("--publish=") || arg.startsWith("-p"))) {
    throw refusal("STOP", "PROBE_PRIVILEGE_REFUSED", "P1 migrator probe command is not the pinned client");
  }
  if (argv[argv.indexOf("psql") - 1] !== imageId) {
    throw refusal("STOP", "PROBE_IMAGE_MISMATCH", "P1 migrator probe command does not use the authenticated image");
  }
}

export function probeMigratorPrivileges(input: {
  session: { endpoint: string; daemonId: string };
  expectedEndpoint: string;
  expectedDaemonId: string;
  expectedImageId: string;
  networkName: string;
  expectedNetworkName?: string;
  database: string;
  credential: MigratorCredential;
  env: NodeJS.ProcessEnv;
  inspectImage?: (ref: string) => string | null;
  spawn?: (argv: readonly string[], sql: string) => { status: number | null; signal: NodeJS.Signals | null; stdout: string };
}): MigratorPrivilegeReport {
  if (input.credential.role !== PROPOSED_MIGRATOR_ROLE || input.credential.database !== input.database) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_MISMATCH", "P1 migrator probe is not bound to the migrator");
  }
  const inspect = input.inspectImage ?? ((ref: string) => dockerImageId(ref, input.env));
  const decided = decideMigratorProbe({
    endpoint: input.session.endpoint,
    daemonId: input.session.daemonId,
    expectedEndpoint: input.expectedEndpoint,
    expectedDaemonId: input.expectedDaemonId,
    expectedImageId: input.expectedImageId,
    tagImageId: inspect(PRODUCTION_POSTGRES_IMAGE),
    digestImageId: inspect(input.expectedImageId),
    networkName: input.networkName,
    expectedNetworkName: input.expectedNetworkName ?? input.networkName,
    dnsAlias: PRODUCTION_DNS_ALIAS,
  });
  const envFile = path.join(os.tmpdir(), `p1-migrator-${randomUUID()}`);
  fs.writeFileSync(envFile, `PGPASSWORD=${input.credential.password}\n`, { mode: 0o600 });
  try {
    const argv = migratorProbeArgv(envFile, input.networkName, PRODUCTION_DNS_ALIAS, input.database, decided.imageId);
    if (argv.some((arg) => arg.includes(input.credential.password) || arg.includes("PGPASSWORD=") || /postgres(?:ql)?:\/\//i.test(arg))) {
      throw refusal("STOP", "CREDENTIAL_LEAK", "P1 migrator probe command contains a credential");
    }
    const child = input.spawn
      ? input.spawn(argv, migratorPrivilegeSql())
      : spawnSync("docker", argv, {
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

function dockerImageId(ref: string, env: NodeJS.ProcessEnv): string | null {
  const child = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", ref], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (child.status !== 0 || child.signal) return null;
  const id = child.stdout.trim();
  return IMAGE_ID.test(id) ? id : null;
}
