import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { successfulHistoricalRows, successfulP1Row } from "@/server/internal/p1-isolated-runner/classify";
import { EXECUTION_POLICY } from "@/server/internal/p1-isolated-runner/contract";
import { createRepoGitSource } from "@/server/internal/p1-isolated-runner/git-source";
import { productionReleaseAuthorized } from "@/server/internal/p1-isolated-runner/p1-release-gate";
import { absentP1Schema, P1_FUNCTION_BODY } from "@/server/internal/p1-isolated-runner/schema-contract";
import type { P1SchemaEvidence } from "@/server/internal/p1-isolated-runner/schema-contract";
import { runProductionAdapterCli } from "@/server/internal/p1-production-adapter/cli";
import {
  PRODUCTION_APP_CONTAINER,
  PRODUCTION_DATABASE_NAME,
  PRODUCTION_DB_CONTAINER,
  PRODUCTION_DNS_ALIAS,
  PRODUCTION_NETWORK_NAME,
  PRODUCTION_POSTGRES_IMAGE,
  PRODUCTION_ROLE_NAME,
  testAppName,
  testDatabaseName,
  testDbName,
  testNetworkName,
} from "@/server/internal/p1-production-adapter/contract";
import { containerFactFromInspect } from "@/server/internal/p1-production-adapter/docker-runtime";
import {
  executeProductionAdapter,
  type AdapterDependencies,
  type AdapterRequest,
} from "@/server/internal/p1-production-adapter/execute";
import {
  declarationFromFacts,
  type ContainerFact,
  type TargetFacts,
} from "@/server/internal/p1-production-adapter/identity";
import {
  publishReleaseBackup,
  type BackupIo,
  type RecoverySnapshot,
} from "@/server/internal/p1-production-adapter/recovery";

const ATTEMPT = "0123456789abcdef";
const APP_ID = "a".repeat(64);
const DB_ID = "b".repeat(64);
const APP_IMAGE = `sha256:${"c".repeat(64)}`;
const DB_IMAGE = `sha256:${"d".repeat(64)}`;
const STARTED = "2026-10-15T12:00:00.000000000Z";
const DAEMON = "daemon-test-1234";

