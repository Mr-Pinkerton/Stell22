import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXECUTION_POLICY,
  P1_GIT_BLOB,
  P1_MIGRATION_NAME,
  P1_SHA256,
} from "@/server/internal/p1-isolated-runner/contract";
import {
  classifyP1State,
  successfulHistoricalRows,
  successfulP1Row,
  type PrismaMigrationRow,
} from "@/server/internal/p1-isolated-runner/classify";
import { runCli } from "@/server/internal/p1-isolated-runner/cli";
import {
  authenticateDisposableTarget,
  parseDisposableAttestation,
  type DisposableAttestation,
  type DisposableProbeResult,
} from "@/server/internal/p1-isolated-runner/disposable-target";
import { buildChildEnv } from "@/server/internal/p1-isolated-runner/env";
import {
  executeDisposableApply,
  type ApplyDependencies,
  type PrismaSpawnRequest,
} from "@/server/internal/p1-isolated-runner/executor";
import { createRepoGitSource } from "@/server/internal/p1-isolated-runner/git-source";
import { acquireHostLock } from "@/server/internal/p1-isolated-runner/lock";
import {
  materializeMigrationSet,
  revalidateMigrationSet,
  verifyAuthorizedMigrationBytes,
  type GitBlobSource,
} from "@/server/internal/p1-isolated-runner/migration-set";
import { RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";
import {
  absentP1Schema,
  P1_FUNCTION_BODY,
  P1_HISTORY_PROBE_SQL,
  P1_IDENTITY_PROBE_SQL,
  P1_SCHEMA_PROBE_SQL,
  type P1SchemaEvidence,
} from "@/server/internal/p1-isolated-runner/schema-contract";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCTION_URL = "postgresql://stell22:secret@db:5432/stell22?schema=public";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1-runner-"));
  tempDirs.push(dir);
  return dir;
}

function matchingSchema(): P1SchemaEvidence {
  return {
    column: {
      schemaName: "public",
      tableName: "BatchCreationCommand",
      matchCount: 1,
      dataType: "jsonb",
      udtName: "jsonb",
      isNullable: "YES",
      columnDefault: null,
    },
    check: {
      schemaName: "public",
      tableName: "BatchCreationCommand",
      constraintName: "BatchCreationCommand_receiptProvenanceSnapshot_shape",
      matchCount: 1,
      definition:
        'CHECK ((("receiptProvenanceSnapshot" IS NULL) OR (jsonb_typeof("receiptProvenanceSnapshot") = \'object\'::text)))',
      validated: true,
    },
    functionDef: {
      schemaName: "public",
      functionName: "batch_creation_command_provenance_guard",
      identityArguments: "",
      matchCount: 1,
      language: "plpgsql",
      securityDefiner: false,
      definition: `CREATE FUNCTION public."batch_creation_command_provenance_guard"() RETURNS trigger LANGUAGE plpgsql AS $function$ ${P1_FUNCTION_BODY} $function$`,
    },
    trigger: {
      schemaName: "public",
      tableName: "BatchCreationCommand",
      triggerName: "batch_creation_command_provenance_guard",
      matchCount: 1,
      enabled: "O",
      functionSchema: "public",
      functionName: "batch_creation_command_provenance_guard",
      functionIdentityArguments: "",
      definition:
        'CREATE TRIGGER "batch_creation_command_provenance_guard" BEFORE UPDATE OR DELETE ON public."BatchCreationCommand" FOR EACH ROW EXECUTE FUNCTION public."batch_creation_command_provenance_guard"()',
    },
    foreignKeyCount: 0,
    extraTriggerNames: [],
    unexpectedObjects: [],
  };
}

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
  return { ...base, ...overrides };
}

function probeFor(raw: DisposableAttestation, overrides: Partial<DisposableProbeResult> = {}) {
  return (): DisposableProbeResult => ({
    currentDatabase: raw.databaseName,
    serverVersionNum: 170004,
    runId: raw.runId,
    nonce: raw.nonce,
    containerId: raw.containerId,
    ...overrides,
  });
}

function refusalCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(RunnerRefusal);
    return (error as RunnerRefusal).code;
  }
  throw new Error("expected refusal");
}

describe("authorized migration set", { timeout: 30_000 }, () => {
  it("matches the pinned commit, 45 historical files, and the P1 blob", () => {
    const verified = verifyAuthorizedMigrationBytes(createRepoGitSource(process.cwd()));
    const p1 = verified.files.find((file) =>
      file.path.endsWith(`${P1_MIGRATION_NAME}/migration.sql`),
    );
    expect(p1?.gitBlob).toBe(P1_GIT_BLOB);
    expect(p1?.sha256).toBe(P1_SHA256);
    expect(verified.files.filter((file) => file.path.endsWith("/migration.sql"))).toHaveLength(46);
  });

  it("stops on the wrong repository SHA", () => {
    const source = createRepoGitSource(process.cwd());
    const wrong: GitBlobSource = {
      ...source,
      resolveCommit: () => ({ commit: "a".repeat(40), tree: "b".repeat(40) }),
    };
    expect(refusalCode(() => verifyAuthorizedMigrationBytes(wrong))).toBe(
      "WRONG_REPOSITORY_COMMIT",
    );
  });

  it("stops on a wrong migration blob", () => {
    const source = createRepoGitSource(process.cwd());
    const wrong: GitBlobSource = {
      ...source,
      listMigrationTree: (commit) =>
        source
          .listMigrationTree(commit)
          .map((entry) =>
            entry.gitBlob === P1_GIT_BLOB ? { ...entry, gitBlob: "c".repeat(40) } : entry,
          ),
    };
    expect(refusalCode(() => verifyAuthorizedMigrationBytes(wrong))).toBe(
      "MIGRATION_INVENTORY_MISMATCH",
    );
  });

  it("stops when migration bytes do not match the pinned checksum", () => {
    const source = createRepoGitSource(process.cwd());
    const wrong: GitBlobSource = {
      ...source,
      readBlob: (blob) =>
        blob === P1_GIT_BLOB ? Buffer.from("altered sql") : source.readBlob(blob),
    };
    expect(refusalCode(() => verifyAuthorizedMigrationBytes(wrong))).toBe(
      "MIGRATION_BYTES_MISMATCH",
    );
  });

  it("stops when a migration is extra or missing", () => {
    const source = createRepoGitSource(process.cwd());
    const extra: GitBlobSource = {
      ...source,
      listMigrationTree: (commit) => [
        ...source.listMigrationTree(commit),
        { path: "prisma/migrations/20990101000000_extra/migration.sql", gitBlob: "d".repeat(40) },
      ],
    };
    const missing: GitBlobSource = {
      ...source,
      listMigrationTree: (commit) =>
        source.listMigrationTree(commit).filter((entry) => entry.gitBlob !== P1_GIT_BLOB),
    };
    expect(refusalCode(() => verifyAuthorizedMigrationBytes(extra))).toBe(
      "MIGRATION_INVENTORY_MISMATCH",
    );
    expect(refusalCode(() => verifyAuthorizedMigrationBytes(missing))).toBe(
      "MIGRATION_INVENTORY_MISMATCH",
    );
  });

  it("seals a private directory and stops if the bytes change", () => {
    const root = path.join(tempDir(), "sealed");
    const set = materializeMigrationSet(createRepoGitSource(process.cwd()), root);
    expect(() => revalidateMigrationSet(set)).not.toThrow();
    const sqlPath = path.join(root, "prisma/migrations", P1_MIGRATION_NAME, "migration.sql");
    fs.chmodSync(sqlPath, 0o644);
    fs.appendFileSync(sqlPath, "\n-- altered\n");
    expect(refusalCode(() => revalidateMigrationSet(set))).toBe("PREFLIGHT_DRIFT");
  });
});

