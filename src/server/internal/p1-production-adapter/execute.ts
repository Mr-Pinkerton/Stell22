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
import { verifyExplicitAuthorization } from "@/server/internal/p1-production-adapter/authorization";
import {
  IMAGE_GIT_SHA,
  type AdapterIntent,
  type AdapterScope,
  type ExecutionPhase,
} from "@/server/internal/p1-production-adapter/contract";
import {
  authenticateTarget,
  dossierDigest,
  sameAppIdentity,
  type TargetDeclaration,
  type TargetFacts,
} from "@/server/internal/p1-production-adapter/identity";
import { planProductionOneShot } from "@/server/internal/p1-production-adapter/oneshot";
import {
  recheckArchiveSha,
  verifyReleaseRecovery,
  type RecoverySnapshot,
} from "@/server/internal/p1-production-adapter/recovery";

export type AdapterResult = {
  verdict: "PREFLIGHT_ONLY" | "RECOVERY_VERIFIED" | "ALREADY_APPLIED" | "STOP" | "BLOCKED";
  code: string;
  phase: ExecutionPhase;
  spawned: boolean;
  retryAttempted: false;
  imageGitSha: typeof IMAGE_GIT_SHA;
  targetClass: "PRODUCTION" | "TEST_OWNED_NOT_PRODUCTION";
  appUnchanged: boolean | null;
  dossierSha256: string | null;
  recoverySha256: string | null;
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

export type OneShotResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
};

