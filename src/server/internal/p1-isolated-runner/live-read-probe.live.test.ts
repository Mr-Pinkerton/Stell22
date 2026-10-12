import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  successfulHistoricalRows,
  successfulP1Row,
} from "@/server/internal/p1-isolated-runner/classify";
import {
  OWNED_CONTAINER_LABEL,
  POSTGRES_IMAGE_REF,
  createOwnedDisposableContainer,
  proveContainerOwnership,
  reconfirmOwnedContainer,
  removeOwnedDisposableContainer,
  type DockerOwnershipProof,
} from "@/server/internal/p1-isolated-runner/container-origin";
import { parseDisposableAttestation } from "@/server/internal/p1-isolated-runner/disposable-target";
import { readDisposablePostgreSql } from "@/server/internal/p1-isolated-runner/live-read-probe";
import { bindOwnedDisposableSql } from "@/server/internal/p1-isolated-runner/owned-sql-binding";
import {
  checkMatchesContract,
  columnMatchesContract,
  functionMatchesContract,
  triggerMatchesContract,
} from "@/server/internal/p1-isolated-runner/schema-contract";

const LIVE_FLAG = "P1_DISPOSABLE_LIVE";
const SAMPLE_IMAGE_ID = `sha256:${"b".repeat(64)}`;
const SAMPLE_DAEMON = "daemon-local-1";

type FixtureStatement = { sql: string; params: readonly unknown[] };

type FixtureHistoryRow = {
  id: string;
  checksum: string;
  finishedAt: string | null;
  migrationName: string;
  startedAt: string | null;
  appliedStepsCount: number;
};

export async function applyFixtureDdl(input: {
  ownership: DockerOwnershipProof;
  query: (sql: string) => Promise<unknown>;
  execute: (sql: string, params?: readonly unknown[]) => Promise<unknown>;
  identity: { runId: string; nonce: string; containerId: string };
  migrationSql: string;
  history: readonly FixtureHistoryRow[];
}): Promise<{ applied: true } | { applied: false; reason: string }> {
  if (!input.ownership.ok) return { applied: false, reason: input.ownership.code };
  if (input.ownership.host !== "127.0.0.1") {
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

const SAMPLE_RUN = "11111111-1111-4111-8111-111111111111";
const SAMPLE_NAME = `stell22-p1-disposable-${SAMPLE_RUN}`;
const SAMPLE_ID = "a".repeat(64);

function sampleInspect(patch?: (row: Record<string, unknown>) => void): unknown {
  const row: Record<string, unknown> = {
    Id: SAMPLE_ID,
    Name: `/${SAMPLE_NAME}`,
    Image: SAMPLE_IMAGE_ID,
    Config: {
      Image: POSTGRES_IMAGE_REF,
      Labels: { [OWNED_CONTAINER_LABEL]: SAMPLE_RUN },
    },
    State: {
      Running: true,
      Status: "running",
      StartedAt: "2026-10-12T00:00:00.000000000Z",
      Pid: 7,
    },
    HostConfig: {
      NetworkMode: "bridge",
      PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] },
    },
    NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54321" }] } },
  };
  patch?.(row);
  return [row];
}

function ownershipOf(inspectDocument: unknown, creationId = SAMPLE_ID, expectedName = SAMPLE_NAME) {
  return proveContainerOwnership({
    creationId,
    expectedName,
    expectedRunId: SAMPLE_RUN,
    expectedImageId: SAMPLE_IMAGE_ID,
    expectedDaemonId: SAMPLE_DAEMON,
    observedDaemonId: SAMPLE_DAEMON,
    expectedStartedAt: null,
    expectedPid: null,
    expectedPort: null,
    inspectDocument,
  });
}

describe("disposable fixture provenance", () => {
  const previousFlag = process.env[LIVE_FLAG];

  afterEach(() => {
    if (previousFlag === undefined) delete process.env[LIVE_FLAG];
    else process.env[LIVE_FLAG] = previousFlag;
  });

  it("refuses fixture DDL when the published port is not loopback", async () => {
    process.env[LIVE_FLAG] = "1";
    const ownership = ownershipOf(
      sampleInspect((row) => {
        row.HostConfig = {
          NetworkMode: "bridge",
          PortBindings: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "" }] },
        };
        row.NetworkSettings = {
          Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "54321" }] },
        };
      }),
    );
    const called = { query: 0, execute: 0 };
    const result = await applyFixtureDdl({
      ownership,
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
    expect(ownership).toEqual({ ok: false, code: "PORT_NOT_LOOPBACK" });
    expect(result).toEqual({ applied: false, reason: "PORT_NOT_LOOPBACK" });
    expect(called).toEqual({ query: 0, execute: 0 });
  });

  it("refuses fixture DDL when the requested port disagrees with the published port", async () => {
    const ownership = ownershipOf(
      sampleInspect((row) => {
        row.HostConfig = {
          NetworkMode: "bridge",
          PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54329" }] },
        };
      }),
    );
    let executed = false;
    const result = await applyFixtureDdl({
      ownership,
      query: async () => [{ table_count: 0 }],
      execute: async () => {
        executed = true;
      },
      identity: { runId: SAMPLE_RUN, nonce: "n".repeat(32), containerId: SAMPLE_ID },
      migrationSql: "",
      history: [],
    });
    expect(ownership).toEqual({ ok: false, code: "PORT_MAPPING_MISMATCH" });
    expect(result.applied).toBe(false);
    expect(executed).toBe(false);
  });

  it("refuses cleanup and DDL when the container id or name belongs to something else", async () => {
    const inspectDocument = sampleInspect();
    expect(ownershipOf(inspectDocument, "c".repeat(64)).ok).toBe(false);
    expect(ownershipOf(inspectDocument, SAMPLE_ID, "stell22-db-prod").ok).toBe(false);
    const owned = ownershipOf(inspectDocument);
    let removed = false;
    if (owned.ok) removed = true;
    expect(removed).toBe(true);
    expect(ownershipOf(inspectDocument, SAMPLE_ID, "stell22-app").ok).toBe(false);
  });

  it("does not create objects when provenance is known but the database is not empty", async () => {
    const ownership = ownershipOf(sampleInspect());
    const seen: string[] = [];
    const result = await applyFixtureDdl({
      ownership,
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
    expect(ownership.ok).toBe(true);
    expect(result).toEqual({ applied: false, reason: "FIXTURE_DATABASE_NOT_EMPTY" });
    expect(seen.some((sql) => /^\s*(CREATE|ALTER|INSERT|DROP)\b/i.test(sql))).toBe(false);
  });
});

