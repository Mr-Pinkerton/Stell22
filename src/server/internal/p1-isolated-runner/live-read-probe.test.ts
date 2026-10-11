import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  successfulHistoricalRows,
  successfulP1Row,
} from "@/server/internal/p1-isolated-runner/classify";
import { runCli } from "@/server/internal/p1-isolated-runner/cli";
import {
  parseDisposableAttestation,
  type DisposableAttestation,
} from "@/server/internal/p1-isolated-runner/disposable-target";
import {
  assessDisposableRead,
  DISPOSABLE_READ_SQL,
  DISPOSABLE_SESSION_GUARD_SQL,
  previewDisposableRead,
  type ProbeBatch,
  type ProbeQuery,
} from "@/server/internal/p1-isolated-runner/live-read-probe";
import { P1_FUNCTION_BODY } from "@/server/internal/p1-isolated-runner/schema-contract";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCTION_URL = "postgresql://stell22:secret@db:5432/stell22?schema=public";

function attestation(overrides: Partial<DisposableAttestation> = {}): DisposableAttestation {
  const base: DisposableAttestation = {
    kind: "stell22-p1-disposable-target",
    version: 1,
    runId: RUN_ID,
    databaseName: `p1disp_${RUN_ID.replaceAll("-", "")}`,
    host: "127.0.0.1",
    port: 54321,
    user: "p1disp",
    password: "disposable-password-value",
    containerId: "a".repeat(64),
    containerName: `stell22-p1-disposable-${RUN_ID}`,
    image: "postgres:17-alpine",
    nonce: "n".repeat(32),
    composeProject: `stell22-p1-disposable-${RUN_ID}`,
    networkName: `stell22-p1-disposable-${RUN_ID}`,
    postgresMajor: 17,
  };
  return parseDisposableAttestation({ ...base, ...overrides });
}

function failed(sqlState: string | null): ProbeQuery {
  return { failed: true, sqlState };
}

function rows(value: Record<string, unknown>[]): ProbeQuery {
  return value;
}

function readyBatch(raw: DisposableAttestation): ProbeBatch {
  return {
    session: rows([{ read_only: "on", search_path: "pg_catalog", statement_timeout: "5s" }]),
    connection: rows([{ current_database: raw.databaseName, server_version_num: 170004 }]),
    identity: rows([{ run_id: raw.runId, nonce: raw.nonce, container_id: raw.containerId }]),
    history: rows(
      successfulHistoricalRows().map((row) => ({
        migration_name: row.migrationName,
        checksum: row.checksum,
        started_at: row.startedAt,
        finished_at: row.finishedAt,
        rolled_back_at: row.rolledBackAt,
        applied_steps_count: row.appliedStepsCount,
      })),
    ),
    column: rows([]),
    check: rows([]),
    function: rows([]),
    trigger: rows([]),
    extraTriggers: rows([]),
    unexpectedObjects: rows([]),
    foreignKeys: rows([{ foreign_key_count: 0 }]),
  };
}

function matchingCatalog(batch: ProbeBatch): ProbeBatch {
  const definition = `CREATE FUNCTION public."batch_creation_command_provenance_guard"() RETURNS trigger LANGUAGE plpgsql AS $function$ ${P1_FUNCTION_BODY} $function$`;
  return {
    ...batch,
    history: rows([
      ...(batch.history as Record<string, unknown>[]),
      {
        migration_name: successfulP1Row().migrationName,
        checksum: successfulP1Row().checksum,
        started_at: successfulP1Row().startedAt,
        finished_at: successfulP1Row().finishedAt,
        rolled_back_at: null,
        applied_steps_count: 1,
      },
    ]),
    column: rows([
      {
        schema_name: "public",
        table_name: "BatchCreationCommand",
        udt_name: "jsonb",
        data_type: "jsonb",
        is_nullable: "YES",
        column_default: null,
      },
    ]),
    check: rows([
      {
        schema_name: "public",
        table_name: "BatchCreationCommand",
        constraint_name: "BatchCreationCommand_receiptProvenanceSnapshot_shape",
        definition:
          'CHECK ((("receiptProvenanceSnapshot" IS NULL) OR (jsonb_typeof("receiptProvenanceSnapshot") = \'object\'::text)))',
        validated: true,
      },
    ]),
    function: rows([
      {
        schema_name: "public",
        function_name: "batch_creation_command_provenance_guard",
        identity_arguments: "",
        language: "plpgsql",
        security_definer: false,
        definition,
      },
    ]),
    trigger: rows([
      {
        schema_name: "public",
        table_name: "BatchCreationCommand",
        trigger_name: "batch_creation_command_provenance_guard",
        enabled: "O",
        definition:
          'CREATE TRIGGER "batch_creation_command_provenance_guard" BEFORE UPDATE OR DELETE ON public."BatchCreationCommand" FOR EACH ROW EXECUTE FUNCTION public."batch_creation_command_provenance_guard"()',
        function_schema: "public",
        function_name: "batch_creation_command_provenance_guard",
        function_identity_arguments: "",
      },
    ]),
  };
}

