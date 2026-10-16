import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { EXPECTED_HISTORICAL_MIGRATION_COUNT, EXPECTED_MIGRATION_SQL_COUNT, P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { materializeHistorical } from "@/server/internal/p1-isolated-runner/disposable-migration-harness";
import { attachReviewedImageToOperatorTag, buildReviewedOneShotImage } from "@/server/internal/p1-isolated-runner/oneshot-recipe-build";
import { ONE_SHOT_BASE_IMAGE, ONE_SHOT_IMAGE } from "@/server/internal/p1-isolated-runner/p1-release-gate";
import {
  checkMatchesContract,
  columnMatchesContract,
  functionMatchesContract,
  triggerMatchesContract,
} from "@/server/internal/p1-isolated-runner/schema-contract";
import { PRODUCTION_POSTGRES_IMAGE, testAppName, testDatabaseName, testDbName, testNetworkName, testRestoreName } from "@/server/internal/p1-production-adapter/contract";
import { inspectContainer, readCatalog, readDaemonId } from "@/server/internal/p1-production-adapter/docker-runtime";
import type { AdapterResult } from "@/server/internal/p1-production-adapter/execute";
import { canonicalJson } from "@/server/internal/p1-production-adapter/identity";
import { planProductionOneShot } from "@/server/internal/p1-production-adapter/oneshot";
import { operatorAttemptRoot, runOperatorCommand, type OperatorDocker, type OperatorRequest } from "@/server/internal/p1-production-adapter/operator";

const LIVE_FLAG = "P1_DISPOSABLE_LIVE";

describe.skipIf(process.env[LIVE_FLAG] !== "1")("operator runtime on a test-owned topology", () => {
  it("preflight stays read-only, then recovery and one apply go through the operator", () => {
    const attemptId = randomBytes(8).toString("hex");
    const password = randomBytes(16).toString("hex");
    const networkName = testNetworkName(attemptId);
    const appName = testAppName(attemptId);
    const dbName = testDbName(attemptId);
    const databaseName = testDatabaseName(attemptId);
    const imageTag = `p1pa-operator:${attemptId}`;
    const workRoot = fs.mkdtempSync(path.join(process.cwd(), ".p1-operator-live-"));
    const attemptRoot = operatorAttemptRoot(workRoot, attemptId);
    let failure: unknown;
    const started = { network: false, app: false, db: false };
    try {
      ensureImages();
      docker(["network", "create", networkName]);
      started.network = true;
      docker([
        "run", "-d", "--pull", "never", "--name", dbName, "--network", networkName, "--network-alias", "db",
        "--restart", "no",
        "-e", "POSTGRES_USER=p1pa", "-e", `POSTGRES_PASSWORD=${password}`, "-e", `POSTGRES_DB=${databaseName}`,
        "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256", PRODUCTION_POSTGRES_IMAGE,
      ]);
      started.db = true;
      waitReady(dbName, databaseName);
      const context = path.join(workRoot, "image");
      fs.mkdirSync(context);
      fs.writeFileSync(path.join(context, "health.js"), 'const http=require("http");http.createServer((q,s)=>{s.end("ok")}).listen(3000,"0.0.0.0");\n');
      fs.writeFileSync(path.join(context, "Dockerfile"), `FROM ${ONE_SHOT_BASE_IMAGE}\nWORKDIR /app\nCOPY health.js .\nENTRYPOINT ["node","/app/health.js"]\n`);
      docker(["build", "-t", imageTag, context]);
      docker(["run", "-d", "--pull", "never", "--name", appName, "--network", networkName, "--restart", "no", imageTag]);
      started.app = true;
      const historicalRoot = path.join(workRoot, "historical");
      materializeHistorical(historicalRoot);
      const historicalPlan = planProductionOneShot({
        networkName,
        dnsAlias: "db",
        databaseName,
        roleName: "p1pa",
        password,
        sealedRoot: historicalRoot,
        credentialDir: path.join(workRoot, "historical-credentials"),
        appContainerId: inspectContainer(appName).id,
        appContainerName: appName,
        dbContainerName: dbName,
        imageId: oneShotImageId(),
      });
      const historical = spawnSync("docker", [...historicalPlan.argv], { encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
      expect(historical.status, redact(`${historical.stdout}\n${historical.stderr}`)).toBe(0);
      execSql(dbName, databaseName, "CREATE TABLE public.p1pa_release_probe (id integer PRIMARY KEY); INSERT INTO public.p1pa_release_probe (id) VALUES (1);");

      const before = inspectContainer(appName);
      const sentinel = path.join(workRoot, "preflight-sentinel");
      const sealedKeep = path.join(attemptRoot, "foreign-keep");
      fs.mkdirSync(attemptRoot, { recursive: true });
      fs.writeFileSync(sentinel, "unchanged");
      fs.writeFileSync(sealedKeep, "foreign-sealed");
      const preflight = runOperatorCommand(owned(attemptId, workRoot, "preflight"));
      expect(preflight).toMatchObject({
        verdict: "PREFLIGHT_ONLY",
        code: "PREFLIGHT_RECORDED",
        phase: "READ_ONLY_PREFLIGHT",
        spawned: false,
        imageGitSha: "UNVERIFIED",
        targetClass: "TEST_OWNED_NOT_PRODUCTION",
      });
      expect(fs.readFileSync(sentinel, "utf8")).toBe("unchanged");
      expect(fs.readFileSync(sealedKeep, "utf8")).toBe("foreign-sealed");
      expect(fs.existsSync(path.join(attemptRoot, "backup"))).toBe(false);
      expect(fs.existsSync(path.join(attemptRoot, "operator.lock"))).toBe(false);
      expect(readCatalog(inspectContainer(dbName).id, "p1pa", databaseName).recovery.successfulMigrationCount).toBe(EXPECTED_HISTORICAL_MIGRATION_COUNT);
      expect(appResponds(appName)).toBe(true);

      const restoreName = testRestoreName(attemptId);
      const restoreNetwork = `${testNetworkName(attemptId)}-restore`;
      docker(["run", "-d", "--pull", "never", "--name", restoreName, "--restart", "no", "--entrypoint", "sleep", PRODUCTION_POSTGRES_IMAGE, "300"]);
      const foreignContainer = runOperatorCommand(owned(attemptId, workRoot, "verify-recovery"));
      expect(foreignContainer).toMatchObject({ code: "DISPOSABLE_NAME_COLLISION", spawned: false });
      expect(spawnSync("docker", ["inspect", restoreName], { windowsHide: true }).status).toBe(0);
      expect(fs.existsSync(path.join(attemptRoot, "backup"))).toBe(false);
      spawnSync("docker", ["rm", "-f", restoreName], { windowsHide: true });
      docker(["network", "create", restoreNetwork]);
      const foreignNetwork = runOperatorCommand(owned(attemptId, workRoot, "verify-recovery"));
      expect(foreignNetwork).toMatchObject({ code: "DISPOSABLE_NAME_COLLISION", spawned: false });
      expect(spawnSync("docker", ["network", "inspect", restoreNetwork], { windowsHide: true }).status).toBe(0);
      expect(fs.readFileSync(sealedKeep, "utf8")).toBe("foreign-sealed");
      docker(["network", "rm", restoreNetwork]);

      const dockerArgs: string[][] = [];
      const concurrent: { result: AdapterResult | null } = { result: null };
      const recovery = runOperatorCommand({
        ...owned(attemptId, workRoot, "verify-recovery"),
        testDocker: recordingDocker(password, dockerArgs, (args) => {
          if (concurrent.result || args[0] !== "network" || args[1] !== "create") return;
          concurrent.result = runOperatorCommand(owned(attemptId, workRoot, "verify-recovery"));
        }),
      });
      expect(recovery).toMatchObject({ verdict: "RECOVERY_VERIFIED", spawned: false, imageGitSha: "UNVERIFIED" });
      expect(concurrent.result?.code).toBe("CONCURRENT_EXECUTION");
      expect(dockerArgs.some((args) => args.includes(password) || args.includes("POSTGRES_PASSWORD=") || args.join("\n").match(/postgres(?:ql)?:\/\//i))).toBe(false);
      expect(dockerArgs.some((args) => args[0] === "run" && args.includes("--env-file"))).toBe(true);
      expect(fs.existsSync(path.join(attemptRoot, ".restore-secret", "postgres.env"))).toBe(false);
      expect(spawnSync("docker", ["inspect", restoreName], { windowsHide: true }).status).not.toBe(0);
      expect(spawnSync("docker", ["network", "inspect", restoreNetwork], { windowsHide: true }).status).not.toBe(0);
      expect(fs.readFileSync(sealedKeep, "utf8")).toBe("foreign-sealed");
      const archivePath = path.join(attemptRoot, "backup", "backup.sql.gz");
      const checksumPath = path.join(attemptRoot, "backup", "backup.sql.gz.sha256");
      const witnessPath = path.join(attemptRoot, "backup", "backup.witness.json");
      const archive = fs.readFileSync(archivePath);
      const recorded = fs.readFileSync(checksumPath, "utf8").trim();
      expect(recorded).toBe(createHash("sha256").update(archive).digest("hex"));
      expect(recorded).toHaveLength(64);

      const drifted = `${"ab".repeat(32)}\n`;
      fs.writeFileSync(checksumPath, drifted);
      const invalid = runOperatorCommand(owned(attemptId, workRoot, "apply"));
      expect(invalid).toMatchObject({ code: "CHECKSUM_DRIFT", spawned: false });
      fs.writeFileSync(checksumPath, `${recorded}\n`);

      const savedWitness = fs.readFileSync(witnessPath);
      const badArchive = zlib.gzipSync(Buffer.from("this is not sql;\n"));
      const badSha = createHash("sha256").update(badArchive).digest("hex");
      const badWitness = JSON.parse(savedWitness.toString("utf8")) as { archiveSha256: string; archiveByteLength: number };
      badWitness.archiveSha256 = badSha;
      badWitness.archiveByteLength = badArchive.length;
      fs.writeFileSync(archivePath, badArchive);
      fs.writeFileSync(checksumPath, `${badSha}\n`);
      fs.writeFileSync(witnessPath, `${canonicalJson(badWitness)}\n`);
      const failedRestore = runOperatorCommand(owned(attemptId, workRoot, "apply"));
      expect(failedRestore).toMatchObject({ code: "RESTORE_FAILED", spawned: false });
      expect(fs.existsSync(path.join(attemptRoot, ".restore-secret", "postgres.env"))).toBe(false);
      expect(spawnSync("docker", ["inspect", restoreName], { windowsHide: true }).status).not.toBe(0);
      fs.writeFileSync(archivePath, archive);
      fs.writeFileSync(checksumPath, `${recorded}\n`);
      fs.writeFileSync(witnessPath, savedWitness);

      const daemonId = readDaemonId();
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
      const binding = {
        dossierSha256: recovery.dossierSha256 ?? "",
        recoverySha256: recovery.recoverySha256 ?? "",
        attemptId,
        daemonId,
      };
      const wrongKey = generateKeyPairSync("ed25519").privateKey;
      const forged = runOperatorCommand({
        ...owned(attemptId, workRoot, "apply"),
        testTrustPublicKey: pem,
        authorization: signOwner(wrongKey, binding),
      });
      expect(forged).toMatchObject({ code: "AUTHORIZATION_ORIGIN_REJECTED", spawned: false });
      expect(readCatalog(inspectContainer(dbName).id, "p1pa", databaseName).recovery.successfulMigrationCount).toBe(EXPECTED_HISTORICAL_MIGRATION_COUNT);

      const consumed = signOwner(privateKey, binding);
      let ambiguousCalls = 0;
      const ambiguous = runOperatorCommand({
        ...owned(attemptId, workRoot, "apply"),
        testTrustPublicKey: pem,
        authorization: consumed,
        testSpawn: () => {
          ambiguousCalls += 1;
          return { status: null, signal: null };
        },
      });
      expect(ambiguous).toMatchObject({ verdict: "BLOCKED", code: "AMBIGUOUS_COMPLETION", spawned: true, retryAttempted: false });
      expect(ambiguousCalls).toBe(1);
      const marker = path.join(attemptRoot, "sealed.production-adapter-ambiguous-stop");
      expect(fs.existsSync(marker)).toBe(true);
      const retry = runOperatorCommand({
        ...owned(attemptId, workRoot, "apply"),
        testTrustPublicKey: pem,
        authorization: consumed,
        testSpawn: () => {
          throw new Error("ambiguous completion was retried");
        },
      });
      expect(retry).toMatchObject({ code: "AMBIGUOUS_COMPLETION", spawned: false });
      fs.rmSync(marker);
      const replay = runOperatorCommand({
        ...owned(attemptId, workRoot, "apply"),
        testTrustPublicKey: pem,
        authorization: consumed,
      });
      expect(replay.code).toBe("AUTHORIZATION_REPLAY");
      expect(replay.spawned).toBe(false);
      const lost = runOperatorCommand({
        ...owned(attemptId, workRoot, "apply"),
        testTrustPublicKey: pem,
        authorization: signOwner(privateKey, binding),
        testLockOwner: () => "not-this-attempt",
      });
      expect(lost).toMatchObject({ code: "LOST_LOCK", spawned: false });

      const applied = runOperatorCommand({
        ...owned(attemptId, workRoot, "apply"),
        testTrustPublicKey: pem,
        authorization: signOwner(privateKey, { ...binding, nonce: randomBytes(16).toString("hex") }),
        testDocker: recordingDocker(password, dockerArgs, () => {}),
      });
      expect(applied).toMatchObject({
        verdict: "ALREADY_APPLIED",
        code: "P1_APPLIED",
        spawned: true,
        retryAttempted: false,
        imageGitSha: "UNVERIFIED",
        appUnchanged: true,
        targetClass: "TEST_OWNED_NOT_PRODUCTION",
      });
      const after = inspectContainer(appName);
      expect(after.id).toBe(before.id);
      expect(after.imageId).toBe(before.imageId);
      expect(after.startedAt).toBe(before.startedAt);
      expect(after.entrypoint.join(" ")).toBe("node /app/health.js");
      expect(appResponds(appName)).toBe(true);
      const catalog = readCatalog(inspectContainer(dbName).id, "p1pa", databaseName);
      expect(catalog.history).toHaveLength(EXPECTED_MIGRATION_SQL_COUNT);
      expect(catalog.recovery.successfulMigrationCount).toBe(EXPECTED_MIGRATION_SQL_COUNT);
      expect(catalog.history.find((row) => row.migrationName.endsWith("batch_receipt_provenance"))?.checksum).toBe(P1_SHA256);
      expect(columnMatchesContract(requirePart(catalog.schema.column))).toBe(true);
      expect(checkMatchesContract(requirePart(catalog.schema.check))).toBe(true);
      expect(functionMatchesContract(requirePart(catalog.schema.functionDef))).toBe(true);
      expect(triggerMatchesContract(requirePart(catalog.schema.trigger))).toBe(true);
      expect(dockerArgs.some((args) => args.includes(password) || args.some((arg) => arg.includes("POSTGRES_PASSWORD=")))).toBe(false);
      expect(fs.existsSync(path.join(attemptRoot, ".restore-secret"))).toBe(false);
      expect(fs.readFileSync(witnessPath)).toEqual(savedWitness);
      expect(fs.readFileSync(sealedKeep, "utf8")).toBe("foreign-sealed");

      const second = runOperatorCommand({
        ...owned(attemptId, workRoot, "apply"),
        testTrustPublicKey: pem,
        authorization: signOwner(privateKey, { ...binding, nonce: randomBytes(16).toString("hex") }),
        testSpawn: () => {
          throw new Error("second invocation spawned");
        },
      });
      expect(second).toMatchObject({ code: "P1_APPLIED", spawned: false });
    } catch (error) {
      failure = error;
    } finally {
      if (started.app) spawnSync("docker", ["rm", "-f", appName], { windowsHide: true });
      if (started.db) spawnSync("docker", ["rm", "-f", dbName], { windowsHide: true });
      spawnSync("docker", ["image", "rm", "-f", imageTag], { windowsHide: true });
      if (started.network) spawnSync("docker", ["network", "rm", networkName], { windowsHide: true });
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
    if (failure) throw failure;
  }, 600_000);

  it("stops wrong containers, the wrong network, and an incomplete migration history", () => {
    const attemptId = randomBytes(8).toString("hex");
    const password = randomBytes(16).toString("hex");
    const workRoot = fs.mkdtempSync(path.join(process.cwd(), ".p1-operator-negative-"));
    const dbName = testDbName(attemptId);
    const appName = testAppName(attemptId);
    const databaseName = testDatabaseName(attemptId);
    const wrongNetwork = `p1pa-wrong-${attemptId}`;
    let dbStarted = false;
    let appStarted = false;
    let networkStarted = false;
    try {
      ensureImages();
      const missing = runOperatorCommand(owned(attemptId, workRoot, "preflight"));
      expect(missing).toMatchObject({ code: "RUNTIME_UNAUTHENTICATED", spawned: false, imageGitSha: "UNVERIFIED" });

      ensurePostgres();
      docker(["network", "create", wrongNetwork]);
      networkStarted = true;
      docker([
        "run", "-d", "--pull", "never", "--name", dbName, "--network", wrongNetwork, "--restart", "no",
        "-e", "POSTGRES_USER=p1pa", "-e", `POSTGRES_PASSWORD=${password}`, "-e", `POSTGRES_DB=${databaseName}`,
        "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256", PRODUCTION_POSTGRES_IMAGE,
      ]);
      dbStarted = true;
      docker([
        "run", "-d", "--pull", "never", "--name", appName, "--network", wrongNetwork, "--restart", "no", "--entrypoint", "sleep", PRODUCTION_POSTGRES_IMAGE, "300",
      ]);
      appStarted = true;
      waitReady(dbName, databaseName);
      execSql(
        dbName,
        databaseName,
        `CREATE TABLE public."User" (id text PRIMARY KEY);
         CREATE TABLE public."_prisma_migrations" (
           id varchar(36) PRIMARY KEY,
           checksum varchar(64) NOT NULL,
           finished_at timestamptz,
           migration_name varchar(255) NOT NULL,
           logs text,
           rolled_back_at timestamptz,
           started_at timestamptz NOT NULL DEFAULT now(),
           applied_steps_count integer NOT NULL DEFAULT 0
         );`,
      );
      const wrong = runOperatorCommand(owned(attemptId, workRoot, "preflight"));
      expect(["TEST_TARGET_MISMATCH", "NETWORK_ALIAS_MISMATCH"]).toContain(wrong.code);
      expect(wrong.spawned).toBe(false);

      spawnSync("docker", ["rm", "-f", dbName, appName], { windowsHide: true });
      dbStarted = false;
      appStarted = false;
      docker(["network", "rm", wrongNetwork]);
      networkStarted = false;
      const networkName = testNetworkName(attemptId);
      docker(["network", "create", networkName]);
      networkStarted = true;
      docker([
        "run", "-d", "--pull", "never", "--name", dbName, "--network", networkName, "--network-alias", "db", "--restart", "no",
        "-e", "POSTGRES_USER=p1pa", "-e", `POSTGRES_PASSWORD=${password}`, "-e", `POSTGRES_DB=${databaseName}`,
        "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256", PRODUCTION_POSTGRES_IMAGE,
      ]);
      dbStarted = true;
      docker(["run", "-d", "--pull", "never", "--name", appName, "--network", networkName, "--restart", "no", "--entrypoint", "sleep", PRODUCTION_POSTGRES_IMAGE, "300"]);
      appStarted = true;
      waitReady(dbName, databaseName);
      execSql(
        dbName,
        databaseName,
        `CREATE TABLE public."User" (id text PRIMARY KEY);
         CREATE TABLE public."_prisma_migrations" (
           id varchar(36) PRIMARY KEY,
           checksum varchar(64) NOT NULL,
           finished_at timestamptz,
           migration_name varchar(255) NOT NULL,
           logs text,
           rolled_back_at timestamptz,
           started_at timestamptz NOT NULL DEFAULT now(),
           applied_steps_count integer NOT NULL DEFAULT 0
         );`,
      );
      const incomplete = runOperatorCommand(owned(attemptId, workRoot, "preflight"));
      expect(incomplete).toMatchObject({ code: "OTHER_PENDING_MIGRATION", spawned: false });
      expect(fs.existsSync(path.join(operatorAttemptRoot(workRoot, attemptId), "backup"))).toBe(false);
    } finally {
      if (dbStarted) spawnSync("docker", ["rm", "-f", dbName], { windowsHide: true });
      if (appStarted) spawnSync("docker", ["rm", "-f", appName], { windowsHide: true });
      if (networkStarted) {
        spawnSync("docker", ["network", "rm", wrongNetwork], { windowsHide: true });
        spawnSync("docker", ["network", "rm", testNetworkName(attemptId)], { windowsHide: true });
      }
      fs.rmSync(workRoot, { recursive: true, force: true });
    }
  }, 180_000);
});

function recordingDocker(password: string, argvLog: string[][], onCall: (args: readonly string[]) => void): OperatorDocker {
  return (args, env) => {
    argvLog.push([...args]);
    onCall(args);
    const rendered = args.join("\n");
    if (rendered.includes(password) || rendered.includes("POSTGRES_PASSWORD=") || /postgres(?:ql)?:\/\//i.test(rendered)) {
      return { status: 97, signal: null, stdout: "", stderr: "" };
    }
    const child = spawnSync("docker", [...args], {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const stderr = child.stderr ?? "";
    const leaked = stderr.includes(password) || stderr.includes("POSTGRES_PASSWORD=") || /postgres(?:ql)?:\/\//i.test(stderr);
    return { status: child.status, signal: child.signal, stdout: child.stdout ?? "", stderr: leaked ? "" : stderr };
  };
}

function owned(attemptId: string, workRoot: string, command: OperatorRequest["command"]): OperatorRequest {
  return { command, scope: "TEST_OWNED", attemptId, workRoot, testApprovedOneShotImageId: oneShotImageId() };
}

function signOwner(
  privateKey: KeyObject,
  binding: { dossierSha256: string; recoverySha256: string; attemptId: string; daemonId: string; nonce?: string },
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
    nonce: binding.nonce ?? randomBytes(16).toString("hex"),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + 60 * 60_000).toISOString(),
  };
  return { payload, signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64") };
}

function appResponds(containerName: string): boolean {
  const child = spawnSync(
    "docker",
    ["exec", containerName, "node", "-e", "require('http').get('http://127.0.0.1:3000',(r)=>{r.resume();r.on('end',()=>process.exit(0))}).on('error',()=>process.exit(1))"],
    { windowsHide: true, encoding: "utf8", timeout: 10_000 },
  );
  return child.status === 0;
}

function waitReady(containerName: string, databaseName: string): void {
  let last = "no response";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const child = spawnSync("docker", ["exec", containerName, "psql", "-U", "p1pa", "-d", databaseName, "-X", "-At", "-c", "SELECT 1"], {
      windowsHide: true,
      encoding: "utf8",
    });
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
  if (child.status !== 0) throw new Error(redact(child.stderr || ""));
}

function docker(args: readonly string[]): string {
  const child = spawnSync("docker", [...args], { encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  if (child.status !== 0) throw new Error(`${args[0] ?? "docker"} failed: ${redact(child.stderr || child.stdout).slice(0, 500)}`);
  return child.stdout.trim();
}

function ensurePostgres(): void {
  const postgres = spawnSync("docker", ["image", "inspect", PRODUCTION_POSTGRES_IMAGE], { windowsHide: true });
  if (postgres.status === 0) return;
  const pulled = spawnSync("docker", ["pull", PRODUCTION_POSTGRES_IMAGE], { windowsHide: true, timeout: 180_000 });
  if (pulled.status !== 0) throw new Error("postgres:17-alpine is unavailable");
}

function ensureImages(): void {
  ensurePostgres();
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
