import fs from "node:fs";
import path from "node:path";
import { EXPECTED_MIGRATION_SQL_COUNT } from "@/server/internal/p1-isolated-runner/contract";
import { classifyP1State, type PrismaMigrationRow } from "@/server/internal/p1-isolated-runner/classify";
import type { GitBlobSource } from "@/server/internal/p1-isolated-runner/migration-set";
import {
  hashMaterializedRoot,
  materializeMigrationSet,
  revalidateMigrationSet,
} from "@/server/internal/p1-isolated-runner/migration-set";
import { verifyPinnedHistoricalPlusP1 } from "@/server/internal/p1-isolated-runner/p1-release-gate";
import { acquireHostLock } from "@/server/internal/p1-isolated-runner/lock";
import { refusal, RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";
import type { P1SchemaEvidence } from "@/server/internal/p1-isolated-runner/schema-contract";
import {
  fileReplayStore,
  isDurableReplayStore,
  readInstalledSignedAuthorization,
  readInstalledTrustPublicKey,
  verifySignedAuthorization,
  type ReplayStore,
} from "@/server/internal/p1-production-adapter/authorization";
import { resolveDockerSession, type DockerSession, type VolumeMount } from "@/server/internal/p1-production-adapter/docker-runtime";
import { executeTrustedRestore, isTrustedRestoreEvidence, type RestoreContainerFact } from "@/server/internal/p1-production-adapter/restore-controller";
import {
  IMAGE_GIT_SHA,
  type AdapterIntent,
  type AdapterScope,
  type ExecutionPhase,
} from "@/server/internal/p1-production-adapter/contract";
import {
  authenticateTarget,
  canonicalJson,
  dossierDigest,
  sameAppIdentity,
  type TargetDeclaration,
  type TargetFacts,
} from "@/server/internal/p1-production-adapter/identity";
import { acceptOneShotImage, planProductionOneShot, releaseProductionCredential, type OneShotImageObservation } from "@/server/internal/p1-production-adapter/oneshot";
import { IMAGE_ID, SHA256 } from "@/server/internal/p1-production-adapter/contract";
import {
  loadPersistedReleaseBackup,
  readClaimedWitness,
  recheckArchiveSha,
  type RecoverySnapshot,
} from "@/server/internal/p1-production-adapter/recovery";

export type RecoveryEvidenceState = "NONE" | "VERIFIED";
export type SigningInputsState = "NOT_SIGNABLE" | "INCOMPLETE" | "COMPLETE";

export type AdapterResult = {
  verdict: "PREFLIGHT_ONLY" | "RECOVERY_VERIFIED" | "ALREADY_APPLIED" | "STOP" | "BLOCKED";
  code: string;
  phase: ExecutionPhase;
  attemptId: string;
  spawned: boolean;
  retryAttempted: false;
  imageGitSha: typeof IMAGE_GIT_SHA;
  oneShotImageId: string | null;
  targetClass: "PRODUCTION" | "TEST_OWNED_NOT_PRODUCTION";
  appUnchanged: boolean | null;
  dossierSha256: string | null;
  recoverySha256: string | null;
  recoveryEvidence: RecoveryEvidenceState;
  signingInputs: SigningInputsState;
};

export type AdapterRequest = {
  intent: AdapterIntent;
  scope: AdapterScope;
  attemptId: string;
  declared: TargetDeclaration;
  databasePassword?: string;
  databaseUrl?: unknown;
  authorization?: unknown;
  recoveryWitness?: unknown;
};

export type OneShotPlan = {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
};

export type OneShotResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
};

