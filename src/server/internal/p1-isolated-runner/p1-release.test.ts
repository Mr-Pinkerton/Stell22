import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  successfulHistoricalRows,
  successfulP1Row,
  type PrismaMigrationRow,
} from "@/server/internal/p1-isolated-runner/classify";
import { EXECUTION_POLICY, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { createRepoGitSource } from "@/server/internal/p1-isolated-runner/git-source";
import { acquireHostLock } from "@/server/internal/p1-isolated-runner/lock";
import {
  assessWriterDeployPrerequisite,
  productionReleaseAuthorized,
  sha256Bytes,
  verifyPinnedHistoricalPlusP1,
  type CatalogProbe,
  type ContainerIdentity,
  type RestoredProbe,
  type TopologyObservation,
} from "@/server/internal/p1-isolated-runner/p1-release-gate";
import {
  executeP1OnlyRelease,
  type OneShotPlan,
  type ReleaseDependencies,
  type ReleaseRequest,
} from "@/server/internal/p1-isolated-runner/p1-release-execute";
import { absentP1Schema, P1_FUNCTION_BODY, type P1SchemaEvidence } from "@/server/internal/p1-isolated-runner/schema-contract";

const ATTEMPT = "0123456789abcdef";

function container(name: string, id: string, image: string): ContainerIdentity {
  return {
    id,
    imageId: image,
    startedAt: "2026-10-15T12:00:00.000000000Z",
    running: true,
    name,
    entrypoint: ["node", "/app/health.js"],
    command: [],
  };
}

function topology(overrides: Partial<TopologyObservation> = {}): TopologyObservation {
  const base: TopologyObservation = {
    attemptId: ATTEMPT,
    app: container(`p1rel-app-${ATTEMPT}`, "a".repeat(64), `sha256:${"c".repeat(64)}`),
    db: container(
      "stell22-p1-disposable-11111111-1111-4111-8111-111111111111",
      "b".repeat(64),
      `sha256:${"d".repeat(64)}`,
    ),
    databaseName: "p1disp_abc",
    roleName: "p1disp",
    networkName: `p1rel-${ATTEMPT}`,
  };
  return { ...base, ...overrides };
}

function probe(overrides: Partial<CatalogProbe> = {}): CatalogProbe {
  return {
    migrationFingerprint: "a".repeat(64),
    logicalSchemaFingerprint: "b".repeat(64),
    publicTableCount: 54,
    successfulMigrationCount: 45,
    failedMigrationCount: 0,
    userRowCount: 0,
    ...overrides,
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

function harness(input: {
  history?: PrismaMigrationRow[];
  schema?: P1SchemaEvidence;
  observed?: TopologyObservation;
  archive?: Buffer;
  live?: CatalogProbe;
  restored?: RestoredProbe;
  spawn?: (plan: OneShotPlan) => { status: number | null; signal: NodeJS.Signals | null };
  identity?: { databaseName: string; roleName: string };
}): { deps: ReleaseDependencies; request: ReleaseRequest; plans: OneShotPlan[]; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1-release-"));
  const archive = input.archive ?? Buffer.from("backup-bytes");
  const declared = input.observed ?? topology();
  let history = input.history ?? successfulHistoricalRows();
  let schema = input.schema ?? absentP1Schema();
  const plans: OneShotPlan[] = [];
  const deps: ReleaseDependencies = {
    git: createRepoGitSource(process.cwd()),
    destinationRoot: path.join(root, "sealed"),
    lockPath: path.join(root, "release.lock"),
    readHistory: () => history,
    readSchema: () => schema,
    inspectTopology: () => declared,
    readDatabaseIdentity: () => input.identity ?? { databaseName: declared.databaseName, roleName: "p1disp" },
    readArchive: () => archive,
    readLiveCatalog: () => input.live ?? probe(),
    readRestoredCatalog: () => input.restored ?? { ...probe(), exitCode: 0 },
    spawnOneShot: (plan) => {
      plans.push(plan);
      if (input.spawn) return input.spawn(plan);
      history = [...successfulHistoricalRows(), successfulP1Row()];
      schema = matchingSchema();
      return { status: 0, signal: null };
    },
  };
  const request: ReleaseRequest = {
    attemptId: declared.attemptId,
    declared,
    databasePassword: "0123456789abcdef",
    recoveryClaim: { attemptId: declared.attemptId, archiveSha256: sha256Bytes(archive) },
  };
  return { deps, request, plans, root };
}

describe("P1-only release gate", { timeout: 30_000 }, () => {
  it("verifies the 45 historical blobs plus the pinned P1 checksum", () => {
    const pinned = verifyPinnedHistoricalPlusP1(createRepoGitSource(process.cwd()));
    expect(pinned).toEqual({
      historicalCount: 45,
      p1Sha256: P1_SHA256,
      p1GitBlob: "3e54eaaae450f76edf75163024bebf4d7d70c358",
    });
    expect(productionReleaseAuthorized()).toBe(false);
    expect(EXECUTION_POLICY.allowProduction).toBe(false);
  });

  it("refuses a recovery word without archive bytes", () => {
    const { deps, request, plans, root } = harness({});
    request.recoveryClaim = "RESTORE_VERIFIED";
    const outcome = executeP1OnlyRelease(request, deps);
    expect(outcome.code).toBe("RESTORE_WORD_REJECTED");
    expect(outcome.spawned).toBe(false);
    expect(plans).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses RESTORE_VERIFIED when the checksum field is absent", () => {
    const { deps, request, root } = harness({});
    request.recoveryClaim = { restoreDrill: "RESTORE_VERIFIED", attemptId: ATTEMPT };
    expect(executeP1OnlyRelease(request, deps).code).toBe("RESTORE_WORD_REJECTED");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses checksum drift and a failed restore", () => {
    const drifted = harness({});
    drifted.request.recoveryClaim = { attemptId: ATTEMPT, archiveSha256: "e".repeat(64) };
    expect(executeP1OnlyRelease(drifted.request, drifted.deps).code).toBe("CHECKSUM_DRIFT");
    fs.rmSync(drifted.root, { recursive: true, force: true });

    const failed = harness({ restored: { ...probe(), exitCode: 1 } });
    expect(executeP1OnlyRelease(failed.request, failed.deps).code).toBe("RESTORE_FAILED");
    fs.rmSync(failed.root, { recursive: true, force: true });

    const mismatch = harness({
      restored: { ...probe(), exitCode: 0, migrationFingerprint: "f".repeat(64) },
    });
    expect(executeP1OnlyRelease(mismatch.request, mismatch.deps).code).toBe("RESTORE_MISMATCH");
    fs.rmSync(mismatch.root, { recursive: true, force: true });
  });

  it("refuses production names, the wrong image, and a caller connection string", () => {
    const production = harness({
      observed: topology({ app: container("stell22-app", "a".repeat(64), `sha256:${"c".repeat(64)}`) }),
    });
    expect(executeP1OnlyRelease(production.request, production.deps).code).toBe("PRODUCTION_NOT_AUTHORIZED");
    fs.rmSync(production.root, { recursive: true, force: true });

    const database = harness({ observed: topology({ databaseName: "stell22" }) });
    expect(executeP1OnlyRelease(database.request, database.deps).code).toBe("PRODUCTION_NOT_AUTHORIZED");
    fs.rmSync(database.root, { recursive: true, force: true });

    const declared = topology();
    const wrongImage = harness({});
    wrongImage.deps.inspectTopology = () => ({
      ...declared,
      app: { ...declared.app, imageId: `sha256:${"e".repeat(64)}` },
    });
    expect(executeP1OnlyRelease(wrongImage.request, wrongImage.deps).code).toBe("RUNTIME_IDENTITY_MISMATCH");
    fs.rmSync(wrongImage.root, { recursive: true, force: true });

    const url = harness({});
    url.request.databaseUrl = "postgresql://stell22:secret@db:5432/stell22";
    const refused = executeP1OnlyRelease(url.request, url.deps);
    expect(refused.code).toBe("DATABASE_URL_REJECTED");
    expect(JSON.stringify(refused)).not.toContain("secret");
    fs.rmSync(url.root, { recursive: true, force: true });
  });

  it("refuses a running entrypoint script and an unauthenticated inspect", () => {
    const entry = topology();
    entry.app = { ...entry.app, entrypoint: ["./docker-entrypoint.sh"] };
    const started = harness({ observed: entry });
    expect(executeP1OnlyRelease(started.request, started.deps).code).toBe("APP_ENTRYPOINT_FORBIDDEN");
    fs.rmSync(started.root, { recursive: true, force: true });

    const missing = harness({});
    missing.deps.inspectTopology = () => {
      throw new Error("inspect failed");
    };
    expect(executeP1OnlyRelease(missing.request, missing.deps)).toMatchObject({
      code: "RUNTIME_UNAUTHENTICATED",
      spawned: false,
    });
    fs.rmSync(missing.root, { recursive: true, force: true });
  });

  it("refuses the wrong database probe, extra history, and a failed migration row", () => {
    const wrongDb = harness({ identity: { databaseName: "other", roleName: "p1disp" } });
    expect(executeP1OnlyRelease(wrongDb.request, wrongDb.deps).code).toBe("DATABASE_MISMATCH");
    fs.rmSync(wrongDb.root, { recursive: true, force: true });

    const extra = harness({
      history: [...successfulHistoricalRows(), { ...successfulP1Row(), migrationName: "extra_migration" }],
    });
    expect(executeP1OnlyRelease(extra.request, extra.deps).code).toBe("EXTRA_HISTORY_ROW");
    fs.rmSync(extra.root, { recursive: true, force: true });

    const failed = successfulHistoricalRows();
    failed[0] = { ...failed[0], finishedAt: null, appliedStepsCount: 0 };
    const broken = harness({ history: failed });
    expect(executeP1OnlyRelease(broken.request, broken.deps).code).toBe("FAILED_MIGRATION");
    fs.rmSync(broken.root, { recursive: true, force: true });
  });

  it("does not spawn when another execution holds the lock", () => {
    const { deps, request, plans, root } = harness({});
    const held = acquireHostLock(deps.lockPath, "other");
    expect(executeP1OnlyRelease(request, deps).code).toBe("CONCURRENT_EXECUTION");
    expect(plans).toHaveLength(0);
    held.release();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("applies through the one-shot plan and does not trust a success status without the catalog", () => {
    const applied = harness({});
    const outcome = executeP1OnlyRelease(applied.request, applied.deps);
    expect(outcome).toMatchObject({
      verdict: "ALREADY_APPLIED",
      code: "P1_APPLIED",
      spawned: true,
      retryAttempted: false,
      imageGitSha: "UNVERIFIED",
      appUnchanged: true,
    });
    const argv = applied.plans[0]?.argv.join("\n") ?? "";
    expect(argv).toContain("--entrypoint\nnode");
    expect(argv).toContain("migrate\ndeploy\n--schema\n/sealed/prisma/schema.prisma");
    expect(argv).not.toContain("docker-entrypoint.sh");
    expect(argv).not.toContain(applied.request.declared.app.id);
    expect(argv).not.toContain("stell22-app");
    fs.rmSync(applied.root, { recursive: true, force: true });

    const lying = harness({ spawn: () => ({ status: 0, signal: null }) });
    const ambiguous = executeP1OnlyRelease(lying.request, lying.deps);
    expect(ambiguous.code).toBe("AMBIGUOUS_COMPLETION");
    expect(ambiguous.spawned).toBe(true);
    lying.deps.spawnOneShot = () => {
      throw new Error("retry");
    };
    const second = executeP1OnlyRelease(lying.request, lying.deps);
    expect(second.code).toBe("AMBIGUOUS_COMPLETION");
    expect(second.spawned).toBe(false);
    fs.rmSync(lying.root, { recursive: true, force: true });
  }, 60_000);

  it("treats an already applied P1 as a read-only no-op", () => {
    const { deps, request, plans, root } = harness({
      history: [...successfulHistoricalRows(), successfulP1Row()],
      schema: matchingSchema(),
    });
    const outcome = executeP1OnlyRelease(request, deps);
    expect(outcome.spawned).toBe(false);
    expect(outcome.code).toBe("P1_APPLIED");
    expect(plans).toHaveLength(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("blocks writer deployment until P1 matches and allows it afterwards", () => {
    expect(
      assessWriterDeployPrerequisite({ history: successfulHistoricalRows(), schema: absentP1Schema() }),
    ).toEqual({ allow: false, code: "P1_ABSENT" });
    expect(
      assessWriterDeployPrerequisite({
        history: [...successfulHistoricalRows(), successfulP1Row()],
        schema: matchingSchema(),
      }),
    ).toEqual({ allow: true, code: "P1_APPLIED" });
    const shell = fs.readFileSync(path.join(process.cwd(), "scripts", "p1-writer-preflight.sh"), "utf8");
    const deploy = fs.readFileSync(path.join(process.cwd(), "scripts", "deploy.sh"), "utf8");
    expect(shell).toContain(P1_SHA256);
    expect(shell).toContain("P1_APPLIED");
    expect(shell).not.toContain("exit 2");
    expect(deploy.indexOf("p1-writer-preflight.sh")).toBeGreaterThan(-1);
    expect(deploy.indexOf("p1-writer-preflight.sh")).toBeLessThan(deploy.indexOf("backup-db.sh"));
    expect(fs.existsSync(path.join(process.cwd(), ".github", "workflows", "p1-only-migration.yml"))).toBe(
      false,
    );
  });

  it("does not retry after an ambiguous one-shot", () => {
    const { deps, request, root } = harness({ spawn: () => ({ status: null, signal: "SIGKILL" }) });
    expect(executeP1OnlyRelease(request, deps)).toMatchObject({
      code: "AMBIGUOUS_COMPLETION",
      spawned: true,
      retryAttempted: false,
    });
    let calls = 0;
    deps.spawnOneShot = () => {
      calls += 1;
      return { status: 0, signal: null };
    };
    expect(executeP1OnlyRelease(request, deps).spawned).toBe(false);
    expect(calls).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("writer preflight script stays a shell file", () => {
  it("is invoked from the production remote script before checkout", () => {
    const remote = fs.readFileSync(path.join(process.cwd(), "scripts", "ci-prod-remote.sh"), "utf8");
    expect(remote.indexOf("p1-writer-preflight.sh")).toBeGreaterThan(-1);
    expect(remote.indexOf("p1-writer-preflight.sh")).toBeLessThan(remote.indexOf("git reset --hard"));
  });
});
