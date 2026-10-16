import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createRepoGitSource } from "@/server/internal/p1-isolated-runner/git-source";
import { refusal, RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";
import { fileReplayStore, readInstalledTrustPublicKey } from "@/server/internal/p1-production-adapter/authorization";
import {
  ATTEMPT_ID,
  DAEMON_ID,
  IMAGE_GIT_SHA,
  PRODUCTION_APP_CONTAINER,
  PRODUCTION_DAEMON_PIN_PATH,
  PRODUCTION_DATABASE_NAME,
  PRODUCTION_DB_CONTAINER,
  PRODUCTION_DNS_ALIAS,
  PRODUCTION_NETWORK_NAME,
  PRODUCTION_POSTGRES_IMAGE,
  PRODUCTION_ROLE_NAME,
  TEST_ROLE_NAME,
  testDatabaseName,
  testDbName,
  testAppName,
  testNetworkName,
  testRestoreName,
  type AdapterScope,
  type ExecutionPhase,
} from "@/server/internal/p1-production-adapter/contract";
import { readCatalog, dumpDatabase, inspectContainer, inspectMounts, resolveDockerSession, restoreArchive, type DockerSession } from "@/server/internal/p1-production-adapter/docker-runtime";
import { executeProductionAdapter, type AdapterResult, type OneShotPlan, type OneShotResult } from "@/server/internal/p1-production-adapter/execute";
import { declarationFromFacts, type TargetFacts } from "@/server/internal/p1-production-adapter/identity";
import { publishReleaseBackup, type ReleaseBackupWitness } from "@/server/internal/p1-production-adapter/recovery";
import type { RestoreContainerFact } from "@/server/internal/p1-production-adapter/restore-controller";

/**
 * Operator runtime.
 * Production dependencies are built from the local Docker daemon at execution time.
 * A caller cannot supply TargetFacts, a catalog snapshot, or a production callback.
 * Test-owned scope may pass a work directory, a test trust key, and a signed document.
 * image Git SHA is never inferred from an image id.
 *
 * Boundaries:
 * - preflight reads containers and the catalog. It does not write a backup or spawn Prisma.
 * - verify-recovery is the separate authorization to create this attempt's backup and a disposable restore.
 * - apply uses the persisted backup, the installed production approval, and one pinned P1 migrate.
 *   It does not replace an existing backup and it does not retry an ambiguous migrate.
 */

export const PRODUCTION_OPERATOR_WORK_ROOT = "/var/lib/stell22/p1-operator-work";

export const OPERATOR_COMMANDS = ["preflight", "verify-recovery", "apply"] as const;
export type OperatorCommand = (typeof OPERATOR_COMMANDS)[number];

export type OperatorRequest = {
  command: OperatorCommand;
  attemptId: string;
  scope: AdapterScope;
  workRoot?: string;
  testTrustPublicKey?: string;
  authorization?: unknown;
  testEnv?: Readonly<Record<string, string | undefined>>;
  testSpawn?: (plan: OneShotPlan) => OneShotResult;
  testLockOwner?: () => string | null;
};

const INJECTED_KEYS = ["workRoot", "testTrustPublicKey", "authorization", "testEnv", "testSpawn", "testLockOwner"] as const;

export function runOperatorCommand(request: OperatorRequest): AdapterResult {
  try {
    assertAttempt(request.attemptId);
    if (request.scope === "PRODUCTION") {
      if (INJECTED_KEYS.some((key) => request[key] !== undefined)) {
        throw refusal("STOP", "INJECTED_PRODUCTION_DEPENDENCY", "Production runtime does not accept caller dependencies");
      }
      if (process.env.GITHUB_ACTIONS === "true") {
        throw refusal("STOP", "PRODUCTION_SCOPE_FORBIDDEN_IN_CI", "Production scope is refused in GitHub Actions");
      }
      const pin = readInstalledDaemonPin();
      if (pin === null || !DAEMON_ID.test(pin)) {
        throw refusal("STOP", "PRODUCTION_DAEMON_UNPINNED", "Production Docker daemon id is not independently pinned");
      }
      if (request.command === "apply") {
        if (readInstalledTrustPublicKey() === null) {
          throw refusal("STOP", "PRODUCTION_TRUST_UNPROVISIONED", "Production apply has no independently provisioned owner trust key");
        }
      }
      return runBound(request, operatorAttemptRoot(PRODUCTION_OPERATOR_WORK_ROOT, request.attemptId), pin);
    }
    if (!request.workRoot) {
      throw refusal("STOP", "OPERATOR_WORK_ROOT_REQUIRED", "Test-owned operator work is not rooted");
    }
    return runBound(request, operatorAttemptRoot(request.workRoot, request.attemptId), null);
  } catch (error) {
    return fromError(error, request);
  }
}

export function formatOperatorResult(result: AdapterResult): string {
  return [
    result.verdict,
    result.code,
    `phase=${result.phase}`,
    `imageGitSha=${result.imageGitSha}`,
    `spawned=${result.spawned}`,
    `retryAttempted=${result.retryAttempted}`,
    `targetClass=${result.targetClass}`,
  ].join(" ");
}

export function operatorAttemptRoot(workRoot: string, attemptId: string): string {
  return path.join(workRoot, attemptId);
}

export function readInstalledDaemonPin(): string | null {
  const pinPath = PRODUCTION_DAEMON_PIN_PATH;
  if (!fs.existsSync(pinPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(pinPath, "utf8")) as Record<string, unknown>;
    if (parsed.kind !== "PRODUCTION_DAEMON_PIN") return null;
    return typeof parsed.daemonId === "string" ? parsed.daemonId : null;
  } catch {
    return null;
  }
}

function runBound(request: OperatorRequest, workRoot: string, productionDaemonPin: string | null): AdapterResult {
  const env = request.scope === "TEST_OWNED" && request.testEnv ? request.testEnv : process.env;
  const session = resolveDockerSession(env);
  const paths = attemptPaths(workRoot);
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  if (request.command === "preflight") {
    return executeAndRelease(
      { intent: "PREFLIGHT", scope: request.scope, attemptId: request.attemptId, declared: declarationFromFacts(inspectLive(request, session)) },
      dependencies(request, session, paths, null, productionDaemonPin),
    );
  }
  if (request.command === "verify-recovery") {
    const preview = executeAndRelease(
      { intent: "PREFLIGHT", scope: request.scope, attemptId: request.attemptId, declared: declarationFromFacts(inspectLive(request, session)) },
      dependencies(request, session, paths, null, productionDaemonPin),
    );
    if (preview.verdict !== "PREFLIGHT_ONLY") return preview;
    const live = inspectLive(request, session);
    const archive = zlib.gzipSync(dumpDatabase(live.db.id, live.roleName, live.databaseName, session.env));
    const witness = publishReleaseBackup(paths.backup, archive, {
      attemptId: request.attemptId,
      container: live.db,
      databaseName: live.databaseName,
      roleName: live.roleName,
    });
    return withRestore(request, session, paths, witness, "RECOVERY", productionDaemonPin);
  }
  const witness = readPersistedWitness(paths.backup);
  return withRestore(request, session, paths, witness, "APPLY", productionDaemonPin);
}

function executeAndRelease(
  request: Parameters<typeof executeProductionAdapter>[0],
  deps: Parameters<typeof executeProductionAdapter>[1],
): AdapterResult {
  try {
    return executeProductionAdapter(request, deps);
  } finally {
    fs.rmSync(deps.destinationRoot, { recursive: true, force: true });
  }
}

function withRestore(
  request: OperatorRequest,
  session: DockerSession,
  paths: AttemptPaths,
  witness: ReleaseBackupWitness,
  intent: "RECOVERY" | "APPLY",
  productionDaemonPin: string | null,
): AdapterResult {
  const restoreName = testRestoreName(request.attemptId);
  const restoreNetwork = `${testNetworkName(request.attemptId)}-restore`;
  let started = false;
  try {
    removeDisposable(restoreName, restoreNetwork, session.env);
    const password = readDatabasePassword(inspectLive(request, session).db.id, session.env);
    const start = () => {
      if (started) return;
      docker(["network", "create", restoreNetwork], session.env);
      docker(
        [
          "run",
          "-d",
          "--pull",
          "never",
          "--name",
          restoreName,
          "--network",
          restoreNetwork,
          "--restart",
          "no",
          "-e",
          `POSTGRES_USER=${namesFor(request).role}`,
          "-e",
          `POSTGRES_PASSWORD=${password}`,
          "-e",
          `POSTGRES_DB=${namesFor(request).database}`,
          "-e",
          "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
          PRODUCTION_POSTGRES_IMAGE,
        ],
        session.env,
      );
      waitReady(restoreName, namesFor(request).role, namesFor(request).database, session.env);
      started = true;
    };
    const live = inspectLive(request, session);
    return executeAndRelease(
      {
        intent,
        scope: request.scope,
        attemptId: request.attemptId,
        declared: declarationFromFacts(live),
        databasePassword: password,
        recoveryWitness: witness,
        authorization: request.scope === "TEST_OWNED" ? request.authorization : undefined,
      },
      dependencies(request, session, paths, { start, restoreName, password }, productionDaemonPin),
    );
  } finally {
    removeDisposable(restoreName, restoreNetwork, session.env);
  }
}

type AttemptPaths = { root: string; backup: string; sealed: string; lock: string; replay: string };

function attemptPaths(workRoot: string): AttemptPaths {
  const root = workRoot;
  return {
    root,
    backup: path.join(root, "backup"),
    sealed: path.join(root, "sealed"),
    lock: path.join(root, "adapter.lock"),
    replay: path.join(root, "replay"),
  };
}

function dependencies(
  request: OperatorRequest,
  session: DockerSession,
  paths: AttemptPaths,
  restore: { start: () => void; restoreName: string; password: string } | null,
  productionDaemonPin: string | null,
) {
  const names = namesFor(request);
  const catalogOf = (containerId: string) => readCatalog(containerId, names.role, names.database, session.env);
  return {
    productionDaemonPin,
    git: createRepoGitSource(process.cwd()),
    destinationRoot: paths.sealed,
    lockPath: paths.lock,
    env: session.env,
    inspect: () => inspectLive(request, session),
    readHistory: () => catalogOf(inspectContainer(names.db, session.env).id).history,
    readSchema: () => catalogOf(inspectContainer(names.db, session.env).id).schema,
    readArchive: () => fs.readFileSync(path.join(paths.backup, "backup.sql.gz")),
    backupDirectory: paths.backup,
    readLiveRecovery: () => catalogOf(inspectContainer(names.db, session.env).id).recovery,
    inspectSourceMounts: () => inspectMounts(inspectContainer(names.db, session.env).id, session.env),
    inspectRestore: (): RestoreContainerFact => {
      if (!restore) throw refusal("STOP", "RESTORE_NOT_AUTHORIZED", "This command does not start a disposable restore");
      restore.start();
      const fact = inspectContainer(restore.restoreName, session.env);
      return { ...fact, mounts: inspectMounts(fact.id, session.env) };
    },
    runRestore: (containerId: string, sql: Buffer) => {
      if (!restore) throw refusal("STOP", "RESTORE_NOT_AUTHORIZED", "This command does not restore a backup");
      try {
        return restoreArchive(containerId, names.role, names.database, sql, session.env);
      } catch (error) {
        if (error instanceof RunnerRefusal) throw error;
        throw refusal("STOP", "RESTORE_FAILED", "Restore command did not exit 0");
      }
    },
    readRestoredCatalog: (containerId: string) => readCatalog(containerId, names.role, names.database, session.env).recovery,
    readLockOwner: () =>
      request.scope === "TEST_OWNED" && request.testLockOwner
        ? request.testLockOwner()
        : fs.existsSync(paths.lock)
          ? fs.readFileSync(paths.lock, "utf8")
          : null,
    testTrustPublicKey: request.scope === "TEST_OWNED" ? request.testTrustPublicKey : undefined,
    replay: request.scope === "TEST_OWNED" ? fileReplayStore(paths.replay) : undefined,
    spawnOneShot: (plan: OneShotPlan): OneShotResult => {
      if (request.scope === "TEST_OWNED" && request.testSpawn) return request.testSpawn(plan);
      return spawnOperatorOneShot(plan);
    },
  };
}

export function spawnOperatorOneShot(plan: OneShotPlan): OneShotResult {
  const child = spawnSync("docker", [...plan.argv], {
    env: plan.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: child.status, signal: child.signal };
}

function inspectLive(request: OperatorRequest, session: DockerSession): TargetFacts {
  const names = namesFor(request);
  const app = inspectContainer(names.app, session.env);
  const db = inspectContainer(names.db, session.env);
  const catalog = readCatalog(db.id, names.role, names.database, session.env);
  const aliasNetwork = db.networks.find((network) => network.aliases.includes(PRODUCTION_DNS_ALIAS));
  return {
    scope: request.scope,
    attemptId: request.attemptId,
    daemonId: session.daemonId,
    app,
    db,
    databaseName: catalog.session.databaseName,
    roleName: catalog.session.roleName,
    networkName: aliasNetwork?.name ?? db.networks[0]?.name ?? "",
    dnsAlias: PRODUCTION_DNS_ALIAS,
    serverVersionNum: catalog.session.serverVersionNum,
  };
}

function namesFor(request: OperatorRequest): { app: string; db: string; database: string; role: string } {
  if (request.scope === "PRODUCTION") {
    return {
      app: PRODUCTION_APP_CONTAINER,
      db: PRODUCTION_DB_CONTAINER,
      database: PRODUCTION_DATABASE_NAME,
      role: PRODUCTION_ROLE_NAME,
    };
  }
  return {
    app: testAppName(request.attemptId),
    db: testDbName(request.attemptId),
    database: testDatabaseName(request.attemptId),
    role: TEST_ROLE_NAME,
  };
}

function readPersistedWitness(backupDirectory: string): ReleaseBackupWitness {
  const witnessPath = path.join(backupDirectory, "backup.witness.json");
  if (!fs.existsSync(witnessPath)) {
    throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "The persisted release backup for this attempt is missing");
  }
  const parsed = JSON.parse(fs.readFileSync(witnessPath, "utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "The persisted release witness is not intact");
  }
  return parsed as ReleaseBackupWitness;
}

function readDatabasePassword(containerId: string, env: NodeJS.ProcessEnv): string {
  const raw = docker(["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", containerId], env);
  const matches = raw.split(/\n/).filter((line) => line.startsWith("POSTGRES_PASSWORD="));
  if (matches.length !== 1) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Database credential is not usable");
  }
  const password = matches[0]?.slice("POSTGRES_PASSWORD=".length) ?? "";
  if (password.length < 16 || /[\r\n]/.test(password)) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Database credential is not usable");
  }
  return password;
}