describe("P1 state classification", () => {
  it("is ready only when P1 is absent and history is consistent", () => {
    expect(
      classifyP1State({ history: successfulHistoricalRows(), schema: absentP1Schema() }),
    ).toEqual({ verdict: "READY_FOR_DISPOSABLE_APPLY", code: "P1_ABSENT" });
  });

  it("reports an already applied P1", () => {
    expect(
      classifyP1State({
        history: [...successfulHistoricalRows(), successfulP1Row()],
        schema: matchingSchema(),
      }),
    ).toEqual({ verdict: "ALREADY_APPLIED", code: "P1_APPLIED" });
  });

  it("stops on an unexpected checksum", () => {
    const row = successfulP1Row();
    row.checksum = "f".repeat(64);
    expect(
      classifyP1State({
        history: [...successfulHistoricalRows(), row],
        schema: matchingSchema(),
      }).code,
    ).toBe("UNEXPECTED_CHECKSUM");
  });

  it("stops on another pending migration", () => {
    const history = successfulHistoricalRows().slice(1);
    expect(classifyP1State({ history, schema: absentP1Schema() }).code).toBe(
      "OTHER_PENDING_MIGRATION",
    );
  });

  it("blocks a failed migration", () => {
    const history = successfulHistoricalRows();
    const failed = history[0] as PrismaMigrationRow;
    failed.finishedAt = null;
    failed.appliedStepsCount = 0;
    expect(classifyP1State({ history, schema: absentP1Schema() }).code).toBe("FAILED_MIGRATION");
  });

  it("blocks bookkeeping that has both a finish and a rollback", () => {
    const row = successfulP1Row();
    row.rolledBackAt = row.finishedAt;
    expect(
      classifyP1State({
        history: [...successfulHistoricalRows(), row],
        schema: matchingSchema(),
      }).code,
    ).toBe("BOOKKEEPING_AMBIGUOUS");
  });

  it("blocks an unfinished P1 row with and without objects", () => {
    const unfinished = successfulP1Row();
    unfinished.finishedAt = null;
    unfinished.appliedStepsCount = 0;
    expect(
      classifyP1State({
        history: [...successfulHistoricalRows(), unfinished],
        schema: absentP1Schema(),
      }).code,
    ).toBe("UNFINISHED_WITHOUT_OBJECTS");
    expect(
      classifyP1State({
        history: [...successfulHistoricalRows(), unfinished],
        schema: matchingSchema(),
      }).code,
    ).toBe("UNFINISHED_WITH_OBJECTS");
  });

  it("blocks a finished row whose objects are missing", () => {
    expect(
      classifyP1State({
        history: [...successfulHistoricalRows(), successfulP1Row()],
        schema: absentP1Schema(),
      }).code,
    ).toBe("FINISHED_WITH_MISSING_OBJECTS");
  });

  it("stops on a duplicate or extra history row", () => {
    const duplicate = [
      ...successfulHistoricalRows(),
      successfulHistoricalRows()[0] as PrismaMigrationRow,
    ];
    expect(classifyP1State({ history: duplicate, schema: absentP1Schema() }).code).toBe(
      "DUPLICATE_HISTORY_ROW",
    );
    const extra = [
      ...successfulHistoricalRows(),
      { ...successfulP1Row(), migrationName: "20990101000000_extra" },
    ];
    expect(classifyP1State({ history: extra, schema: absentP1Schema() }).code).toBe(
      "EXTRA_HISTORY_ROW",
    );
  });

  it("blocks a partial object set and stops on a contract mismatch", () => {
    const partial = matchingSchema();
    partial.trigger = null;
    expect(classifyP1State({ history: successfulHistoricalRows(), schema: partial }).code).toBe(
      "PARTIAL_OBJECT_SET",
    );
    const mismatch = matchingSchema();
    mismatch.functionDef = { ...mismatch.functionDef!, securityDefiner: true };
    expect(
      classifyP1State({
        history: [...successfulHistoricalRows(), successfulP1Row()],
        schema: mismatch,
      }).code,
    ).toBe("OBJECT_CONTRACT_MISMATCH");
  });

  it("stops when preflight evidence changed and blocks concurrent execution", () => {
    expect(
      classifyP1State({
        history: successfulHistoricalRows(),
        schema: absentP1Schema(),
        preflight: { expectedDigest: "a", observedDigest: "b" },
      }).code,
    ).toBe("PREFLIGHT_DRIFT");
    expect(
      classifyP1State({
        history: successfulHistoricalRows(),
        schema: absentP1Schema(),
        lockHeldByOther: true,
      }).code,
    ).toBe("CONCURRENT_EXECUTION");
  });

  it("requires definition probes rather than names alone", () => {
    expect(P1_SCHEMA_PROBE_SQL).toContain("pg_get_constraintdef");
    expect(P1_SCHEMA_PROBE_SQL).toContain("convalidated");
    expect(P1_SCHEMA_PROBE_SQL).toContain("pg_get_functiondef");
    expect(P1_SCHEMA_PROBE_SQL).toContain("prosecdef");
    expect(P1_SCHEMA_PROBE_SQL).toContain("pg_get_triggerdef");
    expect(P1_SCHEMA_PROBE_SQL).toContain("tgenabled");
    expect(P1_SCHEMA_PROBE_SQL).not.toContain("::regclass");
    expect(P1_SCHEMA_PROBE_SQL).toContain("pg_namespace");
    expect(P1_SCHEMA_PROBE_SQL).toContain("pg_get_function_identity_arguments");
    expect(P1_HISTORY_PROBE_SQL).toContain("rolled_back_at");
    expect(P1_IDENTITY_PROBE_SQL).toContain("nonce");
    expect(P1_IDENTITY_PROBE_SQL).toContain("public.stell22_p1_disposable_identity");
  });
});

