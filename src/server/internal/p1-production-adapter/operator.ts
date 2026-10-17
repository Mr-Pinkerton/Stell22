import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  IMAGE_ID,
  PRODUCTION_ONESHOT_IMAGE_PIN_PATH,
  SHA256,
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
import { executeProductionAdapter, type AdapterResult, type OneShotPlan, type OneShotResult, type RecoveryEvidenceState, type SigningInputsState } from "@/server/internal/p1-production-adapter/execute";
import { ONE_SHOT_IMAGE } from "@/server/internal/p1-isolated-runner/p1-release-gate";
import type { OneShotImageObservation } from "@/server/internal/p1-production-adapter/oneshot";
import { declarationFromFacts, type TargetFacts } from "@/server/internal/p1-production-adapter/identity";
import { acquireOperatorHostLock, operatorHostLockPath, type OperatorHostLock } from "@/server/internal/p1-production-adapter/host-lock";
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
 * - preflight reads containers and the catalog. It does not create directories, delete files, or mutate Docker.
 * - verify-recovery is the separate authorization to create this attempt's backup and a disposable restore.
 *   It holds the host-wide operator lock and an exclusive attempt lock, and removes only the disposable resources that invocation created.
 * - apply uses the persisted backup, the installed production approval, and one pinned P1 migrate.
 *   It holds the same host-wide lock. It does not replace an existing backup and it does not retry an ambiguous migrate.
 * - preflight does not acquire either lock.
 * Disposable database credentials travel in a mode 0600 env file. They are not Docker arguments.
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
  testDocker?: OperatorDocker;
  testApprovedOneShotImageId?: string;
};

const INJECTED_KEYS = ["workRoot", "testTrustPublicKey", "authorization", "testEnv", "testSpawn", "testLockOwner", "testDocker", "testApprovedOneShotImageId"] as const;

export type OperatorDockerResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export type OperatorDocker = (args: readonly string[], env: NodeJS.ProcessEnv) => OperatorDockerResult;

export const OPERATOR_LOCK_FILE = "operator.lock";
export const DISPOSABLE_INVOCATION_LABEL = "stell22.p1.operator.invocation";
export const DISPOSABLE_ATTEMPT_LABEL = "stell22.p1.operator.attempt";
export const DISPOSABLE_KIND_LABEL = "stell22.p1.operator.kind";

const PROTECTED_CONTAINER_NAMES = new Set<string>([PRODUCTION_APP_CONTAINER, PRODUCTION_DB_CONTAINER, "stell22-caddy"]);
const PROTECTED_NETWORK_NAMES = new Set<string>([PRODUCTION_NETWORK_NAME, "bridge", "host", "none"]);

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
      const imagePin = readInstalledOneShotImagePin();
      if (imagePin === null || !IMAGE_ID.test(imagePin)) {
        throw refusal("STOP", "ONESHOT_IMAGE_UNPINNED", "Production one-shot image id is not independently pinned");
      }
      if (request.command === "apply") {
        if (readInstalledTrustPublicKey() === null) {
          throw refusal("STOP", "PRODUCTION_TRUST_UNPROVISIONED", "Production apply has no independently provisioned owner trust key");
        }
      }
      return runBound(request, operatorAttemptRoot(PRODUCTION_OPERATOR_WORK_ROOT, request.attemptId), pin, imagePin);
    }
    if (!request.workRoot) {
      throw refusal("STOP", "OPERATOR_WORK_ROOT_REQUIRED", "Test-owned operator work is not rooted");
    }
    return runBound(request, operatorAttemptRoot(request.workRoot, request.attemptId), null, null);
  } catch (error) {
    return fromError(error, request);
  }
}

