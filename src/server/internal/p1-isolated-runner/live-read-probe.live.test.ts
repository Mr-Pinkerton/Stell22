import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  successfulHistoricalRows,
  successfulP1Row,
} from "@/server/internal/p1-isolated-runner/classify";
import { parseDisposableAttestation } from "@/server/internal/p1-isolated-runner/disposable-target";
import { readDisposablePostgreSql } from "@/server/internal/p1-isolated-runner/live-read-probe";
import {
  checkMatchesContract,
  columnMatchesContract,
  functionMatchesContract,
  triggerMatchesContract,
} from "@/server/internal/p1-isolated-runner/schema-contract";

const IMAGE = "postgres:17-alpine";
const LIVE_FLAG = "P1_DISPOSABLE_LIVE";
const LABEL = "stell22.p1.live-read";

type FixtureProvenance =
  | { ok: true; containerId: string; host: "127.0.0.1"; port: number }
  | { ok: false; reason: string };

type FixtureStatement = { sql: string; params: readonly unknown[] };

type FixtureHistoryRow = {
  id: string;
  checksum: string;
  finishedAt: string | null;
  migrationName: string;
  startedAt: string | null;
  appliedStepsCount: number;
};

export function assessFixtureProvenance(input: {
  expectedId: string;
  expectedName: string;
  expectedRunId: string;
  inspectDocument: unknown;
}): FixtureProvenance {
  const row = inspectRow(input.inspectDocument);
  if (!row) return { ok: false, reason: "INSPECT_UNAVAILABLE" };
  if (!isContainerId(input.expectedId) || row.id !== input.expectedId) {
    return { ok: false, reason: "IDENTITY_MISMATCH" };
  }
  if (row.name !== input.expectedName || !ownedName(input.expectedName, input.expectedRunId)) {
    return { ok: false, reason: "NAME_MISMATCH" };
  }
  if (row.label !== input.expectedRunId) return { ok: false, reason: "LABEL_MISMATCH" };
  if (row.imageRef !== IMAGE || !row.imageId.startsWith("sha256:")) {
    return { ok: false, reason: "IMAGE_MISMATCH" };
  }
  if (!row.running) return { ok: false, reason: "NOT_RUNNING" };
  if (!row.binding) return { ok: false, reason: "PORT_NOT_LOOPBACK" };
  if (row.binding.hostIp !== "127.0.0.1") return { ok: false, reason: "PORT_NOT_LOOPBACK" };
  if (row.binding.requestedPort !== null && row.binding.requestedPort !== row.binding.hostPort) {
    return { ok: false, reason: "PORT_MAPPING_MISMATCH" };
  }
  return {
    ok: true,
    containerId: row.id,
    host: "127.0.0.1",
    port: row.binding.hostPort,
  };
}

export function cleanupAllowed(input: {
  createdId: string;
  expectedName: string;
  expectedRunId: string;
  inspectDocument: unknown;
}): boolean {
  const row = inspectRow(input.inspectDocument);
  return (
    row !== null &&
    isContainerId(input.createdId) &&
    row.id === input.createdId &&
    row.name === input.expectedName &&
    ownedName(input.expectedName, input.expectedRunId) &&
    row.label === input.expectedRunId
  );
}

export async function applyFixtureDdl(input: {
  provenance: FixtureProvenance;
  query: (sql: string) => Promise<unknown>;
  execute: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
  identity: { runId: string; nonce: string; containerId: string };
  migrationSql: string;
  history: readonly FixtureHistoryRow[];
}): Promise<{ applied: true } | { applied: false; reason: string }> {
  if (!input.provenance.ok) return { applied: false, reason: input.provenance.reason };
  if (input.provenance.host !== "127.0.0.1") {
    return { applied: false, reason: "PORT_NOT_LOOPBACK" };
  }
  let count: unknown;
  try {
    count = await input.query(PUBLIC_TABLE_COUNT_SQL);
  } catch {
    return { applied: false, reason: "FIXTURE_PRECHECK_FAILED" };
  }
  if (!isZeroTableCount(count)) return { applied: false, reason: "FIXTURE_DATABASE_NOT_EMPTY" };
  const statements = fixtureStatements(input.migrationSql, input.identity, input.history);
  if (statements.some((statement) => !isFixtureStatement(statement.sql))) {
    return { applied: false, reason: "FIXTURE_SQL_REFUSED" };
  }
  for (const statement of statements) {
    await input.execute(statement.sql, statement.params);
  }
  return { applied: true };
}