describe("catalog equivalence", () => {
  function applied(schema: P1SchemaEvidence) {
    return classifyP1State({
      history: [...successfulHistoricalRows(), successfulP1Row()],
      schema,
    });
  }

  it("rejects a tautological CHECK that still contains the expected keywords", () => {
    const schema = matchingSchema();
    schema.check = {
      ...schema.check!,
      definition:
        'CHECK ((true) OR (("receiptProvenanceSnapshot" IS NULL) OR (jsonb_typeof("receiptProvenanceSnapshot") = \'object\'::text)))',
    };
    const result = applied(schema);
    expect(result.verdict).not.toBe("ALREADY_APPLIED");
    expect(result.code).toBe("OBJECT_CONTRACT_MISMATCH");
  });

  it("rejects a function whose exception text exists only in a comment", () => {
    const schema = matchingSchema();
    schema.functionDef = {
      ...schema.functionDef!,
      definition:
        'CREATE FUNCTION public."batch_creation_command_provenance_guard"() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RETURN NEW; -- batch creation command provenance is retained; legacy batch creation command provenance cannot be filled; batch creation command provenance is immutable END; $fn$',
    };
    expect(applied(schema).verdict).not.toBe("ALREADY_APPLIED");
  });

  it("rejects a trigger that names the guard but executes another function", () => {
    const schema = matchingSchema();
    schema.trigger = {
      ...schema.trigger!,
      definition:
        'CREATE TRIGGER "batch_creation_command_provenance_guard" BEFORE UPDATE OR DELETE ON public."BatchCreationCommand" FOR EACH ROW EXECUTE FUNCTION public.evil()',
    };
    expect(applied(schema).verdict).not.toBe("ALREADY_APPLIED");
    const unqualified = matchingSchema();
    unqualified.trigger = {
      ...unqualified.trigger!,
      definition:
        'CREATE TRIGGER "batch_creation_command_provenance_guard" BEFORE UPDATE OR DELETE ON "BatchCreationCommand" FOR EACH ROW EXECUTE FUNCTION "batch_creation_command_provenance_guard"()',
    };
    expect(applied(unqualified).verdict).not.toBe("ALREADY_APPLIED");
  });

  it("rejects an overload and a non-public schema", () => {
    const overload = matchingSchema();
    overload.functionDef = {
      ...overload.functionDef!,
      matchCount: 2,
    };
    expect(applied(overload).verdict).not.toBe("ALREADY_APPLIED");
    const otherSchema = matchingSchema();
    otherSchema.column = {
      ...otherSchema.column!,
      schemaName: "other",
    };
    expect(applied(otherSchema).verdict).not.toBe("ALREADY_APPLIED");
  });

  it("rejects an unvalidated or NOT VALID check", () => {
    const unvalidated = matchingSchema();
    unvalidated.check = { ...unvalidated.check!, validated: false };
    expect(applied(unvalidated).verdict).not.toBe("ALREADY_APPLIED");
    const notValid = matchingSchema();
    notValid.check = {
      ...notValid.check!,
      definition: `${notValid.check!.definition} NOT VALID`,
    };
    expect(applied(notValid).verdict).not.toBe("ALREADY_APPLIED");
  });

  it("accepts the migration function body with schema-qualified trigger identity", () => {
    const sql = fs.readFileSync(
      "prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance/migration.sql",
      "utf8",
    );
    const marker = sql.indexOf("AS $$");
    const close = sql.indexOf("$$;", marker);
    const body = sql.slice(marker + "AS $$".length, close);
    const schema = matchingSchema();
    schema.functionDef = {
      ...schema.functionDef!,
      definition: `CREATE FUNCTION public."batch_creation_command_provenance_guard"() RETURNS trigger LANGUAGE plpgsql AS $function$${body}$function$`,
    };
    expect(applied(schema)).toMatchObject({ verdict: "ALREADY_APPLIED", code: "P1_APPLIED" });
  });
});