export function formatOperatorResult(result: AdapterResult): string {
  const evidence: RecoveryEvidenceState = result.recoveryEvidence === "VERIFIED" ? "VERIFIED" : "NONE";
  const dossier = digestOrUnavailable(result.dossierSha256);
  const recovery = evidence === "VERIFIED" ? digestOrUnavailable(result.recoverySha256) : "UNAVAILABLE";
  const signing: SigningInputsState =
    result.verdict === "STOP" || result.verdict === "BLOCKED"
      ? "NOT_SIGNABLE"
      : dossier !== "UNAVAILABLE" && recovery !== "UNAVAILABLE"
        ? "COMPLETE"
        : dossier !== "UNAVAILABLE"
          ? "INCOMPLETE"
          : "NOT_SIGNABLE";
  const image = result.oneShotImageId !== null && IMAGE_ID.test(result.oneShotImageId) ? result.oneShotImageId : "UNAVAILABLE";
  const attempt = ATTEMPT_ID.test(result.attemptId) ? result.attemptId : "UNAVAILABLE";
  return [
    `verdict=${result.verdict}`,
    `code=${result.code}`,
    `phase=${result.phase}`,
    `attempt=${attempt}`,
    `imageGitSha=${result.imageGitSha}`,
    `oneShotImageId=${image}`,
    `dossierSha256=${dossier}`,
    `recoverySha256=${recovery}`,
    `recoveryEvidence=${evidence}`,
    `signingInputs=${signing}`,
    `spawned=${result.spawned}`,
    `retryAttempted=${result.retryAttempted}`,
    `targetClass=${result.targetClass}`,
  ].join(" ");
}

export function formatUnsignedStop(code: string, attemptId: string | null): string {
  return formatOperatorResult({
    verdict: "STOP",
    code,
    phase: "READ_ONLY_PREFLIGHT",
    attemptId: attemptId ?? "",
    spawned: false,
    retryAttempted: false,
    imageGitSha: IMAGE_GIT_SHA,
    oneShotImageId: null,
    targetClass: "PRODUCTION",
    appUnchanged: null,
    dossierSha256: null,
    recoverySha256: null,
    recoveryEvidence: "NONE",
    signingInputs: "NOT_SIGNABLE",
  });
}