export type AdapterDependencies = {
  productionDaemonPin: string | null;
  git: GitBlobSource;
  destinationRoot: string;
  lockPath: string;
  env: Readonly<Record<string, string | undefined>>;
  inspect: () => TargetFacts;
  readHistory: () => readonly PrismaMigrationRow[];
  readSchema: () => P1SchemaEvidence;
  readArchive: () => Buffer;
  readLiveRecovery: () => RecoverySnapshot;
  readRestoredRecovery: () => RecoverySnapshot & { exitCode: number };
  readLockOwner: () => string | null;
  spawnOneShot: (plan: { argv: readonly string[] }) => OneShotResult;
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
  let credentialDir: string | null = null;
  const targetClass = request.scope === "PRODUCTION" ? "PRODUCTION" : "TEST_OWNED_NOT_PRODUCTION";
  try {
    if (request.databaseUrl !== undefined) {
      throw refusal("STOP", "DATABASE_URL_REJECTED", "A caller connection string is not target authority");
    }
    if (request.scope === "PRODUCTION" && deps.env.GITHUB_ACTIONS === "true") {
      throw refusal("STOP", "PRODUCTION_SCOPE_FORBIDDEN_IN_CI", "Production scope is refused in GitHub Actions");
    }
    const observed = failClosed(() => deps.inspect(), "RUNTIME_UNAUTHENTICATED", "Runtime inspect failed");
    authenticateTarget({
      scope: request.scope,
      declared: request.declared,
      observed,
      productionDaemonPin: deps.productionDaemonPin,
    });
    const dossierSha256 = dossierDigest(observed);
    if (fs.existsSync(markerPath(deps.destinationRoot))) {
      return result("BLOCKED", "AMBIGUOUS_COMPLETION", "POSTCHECK", false, null, targetClass, dossierSha256, null);
    }
    const before = classifyP1State({ history: deps.readHistory(), schema: deps.readSchema() });
    if (before.verdict === "ALREADY_APPLIED") {
      const again = deps.inspect();
      if (!sameAppIdentity(observed.app, again.app) || again.db.id !== observed.db.id) {
        return result("BLOCKED", "APP_IDENTITY_CHANGED", "POSTCHECK", false, false, targetClass, dossierSha256, null);
      }
      return result("ALREADY_APPLIED", before.code, "READ_ONLY_PREFLIGHT", false, true, targetClass, dossierSha256, null);
    }
    if (before.verdict === "STOP" || before.verdict === "BLOCKED") {
      return result(before.verdict, before.code, "READ_ONLY_PREFLIGHT", false, null, targetClass, dossierSha256, null);
    }
    if (request.intent === "PREFLIGHT") {
      return result("PREFLIGHT_ONLY", "PREFLIGHT_RECORDED", "READ_ONLY_PREFLIGHT", false, null, targetClass, dossierSha256, null);
    }
    const restored = deps.readRestoredRecovery();
    const recovery = verifyReleaseRecovery({
      witness: request.recoveryWitness,
      archive: deps.readArchive(),
      live: deps.readLiveRecovery(),
      restored,
      restoreExitCode: restored.exitCode,
      attemptId: request.attemptId,
      source: observed.db,
      databaseName: observed.databaseName,
      roleName: observed.roleName,
    });
    recheckArchiveSha(deps.readArchive(), recovery.archiveSha256);
    if (request.intent === "RECOVERY") {
      return result(
        "RECOVERY_VERIFIED",
        "RECOVERY_VERIFIED",
        "RECOVERY_VERIFICATION",
        false,
        null,
        targetClass,
        dossierSha256,
        recovery.recoverySha256,
      );
    }
    verifyExplicitAuthorization(request.authorization, {
      scope: request.scope,
      attemptId: request.attemptId,
      dossierSha256,
      recoverySha256: recovery.recoverySha256,
      daemonId: observed.daemonId,
    });
    lock = acquireHostLock(deps.lockPath, request.attemptId);
    const locked = deps.readLockOwner()?.trim() ?? null;
    if (locked !== request.attemptId) {
      throw refusal("STOP", "LOST_LOCK", "The host lock is no longer held for this attempt");
    }
    const immediate = failClosed(() => deps.inspect(), "RUNTIME_UNAUTHENTICATED", "Runtime inspect failed before the one-shot");
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
        recovery.recoverySha256,
      );
    }
    recheckArchiveSha(deps.readArchive(), recovery.archiveSha256);
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
    credentialDir = path.join(path.dirname(deps.destinationRoot), "p1-production-credentials");
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
    });
    const stillLocked = deps.readLockOwner()?.trim() ?? null;
    if (stillLocked !== request.attemptId) {
      throw refusal("STOP", "LOST_LOCK", "The host lock disappeared before the one-shot");
    }
    spawned = true;
    let spawnResult: OneShotResult;
    try {
      spawnResult = deps.spawnOneShot(plan);
    } catch {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot, targetClass, dossierSha256);
    }
    if (spawnResult.status === null || spawnResult.signal) {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot, targetClass, dossierSha256);
    }
    if (spawnResult.status !== 0) {
      return record("STOP", "PRISMA_DEPLOY_FAILED", deps.destinationRoot, targetClass, dossierSha256);
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
        return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot, targetClass, dossierSha256);
      }
      const finalFacts = deps.inspect();
      if (!sameAppIdentity(observed.app, finalFacts.app) || finalFacts.db.id !== observed.db.id) {
        return record("BLOCKED", "APP_IDENTITY_CHANGED", deps.destinationRoot, targetClass, dossierSha256);
      }
      return result(
        "ALREADY_APPLIED",
        after.code,
        "POSTCHECK",
        true,
        true,
        targetClass,
        dossierSha256,
        recovery.recoverySha256,
      );
    } catch {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot, targetClass, dossierSha256);
    }
  } catch (error) {
    if (spawned) {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot, targetClass, null);
    }
    if (error instanceof RunnerRefusal) {
      return result(error.verdict, error.code, phaseFor(request.intent), false, null, targetClass, null, null);
    }
    throw error;
  } finally {
    lock?.release();
    if (credentialDir) fs.rmSync(credentialDir, { recursive: true, force: true });
  }
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

function result(
  verdict: AdapterResult["verdict"],
  code: string,
  phase: ExecutionPhase,
  spawned: boolean,
  appUnchanged: boolean | null,
  targetClass: AdapterResult["targetClass"],
  dossierSha256: string | null,
  recoverySha256: string | null,
): AdapterResult {
  return {
    verdict,
    code,
    phase,
    spawned,
    retryAttempted: false,
    imageGitSha: IMAGE_GIT_SHA,
    targetClass,
    appUnchanged,
    dossierSha256,
    recoverySha256,
  };
}

function record(
  verdict: AdapterResult["verdict"],
  code: string,
  root: string,
  targetClass: AdapterResult["targetClass"],
  dossierSha256: string | null,
): AdapterResult {
  try {
    fs.mkdirSync(root, { recursive: true });
    const target = markerPath(root);
    if (!fs.existsSync(target)) fs.writeFileSync(target, `${code}\n`, { flag: "wx" });
  } catch {
    return result("BLOCKED", "AMBIGUOUS_COMPLETION_UNRECORDED", "POSTCHECK", true, null, targetClass, dossierSha256, null);
  }
  return result(verdict, code, "POSTCHECK", true, code === "APP_IDENTITY_CHANGED" ? false : null, targetClass, dossierSha256, null);
}

function markerPath(root: string): string {
  return path.join(path.dirname(root), `${path.basename(root)}.production-adapter-ambiguous-stop`);
}