const PUBLIC_TABLE_COUNT_SQL = `
SELECT count(*)::int AS table_count
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
`.trim();

function fixtureStatements(
  migrationSql: string,
  identity: { runId: string; nonce: string; containerId: string },
  history: readonly FixtureHistoryRow[],
): FixtureStatement[] {
  const functionStart = migrationSql.indexOf("CREATE FUNCTION");
  const functionEnd = migrationSql.indexOf("$$;", functionStart);
  const triggerStart = migrationSql.indexOf("CREATE TRIGGER");
  const triggerEnd = migrationSql.indexOf(";", triggerStart);
  if (functionStart < 0 || functionEnd < 0 || triggerStart < 0 || triggerEnd < 0) {
    return [{ sql: "REJECT", params: [] }];
  }
  const functionSql = migrationSql.slice(functionStart, functionEnd + 3);
  const triggerSql = migrationSql.slice(triggerStart, triggerEnd + 1);
  const statements: FixtureStatement[] = [
    {
      sql: `
        CREATE TABLE public."BatchCreationCommand" (
          id text PRIMARY KEY,
          "requestId" text NOT NULL,
          "batchId" text NOT NULL,
          "receiptProvenanceSnapshot" jsonb
        )
      `,
      params: [],
    },
    {
      sql: `
        ALTER TABLE public."BatchCreationCommand"
          ADD CONSTRAINT "BatchCreationCommand_receiptProvenanceSnapshot_shape"
          CHECK (
            "receiptProvenanceSnapshot" IS NULL
            OR jsonb_typeof("receiptProvenanceSnapshot") = 'object'
          )
      `,
      params: [],
    },
    { sql: functionSql, params: [] },
    { sql: triggerSql, params: [] },
    {
      sql: `
        CREATE TABLE public.stell22_p1_disposable_identity (
          singleton boolean PRIMARY KEY,
          run_id text NOT NULL,
          nonce text NOT NULL,
          container_id text NOT NULL,
          CONSTRAINT stell22_p1_disposable_identity_singleton CHECK (singleton)
        )
      `,
      params: [],
    },
    {
      sql: `
        INSERT INTO public.stell22_p1_disposable_identity
          (singleton, run_id, nonce, container_id)
        VALUES (true, $1, $2, $3)
      `,
      params: [identity.runId, identity.nonce, identity.containerId],
    },
    {
      sql: `
        CREATE TABLE public."_prisma_migrations" (
          id varchar(36) PRIMARY KEY,
          checksum varchar(64) NOT NULL,
          finished_at timestamptz,
          migration_name varchar(255) NOT NULL,
          logs text,
          rolled_back_at timestamptz,
          started_at timestamptz NOT NULL,
          applied_steps_count integer NOT NULL
        )
      `,
      params: [],
    },
  ];
  for (const row of history) {
    statements.push({
      sql: `
        INSERT INTO public."_prisma_migrations"
          (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
        VALUES ($1, $2, $3::timestamptz, $4, $5::timestamptz, $6)
      `,
      params: [
        row.id,
        row.checksum,
        row.finishedAt,
        row.migrationName,
        row.startedAt,
        row.appliedStepsCount,
      ],
    });
  }
  return statements;
}

function isFixtureStatement(sql: string): boolean {
  const text = sql.trim();
  if (/^\s*DROP\b/i.test(text) || /\bDROP\s+TABLE\b/i.test(text)) return false;
  return /^(CREATE|ALTER|INSERT)\b/i.test(text);
}