function digestOrUnavailable(value: string | null): string {
  return value !== null && SHA256.test(value) ? value : "UNAVAILABLE";
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

export function readInstalledOneShotImagePin(): string | null {
  const pinPath = PRODUCTION_ONESHOT_IMAGE_PIN_PATH;
  if (!fs.existsSync(pinPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(pinPath, "utf8")) as Record<string, unknown>;
    if (parsed.kind !== "PRODUCTION_ONESHOT_IMAGE_PIN") return null;
    return typeof parsed.imageId === "string" && IMAGE_ID.test(parsed.imageId) ? parsed.imageId : null;
  } catch {
    return null;
  }
}

function runBound(
  request: OperatorRequest,
  workRoot: string,
  productionDaemonPin: string | null,
  productionOneShotImagePin: string | null,
): AdapterResult {
  const env = request.scope === "TEST_OWNED" && request.testEnv ? request.testEnv : process.env;
  const dockerRun = request.scope === "TEST_OWNED" ? (request.testDocker ?? null) : null;
  const session = resolveDockerSession(env, dockerRun ? dockerRunAdapter(dockerRun) : undefined);
  const paths = attemptPaths(workRoot);
  if (request.command === "preflight") {
    return executeProductionAdapter(
        { intent: "PREFLIGHT", scope: request.scope, attemptId: request.attemptId, declared: declarationFromFacts(inspectLive(request, session)) },
      dependencies(request, session, paths, null, productionDaemonPin, productionOneShotImagePin, dockerRun),
    );
  }
  const invocationId = randomBytes(16).toString("hex");
  let hostLock: OperatorHostLock | null = null;
  let lock: { release: () => void } | null = null;
  let lockReleaseError: unknown = null;
  let result: AdapterResult | null = null;
  try {
    hostLock = acquireOperatorHostLock(operatorHostLockPath(request.scope, path.dirname(paths.root)), {
      attemptId: request.attemptId,
      command: request.command === "verify-recovery" ? "verify-recovery" : "apply",
    });
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    lock = acquireOperatorLock(path.join(paths.root, OPERATOR_LOCK_FILE), `${request.attemptId}:${invocationId}`);
    if (request.command === "verify-recovery") {
      const preview = executeProductionAdapter(
        { intent: "PREFLIGHT", scope: request.scope, attemptId: request.attemptId, declared: declarationFromFacts(inspectLive(request, session)) },
        dependencies(request, session, paths, null, productionDaemonPin, productionOneShotImagePin, dockerRun),
      );
      if (preview.verdict !== "PREFLIGHT_ONLY") {
        result = preview;
      } else {
        assertDisposableNamesFree(request, session.env, dockerRun);
        const live = inspectLive(request, session);
        const archive = zlib.gzipSync(dumpDatabase(live.db.id, live.roleName, live.databaseName, session.env));
        const witness = publishReleaseBackup(paths.backup, archive, {
          attemptId: request.attemptId,
          container: live.db,
          databaseName: live.databaseName,
          roleName: live.roleName,
        });
        result = withRestore(request, session, paths, witness, "RECOVERY", productionDaemonPin, productionOneShotImagePin, invocationId, dockerRun);
      }
    } else {
      const witness = readPersistedWitness(paths.backup);
      result = withRestore(request, session, paths, witness, "APPLY", productionDaemonPin, productionOneShotImagePin, invocationId, dockerRun);
    }
  } catch (error) {
    result = fromError(error, request);
  } finally {
    if (lock) {
      try {
        lock.release();
      } catch (error) {
        lockReleaseError = error;
      }
    }
    if (hostLock) {
      try {
        hostLock.release();
      } catch (error) {
        lockReleaseError = lockReleaseError ?? error;
      }
    }
  }
  if (lockReleaseError && result && (result.verdict === "RECOVERY_VERIFIED" || result.verdict === "ALREADY_APPLIED")) {
    return fromError(lockReleaseError, request);
  }
  return result ?? stopped("STOP", "RUNTIME_UNAUTHENTICATED", phaseFor(request.command), request.scope, request.attemptId);
}

function executeOwned(
  request: Parameters<typeof executeProductionAdapter>[0],
  deps: Parameters<typeof executeProductionAdapter>[1],
): { result: AdapterResult; sealedCreated: boolean } {
  const sealedBefore = fs.existsSync(deps.destinationRoot);
  const result = executeProductionAdapter(request, deps);
  return { result, sealedCreated: !sealedBefore && fs.existsSync(deps.destinationRoot) };
}

function withRestore(
  request: OperatorRequest,
  session: DockerSession,
  paths: AttemptPaths,
  witness: ReleaseBackupWitness,
  intent: "RECOVERY" | "APPLY",
  productionDaemonPin: string | null,
  productionOneShotImagePin: string | null,
  invocationId: string,
  dockerRun: OperatorDocker | null,
): AdapterResult {
  const names = namesFor(request);
  const restoreName = testRestoreName(request.attemptId);
  const restoreNetwork = `${testNetworkName(request.attemptId)}-restore`;
  const owned: OwnedDisposable[] = [];
  let result: AdapterResult | null = null;
  let cleanupError: unknown = null;
  let primaryCleanup: OperatorCleanupError | null = null;
  let sealedCreated = false;
  try {
    assertDisposableNamesFree(request, session.env, dockerRun);
    const password = readDatabasePassword(inspectLive(request, session).db.id, session.env, dockerRun);
    let started = false;
    const identity = { containerId: "" };
    const start = () => {
      if (started) return;
      startOwnedDisposable({
        attemptId: request.attemptId,
        invocationId,
        name: restoreName,
        networkName: restoreNetwork,
        image: PRODUCTION_POSTGRES_IMAGE,
        role: names.role,
        database: names.database,
        password,
        secretDirectory: path.join(paths.root, ".restore-secret"),
        env: session.env,
        owned,
        invoke: (args, env) => invokeDocker(args, env, dockerRun),
      });
      const container = owned.find((resource) => resource.kind === "disposable-restore-container");
      if (!container) throw refusal("STOP", "DISPOSABLE_START_FAILED", "Disposable restore did not record a container id");
      identity.containerId = container.id;
      waitReady(container.id, names.role, names.database, session.env);
      started = true;
    };
    const live = inspectLive(request, session);
    const executed = executeOwned(
      {
        intent,
        scope: request.scope,
        attemptId: request.attemptId,
        declared: declarationFromFacts(live),
        databasePassword: password,
        recoveryWitness: witness,
        authorization: request.scope === "TEST_OWNED" ? request.authorization : undefined,
      },
      dependencies(request, session, paths, { start, containerId: () => identity.containerId }, productionDaemonPin, productionOneShotImagePin, dockerRun),
    );
    result = executed.result;
    sealedCreated = intent === "APPLY" && executed.sealedCreated;
  } catch (error) {
    if (error instanceof OperatorCleanupError) primaryCleanup = error;
    result = fromError(error, request);
  } finally {
    try {
      retireOwnedDisposable(owned, (args, env) => invokeDocker(args, env, dockerRun), session.env);
    } catch (error) {
      cleanupError = error;
    }
  }
  if (primaryCleanup || cleanupError) {
    const cleanupCode = cleanupCodeOf(cleanupError ?? primaryCleanup);
    try {
      writeCleanupEvidence(paths.root, {
        primaryCode: primaryCleanup?.primaryCode ?? result?.code ?? null,
        cleanupCode,
        earlierCleanupCode: cleanupError && primaryCleanup ? primaryCleanup.code : null,
      });
    } catch {
      // Evidence write must not hide the cleanup failure already in hand.
    }
  }
  if (!cleanupError && !primaryCleanup && sealedCreated) {
    fs.rmSync(paths.sealed, { recursive: true, force: true });
  }
  if (cleanupError && result) return mergeOperatorCleanup(result, cleanupError);
  return result ?? stopped("STOP", "RUNTIME_UNAUTHENTICATED", phaseFor(request.command), request.scope, request.attemptId);
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
  restore: { start: () => void; containerId: () => string } | null,
  productionDaemonPin: string | null,
  productionOneShotImagePin: string | null,
  dockerRun: OperatorDocker | null,
) {
  const names = namesFor(request);
  const catalogOf = (containerId: string) => readCatalog(containerId, names.role, names.database, session.env);
  return {
    productionDaemonPin,
    productionOneShotImagePin: request.scope === "PRODUCTION" ? productionOneShotImagePin : null,
    approvedOneShotImageId: request.scope === "TEST_OWNED" ? (request.testApprovedOneShotImageId ?? null) : null,
    inspectOneShotImage: () => observeOneShotImage(session.env, dockerRun),
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
      const fact = inspectContainer(restore.containerId(), session.env);
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

function readDatabasePassword(containerId: string, env: NodeJS.ProcessEnv, dockerRun: OperatorDocker | null): string {
  const raw = requireStdout(
    ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", containerId],
    env,
    dockerRun,
    "RUNTIME_UNAUTHENTICATED",
  );
  const matches = raw.split(/\n/).filter((line) => line.startsWith("POSTGRES_PASSWORD="));
  if (matches.length !== 1) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Database credential is not usable");
  }
  const password = matches[0]?.slice("POSTGRES_PASSWORD=".length) ?? "";
  if (password.length < 16 || /[\r\n\0]/.test(password)) {
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

export type OwnedDisposable = {
  id: string;
  name: string;
  kind: "disposable-restore-container" | "disposable-restore-network";
  attemptId: string;
  invocationId: string;
};

export function disposablePostgresArgv(input: {
  name: string;
  networkName: string;
  envFile: string;
  image: string;
  attemptId: string;
  invocationId: string;
}): readonly string[] {
  return [
    "run",
    "-d",
    "--pull",
    "never",
    "--name",
    input.name,
    "--network",
    input.networkName,
    "--restart",
    "no",
    "--label",
    `${DISPOSABLE_INVOCATION_LABEL}=${input.invocationId}`,
    "--label",
    `${DISPOSABLE_ATTEMPT_LABEL}=${input.attemptId}`,
    "--label",
    `${DISPOSABLE_KIND_LABEL}=disposable-restore-container`,
    "--env-file",
    input.envFile,
    input.image,
  ];
}

export function startOwnedDisposable(input: {
  attemptId: string;
  invocationId: string;
  name: string;
  networkName: string;
  image: string;
  role: string;
  database: string;
  password: string;
  secretDirectory: string;
  env: NodeJS.ProcessEnv;
  owned: OwnedDisposable[];
  invoke: OperatorDocker;
}): void {
  assertNotProtected(input.name, input.networkName);
  const envFile = path.join(input.secretDirectory, "postgres.env");
  const created = { directory: false, owner: false, env: false };
  let failure: unknown = null;
  let secretCleanup: unknown = null;
  try {
    claimRestoreCredential(input.secretDirectory, envFile, input.invocationId, input.role, input.database, input.password, created);
    if (dockerNameExists(["container", "inspect", "--format", "{{.Id}}", input.name], input.env, input.invoke, "container")) {
      throw refusal("STOP", "DISPOSABLE_NAME_COLLISION", "A container already uses the disposable restore name");
    }
    if (dockerNameExists(["network", "inspect", "--format", "{{.Id}}", input.networkName], input.env, input.invoke, "network")) {
      throw refusal("STOP", "DISPOSABLE_NAME_COLLISION", "A network already uses the disposable restore name");
    }
    const networkId = requireId(
      [
        "network",
        "create",
        "--label",
        `${DISPOSABLE_INVOCATION_LABEL}=${input.invocationId}`,
        "--label",
        `${DISPOSABLE_ATTEMPT_LABEL}=${input.attemptId}`,
        "--label",
        `${DISPOSABLE_KIND_LABEL}=disposable-restore-network`,
        input.networkName,
      ],
      input.env,
      input.invoke,
    );
    input.owned.push({
      id: networkId,
      name: input.networkName,
      kind: "disposable-restore-network",
      attemptId: input.attemptId,
      invocationId: input.invocationId,
    });
    const argv = disposablePostgresArgv({
      name: input.name,
      networkName: input.networkName,
      envFile,
      image: input.image,
      attemptId: input.attemptId,
      invocationId: input.invocationId,
    });
    if (argv.some((arg) => arg.includes(input.password) || arg.includes("POSTGRES_PASSWORD=") || /postgres(?:ql)?:\/\//i.test(arg))) {
      throw refusal("STOP", "CREDENTIAL_LEAK", "Disposable database command contains a credential");
    }
    const containerId = requireId(argv, input.env, input.invoke);
    input.owned.push({
      id: containerId,
      name: input.name,
      kind: "disposable-restore-container",
      attemptId: input.attemptId,
      invocationId: input.invocationId,
    });
  } catch (error) {
    failure = error;
  } finally {
    if (created.directory) {
      try {
        releaseOwnedSecret(input.secretDirectory, input.invocationId, created);
      } catch (error) {
        secretCleanup = error;
      }
    }
  }
  if (secretCleanup) {
    const cleanupCode = secretCleanup instanceof RunnerRefusal ? secretCleanup.code : "SECRET_CLEANUP_FAILED";
    const primaryCode = failure instanceof RunnerRefusal ? failure.code : failure ? "DISPOSABLE_START_FAILED" : null;
    throw new OperatorCleanupError(cleanupCode, primaryCode);
  }
  if (failure) throw failure;
}

export function retireOwnedDisposable(owned: readonly OwnedDisposable[], invoke: OperatorDocker, env: NodeJS.ProcessEnv): void {
  const containers = owned.filter((resource) => resource.kind === "disposable-restore-container");
  const networks = owned.filter((resource) => resource.kind === "disposable-restore-network");
  for (const resource of containers) retireOne(resource, invoke, env);
  for (const resource of networks) retireOne(resource, invoke, env);
}

function retireOne(resource: OwnedDisposable, invoke: OperatorDocker, env: NodeJS.ProcessEnv): void {
  const inspected = inspectOwned(resource, invoke, env);
  if (inspected === "absent") return;
  if (inspected === "foreign") {
    throw refusal("STOP", "DISPOSABLE_CLEANUP_REFUSED", "Disposable cleanup refused a resource this invocation does not own");
  }
  const args = resource.kind === "disposable-restore-container" ? ["rm", "-f", resource.id] : ["network", "rm", resource.id];
  if (args.some((arg) => arg === resource.name || PROTECTED_CONTAINER_NAMES.has(arg) || PROTECTED_NETWORK_NAMES.has(arg))) {
    throw refusal("STOP", "DISPOSABLE_CLEANUP_REFUSED", "Disposable cleanup refused a protected name");
  }
  const removed = invoke(args, env);
  if (removed.status !== 0 || removed.signal) {
    throw refusal("STOP", "DISPOSABLE_CLEANUP_FAILED", "Disposable cleanup did not remove an owned resource");
  }
}

function inspectOwned(resource: OwnedDisposable, invoke: OperatorDocker, env: NodeJS.ProcessEnv): "match" | "absent" | "foreign" {
  const format =
    resource.kind === "disposable-restore-container"
      ? `{{.Id}}|{{.Name}}|{{index .Config.Labels "${DISPOSABLE_INVOCATION_LABEL}"}}|{{index .Config.Labels "${DISPOSABLE_ATTEMPT_LABEL}"}}|{{index .Config.Labels "${DISPOSABLE_KIND_LABEL}"}}`
      : `{{.Id}}|{{.Name}}|{{index .Labels "${DISPOSABLE_INVOCATION_LABEL}"}}|{{index .Labels "${DISPOSABLE_ATTEMPT_LABEL}"}}|{{index .Labels "${DISPOSABLE_KIND_LABEL}"}}`;
  const kind = resource.kind === "disposable-restore-container" ? "container" : "network";
  const args = kind === "container" ? ["inspect", "--format", format, resource.id] : ["network", "inspect", "--format", format, resource.id];
  const result = invoke(args, env);
  if (confirmedDockerAbsence(result, kind)) return "absent";
  if (result.signal || result.status !== 0) {
    throw refusal("STOP", "DISPOSABLE_INSPECT_FAILED", "Docker inspect did not prove the disposable resource id");
  }
  const fields = result.stdout.trim().split("|");
  if (fields.length !== 5 || !/^[0-9a-f]{64}$/.test(fields[0] ?? "")) {
    throw refusal("STOP", "DISPOSABLE_INSPECT_FAILED", "Docker inspect output is not a disposable resource record");
  }
  const [id, rawName, invocationId, attemptId, labelKind] = fields;
  const name = (rawName ?? "").replace(/^\//, "");
  if (!id || !rawName || !invocationId || !attemptId || !labelKind) {
    throw refusal("STOP", "DISPOSABLE_INSPECT_FAILED", "Docker inspect output is not a disposable resource record");
  }
  if (invocationId === "<no value>" || attemptId === "<no value>" || labelKind === "<no value>") return "foreign";
  if (PROTECTED_CONTAINER_NAMES.has(name) || PROTECTED_NETWORK_NAMES.has(name)) return "foreign";
  if (id !== resource.id || name !== resource.name || invocationId !== resource.invocationId || attemptId !== resource.attemptId || labelKind !== resource.kind) {
    return "foreign";
  }
  return "match";
}

function assertDisposableNamesFree(request: OperatorRequest, env: NodeJS.ProcessEnv, dockerRun: OperatorDocker | null): void {
  const name = testRestoreName(request.attemptId);
  const networkName = `${testNetworkName(request.attemptId)}-restore`;
  assertNotProtected(name, networkName);
  const invoke = (args: readonly string[], runEnv: NodeJS.ProcessEnv) => invokeDocker(args, runEnv, dockerRun);
  if (dockerNameExists(["container", "inspect", "--format", "{{.Id}}", name], env, invoke, "container")) {
    throw refusal("STOP", "DISPOSABLE_NAME_COLLISION", "A container already uses the disposable restore name");
  }
  if (dockerNameExists(["network", "inspect", "--format", "{{.Id}}", networkName], env, invoke, "network")) {
    throw refusal("STOP", "DISPOSABLE_NAME_COLLISION", "A network already uses the disposable restore name");
  }
}

function assertNotProtected(containerName: string, networkName: string): void {
  if (PROTECTED_CONTAINER_NAMES.has(containerName) || PROTECTED_NETWORK_NAMES.has(networkName)) {
    throw refusal("STOP", "DISPOSABLE_NAME_COLLISION", "Disposable restore names overlap a protected resource");
  }
}

function claimRestoreCredential(
  directory: string,
  envFile: string,
  invocationId: string,
  role: string,
  database: string,
  password: string,
  created: { directory: boolean; owner: boolean; env: boolean },
): void {
  if (secretPathKind(directory) !== "absent") {
    throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Disposable credential directory already exists");
  }
  try {
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Disposable credential directory already exists");
    }
    throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Disposable credential directory could not be created");
  }
  created.directory = true;
  if (secretPathKind(directory) !== "directory") {
    throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Disposable credential directory is not a real directory");
  }
  const ownerPath = path.join(directory, "owner");
  writeExclusiveFile(ownerPath, `${invocationId}\n`);
  created.owner = true;
  writeExclusiveFile(envFile, `POSTGRES_USER=${role}\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=${database}\nPOSTGRES_HOST_AUTH_METHOD=scram-sha-256\n`);
  created.env = true;
}

function writeExclusiveFile(filePath: string, body: string): void {
  if (secretPathKind(filePath) !== "absent") {
    throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Disposable credential file already exists");
  }
  const handle = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(handle, body, { encoding: "utf8" });
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(filePath, 0o600);
  if (secretPathKind(filePath) !== "file") {
    throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Disposable credential file is not a regular file");
  }
}

function releaseOwnedSecret(
  directory: string,
  invocationId: string,
  created: { directory: boolean; owner: boolean; env: boolean },
): void {
  const directoryKind = secretPathKind(directory);
  if (directoryKind === "absent") return;
  if (directoryKind !== "directory") {
    throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Disposable credential directory is no longer a real directory");
  }
  const ownerPath = path.join(directory, "owner");
  const envFile = path.join(directory, "postgres.env");
  if (created.owner) {
    if (secretPathKind(ownerPath) !== "file") {
      throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Disposable credential owner file is not a regular file");
    }
    if (fs.readFileSync(ownerPath, "utf8").trim() !== invocationId) {
      throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Disposable credential directory is not owned by this invocation");
    }
  }
  if (created.env) {
    const envKind = secretPathKind(envFile);
    if (envKind === "symlink" || envKind === "directory" || envKind === "other") {
      throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Disposable credential file is not a regular file");
    }
    if (envKind === "file") fs.rmSync(envFile);
  }
  if (created.owner && secretPathKind(ownerPath) === "file") fs.rmSync(ownerPath);
  if (fs.readdirSync(directory).length > 0) {
    throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Disposable credential directory still holds files");
  }
  if (secretPathKind(directory) !== "directory") {
    throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Disposable credential directory changed before removal");
  }
  fs.rmdirSync(directory);
}

function secretPathKind(target: string): "absent" | "symlink" | "directory" | "file" | "other" {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Disposable credential path could not be classified");
  }
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

export function cleanupEvidenceBody(evidence: {
  primaryCode: string | null;
  cleanupCode: string;
  earlierCleanupCode: string | null;
}): string {
  return `${JSON.stringify({
    kind: "DISPOSABLE_CLEANUP_INCOMPLETE",
    primaryCode: evidence.primaryCode,
    cleanupCode: evidence.cleanupCode,
    earlierCleanupCode: evidence.earlierCleanupCode,
  })}\n`;
}

function writeCleanupEvidence(
  root: string,
  evidence: { primaryCode: string | null; cleanupCode: string; earlierCleanupCode: string | null },
): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, "disposable-cleanup-incomplete.json");
  const handle = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(handle, cleanupEvidenceBody(evidence), "utf8");
  } finally {
    fs.closeSync(handle);
  }
}

class OperatorCleanupError extends RunnerRefusal {
  readonly primaryCode: string | null;

  constructor(code: string, primaryCode: string | null) {
    super("STOP", code, "Disposable cleanup did not finish");
    this.primaryCode = primaryCode;
  }
}

export function mergeOperatorCleanup(primary: AdapterResult, cleanup: unknown): AdapterResult {
  return { ...primary, verdict: "STOP", code: cleanupCodeOf(cleanup) };
}

function cleanupCodeOf(cleanup: unknown): string {
  return cleanup instanceof RunnerRefusal ? cleanup.code : "DISPOSABLE_CLEANUP_FAILED";
}

function acquireOperatorLock(lockPath: string, token: string): { release: () => void } {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle: number;
  try {
    handle = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw refusal("BLOCKED", "CONCURRENT_EXECUTION", "Another operator invocation holds this attempt");
    }
    throw refusal("STOP", "OPERATOR_LOCK_FAILED", "Operator attempt lock could not be created");
  }
  fs.writeFileSync(handle, `${token}\n`, "utf8");
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      fs.closeSync(handle);
      const current = fs.existsSync(lockPath) ? fs.readFileSync(lockPath, "utf8").trim() : "";
      if (current !== token) {
        throw refusal("STOP", "LOST_LOCK", "Operator lock changed before release");
      }
      fs.unlinkSync(lockPath);
    },
  };
}

