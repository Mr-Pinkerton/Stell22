import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { classifyP1State } from "@/server/internal/p1-isolated-runner/classify";
import {
  POSTGRES_IMAGE_REF,
  type OwnedConnection,
  type OwnedContainerHandle,
} from "@/server/internal/p1-isolated-runner/container-origin";
import {
  EXPECTED_HISTORICAL_MIGRATION_COUNT,
  FORBIDDEN_DATABASE_NAMES,
  HISTORICAL_APPLICATION_COMMIT,
  P1_MIGRATION_NAME,
  P1_SHA256,
} from "@/server/internal/p1-isolated-runner/contract";
import { parseDisposableAttestation } from "@/server/internal/p1-isolated-runner/disposable-target";
import { buildChildEnv } from "@/server/internal/p1-isolated-runner/env";
import {
  assertOutsideRepository,
  DisposableMigrateRefusal,
  parseDisposableDatabaseUrl,
  probeCurrentDatabase,
} from "@/server/internal/disposable-migrate/guard";
import { createRepoGitSource } from "@/server/internal/p1-isolated-runner/git-source";
import { PINNED_MIGRATION_FILES } from "@/server/internal/p1-isolated-runner/inventory";
import {
  DISPOSABLE_READ_SQL,
  disposableEvidenceFromQueries,
  type ProbeBatch,
} from "@/server/internal/p1-isolated-runner/live-read-probe";
import {
  checkMatchesContract,
  columnMatchesContract,
  functionMatchesContract,
  triggerMatchesContract,
} from "@/server/internal/p1-isolated-runner/schema-contract";

/**
 * Test-only helpers shared by the disposable migration tests.
 * They are not a public apply command.
 */

const QUERY_NAMES = Object.keys(DISPOSABLE_READ_SQL);

const QUERY_CHILD = `
const fs = require("node:fs");
const urlText = process.env.DATABASE_URL || "";
let parsed;
try {
  parsed = new URL(urlText);
} catch {
  process.stderr.write("refusing url\\n");
  process.exit(2);
}
if (parsed.hostname !== "127.0.0.1") {
  process.stderr.write("refusing non-loopback\\n");
  process.exit(2);
}
const database = decodeURIComponent(parsed.pathname.replace(/^\\//, ""));
const forbidden = ${JSON.stringify([...FORBIDDEN_DATABASE_NAMES])};
if (forbidden.includes(database.toLowerCase()) || parsed.username !== "p1disp") {
  process.stderr.write("refusing database\\n");
  process.exit(2);
}
const { PrismaClient } = require("@prisma/client");
function revive(value) {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(revive);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = revive(item);
    return out;
  }
  return value;
}
(async () => {
  const prisma = new PrismaClient({ datasourceUrl: urlText });
  try {
    const queries = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const out = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '5000'");
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2000'");
      await tx.$executeRawUnsafe("SET LOCAL search_path = pg_catalog");
      const rows = {};
      for (const [name, sql] of Object.entries(queries)) {
        if (typeof sql !== "string" || !/^\\s*SELECT\\b/i.test(sql)) {
          process.stderr.write("refusing statement\\n");
          process.exit(2);
        }
        rows[name] = await tx.$queryRawUnsafe(sql);
      }
      return rows;
    }, { isolationLevel: "RepeatableRead", maxWait: 2000, timeout: 15000 });
    process.stdout.write(JSON.stringify(revive(out)));
  } catch {
    process.stderr.write("owned query failed\\n");
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
`;

export function writeQueryChild(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const script = path.join(directory, `p1-owned-query-${process.pid}.cjs`);
  fs.writeFileSync(script, QUERY_CHILD);
  return script;
}