export type AdapterDependencies = {
  productionDaemonPin: string | null;
  /** Production image id from the installed pin. Null refuses production before spawn. */
  productionOneShotImagePin: string | null;
  /** Test-owned approved image id. Production ignores this and uses the pin. */
  approvedOneShotImageId: string | null;
  /** Local daemon observation of the mutable tag and of that image id. */
  inspectOneShotImage: () => OneShotImageObservation;
  git: GitBlobSource;
  destinationRoot: string;
  lockPath: string;
  env: Readonly<Record<string, string | undefined>>;
  inspect: () => TargetFacts;
  readHistory: () => readonly PrismaMigrationRow[];
  readSchema: () => P1SchemaEvidence;
  readArchive: () => Buffer;
  backupDirectory: string;
  readLiveRecovery: () => RecoverySnapshot;
  inspectSourceMounts: () => readonly VolumeMount[];
  inspectRestore: () => RestoreContainerFact;
  runRestore: (containerId: string, sql: Buffer) => number;
  readRestoredCatalog: (containerId: string) => RecoverySnapshot;
  readLockOwner: () => string | null;
  /**
   * Test-owned scope may inject a Docker resolver or a test trust key.
   * Production scope ignores both and uses the real resolver and the fixed trust path.
   */
  resolveDockerSession?: (env: Readonly<Record<string, string | undefined>>) => DockerSession;
  testTrustPublicKey?: string;
  replay?: ReplayStore;
  spawnOneShot: (plan: OneShotPlan) => OneShotResult;
  /** Test-owned crash injection. Production ignores it. */
  abortBeforeSpawn?: boolean;
};

/**
 * P1-only production adapter.
 * PREFLIGHT and RECOVERY never spawn Prisma.
 * APPLY spawns one pinned migrate after target, recovery, and owner authorization match.
 * An ambiguous spawn is not retried.
 */
