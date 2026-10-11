import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
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

const enabled = process.env.P1_DISPOSABLE_LIVE === "1";
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const DATABASE_NAME = `p1disp_${RUN_ID.replaceAll("-", "")}`;
const CONTAINER_NAME = `stell22-p1-disposable-${RUN_ID}`;
const PORT = 54329;
const PASSWORD = "disposable-password-value";
const NONCE = "n".repeat(32);

function fixtureUrl(): string {
  return `postgresql://p1disp:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE_NAME}`;
}

function attestation(containerId: string) {
  return parseDisposableAttestation({
    kind: "stell22-p1-disposable-target",
    version: 1,
    runId: RUN_ID,
    databaseName: DATABASE_NAME,
    host: "127.0.0.1",
    port: PORT,
    user: "p1disp",
    password: PASSWORD,
    containerId,
    containerName: CONTAINER_NAME,
    image: "postgres:17-alpine",
    nonce: NONCE,
    composeProject: CONTAINER_NAME,
    networkName: CONTAINER_NAME,
    postgresMajor: 17,
  });
}

function containerId(): string {
  const id = execFileSync("docker", ["inspect", "--format", "{{.Id}}", CONTAINER_NAME], {
    encoding: "utf8",
  }).trim();
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw new Error("Disposable container id was not a 64-character docker id");
  }
  return id;
}

describe.skipIf(!enabled)("postgresql 17 disposable read", () => {
  it("reads the isolated server and does not treat a missing identity table as readiness", async () => {
    const fixture = new PrismaClient({ datasourceUrl: fixtureUrl() });
    try {
      await fixture.$executeRawUnsafe(`DROP TABLE IF EXISTS public.stell22_p1_disposable_identity`);
    } finally {
      await fixture.$disconnect();
    }
    const raw = attestation(containerId());
    const report = await readDisposablePostgreSql(raw);
    expect(report.evidenceSource).toBe("postgresql-query");
    expect(report.code).toBe("MISSING_IDENTITY_TABLE");
    expect(report.schema).toBeNull();
    expect(report.connection.currentDatabase).toBe(DATABASE_NAME);
    expect(report.connection.serverVersionNum).toBeGreaterThanOrEqual(170000);
    expect(report.connection.serverVersionNum).toBeLessThan(180000);
    expect(report.containerOrigin.status).toBe("NOT_ESTABLISHED");
    expect(report.fullTargetAuthentication.status).toBe("NOT_CLAIMED");
    expect(report.applyEnabled).toBe(false);
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
    expect(report.verdict).not.toBe("ALREADY_APPLIED");
  }, 30_000);

  it("reads pg_get definitions through the strict contract", async () => {
    const id = containerId();
    const fixture = new PrismaClient({ datasourceUrl: fixtureUrl() });
    try {
      await provisionFixture(fixture, id);
    } finally {
      await fixture.$disconnect();
    }
    const report = await readDisposablePostgreSql(attestation(id));
    const schema = report.schema;
    const structural = Boolean(
      schema?.column &&
      schema.check &&
      schema.functionDef &&
      schema.trigger &&
      columnMatchesContract(schema.column) &&
      checkMatchesContract(schema.check) &&
      functionMatchesContract(schema.functionDef) &&
      triggerMatchesContract(schema.trigger) &&
      schema.foreignKeyCount === 0 &&
      schema.extraTriggerNames.length === 0 &&
      schema.unexpectedObjects.length === 0,
    );
    expect(report.evidenceSource).toBe("postgresql-query");
    expect(report.postgresIdentity).toMatchObject({
      status: "row-read",
      runId: RUN_ID,
      nonce: NONCE,
      containerId: id,
    });
    expect(report.containerOrigin.status).toBe("NOT_ESTABLISHED");
    expect(report.fullTargetAuthentication.status).toBe("NOT_CLAIMED");
    expect(report.applyEnabled).toBe(false);
    expect(schema?.functionDef?.definition.length).toBeGreaterThan(40);
    if (structural) {
      expect(report.verdict).toBe("ALREADY_APPLIED");
      expect(report.code).toBe("P1_APPLIED");
    } else {
      expect(report.verdict).not.toBe("ALREADY_APPLIED");
      expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
    }
  }, 30_000);
});

async function provisionFixture(fixture: PrismaClient, id: string): Promise<void> {
  const migration = fs.readFileSync(
    "prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance/migration.sql",
    "utf8",
  );
  const functionSql = migration.slice(
    migration.indexOf("CREATE FUNCTION"),
    migration.indexOf("$$;", migration.indexOf("CREATE FUNCTION")) + 3,
  );
  const triggerSql = migration.slice(
    migration.indexOf("CREATE TRIGGER"),
    migration.indexOf(";", migration.indexOf("CREATE TRIGGER")) + 1,
  );
  await fixture.$executeRawUnsafe(`DROP TABLE IF EXISTS public."BatchCreationCommand" CASCADE`);
  await fixture.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS public.batch_creation_command_provenance_guard()`,
  );
  await fixture.$executeRawUnsafe(`DROP TABLE IF EXISTS public.stell22_p1_disposable_identity`);
  await fixture.$executeRawUnsafe(`DROP TABLE IF EXISTS public."_prisma_migrations"`);
  await fixture.$executeRawUnsafe(`
    CREATE TABLE public."BatchCreationCommand" (
      id text PRIMARY KEY,
      "requestId" text NOT NULL,
      "batchId" text NOT NULL,
      "receiptProvenanceSnapshot" jsonb
    )
  `);
  await fixture.$executeRawUnsafe(`
    ALTER TABLE public."BatchCreationCommand"
      ADD CONSTRAINT "BatchCreationCommand_receiptProvenanceSnapshot_shape"
      CHECK (
        "receiptProvenanceSnapshot" IS NULL
        OR jsonb_typeof("receiptProvenanceSnapshot") = 'object'
      )
  `);
  await fixture.$executeRawUnsafe(functionSql);
  await fixture.$executeRawUnsafe(triggerSql);
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
    `INSERT INTO public.stell22_p1_disposable_identity (singleton, run_id, nonce, container_id)
     VALUES (true, $1, $2, $3)`,
    RUN_ID,
    NONCE,
    id,
  );
  await fixture.$executeRawUnsafe(`
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
  `);
  for (const row of [...successfulHistoricalRows(), successfulP1Row()]) {
    await fixture.$executeRawUnsafe(
      `INSERT INTO public."_prisma_migrations"
        (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES ($1, $2, $3::timestamptz, $4, $5::timestamptz, $6)`,
      crypto.randomUUID(),
      row.checksum,
      row.finishedAt,
      row.migrationName,
      row.startedAt,
      row.appliedStepsCount,
    );
  }
}
