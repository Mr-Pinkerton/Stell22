import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  HISTORICAL_MIGRATION_NAMES,
  classifyP1State,
} from "@/server/internal/p1-isolated-runner/classify";
import {
  POSTGRES_IMAGE_REF,
  createOwnedDisposableContainer,
  reconfirmOwnedContainer,
  removeOwnedDisposableContainer,
  type OwnedConnection,
  type OwnedContainerHandle,
} from "@/server/internal/p1-isolated-runner/container-origin";
import {
  EXPECTED_HISTORICAL_MIGRATION_COUNT,
  EXPECTED_MIGRATION_SQL_COUNT,
  FORBIDDEN_DATABASE_NAMES,
  HISTORICAL_APPLICATION_COMMIT,
  P1_MIGRATION_NAME,
  P1_SHA256,
} from "@/server/internal/p1-isolated-runner/contract";
import { parseDisposableAttestation } from "@/server/internal/p1-isolated-runner/disposable-target";
import { buildChildEnv } from "@/server/internal/p1-isolated-runner/env";
import { executeDisposableApply } from "@/server/internal/p1-isolated-runner/executor";
import { createRepoGitSource } from "@/server/internal/p1-isolated-runner/git-source";
import { PINNED_MIGRATION_FILES } from "@/server/internal/p1-isolated-runner/inventory";
import {
  DISPOSABLE_READ_SQL,
  disposableEvidenceFromQueries,
  readDisposablePostgreSql,
  type ProbeBatch,
} from "@/server/internal/p1-isolated-runner/live-read-probe";
import { assessOwnedDisposablePreapply } from "@/server/internal/p1-isolated-runner/owned-preapply-gate";
import {
  checkMatchesContract,
  columnMatchesContract,
  functionMatchesContract,
  triggerMatchesContract,
} from "@/server/internal/p1-isolated-runner/schema-contract";

const LIVE_FLAG = "P1_DISPOSABLE_LIVE";
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

describe("owned query child", () => {
  const files: string[] = [];

  afterEach(() => {
    for (const file of files.splice(0)) fs.rmSync(file, { force: true });
  });

  it("refuses a non-loopback URL before opening a client", () => {
    const script = writeQueryChild(os.tmpdir());
    files.push(script);
    const child = spawnSync(process.execPath, [script, "unused.json"], {
      encoding: "utf8",
      windowsHide: true,
      env: buildChildEnv(
        process.env,
        "postgresql://p1disp:not-printed@db.example:5432/stell22",
      ) as NodeJS.ProcessEnv,
    });
    expect(child.status).toBe(2);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("refusing non-loopback\n");
    expect(child.stderr).not.toContain("not-printed");
    expect(child.stderr).not.toContain("stell22");
  });
});