function isZeroTableCount(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const count = value[0]?.table_count;
  return count === 0 || count === BigInt(0) || count === "0";
}

type InspectedContainer = {
  id: string;
  name: string;
  imageRef: string;
  imageId: string;
  label: string | null;
  running: boolean;
  binding: { hostIp: string; hostPort: number; requestedPort: number | null } | null;
};

function inspectRow(document: unknown): InspectedContainer | null {
  if (!Array.isArray(document) || document.length !== 1) return null;
  const row = document[0];
  if (!row || typeof row !== "object") return null;
  const record = row as Record<string, unknown>;
  if (typeof record.Id !== "string" || !isContainerId(record.Id)) return null;
  if (typeof record.Name !== "string" || !record.Name.startsWith("/")) return null;
  const config = record.Config;
  const state = record.State;
  const imageId = record.Image;
  if (!config || typeof config !== "object" || !state || typeof state !== "object") return null;
  if (typeof imageId !== "string") return null;
  const imageRef = (config as { Image?: unknown }).Image;
  const labels = (config as { Labels?: unknown }).Labels;
  const running = (state as { Running?: unknown }).Running;
  const status = (state as { Status?: unknown }).Status;
  if (typeof imageRef !== "string") return null;
  const label =
    labels && typeof labels === "object"
      ? (labels as Record<string, unknown>)[LABEL]
      : undefined;
  return {
    id: record.Id,
    name: record.Name.slice(1),
    imageRef,
    imageId,
    label: typeof label === "string" ? label : null,
    running: running === true && status === "running",
    binding: readBinding(record),
  };
}

function readBinding(
  record: Record<string, unknown>,
): InspectedContainer["binding"] {
  const hostConfig = record.HostConfig;
  const network = record.NetworkSettings;
  if (!hostConfig || typeof hostConfig !== "object" || !network || typeof network !== "object") {
    return null;
  }
  const requested = portList(
    (hostConfig as { PortBindings?: unknown }).PortBindings,
  );
  const published = portList((network as { Ports?: unknown }).Ports);
  if (!requested || !published || requested.length !== 1 || published.length !== 1) return null;
  const request = requested[0];
  const actual = published[0];
  if (!request || !actual || request.hostIp !== actual.hostIp || actual.hostPort === null) {
    return null;
  }
  if (actual.hostPort < 1 || actual.hostPort > 65535) return null;
  return {
    hostIp: actual.hostIp,
    hostPort: actual.hostPort,
    requestedPort: request.hostPort,
  };
}

function portList(value: unknown): { hostIp: string; hostPort: number | null }[] | null {
  if (!value || typeof value !== "object") return null;
  const ports = (value as Record<string, unknown>)["5432/tcp"];
  if (!Array.isArray(ports)) return null;
  const bindings = [];
  for (const entry of ports) {
    if (!entry || typeof entry !== "object") return null;
    const hostIp = (entry as { HostIp?: unknown }).HostIp;
    const hostPort = (entry as { HostPort?: unknown }).HostPort;
    if (typeof hostIp !== "string" || hostIp.length === 0) return null;
    if (typeof hostPort !== "string") return null;
    if (hostPort.length === 0) {
      bindings.push({ hostIp, hostPort: null });
      continue;
    }
    if (!/^[0-9]+$/.test(hostPort)) return null;
    bindings.push({ hostIp, hostPort: Number(hostPort) });
  }
  return bindings;
}

function ownedName(name: string, runId: string): boolean {
  return (
    name === `stell22-p1-disposable-${runId}` &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)
  );
}

