import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
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
import { fileReplayStore, memoryReplayStore, verifySignedAuthorization } from "@/server/internal/p1-production-adapter/authorization";
import { runProductionAdapterCli } from "@/server/internal/p1-production-adapter/cli";
import { ONE_SHOT_IMAGE, ONE_SHOT_BASE_IMAGE } from "@/server/internal/p1-isolated-runner/p1-release-gate";
import { ONE_SHOT_LAUNCHER } from "@/server/internal/p1-isolated-runner/p1-release-execute";
import { PRISMA_VERSION } from "@/server/internal/p1-isolated-runner/contract";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";
import {
  PRODUCTION_APP_CONTAINER,
  PRODUCTION_DATABASE_NAME,
  PRODUCTION_DB_CONTAINER,
  PRODUCTION_DNS_ALIAS,
  PRODUCTION_NETWORK_NAME,
  PRODUCTION_POSTGRES_IMAGE,
  PRODUCTION_ROLE_NAME,
  PROPOSED_MIGRATOR_ROLE,
  testAppName,
  testDatabaseName,
  testDbName,
  testNetworkName,
  testRestoreName,
} from "@/server/internal/p1-production-adapter/contract";
import { containerFactFromInspect, resolveDockerSession, type DockerSession, type VolumeMount } from "@/server/internal/p1-production-adapter/docker-runtime";
import {
  executeProductionAdapter,
  productionSpawnIntentPath,
  type AdapterDependencies,
  type AdapterRequest,
} from "@/server/internal/p1-production-adapter/execute";
import type { MigratorPrivilegeReport } from "@/server/internal/p1-production-adapter/migrator-privilege";
import {
  canonicalJson,
  declarationFromFacts,
  dossierDigest,
  type ContainerFact,
  type TargetFacts,
} from "@/server/internal/p1-production-adapter/identity";
import { formatOperatorResult } from "@/server/internal/p1-production-adapter/operator";
import { RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";
import { executeTrustedRestore, isTrustedRestoreEvidence, type RestoreContainerFact } from "@/server/internal/p1-production-adapter/restore-controller";
import {
  loadPersistedReleaseBackup,
  publishReleaseBackup,
  type BackupIo,
  type RecoverySnapshot,
  type ReleaseBackupWitness,
} from "@/server/internal/p1-production-adapter/recovery";

const ATTEMPT = "0123456789abcdef";
const APPROVED_ONESHOT = `sha256:${"1".repeat(64)}`;
const OTHER_ONESHOT = `sha256:${"2".repeat(64)}`;
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

  it("does not spawn when the migrator credential or privileges are refused", () => {
    const world = readyApply("TEST_OWNED");
    const privileges = world.deps.readMigratorPrivileges;
    const credential = world.deps.readMigratorCredential;
    world.deps.readMigratorCredential = undefined;
    world.deps.readMigratorPrivileges = undefined;
    expect(executeProductionAdapter(world.request, world.deps)).toMatchObject({ code: "MIGRATOR_CREDENTIAL_MISSING", spawned: false });
    expect(world.spawns).toBe(0);
    fs.rmSync(world.deps.destinationRoot, { recursive: true, force: true });
    world.deps.readMigratorCredential = credential;
    world.deps.readMigratorPrivileges = privileges;

    const savedPassword = world.request.databasePassword;
    world.request = { ...world.request, databasePassword: "migrator-secret-value" };
    expect(executeProductionAdapter(world.request, world.deps)).toMatchObject({ code: "MIGRATOR_CREDENTIAL_MISMATCH", spawned: false });
    fs.rmSync(world.deps.destinationRoot, { recursive: true, force: true });
    world.request = { ...world.request, databasePassword: savedPassword };

    world.deps.readMigratorPrivileges = () => ({ ...acceptedPrivileges(), rolsuper: true });
    expect(executeProductionAdapter(world.request, world.deps)).toMatchObject({ code: "MIGRATOR_ROLE_REFUSED", spawned: false });
    fs.rmSync(world.deps.destinationRoot, { recursive: true, force: true });

    world.deps.readMigratorPrivileges = () => ({ ...acceptedPrivileges(), memberships: ["p1pa"] });
    expect(executeProductionAdapter(world.request, world.deps)).toMatchObject({ code: "MIGRATOR_MEMBERSHIP_REFUSED", spawned: false });
    fs.rmSync(world.deps.destinationRoot, { recursive: true, force: true });

    world.deps.readMigratorPrivileges = () => ({ ...acceptedPrivileges(), batchOwner: "p1pa" });
    expect(executeProductionAdapter(world.request, world.deps)).toMatchObject({ code: "MIGRATOR_OWNERSHIP_REFUSED", spawned: false });
    fs.rmSync(world.deps.destinationRoot, { recursive: true, force: true });

    world.deps.readMigratorPrivileges = () => ({
      ...acceptedPrivileges(),
      otherLogin: [{ name: "p1pa_app", schemaCreate: true, memberOfMigrator: false, superuser: false }],
    });
    expect(executeProductionAdapter(world.request, world.deps)).toMatchObject({ code: "MIGRATOR_PRIVILEGE_REFUSED", spawned: false });
    fs.rmSync(world.deps.destinationRoot, { recursive: true, force: true });

    let reads = 0;
    world.deps.readMigratorPrivileges = () => {
      reads += 1;
      return reads === 1 ? acceptedPrivileges() : { ...acceptedPrivileges(), schemaCreate: false };
    };
    expect(executeProductionAdapter(world.request, world.deps)).toMatchObject({ code: "MIGRATOR_PRIVILEGE_DRIFT", spawned: false });
    expect(world.spawns).toBe(0);
    expect(fs.existsSync(world.replayDir) && fs.readdirSync(world.replayDir).length > 0).toBe(false);
  }, 90_000);

  it("puts only the migrator role in the one-shot secret", () => {
    const world = readyApply("TEST_OWNED");
    let secret = "";
    world.deps.spawnOneShot = (plan) => {
      world.spawns += 1;
      world.argv = [...plan.argv];
      secret = fs.readFileSync(path.join(path.dirname(world.deps.destinationRoot), "p1-production-credentials", "database.env"), "utf8");
      return { status: 0, signal: null };
    };
    expect(executeProductionAdapter(world.request, world.deps).spawned).toBe(true);
    expect(secret).toContain("stell22_migrator");
    expect(secret).not.toContain(world.password);
    expect(world.argv.join("\n")).not.toContain("migrator-secret-value");
    expect(world.argv.join("\n")).not.toContain(world.password);
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
    expect(executeProductionAdapter(incomplete.request, incomplete.deps).code).toBe("CHECKSUM_DRIFT");

    const mismatch = worldFor("TEST_OWNED");
    mismatch.request.intent = "RECOVERY";
    mismatch.deps.readRestoredCatalog = () => ({
      ...mismatch.snapshot,
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

    const durable = fs.mkdtempSync(path.join(os.tmpdir(), "p1pa-backup-once-"));
    publishReleaseBackup(durable, Buffer.from("archive-bytes"), {
      attemptId: ATTEMPT,
      container: facts.db,
      databaseName: facts.databaseName,
      roleName: facts.roleName,
    });
    expect(() =>
      publishReleaseBackup(durable, Buffer.from("archive-bytes"), {
        attemptId: ATTEMPT,
        container: facts.db,
        databaseName: facts.databaseName,
        roleName: facts.roleName,
      }),
    ).toThrow(RunnerRefusal);
  });

  it("stops when the lock is lost and does not retry an ambiguous Prisma result", () => {
    const lost = readyApply("TEST_OWNED");
    lost.deps.readLockOwner = () => null;
    expect(executeProductionAdapter(lost.request, lost.deps)).toMatchObject({ code: "LOST_LOCK", spawned: false });
    expect(lost.spawns).toBe(0);
    expect(fs.existsSync(lost.replayDir)).toBe(false);

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
    expect(fs.existsSync(productionSpawnIntentPath(world.deps.destinationRoot))).toBe(false);
  }, 30_000);

  it("leaves a spawn intent when the process stops after authorization and before spawn", () => {
    const world = readyApply("TEST_OWNED");
    world.deps.abortBeforeSpawn = true;
    const first = executeProductionAdapter(world.request, world.deps);
    expect(first).toMatchObject({ verdict: "BLOCKED", code: "SPAWN_INTENT_UNCERTAIN", spawned: false, retryAttempted: false });
    expect(fs.readdirSync(world.replayDir).length).toBeGreaterThan(0);
    expect(fs.existsSync(productionSpawnIntentPath(world.deps.destinationRoot))).toBe(true);
    const second = executeProductionAdapter(world.request, world.deps);
    expect(second).toMatchObject({ verdict: "BLOCKED", code: "SPAWN_INTENT_UNCERTAIN", spawned: false });
    expect(world.spawns).toBe(0);
  }, 30_000);

  it("keeps the spawn intent when spawn throws and refuses a second migration", () => {
    const world = readyApply("TEST_OWNED");
    world.deps.spawnOneShot = () => {
      world.spawns += 1;
      throw new Error("killed after spawn");
    };
    const first = executeProductionAdapter(world.request, world.deps);
    expect(first).toMatchObject({ verdict: "BLOCKED", code: "AMBIGUOUS_COMPLETION", spawned: true, retryAttempted: false });
    expect(fs.existsSync(productionSpawnIntentPath(world.deps.destinationRoot))).toBe(true);
    const second = executeProductionAdapter(world.request, world.deps);
    expect(second).toMatchObject({ verdict: "BLOCKED", code: "AMBIGUOUS_COMPLETION", spawned: false });
    expect(world.spawns).toBe(1);
  }, 30_000);

  it("does not leave an intent marker when authorization is rejected", () => {
    const world = readyApply("TEST_OWNED");
    world.request.authorization = { kind: "not-an-owner-signature" };
    const rejected = executeProductionAdapter(world.request, world.deps);
    expect(rejected.spawned).toBe(false);
    expect(rejected.code).not.toBe("SPAWN_INTENT_UNCERTAIN");
    expect(rejected.code).not.toBe("AMBIGUOUS_COMPLETION");
    expect(fs.existsSync(productionSpawnIntentPath(world.deps.destinationRoot))).toBe(false);
    expect(world.spawns).toBe(0);
  }, 30_000);

  it("does not delete a foreign production credential directory or a symlink to one", () => {
    const occupied = readyApply("TEST_OWNED");
    const directory = path.join(path.dirname(occupied.deps.destinationRoot), "p1-production-credentials");
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "sentinel"), "keep");
    const blocked = executeProductionAdapter(occupied.request, occupied.deps);
    expect(blocked.code).toBe("SECRET_DIRECTORY_COLLISION");
    expect(fs.readFileSync(path.join(directory, "sentinel"), "utf8")).toBe("keep");
    expect(occupied.spawns).toBe(0);

    const linked = readyApply("TEST_OWNED");
    const target = path.join(path.dirname(linked.deps.destinationRoot), "foreign-credential-target");
    const link = path.join(path.dirname(linked.deps.destinationRoot), "p1-production-credentials");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "sentinel"), "linked");
    fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    const refused = executeProductionAdapter(linked.request, linked.deps);
    expect(refused.code).toBe("SECRET_DIRECTORY_COLLISION");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(target, "sentinel"), "utf8")).toBe("linked");
    expect(linked.spawns).toBe(0);
  }, 30_000);

  it("reports credential cleanup failure and leaves a directory it no longer owns", () => {
    const world = readyApply("TEST_OWNED");
    let applied = false;
    world.deps.readHistory = () => (applied ? [...successfulHistoricalRows(), successfulP1Row()] : successfulHistoricalRows());
    world.deps.readSchema = () => (applied ? appliedSchema() : absentP1Schema());
    world.deps.spawnOneShot = () => {
      world.spawns += 1;
      applied = true;
      const directory = path.join(path.dirname(world.deps.destinationRoot), "p1-production-credentials");
      fs.writeFileSync(path.join(directory, "owner"), "other-run\n");
      fs.writeFileSync(path.join(directory, "sentinel"), "keep");
      return { status: 0, signal: null };
    };
    const result = executeProductionAdapter(world.request, world.deps);
    expect(result).toMatchObject({ verdict: "STOP", code: "SECRET_CLEANUP_FAILED", spawned: true });
    const directory = path.join(path.dirname(world.deps.destinationRoot), "p1-production-credentials");
    expect(fs.readFileSync(path.join(directory, "sentinel"), "utf8")).toBe("keep");
    expect(fs.existsSync(path.join(directory, "database.env"))).toBe(true);
  }, 30_000);

  it("does not delete a spawn intent that was replaced by another file with the same record", () => {
    const world = readyApply("TEST_OWNED");
    let applied = false;
    world.deps.readHistory = () => (applied ? [...successfulHistoricalRows(), successfulP1Row()] : successfulHistoricalRows());
    world.deps.readSchema = () => (applied ? appliedSchema() : absentP1Schema());
    const intent = productionSpawnIntentPath(world.deps.destinationRoot);
    let replaced = Buffer.alloc(0);
    world.deps.spawnOneShot = () => {
      world.spawns += 1;
      applied = true;
      replaced = fs.readFileSync(intent);
      fs.rmSync(intent);
      fs.writeFileSync(intent, replaced);
      return { status: 0, signal: null };
    };
    const result = executeProductionAdapter(world.request, world.deps);
    expect(result.verdict).not.toBe("ALREADY_APPLIED");
    expect(result.spawned).toBe(true);
    expect(fs.readFileSync(intent).equals(replaced)).toBe(true);
    expect(world.spawns).toBe(1);
  }, 30_000);

  it("does not apply production from a self-authored authorization object", () => {
    const world = worldFor("PRODUCTION");
    world.request.intent = "APPLY";
    world.request.authorization = {
      kind: "OWNER_AUTHORIZATION",
      scope: "PRODUCTION",
      decision: "AUTHORIZE_P1_ONLY_APPLY",
      attemptId: ATTEMPT,
      dossierSha256: "a".repeat(64),
      recoverySha256: "b".repeat(64),
      daemonId: world.facts.daemonId,
    };
    world.deps.testTrustPublicKey = "injected-test-key";
    expect(executeProductionAdapter(world.request, world.deps)).toMatchObject({
      code: "PRODUCTION_TRUST_UNPROVISIONED",
      spawned: false,
      targetClass: "PRODUCTION",
    });
    expect(world.spawns).toBe(0);

    const shortcut = worldFor("PRODUCTION");
    shortcut.request.authorization = { authorized: true };
    expect(executeProductionAdapter(shortcut.request, shortcut.deps).code).toBe("SHORTCUT_AUTHORIZATION");
    expect(shortcut.spawns).toBe(0);
  });

  it("rejects an unsigned object, a forged restore report, a shared volume, and a replayed signature", () => {
    const unsigned = readyApply("TEST_OWNED");
    unsigned.request.authorization = {
      kind: "OWNER_AUTHORIZATION",
      scope: "TEST_OWNED",
      decision: "AUTHORIZE_P1_ONLY_APPLY",
      attemptId: ATTEMPT,
      dossierSha256: "a".repeat(64),
      recoverySha256: "b".repeat(64),
      daemonId: DAEMON,
    };
    expect(executeProductionAdapter(unsigned.request, unsigned.deps).code).toBe("AUTHORIZATION_REQUIRED");
    expect(unsigned.spawns).toBe(0);

    expect(
      isTrustedRestoreEvidence({
        attemptId: ATTEMPT,
        archiveSha256: "a".repeat(64),
        restoreContainerId: "e".repeat(64),
        restoreImageId: DB_IMAGE,
        restoreExitCode: 0,
        recoverySha256: "b".repeat(64),
      }),
    ).toBe(false);

    const shared = worldFor("TEST_OWNED");
    shared.deps.inspectRestore = () => ({
      ...restoreFact(),
      mounts: [
        {
          type: "volume",
          name: "stell22_pgdata",
          source: "/var/lib/docker/volumes/stell22_pgdata/_data",
          destination: "/var/lib/postgresql/data",
        },
      ],
    });
    shared.request.intent = "RECOVERY";
    expect(executeProductionAdapter(shared.request, shared.deps).code).toBe("RESTORE_VOLUME_SHARED");

    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const replay = memoryReplayStore();
    const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const payload = signedPayload("TEST_OWNED", "c".repeat(64), "d".repeat(64), DAEMON);
    const signed = signPayload(privateKey, payload);
    verifySignedAuthorization(signed, pem, { scope: "TEST_OWNED", attemptId: ATTEMPT, dossierSha256: payload.dossierSha256, recoverySha256: payload.recoverySha256, daemonId: DAEMON }, replay);
    expect(() =>
      verifySignedAuthorization(signed, pem, { scope: "TEST_OWNED", attemptId: ATTEMPT, dossierSha256: payload.dossierSha256, recoverySha256: payload.recoverySha256, daemonId: DAEMON }, replay),
    ).toThrow(RunnerRefusal);
  }, 30_000);

  it("stops when the Docker endpoint or daemon identity changes before apply", () => {
    const endpoint = readyApply("TEST_OWNED");
    let calls = 0;
    endpoint.deps.resolveDockerSession = () => {
      calls += 1;
      const host = calls === 1 ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "npipe:////./pipe/docker_engine";
      return { endpoint: host, daemonId: DAEMON, env: { NODE_ENV: process.env.NODE_ENV, DOCKER_HOST: host, PATH: process.env.PATH } };
    };
    expect(executeProductionAdapter(endpoint.request, endpoint.deps)).toMatchObject({
      code: "DOCKER_ENDPOINT_CHANGED",
      spawned: false,
    });

    const daemon = readyApply("TEST_OWNED");
    let daemonCalls = 0;
    daemon.deps.resolveDockerSession = () => {
      daemonCalls += 1;
      return fakeSession(daemonCalls === 1 ? DAEMON : "daemon-changed-9");
    };
    expect(executeProductionAdapter(daemon.request, daemon.deps)).toMatchObject({
      code: "DAEMON_IDENTITY_CHANGED",
      spawned: false,
    });
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

  it("refuses CLI shortcuts and does not take a caller authorization path", () => {
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    expect(runProductionAdapterCli(["apply", "--authorize"], log)).toBe(2);
    expect(runProductionAdapterCli(["--database-url", "postgresql://stell22:secret@db/stell22"], log)).toBe(2);
    expect(runProductionAdapterCli(["preflight"], log)).toBe(2);
    expect(runProductionAdapterCli(["verify-recovery"], log)).toBe(2);
    expect(runProductionAdapterCli(["apply", "--authorization", "owner.json"], log)).toBe(2);
    expect(lines.some((line) => line.includes("code=SHORTCUT_AUTHORIZATION"))).toBe(true);
    expect(lines.some((line) => line.includes("code=ATTEMPT_REQUIRED"))).toBe(true);
    expect(lines.some((line) => line.includes("code=AUTHORIZATION_PATH_REJECTED"))).toBe(true);
    expect(lines.join("\n")).not.toContain("PRODUCTION_APPLY_NOT_WIRED_TO_THIS_CLI");
    expect(lines.join("\n")).not.toContain("DATABASE_URL=");
    const blocked: string[] = [];
    expect(runProductionAdapterCli(["apply", "--attempt", ATTEMPT], (line) => blocked.push(line))).toBe(2);
    expect(blocked.some((line) => line.includes(process.env.GITHUB_ACTIONS === "true" ? "code=PRODUCTION_SCOPE_FORBIDDEN_IN_CI" : "code=PRODUCTION_DAEMON_UNPINNED"))).toBe(true);
    expect(blocked.some((line) => line.includes("signingInputs=NOT_SIGNABLE") && line.includes("dossierSha256=UNAVAILABLE"))).toBe(true);
  });

  it("refuses a missing, null, or fabricated witness and does not mint one", () => {
    const missing = worldFor("TEST_OWNED");
    missing.request.intent = "RECOVERY";
    delete missing.request.recoveryWitness;
    expect(executeProductionAdapter(missing.request, missing.deps).code).toBe("BACKUP_EVIDENCE_INVALID");

    const absent = worldFor("TEST_OWNED");
    absent.request.intent = "RECOVERY";
    absent.request.recoveryWitness = null;
    expect(executeProductionAdapter(absent.request, absent.deps).code).toBe("BACKUP_EVIDENCE_INVALID");

    const fabricated = worldFor("TEST_OWNED");
    fabricated.request.intent = "RECOVERY";
    fabricated.request.recoveryWitness = { ...(fabricated.request.recoveryWitness as ReleaseBackupWitness), archiveSha256: "c".repeat(64) };
    expect(executeProductionAdapter(fabricated.request, fabricated.deps).code).toBe("BACKUP_EVIDENCE_INVALID");

    expect(() =>
      executeTrustedRestore({
        attemptId: ATTEMPT,
        archive: Buffer.from("archive-bytes"),
        source: testFacts().db,
        sourceMounts: sourceMounts(),
        databaseName: "db",
        roleName: "role",
        live: snapshotOf(),
        claimed: null,
        inspectRestore: () => restoreFact(),
        runRestore: () => 0,
        readRestored: () => snapshotOf(),
      }),
    ).toThrow(RunnerRefusal);
  });

  it("refuses the wrong attempt, an old archive, a changed checksum, and a witness that does not match the archive", () => {
    const wrong = worldFor("TEST_OWNED");
    wrong.request.intent = "RECOVERY";
    const other = "fedcba9876543210";
    const rewritten = { ...(wrong.request.recoveryWitness as ReleaseBackupWitness), attemptId: other };
    fs.writeFileSync(path.join(wrong.backupDirectory, "backup.witness.json"), `${canonicalJson(rewritten)}\n`);
    wrong.request.recoveryWitness = rewritten;
    expect(executeProductionAdapter(wrong.request, wrong.deps).code).toBe("HISTORICAL_BACKUP_NOT_SUFFICIENT");

    const oldArchive = worldFor("TEST_OWNED");
    oldArchive.request.intent = "RECOVERY";
    fs.writeFileSync(path.join(oldArchive.backupDirectory, "backup.sql.gz"), Buffer.from("different-archive-bytes"));
    expect(executeProductionAdapter(oldArchive.request, oldArchive.deps).code).toBe("CHECKSUM_DRIFT");

    const checksum = worldFor("TEST_OWNED");
    checksum.request.intent = "RECOVERY";
    fs.writeFileSync(path.join(checksum.backupDirectory, "backup.sql.gz.sha256"), `${"d".repeat(64)}\n`);
    expect(executeProductionAdapter(checksum.request, checksum.deps).code).toBe("CHECKSUM_DRIFT");

    const mismatched = worldFor("TEST_OWNED");
    mismatched.request.intent = "RECOVERY";
    const drifted = { ...(mismatched.request.recoveryWitness as ReleaseBackupWitness), archiveSha256: "e".repeat(64) };
    fs.writeFileSync(path.join(mismatched.backupDirectory, "backup.witness.json"), `${canonicalJson(drifted)}\n`);
    mismatched.request.recoveryWitness = drifted;
    expect(executeProductionAdapter(mismatched.request, mismatched.deps).code).toBe("CHECKSUM_DRIFT");
    expect(() => loadPersistedReleaseBackup(mismatched.backupDirectory)).toThrow(RunnerRefusal);
  });

  it("accepts an empty verified mount list and refuses a production bind or shared volume", () => {
    const empty = worldFor("TEST_OWNED");
    empty.request.intent = "RECOVERY";
    empty.deps.inspectRestore = () => ({ ...restoreFact(), mounts: [] });
    expect(executeProductionAdapter(empty.request, empty.deps).verdict).toBe("RECOVERY_VERIFIED");

    const bound = worldFor("TEST_OWNED");
    bound.request.intent = "RECOVERY";
    bound.deps.inspectRestore = () => ({
      ...restoreFact(),
      mounts: [{ type: "bind", name: null, source: "/root/Stell22", destination: "/var/lib/postgresql/data" }],
    });
    expect(executeProductionAdapter(bound.request, bound.deps).code).toBe("RESTORE_VOLUME_SHARED");
  });

  it("does not consume approval before the lock and rejects the same approval after restart", () => {
    const lost = readyApply("TEST_OWNED");
    lost.deps.readLockOwner = () => null;
    expect(executeProductionAdapter(lost.request, lost.deps).code).toBe("LOST_LOCK");
    expect(fs.existsSync(lost.replayDir)).toBe(false);
    lost.deps.readLockOwner = () => (fs.existsSync(lost.deps.lockPath) ? fs.readFileSync(lost.deps.lockPath, "utf8") : null);
    let applied = false;
    lost.deps.readHistory = () => (applied ? [...successfulHistoricalRows(), successfulP1Row()] : successfulHistoricalRows());
    lost.deps.readSchema = () => (applied ? appliedSchema() : absentP1Schema());
    lost.deps.spawnOneShot = (plan) => {
      lost.spawns += 1;
      lost.argv = plan.argv;
      applied = true;
      return { status: 0, signal: null };
    };
    expect(executeProductionAdapter(lost.request, lost.deps).code).toBe("P1_APPLIED");
    expect(fs.readdirSync(lost.replayDir)).toHaveLength(1);
    applied = false;
    lost.deps.destinationRoot = path.join(path.dirname(lost.deps.destinationRoot), "sealed-again");
    const replayed = executeProductionAdapter(lost.request, lost.deps);
    expect(replayed.code).toBe("AUTHORIZATION_REPLAY");
    expect(lost.spawns).toBe(1);

    const restarted = fileReplayStore(lost.replayDir);
    expect(() => restarted.consume(fs.readdirSync(lost.replayDir)[0] ?? "")).toThrow(RunnerRefusal);
  }, 30_000);

  it("binds the dossier to the approved one-shot image and spawns that image id", () => {
    const world = readyApply("TEST_OWNED");
    expect(world.request.authorization && typeof world.request.authorization === "object" ? (world.request.authorization as { payload: { dossierSha256: string } }).payload.dossierSha256 : "").toBe(
      dossierDigest(world.facts, APPROVED_ONESHOT),
    );
    expect(dossierDigest(world.facts, APPROVED_ONESHOT)).not.toBe(dossierDigest(world.facts, OTHER_ONESHOT));
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
      spawned: true,
      oneShotImageId: APPROVED_ONESHOT,
      signingInputs: "COMPLETE",
      recoveryEvidence: "VERIFIED",
    });
    expect(world.argv[world.argv.indexOf(ONE_SHOT_LAUNCHER) - 1]).toBe(APPROVED_ONESHOT);
    expect(world.argv).not.toContain(ONE_SHOT_IMAGE);
    expect(world.argv.join("\n")).not.toContain(world.password);
    expect(world.argv.join("\n")).not.toContain("DATABASE_URL=");
    const line = formatOperatorResult(result);
    expect(result.daemonId).toBe(world.facts.daemonId);
    expect(line).toContain(`daemonId=${world.facts.daemonId}`);
    expect(line).toContain(`attempt=${ATTEMPT}`);
    expect(line).toContain(`dossierSha256=${result.dossierSha256}`);
    expect(line).toContain(`recoverySha256=${result.recoverySha256}`);
    expect(line).toContain(`oneShotImageId=${APPROVED_ONESHOT}`);
    expect(line).toContain("recoveryEvidence=VERIFIED");
    expect(line).toContain("signingInputs=COMPLETE");
    expect(line).not.toContain(world.password);
    expect(line).not.toContain("DATABASE_URL");
    expect(line).not.toMatch(/postgres(?:ql)?:\/\//i);
  }, 30_000);

  it("does not consume approval, write an ambiguous marker, or spawn when the one-shot image is missing or wrong", () => {
    const missing = readyApply("TEST_OWNED");
    missing.deps.inspectOneShotImage = () => {
      throw refusal("STOP", "ONESHOT_IMAGE_MISSING", "One-shot image is not present on the local daemon");
    };
    const missingResult = executeProductionAdapter(missing.request, missing.deps);
    expect(missingResult).toMatchObject({ verdict: "STOP", code: "ONESHOT_IMAGE_MISSING", spawned: false, retryAttempted: false });
    expect(missing.spawns).toBe(0);
    expect(fs.existsSync(missing.replayDir) && fs.readdirSync(missing.replayDir).length > 0).toBe(false);
    expect(fs.existsSync(ambiguousMarker(missing.deps.destinationRoot))).toBe(false);

    const malformed = readyApply("TEST_OWNED");
    malformed.deps.inspectOneShotImage = () => ({ tagId: "a".repeat(40), idInspect: "a".repeat(40) });
    expect(executeProductionAdapter(malformed.request, malformed.deps)).toMatchObject({
      code: "ONESHOT_IMAGE_MALFORMED",
      spawned: false,
    });
    expect(malformed.spawns).toBe(0);
    expect(fs.existsSync(ambiguousMarker(malformed.deps.destinationRoot))).toBe(false);

    const wrong = readyApply("TEST_OWNED");
    wrong.deps.inspectOneShotImage = () => ({ tagId: OTHER_ONESHOT, idInspect: OTHER_ONESHOT });
    expect(executeProductionAdapter(wrong.request, wrong.deps)).toMatchObject({ code: "ONESHOT_IMAGE_UNAPPROVED", spawned: false });
    expect(wrong.spawns).toBe(0);
    expect(fs.existsSync(wrong.replayDir) && fs.readdirSync(wrong.replayDir).length > 0).toBe(false);

    const unpinned = worldFor("PRODUCTION");
    unpinned.deps.productionOneShotImagePin = null;
    unpinned.request.intent = "APPLY";
    expect(executeProductionAdapter(unpinned.request, unpinned.deps)).toMatchObject({
      code: "ONESHOT_IMAGE_UNPINNED",
      spawned: false,
    });
  }, 30_000);

  it("stops before spawn when the one-shot tag changes after the dossier was bound", () => {
    const changed = readyApply("TEST_OWNED");
    let reads = 0;
    changed.deps.inspectOneShotImage = () => {
      reads += 1;
      const id = reads === 1 ? APPROVED_ONESHOT : OTHER_ONESHOT;
      return { tagId: id, idInspect: id };
    };
    expect(executeProductionAdapter(changed.request, changed.deps)).toMatchObject({
      code: "ONESHOT_IMAGE_CHANGED",
      spawned: false,
      retryAttempted: false,
    });
    expect(changed.spawns).toBe(0);
    expect(fs.existsSync(changed.replayDir) && fs.readdirSync(changed.replayDir).length > 0).toBe(false);
    expect(fs.existsSync(ambiguousMarker(changed.deps.destinationRoot))).toBe(false);

    const split = readyApply("TEST_OWNED");
    split.deps.inspectOneShotImage = () => ({ tagId: APPROVED_ONESHOT, idInspect: OTHER_ONESHOT });
    expect(executeProductionAdapter(split.request, split.deps)).toMatchObject({ code: "ONESHOT_IMAGE_CHANGED", spawned: false });
    expect(split.spawns).toBe(0);
  }, 30_000);

  it("prints unavailable digests as unavailable and keeps a preflight dossier incomplete", () => {
    const preflight = worldFor("TEST_OWNED");
    const result = executeProductionAdapter(preflight.request, preflight.deps);
    expect(result).toMatchObject({
      verdict: "PREFLIGHT_ONLY",
      attemptId: ATTEMPT,
      oneShotImageId: APPROVED_ONESHOT,
      recoveryEvidence: "NONE",
      signingInputs: "INCOMPLETE",
    });
    expect(result.dossierSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.recoverySha256).toBeNull();
    const line = formatOperatorResult(result);
    expect(line).toBe(
      [
        "verdict=PREFLIGHT_ONLY",
        "code=PREFLIGHT_RECORDED",
        "phase=READ_ONLY_PREFLIGHT",
        `attempt=${ATTEMPT}`,
        `daemonId=${result.daemonId}`,
        "imageGitSha=UNVERIFIED",
        `oneShotImageId=${APPROVED_ONESHOT}`,
        `dossierSha256=${result.dossierSha256}`,
        "recoverySha256=UNAVAILABLE",
        "recoveryEvidence=NONE",
        "signingInputs=INCOMPLETE",
        "spawned=false",
        "retryAttempted=false",
        "targetClass=TEST_OWNED_NOT_PRODUCTION",
      ].join(" "),
    );
    const hidden = formatOperatorResult({
      ...result,
      recoverySha256: "b".repeat(64),
      signingInputs: "COMPLETE",
      recoveryEvidence: "NONE",
    });
    expect(hidden).toContain("recoverySha256=UNAVAILABLE");
    expect(hidden).toContain("signingInputs=INCOMPLETE");
    expect(hidden).not.toContain("b".repeat(64));

    const lines: string[] = [];
    expect(runProductionAdapterCli(["preflight", "--attempt", ATTEMPT], (line) => lines.push(line))).toBe(2);
    const stopped = lines[0] ?? "";
    const earlyCode = process.env.GITHUB_ACTIONS === "true" ? "PRODUCTION_SCOPE_FORBIDDEN_IN_CI" : "PRODUCTION_DAEMON_UNPINNED";
    expect(stopped).toContain(`code=${earlyCode}`);
    expect(stopped).toContain("dossierSha256=UNAVAILABLE");
    expect(stopped).toContain("recoverySha256=UNAVAILABLE");
    expect(stopped).toContain("oneShotImageId=UNAVAILABLE");
    expect(stopped).toContain("signingInputs=NOT_SIGNABLE");
    expect(stopped).toContain("recoveryEvidence=NONE");
    expect(stopped).not.toMatch(/dossierSha256=[0-9a-f]{64}/);
    expect(lines.join("\n")).not.toContain("DATABASE_URL");
    expect(lines.join("\n")).not.toMatch(/postgres(?:ql)?:\/\//i);
  });

  it("pins the one-shot image recipe to a digest, a lockfile, and prisma 6.19.3", () => {
    const recipeDir = path.join(process.cwd(), "docker/p1-oneshot");
    const recipe = fs.readFileSync(path.join(recipeDir, "Dockerfile"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(recipeDir, "package.json"), "utf8")) as { dependencies?: { prisma?: string } };
    const lock = JSON.parse(fs.readFileSync(path.join(recipeDir, "package-lock.json"), "utf8")) as {
      packages?: Record<string, { version?: string; integrity?: string }>;
    };
    expect(recipe).toContain(`FROM ${ONE_SHOT_BASE_IMAGE}@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`);
    expect(recipe).toContain("npm ci --omit=dev");
    expect(recipe).toContain("openssl=3.0.22-1~deb12u1");
    expect(recipe).toContain("snapshot.debian.org/archive/debian-security/20261005T020725Z");
    expect(recipe).not.toMatch(/npm install/i);
    expect(recipe).not.toMatch(/:latest/i);
    expect(recipe).not.toMatch(/\bpull\b/i);
    expect(manifest.dependencies?.prisma).toBe(PRISMA_VERSION);
    const locked = lock.packages?.["node_modules/prisma"];
    expect(locked?.version).toBe(PRISMA_VERSION);
    expect(locked?.integrity).toMatch(/^sha512-/);
    expect(ONE_SHOT_IMAGE).toBe("stell22-p1-oneshot:node22");
  });
});