function dockerNameExists(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  invoke: OperatorDocker,
  kind: "container" | "network",
): boolean {
  const result = invoke(args, env);
  if (result.status === 0 && !result.signal) return true;
  if (confirmedDockerAbsence(result, kind)) return false;
  throw refusal("STOP", "DISPOSABLE_INSPECT_FAILED", "Docker inspect did not prove whether the disposable name exists");
}

function confirmedDockerAbsence(result: OperatorDockerResult, kind: "container" | "network"): boolean {
  if (result.signal || result.status !== 1) return false;
  const stdout = result.stdout.trim();
  if (stdout !== "" && stdout !== "[]") return false;
  const stderr = result.stderr;
  if (/no such file/i.test(stderr)) return false;
  if (kind === "container") return /no such object:/i.test(stderr) || /no such container:/i.test(stderr);
  return /no such object:/i.test(stderr) || /network \S+ not found/i.test(stderr);
}

function requireId(args: readonly string[], env: NodeJS.ProcessEnv, invoke: OperatorDocker): string {
  const raw = requireStdout(args, env, invoke, "DISPOSABLE_START_FAILED").trim();
  const id = raw.split(/\n/).find((line) => /^[0-9a-f]{64}$/.test(line)) ?? "";
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw refusal("STOP", "DISPOSABLE_START_FAILED", "Disposable Docker command did not return a resource id");
  }
  return id;
}