describe("production P1 adapter", () => {
  it("keeps the disposable runner closed to production", () => {
    expect(productionReleaseAuthorized()).toBe(false);
    expect(EXECUTION_POLICY.allowProduction).toBe(false);
  });

  it("refuses a caller connection string before inspect", () => {
    const world = worldFor("TEST_OWNED");
    world.deps.inspect = () => {
      throw new Error("inspect must not run");
    };
    const result = executeProductionAdapter({ ...world.request, databaseUrl: "postgresql://stell22:secret@db:5432/stell22" }, world.deps);
    expect(result).toMatchObject({ verdict: "STOP", code: "DATABASE_URL_REJECTED", spawned: false, retryAttempted: false });
  });

  it("refuses production scope in GitHub Actions and when the daemon pin is missing", () => {
    const ci = worldFor("PRODUCTION");
    ci.deps.env = { GITHUB_ACTIONS: "true" };
    ci.deps.inspect = () => {
      throw new Error("inspect must not run");
    };
    expect(executeProductionAdapter(ci.request, ci.deps).code).toBe("PRODUCTION_SCOPE_FORBIDDEN_IN_CI");

    const unpinned = worldFor("PRODUCTION");
    unpinned.deps.productionDaemonPin = null;
    expect(executeProductionAdapter(unpinned.request, unpinned.deps)).toMatchObject({
      code: "PRODUCTION_DAEMON_UNPINNED",
      spawned: false,
    });
  });

  it("refuses the wrong target, image, container, database, and a Git SHA used as an image id", () => {
    const wrongTarget = worldFor("TEST_OWNED");
    wrongTarget.request.declared = { ...wrongTarget.request.declared, appId: "f".repeat(64) };
    expect(executeProductionAdapter(wrongTarget.request, wrongTarget.deps).code).toBe("RUNTIME_IDENTITY_MISMATCH");

    const changedImage = worldFor("TEST_OWNED");
    changedImage.deps.inspect = () => ({
      ...changedImage.facts,
      db: { ...changedImage.facts.db, imageId: `sha256:${"e".repeat(64)}` },
    });
    expect(executeProductionAdapter(changedImage.request, changedImage.deps).code).toBe("RUNTIME_IDENTITY_MISMATCH");

    const changedContainer = worldFor("TEST_OWNED");
    changedContainer.deps.inspect = () => ({
      ...changedContainer.facts,
      db: { ...changedContainer.facts.db, id: "e".repeat(64) },
    });
    expect(executeProductionAdapter(changedContainer.request, changedContainer.deps).code).toBe("RUNTIME_IDENTITY_MISMATCH");

    const wrongDatabase = worldFor("TEST_OWNED");
    wrongDatabase.deps.inspect = () => ({ ...wrongDatabase.facts, databaseName: "other_db" });
    expect(executeProductionAdapter(wrongDatabase.request, wrongDatabase.deps).code).toBe("RUNTIME_IDENTITY_MISMATCH");

    const gitSha = worldFor("TEST_OWNED");
    gitSha.facts = {
      ...gitSha.facts,
      app: { ...gitSha.facts.app, imageId: "a".repeat(40) },
    };
    gitSha.request.declared = declarationFromFacts(gitSha.facts);
    gitSha.deps.inspect = () => gitSha.facts;
    expect(executeProductionAdapter(gitSha.request, gitSha.deps).code).toBe("IMAGE_ID_NOT_GIT_SHA");
  });

  it("refuses production names on the test-owned profile and a published database port", () => {
    const named = worldFor("TEST_OWNED");
    named.facts = {
      ...named.facts,
      app: { ...named.facts.app, name: PRODUCTION_APP_CONTAINER },
      databaseName: PRODUCTION_DATABASE_NAME,
    };
    named.request.declared = declarationFromFacts(named.facts);
    named.deps.inspect = () => named.facts;
    expect(executeProductionAdapter(named.request, named.deps).code).toBe("PRODUCTION_TARGET_REFUSED");

    const published = worldFor("TEST_OWNED");
    published.facts = { ...published.facts, db: { ...published.facts.db, publishedDbPort: true } };
    published.request.declared = declarationFromFacts(published.facts);
    published.deps.inspect = () => published.facts;
    expect(executeProductionAdapter(published.request, published.deps).code).toBe("DATABASE_PORT_PUBLISHED");
  });

  it("stops on migration drift and does not spawn", () => {
    const world = worldFor("TEST_OWNED");
    world.deps.readHistory = () => [{ ...successfulHistoricalRows()[0]!, checksum: "f".repeat(64) }];
    expect(executeProductionAdapter(world.request, world.deps)).toMatchObject({
      code: "UNEXPECTED_CHECKSUM",
      spawned: false,
      phase: "READ_ONLY_PREFLIGHT",
    });
    expect(world.spawns).toBe(0);
  });

  it("rejects a recovery word, an old backup, an incomplete archive, and a restore mismatch", () => {
    const world = worldFor("TEST_OWNED");
    world.request.intent = "RECOVERY";
    world.request.recoveryWitness = "RESTORE_VERIFIED";
    expect(executeProductionAdapter(world.request, world.deps).code).toBe("RESTORE_WORD_REJECTED");

    const historical = worldFor("TEST_OWNED");
    historical.request.intent = "RECOVERY";
    historical.request.recoveryWitness = { kind: "OLD_BACKUP", archiveSha256: "a".repeat(64) };
    expect(executeProductionAdapter(historical.request, historical.deps).code).toBe("HISTORICAL_BACKUP_NOT_SUFFICIENT");

    const incomplete = worldFor("TEST_OWNED");
    incomplete.request.intent = "RECOVERY";
    incomplete.deps.readArchive = () => incomplete.archive.subarray(0, 4);
    expect(executeProductionAdapter(incomplete.request, incomplete.deps).code).toBe("BACKUP_INCOMPLETE");

    const mismatch = worldFor("TEST_OWNED");
    mismatch.request.intent = "RECOVERY";
    mismatch.deps.readRestoredRecovery = () => ({
      ...mismatch.snapshot,
      exitCode: 0,
      aggregates: [{ table: "User", rowCount: 9 }],
    });
    expect(executeProductionAdapter(mismatch.request, mismatch.deps).code).toBe("RESTORE_MISMATCH");
  });

  it("writes the checksum before the archive and binds it to this attempt", () => {
    const writes: string[] = [];
    const files = new Map<string, Buffer>();
    const io: BackupIo = {
      writeNew(filePath, bytes) {
        writes.push(path.basename(filePath));
        files.set(filePath, Buffer.from(bytes));
      },
      read(filePath) {
        const found = files.get(filePath);
        if (!found) throw new Error("missing");
        return found;
      },
    };
    const facts = testFacts();
    const witness = publishReleaseBackup(
      path.join(os.tmpdir(), "p1pa-backup-order"),
      Buffer.from("archive-bytes"),
      { attemptId: ATTEMPT, container: facts.db, databaseName: facts.databaseName, roleName: facts.roleName },
      io,
    );
    expect(writes).toEqual(["backup.sql.gz.sha256", "backup.sql.gz", "backup.witness.json"]);
    expect(witness.createdForRelease).toBe(true);
    expect(witness.attemptId).toBe(ATTEMPT);
  });

  it("stops when the lock is lost and does not retry an ambiguous Prisma result", () => {
    const lost = readyApply("TEST_OWNED");
    lost.deps.readLockOwner = () => null;
    expect(executeProductionAdapter(lost.request, lost.deps)).toMatchObject({ code: "LOST_LOCK", spawned: false });
    expect(lost.spawns).toBe(0);

    const ambiguous = readyApply("TEST_OWNED");
    ambiguous.deps.spawnOneShot = () => {
      ambiguous.spawns += 1;
      return { status: null, signal: null };
    };
    const first = executeProductionAdapter(ambiguous.request, ambiguous.deps);
    expect(first).toMatchObject({ verdict: "BLOCKED", code: "AMBIGUOUS_COMPLETION", spawned: true, retryAttempted: false });
    const second = executeProductionAdapter(ambiguous.request, ambiguous.deps);
    expect(second).toMatchObject({ verdict: "BLOCKED", code: "AMBIGUOUS_COMPLETION", spawned: false });
    expect(ambiguous.spawns).toBe(1);
  }, 30_000);

  it("applies pinned P1 once on a test-owned target and leaves the application identity unchanged", () => {
    const world = readyApply("TEST_OWNED");
    let applied = false;
    world.deps.readHistory = () => (applied ? [...successfulHistoricalRows(), successfulP1Row()] : successfulHistoricalRows());
    world.deps.readSchema = () => (applied ? appliedSchema() : absentP1Schema());
    world.deps.spawnOneShot = (plan) => {
      world.spawns += 1;
      world.argv = plan.argv;
      applied = true;
      return { status: 0, signal: null };
    };
    const result = executeProductionAdapter(world.request, world.deps);
    expect(result).toMatchObject({
      verdict: "ALREADY_APPLIED",
      code: "P1_APPLIED",
      phase: "POSTCHECK",
      spawned: true,
      retryAttempted: false,
      imageGitSha: "UNVERIFIED",
      targetClass: "TEST_OWNED_NOT_PRODUCTION",
      appUnchanged: true,
    });
    expect(world.argv.join("\n")).not.toContain("docker-entrypoint.sh");
    expect(world.argv).not.toContain(world.facts.app.id);
    expect(world.argv).not.toContain(world.facts.app.name);
    expect(world.argv.join("\n")).not.toContain(world.password);
    expect(world.argv).toContain("--entrypoint");
    expect(world.argv).toContain("node");
    const repeat = executeProductionAdapter(
      { ...world.request, recoveryWitness: "RESTORE_VERIFIED" },
      world.deps,
    );
    expect(repeat).toMatchObject({ verdict: "ALREADY_APPLIED", spawned: false });
    expect(world.spawns).toBe(1);
  }, 30_000);

  it("can apply on a production-shaped target only when the pin and owner authorization match", () => {
    const world = readyApply("PRODUCTION");
    let applied = false;
    world.deps.readHistory = () => (applied ? [...successfulHistoricalRows(), successfulP1Row()] : successfulHistoricalRows());
    world.deps.readSchema = () => (applied ? appliedSchema() : absentP1Schema());
    world.deps.spawnOneShot = (plan) => {
      world.spawns += 1;
      applied = true;
      expect(plan.argv.join("\n")).not.toContain("docker-entrypoint.sh");
      expect(plan.argv).toContain(PRODUCTION_NETWORK_NAME);
      return { status: 0, signal: null };
    };
    const result = executeProductionAdapter(world.request, world.deps);
    expect(result.targetClass).toBe("PRODUCTION");
    expect(result.code).toBe("P1_APPLIED");
    expect(world.spawns).toBe(1);

    const shortcut = readyApply("PRODUCTION");
    shortcut.request.authorization = { authorized: true };
    expect(executeProductionAdapter(shortcut.request, shortcut.deps).code).toBe("SHORTCUT_AUTHORIZATION");
    expect(shortcut.spawns).toBe(0);
  }, 30_000);

  it("does not treat a published database port as closed", () => {
    const fact = containerFactFromInspect({
      Id: DB_ID,
      Image: DB_IMAGE,
      Name: "/stell22-db-prod",
      State: { Running: true, StartedAt: STARTED },
      Config: { Image: PRODUCTION_POSTGRES_IMAGE, Entrypoint: ["docker-entrypoint.sh"], Cmd: ["postgres"] },
      HostConfig: { PortBindings: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "5432" }] } },
      NetworkSettings: { Ports: {}, Networks: { stell22_default: { Aliases: ["db"] } } },
    });
    expect(fact.publishedDbPort).toBe(true);
    expect(fact.imageId).toBe(DB_IMAGE);
  });

  it("refuses CLI shortcuts and does not apply from the CLI without a runtime", () => {
    expect(runProductionAdapterCli(["apply", "--authorize"])).toBe(2);
    expect(runProductionAdapterCli(["--database-url", "postgresql://stell22:secret@db/stell22"])).toBe(2);
    expect(runProductionAdapterCli(["preflight"])).toBe(2);
    expect(runProductionAdapterCli(["verify-recovery"])).toBe(2);
    const lines: string[] = [];
    expect(
      runProductionAdapterCli(["apply", "--authorization", "owner.json"], {
        log: (line) => lines.push(line),
        readPin: () => null,
      }),
    ).toBe(2);
    expect(lines).toContain("STOP PRODUCTION_DAEMON_UNPINNED");
  });
});

