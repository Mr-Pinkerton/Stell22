import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  HISTORICAL_APPLICATION_COMMIT,
  P1_SHA256,
} from "@/server/internal/p1-isolated-runner/contract";
import {
  successfulHistoricalRows,
  successfulP1Row,
  type PrismaMigrationRow,
} from "@/server/internal/p1-isolated-runner/classify";
import {
  type DisposableAttestation,
  type DisposableProbeResult,
} from "@/server/internal/p1-isolated-runner/disposable-target";
import {
  type ApplyDependencies,
  type PrismaSpawnRequest,
} from "@/server/internal/p1-isolated-runner/executor";
import { createRepoGitSource } from "@/server/internal/p1-isolated-runner/git-source";
import {
  assessProductionP1Only,
  executeP1OnlyMigration,
  P1_ONLY_MODE,
  PRODUCTION_P1_APPLY,
} from "@/server/internal/p1-isolated-runner/p1-only-migration";
import {
  absentP1Schema,
  P1_FUNCTION_BODY,
  type P1SchemaEvidence,
} from "@/server/internal/p1-isolated-runner/schema-contract";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1-only-"));
  tempDirs.push(dir);
  return dir;
}

function attestation(): DisposableAttestation {
  return {
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
}

function probe(): DisposableProbeResult {
  const raw = attestation();
  return {
    currentDatabase: raw.databaseName,
    serverVersionNum: 170004,
    runId: raw.runId,
    nonce: raw.nonce,
    containerId: raw.containerId,
  };
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

function fixture(overrides: Partial<ApplyDependencies> = {}): {
  deps: ApplyDependencies;
  spawns: PrismaSpawnRequest[];
  history: { rows: PrismaMigrationRow[] };
} {
  const root = tempDir();
  const spawns: PrismaSpawnRequest[] = [];
  const history = { rows: successfulHistoricalRows() };
  const schema = { value: absentP1Schema() };
  const deps: ApplyDependencies = {
    git: createRepoGitSource(process.cwd()),
    destinationRoot: path.join(root, "sealed"),
    lockPath: path.join(root, "runner.lock"),
    parentEnv: { PATH: "C:\\Windows", DATABASE_URL: "postgresql://blocked.example/stell22" },
    readHistory: () => history.rows,
    readSchema: () => schema.value,
    probeIdentity: () => probe(),
    spawnPrisma: (request) => {
      spawns.push(request);
      history.rows = [...successfulHistoricalRows(), successfulP1Row()];
      schema.value = matchingSchema();
      return { status: 0, signal: null };
    },
    ...overrides,
  };
  return { deps, spawns, history };
}

describe("p1-only migration", { timeout: 30_000 }, () => {
  it("applies through the sealed executor without replacing an application", () => {
    const { deps, spawns } = fixture();
    const result = executeP1OnlyMigration(attestation(), deps);
    expect(P1_ONLY_MODE).toBe("MIGRATION_ONLY");
    expect(result).toEqual({
      verdict: "ALREADY_APPLIED",
      code: "P1_APPLIED",
      spawned: true,
      retryAttempted: false,
      migrationOnly: true,
      appContainerReplaced: false,
      applicationSha: HISTORICAL_APPLICATION_COMMIT,
    });
    expect(spawns).toHaveLength(1);
    expect(spawns[0]?.args.slice(0, 3)).toEqual(["migrate", "deploy", "--schema"]);
    expect(spawns[0]?.env.DATABASE_URL).not.toContain("blocked.example");
  });

  it("does not spawn when P1 is already applied", () => {
    const { deps, spawns, history } = fixture();
    history.rows = [...successfulHistoricalRows(), successfulP1Row()];
    const result = executeP1OnlyMigration(attestation(), {
      ...deps,
      readSchema: () => matchingSchema(),
    });
    expect(result.verdict).toBe("ALREADY_APPLIED");
    expect(result.spawned).toBe(false);
    expect(result.retryAttempted).toBe(false);
    expect(spawns).toHaveLength(0);
  });

  it("refuses a wrong disposable target before spawn", () => {
    const { deps, spawns } = fixture();
    const result = executeP1OnlyMigration(
      { ...attestation(), containerId: "b".repeat(64) },
      deps,
    );
    expect(result.code).toBe("DISPOSABLE_IDENTITY_MISMATCH");
    expect(result.spawned).toBe(false);
    expect(spawns).toHaveLength(0);
  });

  it("refuses a damaged checksum and an incomplete history", () => {
    const damaged = fixture();
    damaged.history.rows = successfulHistoricalRows().map((row) => ({
      ...row,
      checksum: "0".repeat(64),
    }));
    const checksum = executeP1OnlyMigration(attestation(), damaged.deps);
    expect(checksum.code).toBe("UNEXPECTED_CHECKSUM");
    expect(checksum.spawned).toBe(false);
    expect(damaged.spawns).toHaveLength(0);

    const incomplete = fixture();
    incomplete.history.rows = successfulHistoricalRows().slice(1);
    const missing = executeP1OnlyMigration(attestation(), incomplete.deps);
    expect(missing.code).toBe("OTHER_PENDING_MIGRATION");
    expect(missing.spawned).toBe(false);
    expect(incomplete.spawns).toHaveLength(0);
  });

  it("refuses an extra migration row", () => {
    const { deps, spawns, history } = fixture();
    history.rows = [
      ...successfulHistoricalRows(),
      {
        migrationName: "20990101000000_not_pinned",
        checksum: P1_SHA256,
        startedAt: "2026-10-01T00:00:00.000Z",
        finishedAt: "2026-10-01T00:00:00.000Z",
        rolledBackAt: null,
        appliedStepsCount: 1,
      },
    ];
    const result = executeP1OnlyMigration(attestation(), deps);
    expect(result.code).toBe("EXTRA_HISTORY_ROW");
    expect(result.spawned).toBe(false);
    expect(spawns).toHaveLength(0);
  });

  it("does not authorize production from a caller-supplied proof or url", () => {
    expect(PRODUCTION_P1_APPLY).toBe("NOT_AUTHORIZED");
    expect(assessProductionP1Only({})).toMatchObject({
      code: "BACKUP_CHECKSUM_REQUIRED",
      spawned: false,
      executionAuthorized: false,
      appContainerReplaced: false,
    });
    expect(
      assessProductionP1Only({ backupChecksum: "a".repeat(64) }),
    ).toMatchObject({ code: "RESTORE_NOT_VERIFIED", executionAuthorized: false });
    expect(
      assessProductionP1Only({
        backupChecksum: "a".repeat(64),
        restoreDrill: "RESTORE_VERIFIED",
      }),
    ).toMatchObject({
      code: "PRODUCTION_TARGET_UNAUTHENTICATED",
      spawned: false,
      executionAuthorized: false,
    });
    const rejected = assessProductionP1Only({
      databaseUrl: "postgresql://stell22:secret@db:5432/stell22",
    });
    expect(rejected.code).toBe("DATABASE_URL_REJECTED");
    expect(JSON.stringify(rejected)).not.toContain("postgresql://");
    expect(JSON.stringify(rejected)).not.toContain("secret");
  });

  it("keeps Production Deploy from reaching SSH while migration and startup are bundled", () => {
    const script = spawnSync(process.execPath, ["scripts/assert-production-deploy-separation.mjs"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(script.status).toBe(1);
    expect(script.stderr).toContain("DEPLOY_BUNDLES_MIGRATION_AND_APP");
    const workflow = fs.readFileSync(".github/workflows/deploy-production.yml", "utf8");
    const guard = workflow.indexOf("assert-production-deploy-separation.mjs");
    const ssh = workflow.indexOf("appleboy/ssh-action");
    expect(guard).toBeGreaterThan(-1);
    expect(ssh).toBeGreaterThan(guard);
    const manual = fs.readFileSync(".github/workflows/p1-only-migration.yml", "utf8");
    expect(manual).not.toContain("environment: production");
    expect(manual).not.toContain("appleboy/ssh-action");
    expect(fs.readFileSync("src/server/internal/p1-isolated-runner/cli.ts", "utf8")).toContain(
      "LIVE_DISPOSABLE_PROBE_NOT_IMPLEMENTED",
    );
    expect(fs.readFileSync("src/server/internal/p1-isolated-runner/contract.ts", "utf8")).toContain(
      "allowProduction: false",
    );
  });
});