describe("disposable target boundary", () => {
  it("rejects the production database name and a localhost-only claim", () => {
    const named = attestation({ databaseName: "stell22" });
    expect(refusalCode(() => parseDisposableAttestation(named))).toBe("WRONG_DATABASE_IDENTITY");
    expect(
      refusalCode(() =>
        parseDisposableAttestation({ host: "127.0.0.1", port: 5432, databaseName: "stell22" }),
      ),
    ).toBe("MALFORMED_ATTESTATION");
  });

  it("rejects stell22_integrity, the production container, and an unknown host", () => {
    expect(
      refusalCode(() =>
        parseDisposableAttestation(attestation({ databaseName: "stell22_integrity" })),
      ),
    ).toBe("WRONG_DATABASE_IDENTITY");
    expect(
      refusalCode(() =>
        parseDisposableAttestation(attestation({ containerName: "stell22-db-prod" })),
      ),
    ).toBe("WRONG_DATABASE_IDENTITY");
    expect(refusalCode(() => parseDisposableAttestation(attestation({ host: "db" })))).toBe(
      "WRONG_DATABASE_IDENTITY",
    );
  });

  it("rejects a missing nonce and does not echo the password", () => {
    const raw = attestation({ nonce: "" });
    expect(refusalCode(() => parseDisposableAttestation(raw))).toBe("MISSING_DISPOSABLE_NONCE");
    const valid = attestation();
    try {
      authenticateDisposableTarget(valid, () => {
        throw new Error(`leaked ${valid.password}`);
      });
    } catch (error) {
      expect(error).toBeInstanceOf(RunnerRefusal);
      expect((error as Error).message).not.toContain(valid.password);
    }
    expect(
      refusalCode(() => authenticateDisposableTarget(valid, probeFor(valid, { nonce: "" }))),
    ).toBe("MISSING_DISPOSABLE_NONCE");
  });

  it("drops inherited production URLs before a child process exists", () => {
    const previousDatabase = process.env.DATABASE_URL;
    const previousProd = process.env.PROD_DATABASE_URL;
    process.env.DATABASE_URL = PRODUCTION_URL;
    process.env.PROD_DATABASE_URL = PRODUCTION_URL;
    try {
      const child = buildChildEnv(
        {
          PATH: "C:\\Windows",
          DATABASE_URL: PRODUCTION_URL,
          PROD_DATABASE_URL: PRODUCTION_URL,
          INTEGRITY_TEST_DATABASE_URL:
            "postgresql://stell22:secret@127.0.0.1:5432/stell22_integrity",
        },
        "postgresql://p1disp:disposable-password-value@127.0.0.1:54321/p1disp_11111111111141118111111111111111?schema=public",
      );
      expect(child.PATH).toBe("C:\\Windows");
      expect(child.PROD_DATABASE_URL).toBeUndefined();
      expect(child.INTEGRITY_TEST_DATABASE_URL).toBeUndefined();
      expect(child.DATABASE_URL).not.toContain("/stell22?");
      expect(child.DATABASE_URL).toContain("/p1disp_");
      expect(process.env.DATABASE_URL).toBe(PRODUCTION_URL);
      const disposable =
        "postgresql://p1disp:disposable-password-value@127.0.0.1:54321/p1disp_11111111111141118111111111111111?schema=public";
      const scrubbed = buildChildEnv(
        {
          PATH: "C:\\Windows",
          path: "C:\\evil",
          NODE_OPTIONS: "--require C:\\preload.js",
          PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK: "1",
          prisma_schema_path: "evil.prisma",
          database_url: PRODUCTION_URL,
          PGHOST: "db",
          POSTGRES_PASSWORD: "secret",
          PROD_DATABASE_URL: PRODUCTION_URL,
        },
        disposable,
      );
      expect(scrubbed.DATABASE_URL).toBe(disposable);
      expect(scrubbed.PATH).toBeUndefined();
      expect(scrubbed.path).toBeUndefined();
      expect(scrubbed.NODE_OPTIONS).toBeUndefined();
      expect(scrubbed.PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK).toBeUndefined();
      expect(scrubbed.prisma_schema_path).toBeUndefined();
      expect(scrubbed.database_url).toBeUndefined();
      expect(scrubbed.PGHOST).toBeUndefined();
      expect(scrubbed.POSTGRES_PASSWORD).toBeUndefined();
      expect(scrubbed.PROD_DATABASE_URL).toBeUndefined();
      expect(JSON.stringify(scrubbed)).not.toContain("secret");
      expect(JSON.stringify(scrubbed)).not.toContain("preload");
    } finally {
      if (previousDatabase === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabase;
      if (previousProd === undefined) delete process.env.PROD_DATABASE_URL;
      else process.env.PROD_DATABASE_URL = previousProd;
    }
  });
});

describe("disposable execution", { timeout: 30_000 }, () => {
  function deps(overrides: Partial<ApplyDependencies> = {}): {
    deps: ApplyDependencies;
    spawns: PrismaSpawnRequest[];
    history: { rows: PrismaMigrationRow[] };
    schema: { value: P1SchemaEvidence };
  } {
    const root = tempDir();
    const spawns: PrismaSpawnRequest[] = [];
    const history = { rows: successfulHistoricalRows() };
    const schema = { value: absentP1Schema() };
    const valid = attestation();
    return {
      spawns,
      history,
      schema,
      deps: {
        git: createRepoGitSource(process.cwd()),
        destinationRoot: path.join(root, "sealed"),
        lockPath: path.join(root, "runner.lock"),
        parentEnv: {
          PATH: "C:\\Windows",
          DATABASE_URL: PRODUCTION_URL,
          PROD_DATABASE_URL: PRODUCTION_URL,
        },
        readHistory: () => history.rows,
        readSchema: () => schema.value,
        probeIdentity: probeFor(valid),
        spawnPrisma: (request) => {
          spawns.push(request);
          history.rows = [...successfulHistoricalRows(), successfulP1Row()];
          schema.value = matchingSchema();
          return { status: 0, signal: null };
        },
        ...overrides,
      },
    };
  }

  it("spawns migrate deploy once against the sealed schema and scrubs production env", () => {
    const fixture = deps();
    const result = executeDisposableApply(attestation(), fixture.deps);
    expect(result).toMatchObject({
      verdict: "ALREADY_APPLIED",
      spawned: true,
      retryAttempted: false,
    });
    expect(fixture.spawns).toHaveLength(1);
    expect(fixture.spawns[0]?.args.slice(0, 3)).toEqual(["migrate", "deploy", "--schema"]);
    expect(fixture.spawns[0]?.args.join(" ")).not.toContain("resolve");
    expect(fixture.spawns[0]?.env.DATABASE_URL).toContain("/p1disp_");
    expect(fixture.spawns[0]?.env.PROD_DATABASE_URL).toBeUndefined();
    expect(fixture.spawns[0]?.env.DATABASE_URL).not.toContain("@db:5432/stell22");
  });

  it("does not spawn when P1 is already applied", () => {
    const fixture = deps();
    fixture.history.rows = [...successfulHistoricalRows(), successfulP1Row()];
    fixture.schema.value = matchingSchema();
    const result = executeDisposableApply(attestation(), fixture.deps);
    expect(result.verdict).toBe("ALREADY_APPLIED");
    expect(fixture.spawns).toHaveLength(0);
  });

  it("does not spawn or retry after an ambiguous Prisma completion", () => {
    const fixture = deps({
      spawnPrisma: (request) => {
        fixture.spawns.push(request);
        return { status: null, signal: "SIGTERM" };
      },
    });
    const first = executeDisposableApply(attestation(), fixture.deps);
    const second = executeDisposableApply(attestation(), fixture.deps);
    expect(first).toMatchObject({
      verdict: "BLOCKED",
      code: "AMBIGUOUS_COMPLETION",
      retryAttempted: false,
    });
    expect(second).toMatchObject({
      verdict: "BLOCKED",
      code: "AMBIGUOUS_COMPLETION",
      spawned: false,
    });
    expect(fixture.spawns).toHaveLength(1);
  });

  it("records ambiguous completion when post-spawn revalidation throws", () => {
    const fixture = deps();
    fixture.deps.spawnPrisma = (request) => {
      fixture.spawns.push(request);
      const sealed = path.join(
        fixture.deps.destinationRoot,
        "prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance/migration.sql",
      );
      fs.chmodSync(sealed, 0o644);
      fs.writeFileSync(sealed, "-- tampered\n");
      return { status: 0, signal: null };
    };
    const first = executeDisposableApply(attestation(), fixture.deps);
    const second = executeDisposableApply(attestation(), fixture.deps);
    expect(first).toMatchObject({
      verdict: "BLOCKED",
      code: "AMBIGUOUS_COMPLETION",
      spawned: true,
      retryAttempted: false,
    });
    expect(fs.existsSync(path.join(fixture.deps.destinationRoot, ".ambiguous-stop"))).toBe(true);
    expect(second.spawned).toBe(false);
    expect(fixture.spawns).toHaveLength(1);
  });

  it("records ambiguous completion when post-spawn history or schema reads throw", () => {
    const historyFixture = deps();
    let historyReads = 0;
    historyFixture.deps.readHistory = () => {
      historyReads += 1;
      if (historyReads > 2) throw new Error("history reader failed");
      return historyFixture.history.rows;
    };
    const historyResult = executeDisposableApply(attestation(), historyFixture.deps);
    expect(historyResult).toMatchObject({
      verdict: "BLOCKED",
      code: "AMBIGUOUS_COMPLETION",
      retryAttempted: false,
    });
    expect(executeDisposableApply(attestation(), historyFixture.deps).spawned).toBe(false);

    const schemaFixture = deps();
    let schemaReads = 0;
    schemaFixture.deps.readSchema = () => {
      schemaReads += 1;
      if (schemaReads > 2) throw new Error("schema reader failed");
      return schemaFixture.schema.value;
    };
    const schemaResult = executeDisposableApply(attestation(), schemaFixture.deps);
    expect(schemaResult).toMatchObject({
      verdict: "BLOCKED",
      code: "AMBIGUOUS_COMPLETION",
      retryAttempted: false,
    });
    expect(executeDisposableApply(attestation(), schemaFixture.deps).spawned).toBe(false);
  });

  it("does not claim a marker when the sealed directory cannot record one", () => {
    const fixture = deps();
    fixture.deps.spawnPrisma = (request) => {
      fixture.spawns.push(request);
      fs.rmSync(fixture.deps.destinationRoot, { recursive: true, force: true });
      fs.writeFileSync(fixture.deps.destinationRoot, "not-a-directory");
      return { status: 0, signal: null };
    };
    const result = executeDisposableApply(attestation(), fixture.deps);
    expect(result).toMatchObject({
      verdict: "BLOCKED",
      code: "AMBIGUOUS_COMPLETION_UNRECORDED",
      spawned: true,
      retryAttempted: false,
    });
    expect(fs.existsSync(path.join(fixture.deps.destinationRoot, ".ambiguous-stop"))).toBe(false);
  });

  it("blocks a second overlapping run", () => {
    const fixture = deps();
    const held = acquireHostLock(fixture.deps.lockPath, "other-run");
    try {
      const result = executeDisposableApply(attestation(), fixture.deps);
      expect(result).toMatchObject({
        verdict: "BLOCKED",
        code: "CONCURRENT_EXECUTION",
        spawned: false,
      });
      expect(fixture.spawns).toHaveLength(0);
    } finally {
      held.release();
    }
  });

  it("does not resolve or replay SQL when the migration failed", () => {
    expect(EXECUTION_POLICY).toEqual({
      allowProduction: false,
      allowResolve: false,
      allowSqlReplay: false,
      allowRetry: false,
      allowBypass: false,
    });
    const fixture = deps();
    const failed = fixture.history.rows[0] as PrismaMigrationRow;
    failed.finishedAt = null;
    failed.appliedStepsCount = 0;
    const result = executeDisposableApply(attestation(), fixture.deps);
    expect(result).toMatchObject({ verdict: "BLOCKED", code: "FAILED_MIGRATION", spawned: false });
  });
});

describe("CLI", { timeout: 30_000 }, () => {
  it("plans without applying and rejects malformed or production flags", () => {
    const lines: string[] = [];
    expect(
      runCli([], { git: createRepoGitSource(process.cwd()), log: (line) => lines.push(line) }),
    ).toBe(0);
    expect(lines.join("\n")).toContain("NO_APPLY");
    for (const argv of [
      ["--production"],
      ["--force"],
      ["--resolve"],
      ["--database-url", PRODUCTION_URL],
      ["apply"],
      ["apply", "--attestation"],
      ["unknown"],
    ]) {
      expect(runCli(argv, { log: () => undefined })).toBe(2);
    }
  });

  it("does not execute a migration when an attestation file is present", () => {
    const dir = tempDir();
    const file = path.join(dir, "attestation.json");
    fs.writeFileSync(file, JSON.stringify(attestation()));
    const lines: string[] = [];
    expect(runCli(["apply", "--attestation", file], { log: (line) => lines.push(line) })).toBe(2);
    expect(lines.join("\n")).toContain("LIVE_DISPOSABLE_PROBE_NOT_IMPLEMENTED");
  });
});

describe("source boundary", () => {
  it("does not call migrate resolve, docker-entrypoint, or a production override", () => {
    const dir = path.join(process.cwd(), "src/server/internal/p1-isolated-runner");
    const names = ["executor.ts", "cli.ts", "disposable-target.ts", "env.ts", "migration-set.ts"];
    const source = names.map((name) => fs.readFileSync(path.join(dir, name), "utf8")).join("\n");
    expect(source).not.toContain("migrate resolve");
    expect(source).not.toContain("docker-entrypoint");
    expect(source).not.toContain("allowProduction: true");
    expect(fs.readFileSync(path.join(dir, "contract.ts"), "utf8")).toContain(
      "allowProduction: false",
    );
  });
});