type World = {
  facts: TargetFacts;
  request: AdapterRequest;
  deps: AdapterDependencies;
  archive: Buffer;
  snapshot: RecoverySnapshot;
  password: string;
  spawns: number;
  argv: readonly string[];
};

function worldFor(scope: "TEST_OWNED" | "PRODUCTION"): World {
  const facts = scope === "TEST_OWNED" ? testFacts() : productionFacts();
  const snapshot = snapshotOf();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p1pa-unit-"));
  const archive = Buffer.from("gzip-archive-bytes");
  const witness = publishReleaseBackup(
    directory,
    archive,
    { attemptId: ATTEMPT, container: facts.db, databaseName: facts.databaseName, roleName: facts.roleName },
    memoryIo(),
  );
  const spawns = { count: 0, argv: [] as string[] };
  const lockPath = path.join(directory, "adapter.lock");
  const deps: AdapterDependencies = {
    productionDaemonPin: scope === "PRODUCTION" ? DAEMON : null,
    git: createRepoGitSource(process.cwd()),
    destinationRoot: path.join(directory, "sealed"),
    lockPath,
    env: {},
    inspect: () => facts,
    readHistory: () => successfulHistoricalRows(),
    readSchema: () => absentP1Schema(),
    readArchive: () => archive,
    readLiveRecovery: () => snapshot,
    readRestoredRecovery: () => ({ ...snapshot, exitCode: 0 }),
    readLockOwner: () => (fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null),
    spawnOneShot: (plan) => {
      spawns.count += 1;
      spawns.argv = [...plan.argv];
      return { status: 0, signal: null };
    },
  };
  return {
    facts,
    request: {
      intent: "PREFLIGHT",
      scope,
      attemptId: ATTEMPT,
      declared: declarationFromFacts(facts),
      databasePassword: "adapter-secret-value",
      recoveryWitness: witness,
    },
    deps,
    archive,
    snapshot,
    password: "adapter-secret-value",
    get spawns() {
      return spawns.count;
    },
    set spawns(value: number) {
      spawns.count = value;
    },
    get argv() {
      return spawns.argv;
    },
    set argv(value: readonly string[]) {
      spawns.argv = [...value];
    },
  };
}