function isContainerId(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

const SAMPLE_RUN = "11111111-1111-4111-8111-111111111111";
const SAMPLE_NAME = `stell22-p1-disposable-${SAMPLE_RUN}`;
const SAMPLE_ID = "a".repeat(64);

function sampleInspect(patch?: (row: Record<string, unknown>) => void): unknown {
  const row: Record<string, unknown> = {
    Id: SAMPLE_ID,
    Name: `/${SAMPLE_NAME}`,
    Image: `sha256:${"b".repeat(64)}`,
    Config: {
      Image: IMAGE,
      Labels: { [LABEL]: SAMPLE_RUN },
    },
    State: { Running: true, Status: "running" },
    HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
    NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54321" }] } },
  };
  patch?.(row);
  return [row];
}

describe("disposable fixture provenance", () => {
  const previousFlag = process.env[LIVE_FLAG];

  afterEach(() => {
    if (previousFlag === undefined) delete process.env[LIVE_FLAG];
    else process.env[LIVE_FLAG] = previousFlag;
  });

  it("refuses fixture DDL when the published port is not loopback", async () => {
    process.env[LIVE_FLAG] = "1";
    const provenance = assessFixtureProvenance({
      expectedId: SAMPLE_ID,
      expectedName: SAMPLE_NAME,
      expectedRunId: SAMPLE_RUN,
      inspectDocument: sampleInspect((row) => {
        row.HostConfig = { PortBindings: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }] } };
        row.NetworkSettings = {
          Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "54321" }] },
        };
      }),
    });
    const called = { query: 0, execute: 0 };
    const result = await applyFixtureDdl({
      provenance,
      query: async () => {
        called.query += 1;
        return [{ table_count: 0 }];
      },
      execute: async () => {
        called.execute += 1;
      },
      identity: { runId: SAMPLE_RUN, nonce: "n".repeat(32), containerId: SAMPLE_ID },
      migrationSql: "",
      history: [],
    });
    expect(provenance).toEqual({ ok: false, reason: "PORT_NOT_LOOPBACK" });
    expect(result).toEqual({ applied: false, reason: "PORT_NOT_LOOPBACK" });
    expect(called).toEqual({ query: 0, execute: 0 });
  });

  it("refuses fixture DDL when the requested port disagrees with the published port", async () => {
    const provenance = assessFixtureProvenance({
      expectedId: SAMPLE_ID,
      expectedName: SAMPLE_NAME,
      expectedRunId: SAMPLE_RUN,
      inspectDocument: sampleInspect((row) => {
        row.HostConfig = {
          PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54329" }] },
        };
      }),
    });
    let executed = false;
    const result = await applyFixtureDdl({
      provenance,
      query: async () => [{ table_count: 0 }],
      execute: async () => {
        executed = true;
      },
      identity: { runId: SAMPLE_RUN, nonce: "n".repeat(32), containerId: SAMPLE_ID },
      migrationSql: "",
      history: [],
    });
    expect(provenance).toEqual({ ok: false, reason: "PORT_MAPPING_MISMATCH" });
    expect(result.applied).toBe(false);
    expect(executed).toBe(false);
  });

  it("refuses cleanup and DDL when the container id or name belongs to something else", async () => {
    const inspectDocument = sampleInspect();
    expect(
      cleanupAllowed({
        createdId: "c".repeat(64),
        expectedName: SAMPLE_NAME,
        expectedRunId: SAMPLE_RUN,
        inspectDocument,
      }),
    ).toBe(false);
    expect(
      cleanupAllowed({
        createdId: SAMPLE_ID,
        expectedName: "stell22-db-prod",
        expectedRunId: SAMPLE_RUN,
        inspectDocument,
      }),
    ).toBe(false);
    let removed = false;
    const allowed = cleanupAllowed({
      createdId: SAMPLE_ID,
      expectedName: SAMPLE_NAME,
      expectedRunId: SAMPLE_RUN,
      inspectDocument,
    });
    if (allowed) removed = true;
    expect(removed).toBe(true);
    let removedForeign = false;
    if (
      cleanupAllowed({
        createdId: SAMPLE_ID,
        expectedName: "stell22-app",
        expectedRunId: SAMPLE_RUN,
        inspectDocument,
      })
    ) {
      removedForeign = true;
    }
    expect(removedForeign).toBe(false);
  });

  it("does not create objects when provenance is known but the database is not empty", async () => {
    const provenance = assessFixtureProvenance({
      expectedId: SAMPLE_ID,
      expectedName: SAMPLE_NAME,
      expectedRunId: SAMPLE_RUN,
      inspectDocument: sampleInspect(),
    });
    const seen: string[] = [];
    const result = await applyFixtureDdl({
      provenance,
      query: async (sql) => {
        seen.push(sql);
        return [{ table_count: 1 }];
      },
      execute: async (sql) => {
        seen.push(sql);
      },
      identity: { runId: SAMPLE_RUN, nonce: "n".repeat(32), containerId: SAMPLE_ID },
      migrationSql: fs.readFileSync(
        "prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance/migration.sql",
        "utf8",
      ),
      history: [],
    });
    expect(provenance.ok).toBe(true);
    expect(result).toEqual({ applied: false, reason: "FIXTURE_DATABASE_NOT_EMPTY" });
    expect(seen.some((sql) => /^\s*(CREATE|ALTER|INSERT|DROP)\b/i.test(sql))).toBe(false);
  });
});