export function executeProductionAdapter(request: AdapterRequest, deps: AdapterDependencies): AdapterResult {
  let spawned = false;
  let lock: { release: () => void } | null = null;
  let credentialOwner: { directory: string; ownerToken: string } | null = null;
  const targetClass = request.scope === "PRODUCTION" ? "PRODUCTION" : "TEST_OWNED_NOT_PRODUCTION";
  try {
    if (request.databaseUrl !== undefined) {
      throw refusal("STOP", "DATABASE_URL_REJECTED", "A caller connection string is not target authority");
    }
    if (request.scope === "PRODUCTION" && deps.env.GITHUB_ACTIONS === "true") {
      throw refusal("STOP", "PRODUCTION_SCOPE_FORBIDDEN_IN_CI", "Production scope is refused in GitHub Actions");
    }
    if (hasShortcut(request.authorization)) {
      throw refusal("STOP", "SHORTCUT_AUTHORIZATION", "A flag cannot authorize production apply");
    }
    const resolve = request.scope === "PRODUCTION" ? resolveDockerSession : (deps.resolveDockerSession ?? resolveDockerSession);
    const session = resolve(deps.env);
    const observed = failClosed(() => deps.inspect(), "RUNTIME_UNAUTHENTICATED", "Runtime inspect failed");
    if (observed.daemonId !== session.daemonId) {
      throw refusal("STOP", "DAEMON_IDENTITY_CHANGED", "Observed daemon does not match the resolved Docker endpoint");
    }
    authenticateTarget({
      scope: request.scope,
      declared: request.declared,
      observed,
      productionDaemonPin: deps.productionDaemonPin,
    });
    const oneShotImageId = resolveOneShotImage(request.scope, deps, null);
    const dossierSha256 = dossierDigest(observed, oneShotImageId);
    if (pathKind(markerPath(deps.destinationRoot)) !== "absent") {
      return result("BLOCKED", "AMBIGUOUS_COMPLETION", "POSTCHECK", false, null, targetClass, dossierSha256, null, request.attemptId, oneShotImageId, "NONE");
    }
    if (pathKind(productionSpawnIntentPath(deps.destinationRoot)) !== "absent") {
      return result("BLOCKED", "SPAWN_INTENT_UNCERTAIN", "POSTCHECK", false, null, targetClass, dossierSha256, null, request.attemptId, oneShotImageId, "NONE");
    }
    const before = classifyP1State({ history: deps.readHistory(), schema: deps.readSchema() });
    if (before.verdict === "ALREADY_APPLIED") {
      const again = deps.inspect();
      if (!sameAppIdentity(observed.app, again.app) || again.db.id !== observed.db.id) {
        return result("BLOCKED", "APP_IDENTITY_CHANGED", "POSTCHECK", false, false, targetClass, dossierSha256, null, request.attemptId, oneShotImageId, "NONE");
      }
      return result("ALREADY_APPLIED", before.code, "READ_ONLY_PREFLIGHT", false, true, targetClass, dossierSha256, null, request.attemptId, oneShotImageId, "NONE");
    }
    if (before.verdict === "STOP" || before.verdict === "BLOCKED") {
      return result(before.verdict, before.code, "READ_ONLY_PREFLIGHT", false, null, targetClass, dossierSha256, null, request.attemptId, oneShotImageId, "NONE");
    }
    if (request.intent === "PREFLIGHT") {
      return result("PREFLIGHT_ONLY", "PREFLIGHT_RECORDED", "READ_ONLY_PREFLIGHT", false, null, targetClass, dossierSha256, null, request.attemptId, oneShotImageId, "NONE");
    }
    if (request.intent === "APPLY" && request.scope === "PRODUCTION" && readInstalledTrustPublicKey() === null) {
      throw refusal(
        "STOP",
        "PRODUCTION_TRUST_UNPROVISIONED",
        "Production apply has no independently provisioned owner trust key",
      );
    }
    const claimed = readClaimedWitness(request.recoveryWitness);
    const persisted = loadPersistedReleaseBackup(deps.backupDirectory);
    if (canonicalJson(claimed) !== canonicalJson(persisted.witness)) {
      throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "A caller witness is not the persisted release backup");
    }
    if (!persisted.archive.equals(deps.readArchive())) {
      throw refusal("STOP", "CHECKSUM_DRIFT", "Archive bytes do not match the persisted release backup");
    }
    const evidence = executeTrustedRestore({
      attemptId: request.attemptId,
      archive: persisted.archive,
      source: observed.db,
      sourceMounts: deps.inspectSourceMounts(),
      databaseName: observed.databaseName,
      roleName: observed.roleName,
      live: deps.readLiveRecovery(),
      claimed: persisted.witness,
      inspectRestore: deps.inspectRestore,
      runRestore: deps.runRestore,
      readRestored: deps.readRestoredCatalog,
    });
    if (!isTrustedRestoreEvidence(evidence)) {
      throw refusal("STOP", "FORGED_RESTORE_EVIDENCE", "Restore evidence was not produced by the restore controller");
    }
    recheckArchiveSha(deps.readArchive(), evidence.archiveSha256);
    if (request.intent === "RECOVERY") {
      return result(
        "RECOVERY_VERIFIED",
        "RECOVERY_VERIFIED",
        "RECOVERY_VERIFICATION",
        false,
        null,
        targetClass,
        dossierSha256,
        evidence.recoverySha256,
        request.attemptId,
        oneShotImageId,
        "VERIFIED",
      );
    }
    lock = acquireHostLock(deps.lockPath, request.attemptId);
    const locked = deps.readLockOwner()?.trim() ?? null;
    if (locked !== request.attemptId) {
      throw refusal("STOP", "LOST_LOCK", "The host lock is no longer held for this attempt");
    }
    const immediate = failClosed(() => deps.inspect(), "RUNTIME_UNAUTHENTICATED", "Runtime inspect failed before the one-shot");
    if (immediate.daemonId !== session.daemonId) {
      throw refusal("STOP", "DAEMON_IDENTITY_CHANGED", "Observed daemon does not match the resolved Docker endpoint");
    }
    authenticateTarget({
      scope: request.scope,
      declared: request.declared,
      observed: immediate,
      productionDaemonPin: deps.productionDaemonPin,
    });
    const again = classifyP1State({ history: deps.readHistory(), schema: deps.readSchema() });
    if (again.verdict === "STOP" || again.verdict === "BLOCKED" || again.verdict === "ALREADY_APPLIED") {
      return result(
        again.verdict === "ALREADY_APPLIED" ? "ALREADY_APPLIED" : again.verdict,
        again.code,
        "P1_ONLY_APPLY",
        false,
        null,
        targetClass,
        dossierSha256,
        evidence.recoverySha256,
        request.attemptId,
        oneShotImageId,
        "VERIFIED",
      );
    }
    const rebound = resolve(deps.env);
    if (rebound.endpoint !== session.endpoint) {
      throw refusal("STOP", "DOCKER_ENDPOINT_CHANGED", "Docker endpoint changed before the one-shot");
    }
    if (rebound.daemonId !== session.daemonId) {
      throw refusal("STOP", "DAEMON_IDENTITY_CHANGED", "Docker daemon identity changed before the one-shot");
    }
    recheckArchiveSha(deps.readArchive(), evidence.archiveSha256);
    verifyPinnedHistoricalPlusP1(deps.git);
    const set = materializeMigrationSet(deps.git, deps.destinationRoot);
    const observedDigest = hashMaterializedRoot(set.root);
    if (observedDigest !== set.digest) {
      throw refusal("STOP", "PREFLIGHT_DRIFT", "Materialized migration digest drifted");
    }
    revalidateMigrationSet(set);
    if (!request.databasePassword) {
      throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Database credential is not usable");
    }
    const credentialDir = path.join(path.dirname(deps.destinationRoot), "p1-production-credentials");
    const plan = planProductionOneShot({
      networkName: immediate.networkName,
      dnsAlias: immediate.dnsAlias,
      databaseName: immediate.databaseName,
      roleName: immediate.roleName,
      password: request.databasePassword,
      sealedRoot: set.root,
      credentialDir,
      appContainerId: immediate.app.id,
      appContainerName: immediate.app.name,
      dbContainerName: immediate.db.name,
      imageId: oneShotImageId,
      ownerToken: request.attemptId,
    });
    credentialOwner = { directory: credentialDir, ownerToken: request.attemptId };
    const stillLocked = deps.readLockOwner()?.trim() ?? null;
    if (stillLocked !== request.attemptId) {
      throw refusal("STOP", "LOST_LOCK", "The host lock disappeared before the one-shot");
    }
    resolveOneShotImage(request.scope, deps, oneShotImageId);
    writeSpawnIntent(deps.destinationRoot, request.attemptId);
    try {
      authorize(request, deps, {
        dossierSha256,
        recoverySha256: evidence.recoverySha256,
        daemonId: observed.daemonId,
      });
    } catch (error) {
      removeOwnedSpawnIntent(deps.destinationRoot, request.attemptId);
      throw error;
    }
    if (request.scope === "TEST_OWNED" && deps.abortBeforeSpawn === true) {
      return result("BLOCKED", "SPAWN_INTENT_UNCERTAIN", "POSTCHECK", false, null, targetClass, dossierSha256, null, request.attemptId, oneShotImageId, "NONE");
    }
    spawned = true;
    let spawnResult: OneShotResult;
    try {
      spawnResult = deps.spawnOneShot({ argv: plan.argv, env: rebound.env });
    } catch {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot, targetClass, dossierSha256, request.attemptId, oneShotImageId);
    }
    if (spawnResult.status === null || spawnResult.signal) {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot, targetClass, dossierSha256, request.attemptId, oneShotImageId);
    }
    if (spawnResult.status !== 0) {
      return record("STOP", "PRISMA_DEPLOY_FAILED", deps.destinationRoot, targetClass, dossierSha256, request.attemptId, oneShotImageId);
    }
    try {
      revalidateMigrationSet(set);
      const history = deps.readHistory();
      const after = classifyP1State({ history, schema: deps.readSchema() });
      const successful = history.filter(
        (row) =>
          row.startedAt !== null &&
          row.finishedAt !== null &&
          row.rolledBackAt === null &&
          row.appliedStepsCount === 1,
      );
      if (after.verdict !== "ALREADY_APPLIED" || successful.length !== EXPECTED_MIGRATION_SQL_COUNT) {
        return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot, targetClass, dossierSha256, request.attemptId, oneShotImageId);
      }
      const finalFacts = deps.inspect();
      if (!sameAppIdentity(observed.app, finalFacts.app) || finalFacts.db.id !== observed.db.id) {
        return record("BLOCKED", "APP_IDENTITY_CHANGED", deps.destinationRoot, targetClass, dossierSha256, request.attemptId, oneShotImageId);
      }
      removeOwnedSpawnIntent(deps.destinationRoot, request.attemptId);
      return result(
        "ALREADY_APPLIED",
        after.code,
        "POSTCHECK",
        true,
        true,
        targetClass,
        dossierSha256,
        evidence.recoverySha256,
        request.attemptId,
        oneShotImageId,
        "VERIFIED",
      );
    } catch {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot, targetClass, dossierSha256, request.attemptId, oneShotImageId);
    }
  } catch (error) {
    if (spawned) {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot, targetClass, null, request.attemptId, null);
    }
    if (error instanceof RunnerRefusal) {
      return result(error.verdict, error.code, phaseFor(request.intent), false, null, targetClass, null, null, request.attemptId, null, "NONE");
    }
    throw error;
  } finally {
    let cleanupFailure: AdapterResult | null = null;
    if (credentialOwner) {
      try {
        releaseProductionCredential(credentialOwner.directory, credentialOwner.ownerToken);
      } catch (error) {
        cleanupFailure = result(
          "STOP",
          error instanceof RunnerRefusal ? error.code : "SECRET_CLEANUP_FAILED",
          "POSTCHECK",
          spawned,
          null,
          targetClass,
          null,
          null,
          request.attemptId,
          null,
          "NONE",
        );
      }
    }
    lock?.release();
    if (cleanupFailure) return cleanupFailure;
  }
}