function readyApply(scope: "TEST_OWNED" | "PRODUCTION"): World {
  const world = worldFor(scope);
  const recovery = executeProductionAdapter({ ...world.request, intent: "RECOVERY" }, world.deps);
  expect(recovery.verdict).toBe("RECOVERY_VERIFIED");
  world.request = {
    ...world.request,
    intent: "APPLY",
    authorization: {
      kind: "OWNER_AUTHORIZATION",
      scope,
      decision: "AUTHORIZE_P1_ONLY_APPLY",
      attemptId: ATTEMPT,
      dossierSha256: recovery.dossierSha256,
      recoverySha256: recovery.recoverySha256,
      daemonId: world.facts.daemonId,
    },
  };
  return world;
}

function testFacts(): TargetFacts {
  return {
    scope: "TEST_OWNED",
    attemptId: ATTEMPT,
    daemonId: DAEMON,
    app: container(testAppName(ATTEMPT), APP_ID, APP_IMAGE, "p1pa-app:test", testNetworkName(ATTEMPT), false),
    db: container(testDbName(ATTEMPT), DB_ID, DB_IMAGE, "postgres:17-alpine", testNetworkName(ATTEMPT), true),
    databaseName: testDatabaseName(ATTEMPT),
    roleName: "p1pa",
    networkName: testNetworkName(ATTEMPT),
    dnsAlias: PRODUCTION_DNS_ALIAS,
    serverVersionNum: 170010,
  };
}