function assess(batch: ProbeBatch, raw = attestation()) {
  return assessDisposableRead(raw, batch);
}

describe("disposable live read mapping", () => {
  const previousDatabase = process.env.DATABASE_URL;

  afterEach(() => {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
  });

  it("keeps a caller-supplied absent catalog distinct from a live connection", () => {
    const report = assess(readyBatch(attestation()));
    expect(report.evidenceSource).toBe("caller-supplied-rows");
    expect(report.containerOrigin.status).toBe("NOT_ESTABLISHED");
    expect(report.fullTargetAuthentication.status).toBe("NOT_CLAIMED");
    expect(report.applyEnabled).toBe(false);
    expect(report.verdict).toBe("READY_FOR_DISPOSABLE_APPLY");
    expect(report.code).toBe("P1_ABSENT");
    expect(report.schema?.column).toBeNull();
  });

  it("maps a structural catalog match without treating it as container proof", () => {
    const report = assess(matchingCatalog(readyBatch(attestation())));
    expect(report.evidenceSource).toBe("caller-supplied-rows");
    expect(report.applyEnabled).toBe(false);
    expect(report.containerOrigin.status).toBe("NOT_ESTABLISHED");
    expect(report.verdict).toBe("ALREADY_APPLIED");
    expect(report.code).toBe("P1_APPLIED");
    expect(report.schema?.column?.matchCount).toBe(1);
  });

  it("does not treat a missing identity table as an absent migration", () => {
    const batch = readyBatch(attestation());
    batch.identity = failed("42P01");
    const report = assess(batch);
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
    expect(report.verdict).not.toBe("ALREADY_APPLIED");
    expect(report.code).toBe("MISSING_IDENTITY_TABLE");
    expect(report.schema).toBeNull();
    expect(report.postgresIdentity.status).toBe("query-failed");
  });

  it.each([
    ["run id", { run_id: "22222222-2222-4222-8222-222222222222" }, "DISPOSABLE_IDENTITY_MISMATCH"],
    ["nonce", { nonce: "x".repeat(32) }, "DISPOSABLE_NONCE_MISMATCH"],
    ["container id", { container_id: "b".repeat(64) }, "DISPOSABLE_IDENTITY_MISMATCH"],
  ] as const)("stops on a wrong %s", (_label, patch, code) => {
    const raw = attestation();
    const batch = readyBatch(raw);
    batch.identity = rows([
      { run_id: raw.runId, nonce: raw.nonce, container_id: raw.containerId, ...patch },
    ]);
    const report = assess(batch);
    expect(report.code).toBe(code);
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
    expect(report.verdict).not.toBe("ALREADY_APPLIED");
  });

  it("stops when the connected database name differs", () => {
    const batch = readyBatch(attestation());
    batch.connection = rows([{ current_database: "stell22", server_version_num: 170004 }]);
    const report = assess(batch);
    expect(report.code).toBe("WRONG_DATABASE_IDENTITY");
    expect(report.connection.currentDatabase).toBe("stell22");
    expect(report.schema).toBeNull();
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
  });

  it("stops when the server is not PostgreSQL 17", () => {
    const batch = readyBatch(attestation());
    batch.connection = rows([
      { current_database: attestation().databaseName, server_version_num: 160009 },
    ]);
    const report = assess(batch);
    expect(report.code).toBe("WRONG_DATABASE_IDENTITY");
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
    expect(report.verdict).not.toBe("ALREADY_APPLIED");
  });

  it("stops on missing permissions without inventing an empty catalog", () => {
    const batch = readyBatch(attestation());
    batch.column = failed("42501");
    const report = assess(batch);
    expect(report.code).toBe("MISSING_PERMISSIONS");
    expect(report.schema).toBeNull();
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
  });

  it("stops on a query timeout without inventing an empty catalog", () => {
    const batch = readyBatch(attestation());
    batch.history = failed("57014");
    const report = assess(batch);
    expect(report.code).toBe("QUERY_TIMEOUT");
    expect(report.schema).toBeNull();
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
  });

  it("stops on a malformed catalog row", () => {
    const batch = matchingCatalog(readyBatch(attestation()));
    batch.check = rows([
      {
        schema_name: "public",
        table_name: "BatchCreationCommand",
        constraint_name: "BatchCreationCommand_receiptProvenanceSnapshot_shape",
        definition: null,
        validated: "true",
      },
    ]);
    const report = assess(batch);
    expect(report.code).toBe("MALFORMED_CATALOG_RESULT");
    expect(report.verdict).not.toBe("ALREADY_APPLIED");
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
  });

  it("keeps duplicate catalog rows instead of accepting the first", () => {
    const batch = matchingCatalog(readyBatch(attestation()));
    const column = (batch.column as Record<string, unknown>[])[0] as Record<string, unknown>;
    batch.column = rows([column, { ...column }]);
    const report = assess(batch);
    expect(report.schema?.column?.matchCount).toBe(2);
    expect(report.verdict).not.toBe("ALREADY_APPLIED");
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
  });

  it("stops on an unexpected trigger or function", () => {
    const trigger = readyBatch(attestation());
    trigger.extraTriggers = rows([{ trigger_name: "evil_provenance" }]);
    expect(assess(trigger).code).toBe("UNEXPECTED_ALTERATION");
    expect(assess(trigger).verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");

    const fn = readyBatch(attestation());
    fn.unexpectedObjects = rows([{ schema_name: "public", object_name: "evil_provenance" }]);
    const report = assess(fn);
    expect(report.code).toBe("UNEXPECTED_ALTERATION");
    expect(report.schema?.unexpectedObjects).toEqual(["public.evil_provenance"]);
    expect(report.verdict).not.toBe("ALREADY_APPLIED");
  });

  it("blocks incomplete migration history", () => {
    const batch = readyBatch(attestation());
    const history = batch.history as Record<string, unknown>[];
    history[0] = { ...history[0], finished_at: null, rolled_back_at: null, applied_steps_count: 0 };
    const report = assess(batch);
    expect(report.code).toBe("FAILED_MIGRATION");
    expect(report.verdict).toBe("BLOCKED");
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
  });

  it("blocks an inconsistent P1 object set", () => {
    const batch = readyBatch(attestation());
    batch.column = rows([
      {
        schema_name: "public",
        table_name: "BatchCreationCommand",
        udt_name: "jsonb",
        data_type: "jsonb",
        is_nullable: "YES",
        column_default: null,
      },
    ]);
    const report = assess(batch);
    expect(report.code).toBe("PARTIAL_OBJECT_SET");
    expect(report.verdict).toBe("BLOCKED");
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
  });

  it("does not turn a failed history query into zero migrations", () => {
    const batch = readyBatch(attestation());
    batch.history = failed("42P01");
    const report = assess(batch);
    expect(report.code).toBe("QUERY_FAILED");
    expect(report.failedQuery).toBe("history");
    expect(report.schema).toBeNull();
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
  });

  it("reports an unavailable connection without reading another database", async () => {
    process.env.DATABASE_URL = PRODUCTION_URL;
    let seen = "";
    const report = await previewDisposableRead(attestation(), async (url) => {
      seen = url;
      throw new Error(`refused ${PRODUCTION_URL}`);
    });
    expect(report.evidenceSource).toBe("injected-connector");
    expect(report.code).toBe("CONNECTION_UNAVAILABLE");
    expect(report.connection.status).toBe("failed");
    expect(report.schema).toBeNull();
    expect(report.verdict).not.toBe("READY_FOR_DISPOSABLE_APPLY");
    expect(report.verdict).not.toBe("ALREADY_APPLIED");
    expect(seen).toContain("127.0.0.1");
    expect(seen).toContain(attestation().databaseName);
    expect(seen).not.toContain("@db");
    expect(seen).not.toContain("/stell22");
    expect(report.message).not.toContain(PRODUCTION_URL);
    expect(report.message).not.toContain(attestation().password);
  });
});

describe("disposable live read statements", () => {
  it("sends only schema-qualified selects and leaves apply unimplemented", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/server/internal/p1-isolated-runner/live-read-probe.ts"),
      "utf8",
    );
    expect(source).not.toContain("migrate resolve");
    expect(source).not.toContain("migrate deploy");
    expect(source).not.toContain("$executeRaw");
    expect(source).not.toContain("::regclass");
    const forbidden = /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|GRANT|COPY)\b/i;
    for (const sql of [DISPOSABLE_SESSION_GUARD_SQL, ...Object.values(DISPOSABLE_READ_SQL)]) {
      expect(sql.trim().startsWith("SELECT")).toBe(true);
      expect(sql).not.toMatch(forbidden);
      expect(sql).not.toContain("::regclass");
    }
    const lines: string[] = [];
    const dir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-attestation-"));
    try {
      const file = path.join(dir, "attestation.json");
      fs.writeFileSync(file, JSON.stringify(attestation()));
      expect(runCli(["apply", "--attestation", file], { log: (line) => lines.push(line) })).toBe(2);
      expect(lines.join("\n")).toContain("STOP LIVE_DISPOSABLE_PROBE_NOT_IMPLEMENTED");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