function authorize(
  request: AdapterRequest,
  deps: AdapterDependencies,
  expected: { dossierSha256: string; recoverySha256: string; daemonId: string },
): void {
  if (request.scope === "PRODUCTION") {
    const trust = readInstalledTrustPublicKey();
    if (trust === null) {
      throw refusal(
        "STOP",
        "PRODUCTION_TRUST_UNPROVISIONED",
        "Production apply has no independently provisioned owner trust key",
      );
    }
    const installed = readInstalledSignedAuthorization();
    if (installed === undefined) {
      throw refusal("STOP", "AUTHORIZATION_REQUIRED", "Production apply has no installed signed authorization");
    }
    verifySignedAuthorization(
      installed,
      trust,
      {
        scope: "PRODUCTION",
        attemptId: request.attemptId,
        dossierSha256: expected.dossierSha256,
        recoverySha256: expected.recoverySha256,
        daemonId: expected.daemonId,
      },
      fileReplayStore(),
    );
    return;
  }
  if (!deps.testTrustPublicKey) {
    throw refusal("STOP", "AUTHORIZATION_REQUIRED", "Test-owned apply has no isolated trust key");
  }
  if (!deps.replay || !isDurableReplayStore(deps.replay)) {
    throw refusal("STOP", "AUTHORIZATION_REPLAY_UNAVAILABLE", "Test-owned apply has no durable replay store");
  }
  verifySignedAuthorization(
    request.authorization,
    deps.testTrustPublicKey,
    {
      scope: request.scope,
      attemptId: request.attemptId,
      dossierSha256: expected.dossierSha256,
      recoverySha256: expected.recoverySha256,
      daemonId: expected.daemonId,
    },
    deps.replay,
  );
}