describe.skipIf(process.env[LIVE_FLAG] !== "1")("postgresql 17 disposable read", () => {
  it("reads only a container this test created and requires an exact structural match", async () => {
    const runId = randomUUID();
    const name = `stell22-p1-disposable-${runId}`;
    const password = randomBytes(24).toString("hex");
    const nonce = randomBytes(24).toString("hex");
    const databaseName = `p1disp_${runId.replaceAll("-", "")}`;
    const created = createOwnedContainer({ name, runId, password, databaseName });
    try {
      const inspectDocument = dockerInspect(created.id);
      const provenance = assessFixtureProvenance({
        expectedId: created.id,
        expectedName: name,
        expectedRunId: runId,
        inspectDocument,
      });
      expect(provenance.ok).toBe(true);
      if (!provenance.ok) return;
      const fixture = new PrismaClient({
        datasourceUrl: fixtureUrl(provenance, databaseName, password),
      });
      try {
        await waitUntilReady(fixture);
        const raw = attestationFor({
          runId,
          name,
          password,
          nonce,
          databaseName,
          containerId: provenance.containerId,
          port: provenance.port,
        });
        const missing = await readDisposablePostgreSql(raw);
        expect(missing.evidenceSource).toBe("postgresql-query");
        expect(missing.code).toBe("MISSING_IDENTITY_TABLE");
        expect(missing.verdict).toBe("STOP");
        expect(missing.schema).toBeNull();
        expect(missing.classification).toBeNull();
        expect(missing.applyEnabled).toBe(false);
        expect(missing.containerOrigin.status).toBe("NOT_ESTABLISHED");
        expect(missing.fullTargetAuthentication.status).toBe("NOT_CLAIMED");

        const applied = await applyFixtureDdl({
          provenance,
          query: (sql) => fixture.$queryRawUnsafe(sql),
          execute: (sql, params) => fixture.$executeRawUnsafe(sql, ...(params ?? [])),
          identity: { runId, nonce, containerId: provenance.containerId },
          migrationSql: fs.readFileSync(
            "prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance/migration.sql",
            "utf8",
          ),
          history: [...successfulHistoricalRows(), successfulP1Row()].map((row) => ({
            id: randomUUID(),
            checksum: row.checksum,
            finishedAt: row.finishedAt,
            migrationName: row.migrationName,
            startedAt: row.startedAt,
            appliedStepsCount: row.appliedStepsCount,
          })),
        });
        expect(applied).toEqual({ applied: true });

        const report = await readDisposablePostgreSql(raw);
        const schema = report.schema;
        expect(report.evidenceSource).toBe("postgresql-query");
        expect(schema?.column && columnMatchesContract(schema.column)).toBe(true);
        expect(schema?.check && checkMatchesContract(schema.check)).toBe(true);
        expect(schema?.functionDef && functionMatchesContract(schema.functionDef)).toBe(true);
        expect(schema?.trigger && triggerMatchesContract(schema.trigger)).toBe(true);
        expect(schema?.foreignKeyCount).toBe(0);
        expect(schema?.extraTriggerNames).toEqual([]);
        expect(schema?.unexpectedObjects).toEqual([]);
        expect(report.classification).toEqual({ verdict: "ALREADY_APPLIED", code: "P1_APPLIED" });
        expect(report.verdict).toBe("BLOCKED");
        expect(report.code).toBe("CONTAINER_ORIGIN_NOT_ESTABLISHED");
        expect(report.applyEnabled).toBe(false);
        expect(report.containerOrigin.status).toBe("NOT_ESTABLISHED");
        expect(report.fullTargetAuthentication.status).toBe("NOT_CLAIMED");
        expect(report.postgresIdentity).toMatchObject({
          status: "row-read",
          runId,
          nonce,
          containerId: provenance.containerId,
        });
      } finally {
        await fixture.$disconnect();
      }
    } finally {
      removeOwnedContainer({
        createdId: created.id,
        expectedName: name,
        expectedRunId: runId,
      });
    }
  }, 120_000);
});