function requireStdout(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  invoke: OperatorDocker | null,
  code: string,
): string {
  const result = invokeDocker(args, env, invoke);
  if (result.status !== 0 || result.signal) {
    throw refusal("STOP", code, "Docker command failed");
  }
  return result.stdout;
}

function observeOneShotImage(env: NodeJS.ProcessEnv, dockerRun: OperatorDocker | null): OneShotImageObservation {
  const tag = invokeDocker(["image", "inspect", "--format", "{{.Id}}", ONE_SHOT_IMAGE], env, dockerRun);
  if (oneShotImageAbsent(tag)) {
    throw refusal("STOP", "ONESHOT_IMAGE_MISSING", "One-shot image is not present on the local daemon");
  }
  if (tag.status !== 0 || tag.signal) {
    throw refusal("STOP", "ONESHOT_IMAGE_UNAVAILABLE", "One-shot image inspect did not return an image id");
  }
  const tagId = tag.stdout.trim();
  const confirmed = invokeDocker(["image", "inspect", "--format", "{{.Id}}", tagId], env, dockerRun);
  if (oneShotImageAbsent(confirmed)) {
    throw refusal("STOP", "ONESHOT_IMAGE_MISSING", "One-shot image id is not present on the local daemon");
  }
  if (confirmed.status !== 0 || confirmed.signal) {
    throw refusal("STOP", "ONESHOT_IMAGE_UNAVAILABLE", "One-shot image id inspect did not return an image id");
  }
  return { tagId, idInspect: confirmed.stdout.trim() };
}