export function materializeHistorical(root: string): string {
  const git = createRepoGitSource(process.cwd());
  const resolved = git.resolveCommit(HISTORICAL_APPLICATION_COMMIT);
  if (resolved.commit !== HISTORICAL_APPLICATION_COMMIT) {
    throw new Error("historical commit drift");
  }
  const listed = git.listMigrationTree(HISTORICAL_APPLICATION_COMMIT);
  const sql = listed.filter((entry) => entry.path.endsWith("/migration.sql"));
  if (sql.length !== EXPECTED_HISTORICAL_MIGRATION_COUNT) {
    throw new Error("historical migration count drift");
  }
  if (sql.some((entry) => entry.path.includes(P1_MIGRATION_NAME))) {
    throw new Error("historical tree contains P1");
  }
  const pinned = new Map<string, string>(
    PINNED_MIGRATION_FILES.map((entry) => [entry.path, entry.gitBlob]),
  );
  for (const entry of sql) {
    if (pinned.get(entry.path) !== entry.gitBlob) {
      throw new Error(`historical blob drift ${entry.path}`);
    }
  }
  fs.mkdirSync(root);
  for (const entry of listed) {
    writeBlob(root, entry.path, git.readBlob(entry.gitBlob));
  }
  const schemaBlob = git.resolvePathBlob(HISTORICAL_APPLICATION_COMMIT, "prisma/schema.prisma");
  writeBlob(root, "prisma/schema.prisma", git.readBlob(schemaBlob));
  return path.join(root, "prisma", "schema.prisma");
}