function createOwnedContainer(input: {
  name: string;
  runId: string;
  password: string;
  databaseName: string;
}): { id: string } {
  try {
    execFileSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" });
  } catch {
    throw new Error("postgres:17-alpine is not available locally");
  }
  let id = "";
  try {
    id = execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        input.name,
        "--label",
        `${LABEL}=${input.runId}`,
        "-p",
        "127.0.0.1::5432",
        "-e",
        "POSTGRES_USER=p1disp",
        "-e",
        `POSTGRES_PASSWORD=${input.password}`,
        "-e",
        `POSTGRES_DB=${input.databaseName}`,
        IMAGE,
      ],
      { encoding: "utf8" },
    ).trim();
  } catch {
    throw new Error("docker run failed before a container id was proven");
  }
  if (!isContainerId(id)) {
    throw new Error("docker run did not return a container id");
  }
  return { id };
}

function dockerInspect(id: string): unknown {
  const raw = execFileSync("docker", ["inspect", id], { encoding: "utf8" });
  return JSON.parse(raw) as unknown;
}

function removeOwnedContainer(input: {
  createdId: string;
  expectedName: string;
  expectedRunId: string;
}): void {
  let document: unknown;
  try {
    document = dockerInspect(input.createdId);
  } catch {
    throw new Error("refusing cleanup because the container id could not be inspected");
  }
  if (
    !cleanupAllowed({
      createdId: input.createdId,
      expectedName: input.expectedName,
      expectedRunId: input.expectedRunId,
      inspectDocument: document,
    })
  ) {
    throw new Error("refusing cleanup because the container is not the one this test created");
  }
  execFileSync("docker", ["rm", "-f", input.createdId], { stdio: "ignore" });
}

function fixtureUrl(
  provenance: { host: "127.0.0.1"; port: number },
  databaseName: string,
  password: string,
): string {
  const url = new URL("postgresql://127.0.0.1");
  url.username = "p1disp";
  url.password = password;
  url.hostname = provenance.host;
  url.port = String(provenance.port);
  url.pathname = `/${databaseName}`;
  url.searchParams.set("connect_timeout", "5");
  if (url.hostname !== "127.0.0.1") {
    throw new Error("fixture URL host is not loopback");
  }
  return url.toString();
}

function attestationFor(input: {
  runId: string;
  name: string;
  password: string;
  nonce: string;
  databaseName: string;
  containerId: string;
  port: number;
}) {
  return parseDisposableAttestation({
    kind: "stell22-p1-disposable-target",
    version: 1,
    runId: input.runId,
    databaseName: input.databaseName,
    host: "127.0.0.1",
    port: input.port,
    user: "p1disp",
    password: input.password,
    containerId: input.containerId,
    containerName: input.name,
    image: IMAGE,
    nonce: input.nonce,
    composeProject: input.name,
    networkName: input.name,
    postgresMajor: 17,
  });
}

async function waitUntilReady(fixture: PrismaClient): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fixture.$queryRawUnsafe("SELECT 1");
      return;
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`disposable postgres did not accept a read: ${errorText(last)}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}