function oneShotImageAbsent(result: OperatorDockerResult): boolean {
  if (result.signal || result.status !== 1) return false;
  if (/no such file/i.test(result.stderr)) return false;
  return /no such image/i.test(result.stderr);
}

function invokeDocker(args: readonly string[], env: NodeJS.ProcessEnv, invoke: OperatorDocker | null): OperatorDockerResult {
  if (invoke) return invoke(args, env);
  const child: SpawnSyncReturns<string> = spawnSync("docker", [...args], {
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { status: child.status, signal: child.signal, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

function dockerRunAdapter(invoke: OperatorDocker): (args: readonly string[], env: NodeJS.ProcessEnv) => string {
  return (args, env) => {
    const result = invoke(args, env);
    if (result.status !== 0 || result.signal) {
      throw refusal("STOP", "DOCKER_ENDPOINT_UNTRUSTED", "Docker endpoint could not be resolved");
    }
    return result.stdout;
  };
}

function assertAttempt(attemptId: string): void {
  if (!ATTEMPT_ID.test(attemptId)) {
    throw refusal("STOP", "ATTEMPT_REQUIRED", "Operator attempt id is not a 16 hex binding");
  }
}

function fromError(error: unknown, request: OperatorRequest): AdapterResult {
  if (error instanceof RunnerRefusal) {
    return stopped(error.verdict, error.code, phaseFor(request.command), request.scope, request.attemptId);
  }
  return stopped("STOP", "RUNTIME_UNAUTHENTICATED", phaseFor(request.command), request.scope, request.attemptId);
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
  attemptId: string,
): AdapterResult {
  return {
    verdict,
    code,
    phase,
    spawned: false,
    retryAttempted: false,
    attemptId,
    imageGitSha: IMAGE_GIT_SHA,
    oneShotImageId: null,
    targetClass: scope === "PRODUCTION" ? "PRODUCTION" : "TEST_OWNED_NOT_PRODUCTION",
    appUnchanged: null,
    dossierSha256: null,
    recoverySha256: null,
    recoveryEvidence: "NONE",
    signingInputs: "NOT_SIGNABLE",
  };
}

export const OBSERVED_PRODUCTION_TOPOLOGY = {
  networkName: PRODUCTION_NETWORK_NAME,
  dnsAlias: PRODUCTION_DNS_ALIAS,
  databaseName: PRODUCTION_DATABASE_NAME,
  roleName: PRODUCTION_ROLE_NAME,
} as const;