describe.skipIf(process.env[LIVE_FLAG] !== "1")(
  "postgresql 17 disposable real migration",
  () => {
    it(
      "applies the historical migrations and then P1 once on a new owned database",
      async () => {
        const owned = createOwnedDisposableContainer();
        const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "stell22-p1-real-"));
        const queryScript = writeQueryChild(
          path.join(process.cwd(), "node_modules", ".cache"),
        );
        let fixture: PrismaClient | null = null;
        let failure: unknown;
        try {
          expect(owned.host).toBe("127.0.0.1");
          expect(owned.user).toBe("p1disp");
          expect(owned.imageRef).toBe(POSTGRES_IMAGE_REF);
          expect(owned.containerId).toMatch(/^[0-9a-f]{64}$/);
          expect(owned.port).toBeGreaterThan(0);
          expect(owned.databaseName.startsWith("p1disp_")).toBe(true);
          expect(owned.endpoint.startsWith("tcp:")).toBe(false);
          expect(owned.endpoint.startsWith("ssh:")).toBe(false);

          const ready = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, ready)).toBe(true);
          fixture = new PrismaClient({ datasourceUrl: ownedUrl(ready) });
          await waitUntilReady(fixture);
          await fixture.$disconnect();
          fixture = null;

          const historicalSchema = materializeHistorical(path.join(scratch, "historical"));
          const historical = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, historical)).toBe(true);
          const historicalUrl = ownedUrl(historical);
          const historicalDeploy = deployPrisma(historicalSchema, historicalUrl);
          expect(historicalDeploy.status, historicalDeploy.detail).toBe(0);
          expect(historicalDeploy.signal).toBeNull();

          const identified = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, identified)).toBe(true);
          fixture = new PrismaClient({ datasourceUrl: ownedUrl(identified) });
          await installIdentity(fixture, identified);
          await fixture.$disconnect();
          fixture = null;

          const before = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, before)).toBe(true);
          const beforeEvidence = disposableEvidenceFromQueries(
            queryOwned(queryScript, ownedUrl(before)),
          );
          expect(finishedNames(beforeEvidence.history)).toEqual(
            [...HISTORICAL_MIGRATION_NAMES].sort(),
          );
          expect(beforeEvidence.history).toHaveLength(EXPECTED_HISTORICAL_MIGRATION_COUNT);
          expect(beforeEvidence.schema.column).toBeNull();

          const gate = await assessOwnedDisposablePreapply(owned);
          expect(gate.status, "code" in gate ? gate.code : "").toBe("diagnostic-ready");
          if (gate.status !== "diagnostic-ready") return;
          expect(gate.code).toBe("P1_ABSENT");
          expect(gate.executionAuthorized).toBe(false);
          expect(gate.prismaExecutionAuthorized).toBe(false);
          expect(gate.publicAuthorization.applyEnabled).toBe(false);

          const confirmed = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, confirmed)).toBe(true);
          const confirmedUrl = ownedUrl(confirmed);
          let spawns = 0;
          let prismaDetail = "";
          const parentEnv = {
            ...process.env,
            DATABASE_URL: "postgresql://blocked.example/stell22",
          };
          const first = executeDisposableApply(attestationFor(confirmed), {
            git: createRepoGitSource(process.cwd()),
            destinationRoot: path.join(scratch, "p1"),
            lockPath: path.join(scratch, "p1.lock"),
            parentEnv,
            readHistory: () =>
              disposableEvidenceFromQueries(queryOwned(queryScript, confirmedUrl)).history,
            readSchema: () =>
              disposableEvidenceFromQueries(queryOwned(queryScript, confirmedUrl)).schema,
            probeIdentity: () => identityFrom(queryOwned(queryScript, confirmedUrl)),
            spawnPrisma: (request) => {
              spawns += 1;
              const argsOk =
                request.args.length === 4 &&
                request.args[0] === "migrate" &&
                request.args[1] === "deploy" &&
                request.args[2] === "--schema";
              const target = new URL(String(request.env.DATABASE_URL));
              const database = decodeURIComponent(target.pathname.replace(/^\//, ""));
              const targetOk =
                target.hostname === "127.0.0.1" &&
                target.port === String(confirmed.port) &&
                target.username === "p1disp" &&
                database === confirmed.databaseName &&
                !Object.values(request.env).some((value) =>
                  String(value).includes("blocked.example"),
                );
              if (!argsOk || !targetOk) {
                prismaDetail = "refusing prisma target";
                return { status: 1, signal: null };
              }
              const result = runPrisma(request.args, request.cwd, request.env);
              prismaDetail = `${result.detail || "no prisma text"} files ${countMigrationSql(request.cwd)}`;
              return result;
            },
          });
          if (first.verdict !== "ALREADY_APPLIED") {
            throw new Error(postApplySummary(queryScript, confirmedUrl, first, prismaDetail));
          }
          expect(first, prismaDetail).toEqual({
            verdict: "ALREADY_APPLIED",
            code: "P1_APPLIED",
            spawned: true,
            retryAttempted: false,
          });
          expect(spawns).toBe(1);

          const after = reconfirmOwnedContainer(owned);
          expect(sameTarget(owned, after)).toBe(true);
          const afterEvidence = disposableEvidenceFromQueries(
            queryOwned(queryScript, ownedUrl(after)),
          );
          expect(afterEvidence.history).toHaveLength(EXPECTED_MIGRATION_SQL_COUNT);
          expect(finishedNames(afterEvidence.history)).toEqual(
            [...HISTORICAL_MIGRATION_NAMES, P1_MIGRATION_NAME].sort(),
          );
          const p1 = afterEvidence.history.find((row) => row.migrationName === P1_MIGRATION_NAME);
          expect(p1?.checksum).toBe(P1_SHA256);
          const column = afterEvidence.schema.column;
          const check = afterEvidence.schema.check;
          const functionDef = afterEvidence.schema.functionDef;
          const trigger = afterEvidence.schema.trigger;
          if (!column || !check || !functionDef || !trigger) {
            throw new Error("P1 schema evidence is incomplete");
          }
          expect(column.isNullable).toBe("YES");
          expect(column.columnDefault).toBeNull();
          expect(column.dataType).toBe("jsonb");
          expect(columnMatchesContract(column)).toBe(true);
          expect(checkMatchesContract(check)).toBe(true);
          expect(functionMatchesContract(functionDef)).toBe(true);
          expect(trigger.enabled).toBe("O");
          expect(triggerMatchesContract(trigger)).toBe(true);
          expect(afterEvidence.schema.foreignKeyCount).toBe(0);
          expect(afterEvidence.schema.extraTriggerNames).toEqual([]);
          expect(afterEvidence.schema.unexpectedObjects).toEqual([]);

          const report = await readDisposablePostgreSql(attestationFor(after));
          expect(report.evidenceSource).toBe("postgresql-query");
          expect(report.classification).toMatchObject({
            verdict: "ALREADY_APPLIED",
            code: "P1_APPLIED",
          });
          expect(report.verdict).toBe("BLOCKED");
          expect(report.code).toBe("CONTAINER_ORIGIN_NOT_ESTABLISHED");
          expect(report.applyEnabled).toBe(false);
          const reportText = JSON.stringify(report);
          expect(reportText).not.toContain(after.password);
          expect(reportText).not.toContain("postgresql://");

          const applied = await assessOwnedDisposablePreapply(owned);
          expect(applied.status).toBe("already-applied");
          if (applied.status !== "already-applied") return;
          expect(applied.code).toBe("P1_APPLIED");
          expect(applied.executionAuthorized).toBe(false);
          expect(applied.repeatMigrationAuthorized).toBe(false);

          const second = executeDisposableApply(attestationFor(after), {
            git: createRepoGitSource(process.cwd()),
            destinationRoot: path.join(scratch, "p1-repeat"),
            lockPath: path.join(scratch, "p1-repeat.lock"),
            parentEnv,
            readHistory: () =>
              disposableEvidenceFromQueries(queryOwned(queryScript, ownedUrl(after))).history,
            readSchema: () =>
              disposableEvidenceFromQueries(queryOwned(queryScript, ownedUrl(after))).schema,
            probeIdentity: () => identityFrom(queryOwned(queryScript, ownedUrl(after))),
            spawnPrisma: () => {
              spawns += 1;
              return { status: 1, signal: null };
            },
          });
          expect(second).toEqual({
            verdict: "ALREADY_APPLIED",
            code: "P1_APPLIED",
            spawned: false,
            retryAttempted: false,
          });
          expect(spawns).toBe(1);
        } catch (error) {
          failure = error;
        } finally {
          await fixture?.$disconnect().catch(() => undefined);
          try {
            removeOwnedDisposableContainer(owned);
          } catch (error) {
            failure ??= error;
          }
          fs.rmSync(queryScript, { force: true });
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              fs.rmSync(scratch, { recursive: true, force: true });
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
        }
        if (failure) throw failure;
      },
      360_000,
    );
  },
);