describe.skipIf(process.env[LIVE_FLAG] !== "1")("postgresql 17 disposable read", () => {
  it("reads only a container this test created and requires an exact structural match", async () => {
    const owned = createOwnedDisposableContainer();
    let fixture: PrismaClient | null = null;
    try {
      const connection = reconfirmOwnedContainer(owned);
      fixture = new PrismaClient({
        datasourceUrl: fixtureUrl(connection),
      });
      await waitUntilReady(fixture);
      const confirmed = reconfirmOwnedContainer(owned);
      const raw = attestationFor(confirmed);
      const unbound = await bindOwnedDisposableSql(owned);
      expect(unbound.ok).toBe(false);
      if (!unbound.ok) {
        expect(unbound.kind).toBe("sql-identity-missing");
        expect(unbound.code).toBe("MISSING_IDENTITY_TABLE");
        expect(unbound.publicAuthorization).toMatchObject({
          containerOrigin: "NOT_ESTABLISHED",
          fullTargetAuthentication: "NOT_CLAIMED",
          applyEnabled: false,
        });
        expect(JSON.stringify(unbound).includes(confirmed.nonce)).toBe(false);
        expect(JSON.stringify(unbound).includes(confirmed.password)).toBe(false);
      }
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
        ownership: {
          ok: true,
          containerId: confirmed.containerId,
          name: confirmed.containerName,
          runId: confirmed.runId,
          imageId: owned.imageId,
          host: confirmed.host,
          port: confirmed.port,
          startedAt: owned.startedAt,
          pid: owned.pid,
        },
        query: (sql) => fixture!.$queryRawUnsafe(sql),
        execute: (sql, params) => fixture!.$executeRawUnsafe(sql, ...(params ?? [])),
        identity: {
          runId: confirmed.runId,
          nonce: confirmed.nonce,
          containerId: confirmed.containerId,
        },
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
        runId: confirmed.runId,
        nonce: confirmed.nonce,
        containerId: confirmed.containerId,
      });
      const bound = await bindOwnedDisposableSql(owned);
      expect(bound.ok).toBe(true);
      if (bound.ok) {
        expect(bound.kind).toBe("verified-readonly-binding");
        expect(bound.evidenceSource).toBe("postgresql-query");
        expect(bound.runId).toBe(confirmed.runId);
        expect(bound.containerId).toBe(confirmed.containerId);
        expect(bound.databaseName).toBe(confirmed.databaseName);
        expect(bound.serverVersionNum).toBeGreaterThanOrEqual(170000);
        expect(bound.serverVersionNum).toBeLessThan(180000);
        expect(bound.classification).toEqual({ verdict: "ALREADY_APPLIED", code: "P1_APPLIED" });
        expect(bound.publicAuthorization).toEqual({
          containerOrigin: "NOT_ESTABLISHED",
          fullTargetAuthentication: "NOT_CLAIMED",
          applyEnabled: false,
          verdict: "BLOCKED",
          code: "CONTAINER_ORIGIN_NOT_ESTABLISHED",
        });
        expect(JSON.stringify(bound).includes(confirmed.nonce)).toBe(false);
        expect(JSON.stringify(bound).includes(confirmed.password)).toBe(false);
      }
    } finally {
      try {
        await fixture?.$disconnect();
      } finally {
        removeOwnedDisposableContainer(owned);
      }
    }
  }, 120_000);
});

function fixtureUrl(connection: {
  host: "127.0.0.1";
  port: number;
  databaseName: string;
  password: string;
}): string {
  const url = new URL("postgresql://127.0.0.1");
  url.username = "p1disp";
  url.password = connection.password;
  url.hostname = connection.host;
  url.port = String(connection.port);
  url.pathname = `/${connection.databaseName}`;
  url.searchParams.set("connect_timeout", "5");
  if (url.hostname !== "127.0.0.1") {
    throw new Error("fixture URL host is not loopback");
  }
  return url.toString();
}

function attestationFor(connection: {
  runId: string;
  containerName: string;
  password: string;
  nonce: string;
  databaseName: string;
  containerId: string;
  port: number;
}) {
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