function hasShortcut(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = new Set(["authorized", "allowProduction", "force", "yes", "approve", "bypass"]);
  return Object.keys(value as Record<string, unknown>).some((key) => keys.has(key));
}

function phaseFor(intent: AdapterIntent): ExecutionPhase {
  if (intent === "PREFLIGHT") return "READ_ONLY_PREFLIGHT";
  if (intent === "RECOVERY") return "RECOVERY_VERIFICATION";
  return "EXPLICIT_AUTHORIZATION";
}

function failClosed<T>(fn: () => T, code: string, message: string): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RunnerRefusal) throw error;
    throw refusal("STOP", code, message);
  }
}

function resolveOneShotImage(scope: AdapterRequest["scope"], deps: AdapterDependencies, previouslyBound: string | null): string {
  const expected = scope === "PRODUCTION" ? deps.productionOneShotImagePin : deps.approvedOneShotImageId;
  if (expected === null || !IMAGE_ID.test(expected)) {
    throw refusal(
      "STOP",
      scope === "PRODUCTION" ? "ONESHOT_IMAGE_UNPINNED" : "ONESHOT_IMAGE_UNAPPROVED",
      scope === "PRODUCTION"
        ? "Production one-shot image id is not independently pinned"
        : "Test-owned one-shot image id is not approved",
    );
  }
  return acceptOneShotImage(deps.inspectOneShotImage(), previouslyBound ?? expected, previouslyBound);
}