function writeQueryChild(directory: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const script = path.join(directory, `p1-owned-query-${process.pid}.cjs`);
  fs.writeFileSync(script, QUERY_CHILD);
  return script;
}

function materializeHistorical(root: string): string {
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

function writeBlob(root: string, filePath: string, bytes: Buffer): void {
  const target = path.join(root, filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
}

function deployPrisma(
  schemaPath: string,
  url: string,
): { status: number | null; signal: NodeJS.Signals | null; detail: string } {
  return runPrisma(
    ["migrate", "deploy", "--schema", schemaPath],
    path.dirname(path.dirname(schemaPath)),
    buildChildEnv({ ...process.env, DATABASE_URL: "postgresql://blocked.example/stell22" }, url),
  );
}

function runPrisma(
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): { status: number | null; signal: NodeJS.Signals | null; detail: string } {
  const databaseUrl = env.DATABASE_URL ?? "";
  const parsed = new URL(databaseUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.username !== "p1disp") {
    throw new Error("refusing prisma target");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (
    FORBIDDEN_DATABASE_NAMES.some((name) => name === database.toLowerCase()) ||
    !database.startsWith("p1disp_")
  ) {
    throw new Error("refusing prisma database");
  }
  const cli = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  const child = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...env } as NodeJS.ProcessEnv,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const detail = redactText(`${child.stdout ?? ""}\n${child.stderr ?? ""}`, databaseUrl)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /migration|pending|applied|error|P\d{4}/i.test(line))
    .slice(0, 8)
    .join(" | ")
    .slice(0, 800);
  return { status: child.status, signal: child.signal, detail };
}

function queryOwned(script: string, url: string): ProbeBatch {
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

function identityFrom(batch: ProbeBatch): {
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

function arrayRow(value: unknown, key: string): Record<string, unknown> {
  if (!Array.isArray(value) || value.length !== 1 || !value[0] || typeof value[0] !== "object") {
    throw new Error(`owned ${key} row is missing`);
  }
  return value[0] as Record<string, unknown>;
}

function finishedNames(
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

function sameTarget(owned: OwnedContainerHandle, connection: OwnedConnection): boolean {
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

function ownedUrl(connection: OwnedConnection): string {
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

function attestationFor(connection: OwnedConnection) {
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

async function installIdentity(fixture: PrismaClient, identity: OwnedConnection): Promise<void> {
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

async function waitUntilReady(fixture: PrismaClient): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fixture.$queryRawUnsafe("SELECT 1");
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("disposable postgres did not accept a read");
}

function countMigrationSql(root: string): number {
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

function postApplySummary(
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

function redactText(detail: string, secret: string): string {
  return detail
    .split(secret)
    .join("[redacted]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]")
    .replace(/p1disp_[0-9a-f]+/gi, "[database]")
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:[port]");
}