function productionFacts(): TargetFacts {
  const facts = testFacts();
  return {
    ...facts,
    scope: "PRODUCTION",
    app: {
      ...container(PRODUCTION_APP_CONTAINER, APP_ID, APP_IMAGE, "stell22-app", PRODUCTION_NETWORK_NAME, false),
      entrypoint: ["./docker-entrypoint.sh"],
    },
    db: container(PRODUCTION_DB_CONTAINER, DB_ID, DB_IMAGE, PRODUCTION_POSTGRES_IMAGE, PRODUCTION_NETWORK_NAME, true),
    databaseName: PRODUCTION_DATABASE_NAME,
    roleName: PRODUCTION_ROLE_NAME,
    networkName: PRODUCTION_NETWORK_NAME,
  };
}

function container(
  name: string,
  id: string,
  imageId: string,
  imageRef: string,
  networkName: string,
  aliasDb: boolean,
): ContainerFact {
  return {
    id,
    imageId,
    imageRef,
    startedAt: STARTED,
    running: true,
    name,
    entrypoint: aliasDb ? ["docker-entrypoint.sh"] : ["node", "/app/health.js"],
    command: aliasDb ? ["postgres"] : [],
    publishedDbPort: false,
    networks: [{ name: networkName, aliases: aliasDb ? ["db", name] : [name] }],
  };
}

function snapshotOf(): RecoverySnapshot {
  return {
    migrations: successfulHistoricalRows().map((row) => ({
      name: row.migrationName,
      checksum: row.checksum,
      finished: true,
      rolledBack: false,
      steps: 1,
    })),
    columns: [],
    constraints: [],
    aggregates: [{ table: "User", rowCount: 1 }],
    invalidIndexCount: 0,
    notValidConstraintCount: 0,
    publicTableCount: 45,
    successfulMigrationCount: 45,
    failedMigrationCount: 0,
    userRowCount: 1,
  };
}

function appliedSchema(): P1SchemaEvidence {
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
      definition: `CHECK (("receiptProvenanceSnapshot" IS NULL OR jsonb_typeof("receiptProvenanceSnapshot") = 'object'))`,
      validated: true,
    },
    functionDef: {
      schemaName: "public",
      functionName: "batch_creation_command_provenance_guard",
      identityArguments: "",
      matchCount: 1,
      language: "plpgsql",
      definition: `CREATE FUNCTION public."batch_creation_command_provenance_guard"() RETURNS trigger LANGUAGE plpgsql AS $$\n${P1_FUNCTION_BODY}\n$$`,
      securityDefiner: false,
    },
    trigger: {
      schemaName: "public",
      tableName: "BatchCreationCommand",
      triggerName: "batch_creation_command_provenance_guard",
      matchCount: 1,
      enabled: "O",
      definition:
        'CREATE TRIGGER "batch_creation_command_provenance_guard" BEFORE UPDATE OR DELETE ON public."BatchCreationCommand" FOR EACH ROW EXECUTE FUNCTION public."batch_creation_command_provenance_guard"()',
      functionSchema: "public",
      functionName: "batch_creation_command_provenance_guard",
      functionIdentityArguments: "",
    },
    foreignKeyCount: 0,
    extraTriggerNames: [],
    unexpectedObjects: [],
  };
}

function memoryIo(): BackupIo {
  const files = new Map<string, Buffer>();
  return {
    writeNew(filePath, bytes) {
      if (files.has(filePath)) throw new Error("exists");
      files.set(filePath, Buffer.from(bytes));
    },
    read(filePath) {
      const found = files.get(filePath);
      if (!found) throw new Error("missing");
      return found;
    },
  };
}