type World = {
  facts: TargetFacts;
  request: AdapterRequest;
  deps: AdapterDependencies;
  archive: Buffer;
  snapshot: RecoverySnapshot;
  password: string;
  backupDirectory: string;
  replayDir: string;
  spawns: number;
  argv: readonly string[];
};

function worldFor(scope: "TEST_OWNED" | "PRODUCTION"): World {
  const facts = scope === "TEST_OWNED" ? testFacts() : productionFacts();
  const snapshot = snapshotOf();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p1pa-unit-"));
  const backupDirectory = path.join(directory, "backup");
  const replayDir = path.join(directory, "replay");
  const archive = Buffer.from("gzip-archive-bytes");
  const witness = publishReleaseBackup(backupDirectory, archive, {
    attemptId: ATTEMPT,
    container: facts.db,
    databaseName: facts.databaseName,
    roleName: facts.roleName,
  });
  const spawns = { count: 0, argv: [] as string[] };
  const lockPath = path.join(directory, "adapter.lock");
  const deps: AdapterDependencies = {
    productionDaemonPin: scope === "PRODUCTION" ? facts.daemonId : null,
    git: createRepoGitSource(process.cwd()),
    destinationRoot: path.join(directory, "sealed"),
    lockPath,
    env: {},
    inspect: () => facts,
    readHistory: () => successfulHistoricalRows(),
    readSchema: () => absentP1Schema(),
    readArchive: () => archive,
    backupDirectory,
    readLiveRecovery: () => snapshot,
    inspectSourceMounts: () => sourceMounts(),
    inspectRestore: () => restoreFact(),
    runRestore: () => 0,
    readRestoredCatalog: () => snapshot,
    readLockOwner: () => (fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null),
    resolveDockerSession: scope === "TEST_OWNED" ? () => fakeSession(facts.daemonId) : undefined,
    replay: fileReplayStore(replayDir),
    productionOneShotImagePin: scope === "PRODUCTION" ? APPROVED_ONESHOT : null,
    approvedOneShotImageId: scope === "TEST_OWNED" ? APPROVED_ONESHOT : null,
    inspectOneShotImage: () => ({ tagId: APPROVED_ONESHOT, idInspect: APPROVED_ONESHOT }),
    spawnOneShot: (plan) => {
      spawns.count += 1;
      spawns.argv = [...plan.argv];
      return { status: 0, signal: null };
    },
    readMigratorCredential: (databaseName) => ({
      role: PROPOSED_MIGRATOR_ROLE,
      database: databaseName,
      password: "migrator-secret-value",
    }),
    readMigratorPrivileges: () => acceptedPrivileges(),
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
    backupDirectory,
    replayDir,
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
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  world.deps.testTrustPublicKey = publicKey.export({ type: "spki", format: "pem" }).toString();
  const payload = signedPayload(scope, recovery.dossierSha256 ?? "", recovery.recoverySha256 ?? "", world.facts.daemonId);
  world.request = {
    ...world.request,
    intent: "APPLY",
    authorization: signPayload(privateKey, payload),
  };
  return world;
}

function signedPayload(scope: "TEST_OWNED" | "PRODUCTION", dossierSha256: string, recoverySha256: string, daemonId: string) {
  const now = Date.now();
  return {
    kind: "OWNER_SIGNED_AUTHORIZATION" as const,
    operation: "P1_ONLY_APPLY" as const,
    decision: "AUTHORIZE_P1_ONLY_APPLY" as const,
    scope,
    attemptId: ATTEMPT,
    dossierSha256,
    recoverySha256,
    daemonId,
    nonce: "ab".repeat(16),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 60 * 60_000).toISOString(),
  };
}

