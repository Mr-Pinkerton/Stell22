import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { EXPECTED_HISTORICAL_MIGRATION_COUNT, EXPECTED_MIGRATION_SQL_COUNT, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { materializeHistorical } from "@/server/internal/p1-isolated-runner/disposable-migration-harness";
import { createRepoGitSource } from "@/server/internal/p1-isolated-runner/git-source";
import { attachReviewedImageToOperatorTag, buildReviewedOneShotImage, releaseOwnedOperatorTag } from "@/server/internal/p1-isolated-runner/oneshot-recipe-build";
import { ONE_SHOT_BASE_IMAGE, ONE_SHOT_IMAGE } from "@/server/internal/p1-isolated-runner/p1-release-gate";
import {
  checkMatchesContract,
  columnMatchesContract,
  functionMatchesContract,
  triggerMatchesContract,
} from "@/server/internal/p1-isolated-runner/schema-contract";
import { classifyP1State } from "@/server/internal/p1-isolated-runner/classify";
import {
  PRODUCTION_APP_CONTAINER,
  PRODUCTION_DB_CONTAINER,
  testAppName,
  testDatabaseName,
  testDbName,
  testNetworkName,
  testRestoreName,
} from "@/server/internal/p1-production-adapter/contract";
import { dumpDatabase, inspectContainer, inspectMounts, readCatalog, readDaemonId, restoreArchive } from "@/server/internal/p1-production-adapter/docker-runtime";
import { fileReplayStore } from "@/server/internal/p1-production-adapter/authorization";
import { executeProductionAdapter, type AdapterDependencies } from "@/server/internal/p1-production-adapter/execute";
import { canonicalJson, declarationFromFacts, type TargetFacts } from "@/server/internal/p1-production-adapter/identity";
import type { RestoreContainerFact } from "@/server/internal/p1-production-adapter/restore-controller";
import { planProductionOneShot } from "@/server/internal/p1-production-adapter/oneshot";
import { assertIndependentRestore, publishReleaseBackup } from "@/server/internal/p1-production-adapter/recovery";

const LIVE_FLAG = "P1_DISPOSABLE_LIVE";

describe.skipIf(process.env[LIVE_FLAG] !== "1")("test-owned production-shaped P1 adapter", () => {
  afterAll(() => {
    releaseOwnedOperatorTag();
  });
  it(
    "backs up, restores, and applies pinned P1 without calling the database production",
    () => {
      const attemptId = randomBytes(8).toString("hex");
      const password = randomBytes(16).toString("hex");
      const networkName = testNetworkName(attemptId);
      const appName = testAppName(attemptId);
      const dbName = testDbName(attemptId);
      const restoreName = testRestoreName(attemptId);
      const databaseName = testDatabaseName(attemptId);
      const imageTag = `p1pa-app:${attemptId}`;
      const runtime = fs.mkdtempSync(path.join(process.cwd(), ".p1-production-adapter-"));
      let failure: unknown;
      let appStarted = false;
      let dbStarted = false;
      let restoreStarted = false;
      let networkStarted = false;
      let restoreNetworkStarted = false;
      try {
        ensureImages();
        docker(["network", "create", networkName]);
        networkStarted = true;
        docker(["network", "create", `${networkName}-restore`]);
        restoreNetworkStarted = true;
        docker([
          "run", "-d", "--pull", "never", "--name", dbName, "--network", networkName, "--network-alias", "db",
          "--restart", "no",
          "-e", "POSTGRES_USER=p1pa", "-e", `POSTGRES_PASSWORD=${password}`, "-e", `POSTGRES_DB=${databaseName}`,
          "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256", "postgres:17-alpine",
        ]);
        dbStarted = true;
        waitReady(dbName, databaseName);
        const context = path.join(runtime, "image");
        fs.mkdirSync(context);
        fs.writeFileSync(path.join(context, "health.js"), 'const http=require("http");http.createServer((q,s)=>{s.end("ok")}).listen(3000,"0.0.0.0");\n');
        fs.writeFileSync(path.join(context, "Dockerfile"), `FROM ${ONE_SHOT_BASE_IMAGE}\nWORKDIR /app\nCOPY health.js .\nENTRYPOINT ["node","/app/health.js"]\n`);
        docker(["build", "-t", imageTag, context]);
        docker(["run", "-d", "--pull", "never", "--name", appName, "--network", networkName, "--restart", "no", imageTag]);
        appStarted = true;

        const historicalRoot = path.join(runtime, "historical");
        materializeHistorical(historicalRoot);
        const historicalPlan = planProductionOneShot({
          networkName,
          dnsAlias: "db",
          databaseName,
          roleName: "p1pa",
          password,
          sealedRoot: historicalRoot,
          credentialDir: path.join(runtime, "historical-credentials"),
          appContainerId: inspectContainer(appName).id,
          appContainerName: appName,
          dbContainerName: dbName,
          imageId: oneShotImageId(),
        });
        const historical = spawnSync("docker", [...historicalPlan.argv], { encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
        expect(historical.status, redact(`${historical.stdout}\n${historical.stderr}`)).toBe(0);
        execSql(dbName, databaseName, 'CREATE TABLE public.p1pa_release_probe (id integer PRIMARY KEY); INSERT INTO public.p1pa_release_probe (id) VALUES (1);');

        const daemonId = readDaemonId();
        const stale = observe(attemptId, daemonId, appName, dbName, databaseName);
        expect(stale.app.name).not.toBe(PRODUCTION_APP_CONTAINER);
        expect(stale.db.name).not.toBe(PRODUCTION_DB_CONTAINER);
        expect(stale.db.publishedDbPort).toBe(false);
        const wrong = executeProductionAdapter(
          { intent: "PREFLIGHT", scope: "TEST_OWNED", attemptId, declared: { ...declarationFromFacts(stale), appId: "f".repeat(64) }, databasePassword: password },
          dependencies(runtime, stale, () => Buffer.alloc(0), null, path.join(runtime, "unused-backup")),
        );
        expect(wrong).toMatchObject({ code: "RUNTIME_IDENTITY_MISMATCH", spawned: false, targetClass: "TEST_OWNED_NOT_PRODUCTION" });

        docker(["restart", dbName]);
        waitReady(dbName, databaseName);
        const restarted = executeProductionAdapter(
          { intent: "PREFLIGHT", scope: "TEST_OWNED", attemptId, declared: declarationFromFacts(stale), databasePassword: password },
          dependencies(runtime, stale, () => Buffer.alloc(0), null, path.join(runtime, "unused-backup")),
        );
        expect(restarted.code).toBe("RUNTIME_IDENTITY_MISMATCH");

        const live = observe(attemptId, daemonId, appName, dbName, databaseName);
        const incomplete = executeProductionAdapter(
          {
            intent: "RECOVERY",
            scope: "TEST_OWNED",
            attemptId,
            declared: declarationFromFacts(live),
            databasePassword: password,
            recoveryWitness: {
              kind: "RELEASE_BACKUP",
              createdForRelease: true,
              creator: "p1-production-adapter",
              attemptId,
              archiveSha256: "a".repeat(64),
              archiveByteLength: 4,
              sourceContainerId: live.db.id,
              sourceImageId: live.db.imageId,
              sourceStartedAt: live.db.startedAt,
              databaseName,
              roleName: "p1pa",
            },
          },
          dependencies(path.join(runtime, "incomplete"), live, () => Buffer.from("tiny"), null, path.join(runtime, "missing-backup")),
        );
        expect(incomplete.code).toBe("BACKUP_EVIDENCE_INVALID");

        const archive = zlib.gzipSync(dumpDatabase(inspectContainer(dbName).id, "p1pa", databaseName));
        const witness = publishReleaseBackup(path.join(runtime, "backup"), archive, {
          attemptId,
          container: live.db,
          databaseName,
          roleName: "p1pa",
        });
        expect(witness.archiveSha256).toHaveLength(64);
        const reread = fs.readFileSync(path.join(runtime, "backup", "backup.sql.gz"));
        expect(reread.equals(archive)).toBe(true);

        startRestore(restoreName, `${networkName}-restore`, databaseName, password);
        restoreStarted = true;
        assertIndependentRestore(live.db, inspectContainer(restoreName), attemptId);
        const backupDirectory = path.join(runtime, "backup");
        const mismatchDeps = dependencies(path.join(runtime, "mismatch"), live, () => fs.readFileSync(path.join(backupDirectory, "backup.sql.gz")), restoreName, backupDirectory);
        const restoreOnly = mismatchDeps.runRestore;
        mismatchDeps.runRestore = (id, sql) => {
          const status = restoreOnly(id, sql);
          execSql(restoreName, databaseName, "INSERT INTO public.p1pa_release_probe (id) VALUES (2);");
          return status;
        };
        const mismatch = executeProductionAdapter(recoveryRequest(attemptId, password, live, witness), mismatchDeps);
        expect(mismatch.code).toBe("RESTORE_MISMATCH");
        spawnSync("docker", ["rm", "-f", restoreName], { windowsHide: true });
        startRestore(restoreName, `${networkName}-restore`, databaseName, password);
        const beforeCatalog = liveCatalog(dbName, databaseName);
        expect(beforeCatalog.recovery.successfulMigrationCount).toBe(EXPECTED_HISTORICAL_MIGRATION_COUNT);
        const appBefore = inspectContainer(appName);
        let detail = "";
        let spawns = 0;
        const recovery = executeProductionAdapter(
          recoveryRequest(attemptId, password, live, witness),
          dependencies(path.join(runtime, "recovery"), live, () => fs.readFileSync(path.join(backupDirectory, "backup.sql.gz")), restoreName, backupDirectory),
        );
        expect(recovery.verdict).toBe("RECOVERY_VERIFIED");
        spawnSync("docker", ["rm", "-f", restoreName], { windowsHide: true });
        startRestore(restoreName, `${networkName}-restore`, databaseName, password);
        const { publicKey, privateKey } = generateKeyPairSync("ed25519");
        const applied = executeProductionAdapter(
          {
            intent: "APPLY",
            scope: "TEST_OWNED",
            attemptId,
            declared: declarationFromFacts(live),
            databasePassword: password,
            recoveryWitness: witness,
            authorization: signLive(privateKey, {
              dossierSha256: recovery.dossierSha256 ?? "",
              recoverySha256: recovery.recoverySha256 ?? "",
              attemptId,
              daemonId,
            }),
          },
          {
            ...dependencies(path.join(runtime, "apply"), live, () => fs.readFileSync(path.join(backupDirectory, "backup.sql.gz")), restoreName, backupDirectory),
            testTrustPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
            spawnOneShot: (plan) => {
              spawns += 1;
              const child = spawnSync("docker", [...plan.argv], {
                encoding: "utf8",
                windowsHide: true,
                timeout: 180_000,
                maxBuffer: 8 * 1024 * 1024,
                env: plan.env,
              });
              detail = redact(`${child.stdout}\n${child.stderr}`);
              return { status: child.status, signal: child.signal };
            },
          },
        );
        expect(applied, detail).toMatchObject({
          verdict: "ALREADY_APPLIED",
          code: "P1_APPLIED",
          spawned: true,
          retryAttempted: false,
          imageGitSha: "UNVERIFIED",
          targetClass: "TEST_OWNED_NOT_PRODUCTION",
          appUnchanged: true,
        });
        expect(spawns).toBe(1);
        const appAfter = inspectContainer(appName);
        expect(appAfter.id).toBe(appBefore.id);
        expect(appAfter.imageId).toBe(appBefore.imageId);
        expect(appAfter.startedAt).toBe(appBefore.startedAt);
        expect(appAfter.entrypoint.join(" ")).toBe("node /app/health.js");
        const after = liveCatalog(dbName, databaseName);
        expect(after.history).toHaveLength(EXPECTED_MIGRATION_SQL_COUNT);
        expect(after.recovery.successfulMigrationCount).toBe(EXPECTED_MIGRATION_SQL_COUNT);
        expect(after.history.find((row) => row.migrationName.endsWith("batch_receipt_provenance"))?.checksum).toBe(P1_SHA256);
        expect(classifyP1State({ history: after.history, schema: after.schema })).toMatchObject({ verdict: "ALREADY_APPLIED", code: "P1_APPLIED" });
        expect(columnMatchesContract(requirePart(after.schema.column))).toBe(true);
        expect(checkMatchesContract(requirePart(after.schema.check))).toBe(true);
        expect(functionMatchesContract(requirePart(after.schema.functionDef))).toBe(true);
        expect(triggerMatchesContract(requirePart(after.schema.trigger))).toBe(true);
        const repeat = executeProductionAdapter(
          { intent: "APPLY", scope: "TEST_OWNED", attemptId, declared: declarationFromFacts(live), databasePassword: password, recoveryWitness: "RESTORE_VERIFIED" },
          dependencies(path.join(runtime, "repeat"), live, () => { throw new Error("repeat must not read the archive"); }, null, backupDirectory),
        );
        expect(repeat.spawned).toBe(false);
        expect(repeat.code).toBe("P1_APPLIED");
      } catch (error) {
        failure = error;
      } finally {
        if (appStarted) spawnSync("docker", ["rm", "-f", appName], { windowsHide: true });
        if (dbStarted) spawnSync("docker", ["rm", "-f", dbName], { windowsHide: true });
        if (restoreStarted) spawnSync("docker", ["rm", "-f", restoreName], { windowsHide: true });
        spawnSync("docker", ["image", "rm", "-f", imageTag], { windowsHide: true });
        if (networkStarted) spawnSync("docker", ["network", "rm", networkName], { windowsHide: true });
        if (restoreNetworkStarted) spawnSync("docker", ["network", "rm", `${networkName}-restore`], { windowsHide: true });
        fs.rmSync(runtime, { recursive: true, force: true });
      }
      if (failure) throw failure;
    },
    600_000,
  );
});

function observe(attemptId: string, daemonId: string, appName: string, dbName: string, databaseName: string): TargetFacts {
  const catalog = liveCatalog(dbName, databaseName);
  const db = inspectContainer(dbName);
  return {
    scope: "TEST_OWNED",
    attemptId,
    daemonId,
    app: inspectContainer(appName),
    db,
    databaseName: catalog.session.databaseName,
    roleName: catalog.session.roleName,
    networkName: testNetworkName(attemptId),
    dnsAlias: "db",
    serverVersionNum: catalog.session.serverVersionNum,
  };
}

function liveCatalog(containerName: string, databaseName: string) {
  return readCatalog(inspectContainer(containerName).id, "p1pa", databaseName);
}

function recoveryRequest(attemptId: string, password: string, live: TargetFacts, witness: unknown) {
  return {
    intent: "RECOVERY" as const,
    scope: "TEST_OWNED" as const,
    attemptId,
    declared: declarationFromFacts(live),
    databasePassword: password,
    recoveryWitness: witness,
  };
}

function dependencies(
  root: string,
  live: TargetFacts,
  readArchive: () => Buffer,
  restoreName: string | null,
  backupDirectory: string,
): AdapterDependencies {
  const lockPath = path.join(root, "adapter.lock");
  const replayParent = path.join(root, "replay-parent");
  fs.mkdirSync(replayParent, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(replayParent, 0o700);
  return {
    productionDaemonPin: null,
    productionOneShotImagePin: null,
    approvedOneShotImageId: oneShotImageId(),
    inspectOneShotImage: () => {
      const id = oneShotImageId();
      return { tagId: id, idInspect: id };
    },
    git: createRepoGitSource(process.cwd()),
    destinationRoot: path.join(root, "sealed"),
    lockPath,
    env: {},
    inspect: () => observe(live.attemptId, live.daemonId, live.app.name, live.db.name, live.databaseName),
    readHistory: () => liveCatalog(live.db.name, live.databaseName).history,
    readSchema: () => liveCatalog(live.db.name, live.databaseName).schema,
    readArchive,
    backupDirectory,
    readLiveRecovery: () => liveCatalog(live.db.name, live.databaseName).recovery,
    inspectSourceMounts: () => inspectMounts(live.db.id),
    inspectRestore: () => {
      if (!restoreName) throw new Error("restore container is not part of this call");
      return restoreFact(restoreName);
    },
    runRestore: (id, sql) => restoreArchive(id, "p1pa", live.databaseName, sql),
    readRestoredCatalog: (id) => readCatalog(id, "p1pa", live.databaseName).recovery,
    readLockOwner: () => (fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8") : null),
    replay: fileReplayStore(path.join(replayParent, "replay")),
    spawnOneShot: () => {
      throw new Error("this dependency must be replaced before apply");
    },
  };
}

function restoreFact(name: string): RestoreContainerFact {
  return { ...inspectContainer(name), mounts: inspectMounts(name) };
}

function signLive(
  privateKey: KeyObject,
  binding: { dossierSha256: string; recoverySha256: string; attemptId: string; daemonId: string },
) {
  const now = Date.now();
  const payload = {
    kind: "OWNER_SIGNED_AUTHORIZATION" as const,
    operation: "P1_ONLY_APPLY" as const,
    decision: "AUTHORIZE_P1_ONLY_APPLY" as const,
    scope: "TEST_OWNED" as const,
    attemptId: binding.attemptId,
    dossierSha256: binding.dossierSha256,
    recoverySha256: binding.recoverySha256,
    daemonId: binding.daemonId,
    nonce: randomBytes(16).toString("hex"),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 60 * 60_000).toISOString(),
  };
  return { payload, signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64") };
}

function startRestore(name: string, network: string, databaseName: string, password: string): void {
  docker([
    "run", "-d", "--pull", "never", "--name", name, "--network", network, "--restart", "no",
    "-e", "POSTGRES_USER=p1pa", "-e", `POSTGRES_PASSWORD=${password}`, "-e", `POSTGRES_DB=${databaseName}`,
    "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256", "postgres:17-alpine",
  ]);
  waitReady(name, databaseName);
}

function waitReady(containerName: string, databaseName: string): void {
  let last = "no response";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const child = spawnSync(
      "docker",
      ["exec", containerName, "psql", "-U", "p1pa", "-d", databaseName, "-X", "-At", "-c", "SELECT 1"],
      { windowsHide: true, encoding: "utf8" },
    );
    if (child.status === 0 && child.stdout.includes("1")) return;
    last = `${child.status ?? "null"} ${(child.stderr || child.stdout || "").trim()}`.slice(0, 300);
    spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);"], { windowsHide: true });
  }
  throw new Error(`database ${containerName} did not become ready: ${last}`);
}

function execSql(containerName: string, databaseName: string, sql: string): void {
  const child = spawnSync("docker", ["exec", "-i", inspectContainer(containerName).id, "psql", "-U", "p1pa", "-d", databaseName, "-v", "ON_ERROR_STOP=1"], {
    input: sql,
    encoding: "utf8",
    windowsHide: true,
  });
  if (child.status !== 0) throw new Error(redact(`${child.stderr}`));
}

function docker(args: readonly string[]): string {
  const child = spawnSync("docker", [...args], { encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`${args[0] ?? "docker"} failed: ${redact(child.stderr || child.stdout).slice(0, 500)}`);
  return child.stdout.trim();
}

function ensureImages(): void {
  const postgres = spawnSync("docker", ["image", "inspect", "postgres:17-alpine"], { windowsHide: true });
  if (postgres.status !== 0) {
    const pulled = spawnSync("docker", ["pull", "postgres:17-alpine"], { windowsHide: true, timeout: 180_000 });
    if (pulled.status !== 0) throw new Error("postgres:17-alpine is unavailable");
  }
  const node = spawnSync("docker", ["image", "inspect", ONE_SHOT_BASE_IMAGE], { windowsHide: true });
  if (node.status !== 0) {
    const pulled = spawnSync("docker", ["pull", ONE_SHOT_BASE_IMAGE], { windowsHide: true, timeout: 180_000 });
    if (pulled.status !== 0) throw new Error(`${ONE_SHOT_BASE_IMAGE} is unavailable`);
  }
  const built = buildReviewedOneShotImage();
  try {
    attachReviewedImageToOperatorTag(built);
  } finally {
    built.remove();
  }
}

function oneShotImageId(): string {
  const id = docker(["image", "inspect", "--format", "{{.Id}}", ONE_SHOT_IMAGE]);
  if (!/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error("one-shot image id is not a Docker digest");
  return id;
}

function requirePart<T>(value: T | null): T {
  if (value === null) throw new Error("missing P1 object");
  return value;
}

function redact(value: string): string {
  return value.replace(/postgres(?:ql)?:\/\/\S+/gi, "[url]").slice(0, 1500);
}