function waitReady(containerName: string, role: string, database: string, env: NodeJS.ProcessEnv): void {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const child = spawnSync("docker", ["exec", containerName, "psql", "-U", role, "-d", database, "-X", "-At", "-c", "SELECT 1"], {
      env,
      windowsHide: true,
      encoding: "utf8",
    });
    if (child.status === 0 && child.stdout.includes("1")) return;
    spawnSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);"], { windowsHide: true });
  }
  throw refusal("STOP", "RESTORE_FAILED", "Disposable restore did not become ready");
}

function removeDisposable(name: string, network: string, env: NodeJS.ProcessEnv): void {
  spawnSync("docker", ["rm", "-f", name], { env, windowsHide: true });
  spawnSync("docker", ["network", "rm", network], { env, windowsHide: true });
}

function docker(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const child = spawnSync("docker", [...args], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Docker command failed");
  }
  return child.stdout;
}

function assertAttempt(attemptId: string): void {
  if (!ATTEMPT_ID.test(attemptId)) {
    throw refusal("STOP", "ATTEMPT_REQUIRED", "Operator attempt id is not a 16 hex binding");
  }
}

function fromError(error: unknown, request: OperatorRequest): AdapterResult {
  if (error instanceof RunnerRefusal) {
    return stopped(error.verdict, error.code, phaseFor(request.command), request.scope);
  }
  return stopped("STOP", "RUNTIME_UNAUTHENTICATED", phaseFor(request.command), request.scope);
}

function phaseFor(command: OperatorCommand): ExecutionPhase {
  if (command === "preflight") return "READ_ONLY_PREFLIGHT";
  if (command === "verify-recovery") return "RECOVERY_VERIFICATION";
  return "EXPLICIT_AUTHORIZATION";
}

function stopped(
  verdict: AdapterResult["verdict"],
  code: string,
  phase: ExecutionPhase,
  scope: AdapterScope,
): AdapterResult {
  return {
    verdict,
    code,
    phase,
    spawned: false,
    retryAttempted: false,
    imageGitSha: IMAGE_GIT_SHA,
    targetClass: scope === "PRODUCTION" ? "PRODUCTION" : "TEST_OWNED_NOT_PRODUCTION",
    appUnchanged: null,
    dossierSha256: null,
    recoverySha256: null,
  };
}

export const OBSERVED_PRODUCTION_TOPOLOGY = {
  networkName: PRODUCTION_NETWORK_NAME,
  dnsAlias: PRODUCTION_DNS_ALIAS,
  databaseName: PRODUCTION_DATABASE_NAME,
  roleName: PRODUCTION_ROLE_NAME,
} as const;