function signPayload(privateKey: KeyObject, payload: ReturnType<typeof signedPayload>) {
  return {
    payload,
    signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64"),
  };
}

function ambiguousMarker(destinationRoot: string): string {
  return path.join(path.dirname(destinationRoot), `${path.basename(destinationRoot)}.production-adapter-ambiguous-stop`);
}

function acceptedPrivileges(): MigratorPrivilegeReport {
  return {
    currentUser: PROPOSED_MIGRATOR_ROLE,
    sessionUser: PROPOSED_MIGRATOR_ROLE,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    rolcanlogin: true,
    rolinherit: false,
    memberships: [],
    batchOwner: PROPOSED_MIGRATOR_ROLE,
    migrationInsert: true,
    migrationUpdate: true,
    schemaCreate: true,
    publicCreate: false,
    otherLogin: [{ name: "p1pa_app", schemaCreate: false, memberOfMigrator: false, superuser: false }],
  };
}

function fakeSession(daemonId: string): DockerSession {
  const endpoint = "npipe:////./pipe/dockerDesktopLinuxEngine";
  return { endpoint, daemonId, env: { NODE_ENV: process.env.NODE_ENV, DOCKER_HOST: endpoint, PATH: process.env.PATH } };
}

function sourceMounts(): VolumeMount[] {
  return [
    {
      type: "volume",
      name: "source-data",
      source: "/var/lib/docker/volumes/source-data/_data",
      destination: "/var/lib/postgresql/data",
    },
  ];
}

function restoreFact(): RestoreContainerFact {
  return {
    ...container(testRestoreName(ATTEMPT), "e".repeat(64), DB_IMAGE, "postgres:17-alpine", `p1pa-restore-net-${ATTEMPT}`, false),
    mounts: [
      {
        type: "volume",
        name: `p1pa-data-${ATTEMPT}`,
        source: `/var/lib/docker/volumes/p1pa-data-${ATTEMPT}/_data`,
        destination: "/var/lib/postgresql/data",
      },
    ],
  };
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
  facts.daemonId = resolveDockerSession({}).daemonId;
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