export function writeBlob(root: string, filePath: string, bytes: Buffer): void {
  const target = path.join(root, filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function schemaOutsideRepository(schemaPath: string, repositoryRoot: string): {
  schemaPath: string;
  cwd: string;
  cleanup?: () => void;
} {
  const resolved = path.resolve(schemaPath);
  const cwd = path.dirname(path.dirname(resolved));
  try {
    assertOutsideRepository(cwd, repositoryRoot);
    assertOutsideRepository(resolved, repositoryRoot);
    return { schemaPath: resolved, cwd };
  } catch (error) {
    if (!(error instanceof DisposableMigrateRefusal) || error.code !== "INSIDE_REPOSITORY") throw error;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stell22-prisma-deploy-"));
  fs.cpSync(path.dirname(resolved), path.join(root, "prisma"), { recursive: true });
  return {
    schemaPath: path.join(root, "prisma", "schema.prisma"),
    cwd: root,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function deployPrisma(
  schemaPath: string,
  url: string,
): { status: number | null; signal: NodeJS.Signals | null; detail: string } {
  return runPrisma(
    ["migrate", "deploy", "--schema", schemaPath],
    path.dirname(path.dirname(schemaPath)),
    buildChildEnv({ ...process.env, DATABASE_URL: "postgresql://blocked.example/stell22" }, url),
  );
}

export function runPrisma(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): { status: number | null; signal: NodeJS.Signals | null; detail: string } {
  const databaseUrl = env.DATABASE_URL ?? "";
  const parsed = new URL(databaseUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.username !== "p1disp") {
    throw new Error("refusing prisma target");
  }
  const target = parseDisposableDatabaseUrl(databaseUrl);
  const schemaIndex = args.indexOf("--schema");
  const schemaArg = schemaIndex >= 0 ? args[schemaIndex + 1] ?? "" : "";
  const relocated = schemaArg ? schemaOutsideRepository(schemaArg, process.cwd()) : undefined;
  const spawnCwd = relocated?.cwd ?? cwd;
  const spawnArgs = [...args];
  if (relocated) spawnArgs[schemaIndex + 1] = relocated.schemaPath;
  else assertOutsideRepository(spawnCwd, process.cwd());
  const cli = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  let child: SpawnSyncReturns<string>;
  try {
    if (probeCurrentDatabase(databaseUrl, process.cwd()).toLowerCase() !== target.database) {
      throw new Error("refusing prisma database");
    }
    child = spawnSync(process.execPath, [cli, ...spawnArgs], {
      cwd: spawnCwd,
      env: { ...env } as NodeJS.ProcessEnv,
      encoding: "utf8",
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } finally {
    relocated?.cleanup?.();
  }
  const detail = redactText(`${child.stdout ?? ""}\n${child.stderr ?? ""}`, databaseUrl)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /migration|pending|applied|error|P\d{4}/i.test(line))
    .slice(0, 8)
    .join(" | ")
    .slice(0, 800);
  return { status: child.status, signal: child.signal, detail };
}

export function queryOwned(script: string, url: string): ProbeBatch {
  const queries = path.join(path.dirname(script), `p1-owned-queries-${process.pid}.json`);
  fs.writeFileSync(queries, JSON.stringify(DISPOSABLE_READ_SQL));
  try {
    const child = spawnSync(process.execPath, [script, queries], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: buildChildEnv(process.env, url) as NodeJS.ProcessEnv,
    });
    if (child.status !== 0) throw new Error("owned query failed");
    const parsed: unknown = JSON.parse(child.stdout);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("owned query response is not an object");
    }
    const record = parsed as Record<string, unknown>;
    if (QUERY_NAMES.some((name) => !Array.isArray(record[name]))) {
      throw new Error("owned query response is missing a row set");
    }
    return record as ProbeBatch;
  } finally {
    fs.rmSync(queries, { force: true });
  }
}

export function identityFrom(batch: ProbeBatch): {
  currentDatabase: string;
  serverVersionNum: number;
  runId: string;
  nonce: string;
  containerId: string;
} {
  const connection = arrayRow(batch.connection, "current_database");
  const identity = arrayRow(batch.identity, "run_id");
  const serverVersionNum = Number(connection.server_version_num);
  if (
    typeof connection.current_database !== "string" ||
    !Number.isInteger(serverVersionNum) ||
    typeof identity.run_id !== "string" ||
    typeof identity.nonce !== "string" ||
    typeof identity.container_id !== "string"
  ) {
    throw new Error("owned identity row is malformed");
  }
  return {
    currentDatabase: connection.current_database,
    serverVersionNum,
    runId: identity.run_id,
    nonce: identity.nonce,
    containerId: identity.container_id,
  };
}

export function arrayRow(value: unknown, key: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") {
    throw new Error(`owned ${key} row is missing`);
  }
  return value[0] as Record<string, unknown>;
}

export function finishedNames(
  rows: readonly {
    migrationName: string;
    startedAt: string | null;
    finishedAt: string | null;
    rolledBackAt: string | null;
    appliedStepsCount: number;
  }[],
): string[] {
  if (
    rows.some(
      (row) =>
        row.startedAt === null ||
        row.finishedAt === null ||
        row.rolledBackAt !== null ||
        row.appliedStepsCount !== 1,
    )
  ) {
    throw new Error("migration history is not a complete successful set");
  }
  return rows.map((row) => row.migrationName).sort();
}

export function sameTarget(owned: OwnedContainerHandle, connection: OwnedConnection): boolean {
  return (
    connection.host === "127.0.0.1" &&
    connection.port === owned.port &&
    connection.databaseName === owned.databaseName &&
    connection.runId === owned.runId &&
    connection.containerId === owned.containerId &&
    connection.containerName === owned.containerName &&
    connection.user === "p1disp"
  );
}

export function ownedUrl(connection: OwnedConnection): string {
  const url = new URL("postgresql://127.0.0.1");
  url.username = connection.user;
  url.password = connection.password;
  url.hostname = connection.host;
  url.port = String(connection.port);
  url.pathname = `/${connection.databaseName}`;
  url.searchParams.set("schema", "public");
  url.searchParams.set("connect_timeout", "5");
  if (url.hostname !== "127.0.0.1") throw new Error("refusing non-loopback");
  return url.toString();
}

export function attestationFor(connection: OwnedConnection) {
  return parseDisposableAttestation({
    kind: "stell22-p1-disposable-target",
    version: 1,
    runId: connection.runId,
    databaseName: connection.databaseName,
    host: "127.0.0.1",
    port: connection.port,
    user: "p1disp",
    password: connection.password,
    containerId: connection.containerId,
    containerName: connection.containerName,
    image: POSTGRES_IMAGE_REF,
    nonce: connection.nonce,
    composeProject: connection.containerName,
    networkName: connection.containerName,
    postgresMajor: 17,
  });
}

export async function installIdentity(fixture: PrismaClient, identity: OwnedConnection): Promise<void> {
  await fixture.$executeRawUnsafe(`
    CREATE TABLE public.stell22_p1_disposable_identity (
      singleton boolean PRIMARY KEY,
      run_id text NOT NULL,
      nonce text NOT NULL,
      container_id text NOT NULL,
      CONSTRAINT stell22_p1_disposable_identity_singleton CHECK (singleton)
    )
  `);
  await fixture.$executeRawUnsafe(
    `
      INSERT INTO public.stell22_p1_disposable_identity
        (singleton, run_id, nonce, container_id)
      VALUES (true, $1, $2, $3)
    `,
    identity.runId,
    identity.nonce,
    identity.containerId,
  );
}

export async function waitUntilReady(fixture: PrismaClient): Promise<void> {
  let last = "no attempt";
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await fixture.$queryRawUnsafe("SELECT 1");
      return;
    } catch (error) {
      last = publicRedact(error instanceof Error ? error.message : "read failed").slice(0, 240);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`disposable postgres did not accept a read: ${last}`);
}

export function countMigrationSql(root: string): number {
  const directory = path.join(root, "prisma", "migrations");
  if (!fs.existsSync(directory)) return 0;
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(directory, entry.name, "migration.sql")),
    ).length;
}