function result(
  verdict: AdapterResult["verdict"],
  code: string,
  phase: ExecutionPhase,
  spawned: boolean,
  appUnchanged: boolean | null,
  targetClass: AdapterResult["targetClass"],
  dossierSha256: string | null,
  recoverySha256: string | null,
  attemptId: string,
  oneShotImageId: string | null,
  recoveryEvidence: RecoveryEvidenceState,
): AdapterResult {
  const publishedRecovery = recoveryEvidence === "VERIFIED" ? recoverySha256 : null;
  return {
    verdict,
    code,
    phase,
    attemptId,
    spawned,
    retryAttempted: false,
    imageGitSha: IMAGE_GIT_SHA,
    oneShotImageId: oneShotImageId !== null && IMAGE_ID.test(oneShotImageId) ? oneShotImageId : null,
    targetClass,
    appUnchanged,
    dossierSha256,
    recoverySha256: publishedRecovery,
    recoveryEvidence,
    signingInputs: signingInputsFor(verdict, dossierSha256, publishedRecovery, recoveryEvidence),
  };
}

function signingInputsFor(
  verdict: AdapterResult["verdict"],
  dossierSha256: string | null,
  recoverySha256: string | null,
  recoveryEvidence: RecoveryEvidenceState,
): SigningInputsState {
  if (verdict === "STOP" || verdict === "BLOCKED") return "NOT_SIGNABLE";
  const dossierReady = dossierSha256 !== null && SHA256.test(dossierSha256);
  const recoveryReady = recoveryEvidence === "VERIFIED" && recoverySha256 !== null && SHA256.test(recoverySha256);
  if (dossierReady && recoveryReady) return "COMPLETE";
  if (dossierReady) return "INCOMPLETE";
  return "NOT_SIGNABLE";
}

function record(
  verdict: AdapterResult["verdict"],
  code: string,
  root: string,
  targetClass: AdapterResult["targetClass"],
  dossierSha256: string | null,
  attemptId: string,
  oneShotImageId: string | null,
): AdapterResult {
  try {
    fs.mkdirSync(root, { recursive: true });
    const target = markerPath(root);
    if (!fs.existsSync(target)) fs.writeFileSync(target, `${code}\n`, { flag: "wx" });
  } catch {
    return result("BLOCKED", "AMBIGUOUS_COMPLETION_UNRECORDED", "POSTCHECK", true, null, targetClass, dossierSha256, null, attemptId, oneShotImageId, "NONE");
  }
  return result(verdict, code, "POSTCHECK", true, code === "APP_IDENTITY_CHANGED" ? false : null, targetClass, dossierSha256, null, attemptId, oneShotImageId, "NONE");
}

export function productionSpawnIntentPath(root: string): string {
  return path.join(path.dirname(root), `${path.basename(root)}.production-adapter-spawn-intent`);
}

function markerPath(root: string): string {
  return path.join(path.dirname(root), `${path.basename(root)}.production-adapter-ambiguous-stop`);
}

function writeSpawnIntent(root: string, attemptId: string): void {
  const target = productionSpawnIntentPath(root);
  if (pathKind(target) !== "absent") {
    throw refusal("BLOCKED", "SPAWN_INTENT_UNCERTAIN", "A spawn intent marker already exists");
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const handle = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify({ kind: "P1_SPAWN_INTENT", attemptId, phase: "BEFORE_SPAWN" })}\n`, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function removeOwnedSpawnIntent(root: string, attemptId: string): void {
  const target = productionSpawnIntentPath(root);
  const kind = pathKind(target);
  if (kind === "absent") return;
  if (kind !== "file") {
    throw refusal("BLOCKED", "SPAWN_INTENT_UNCERTAIN", "Spawn intent marker is not a regular file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch {
    throw refusal("BLOCKED", "SPAWN_INTENT_UNCERTAIN", "Spawn intent marker is not readable");
  }
  const attempt = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { attemptId?: unknown }).attemptId : null;
  if (attempt !== attemptId) {
    throw refusal("BLOCKED", "SPAWN_INTENT_UNCERTAIN", "Spawn intent marker belongs to another attempt");
  }
  fs.unlinkSync(target);
}

function pathKind(target: string): "absent" | "symlink" | "directory" | "file" | "other" {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw refusal("BLOCKED", "SPAWN_INTENT_UNCERTAIN", "Spawn intent path could not be classified");
  }
}