export function postApplySummary(
  script: string,
  url: string,
  first: { verdict: string; code: string },
  prismaDetail: string,
): string {
  try {
    const evidence = disposableEvidenceFromQueries(queryOwned(script, url));
    const classification = classifyP1State({
      history: evidence.history,
      schema: evidence.schema,
    });
    const p1 = evidence.history.find((row) => row.migrationName === P1_MIGRATION_NAME);
    const column = evidence.schema.column;
    const check = evidence.schema.check;
    const functionDef = evidence.schema.functionDef;
    const trigger = evidence.schema.trigger;
    return [
      `executor ${first.verdict} ${first.code}`,
      `prisma ${prismaDetail || "no output"}`,
      `structural ${classification.verdict} ${classification.code}`,
      `rows ${evidence.history.length}`,
      `p1 ${p1 ? "present" : "absent"} checksum ${p1?.checksum === P1_SHA256 ? "match" : "differs"}`,
      `column ${column ? `${column.dataType} nullable=${column.isNullable} default=${column.columnDefault === null}` : "absent"} contract ${column ? columnMatchesContract(column) : false}`,
      `check ${check ? checkMatchesContract(check) : false}`,
      `function ${functionDef ? functionMatchesContract(functionDef) : false}`,
      `trigger ${trigger ? `${trigger.enabled} ${triggerMatchesContract(trigger)}` : "absent"}`,
      `fk ${evidence.schema.foreignKeyCount} extra ${evidence.schema.extraTriggerNames.length} unexpected ${evidence.schema.unexpectedObjects.length}`,
    ].join("; ");
  } catch {
    return `executor ${first.verdict} ${first.code}; post-read failed; prisma ${prismaDetail || "exit 0"}`;
  }
}

function publicRedact(detail: string): string {
  return detail
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]")
    .replace(/p1disp_[0-9a-f]+/gi, "[database]")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:[port]");
}

export function redactText(detail: string, secret: string): string {
  const hidden = secret.length > 0 ? detail.split(secret).join("[redacted]") : detail;
  return hidden
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]")
    .replace(/p1disp_[0-9a-f]+/gi, "[database]")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:[port]");
}
