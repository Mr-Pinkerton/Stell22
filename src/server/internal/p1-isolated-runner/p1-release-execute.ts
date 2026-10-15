import fs from "node:fs";
import path from "node:path";
import { EXECUTION_POLICY, EXPECTED_MIGRATION_SQL_COUNT } from "@/server/internal/p1-isolated-runner/contract";
import { classifyP1State, type PrismaMigrationRow } from "@/server/internal/p1-isolated-runner/classify";
import { acquireHostLock } from "@/server/internal/p1-isolated-runner/lock";
import {
  hashMaterializedRoot,
  materializeMigrationSet,
  revalidateMigrationSet,
  type GitBlobSource,
} from "@/server/internal/p1-isolated-runner/migration-set";
import {
  IMAGE_GIT_SHA,
  ONE_SHOT_IMAGE,
  authenticateTopology,
  bindRecovery,
  sameAppIdentity,
  verifyPinnedHistoricalPlusP1,
  type CatalogProbe,
  type RestoredProbe,
  type TopologyObservation,
} from "@/server/internal/p1-isolated-runner/p1-release-gate";
import { refusal, RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";
import type { P1SchemaEvidence } from "@/server/internal/p1-isolated-runner/schema-contract";

export const ONE_SHOT_COMMAND = [
  "/opt/migrator/node_modules/prisma/build/index.js",
  "migrate",
  "deploy",
  "--schema",
  "/sealed/prisma/schema.prisma",
] as const;

export type OneShotPlan = {
  argv: readonly string[];
  appContainerId: string;
};

export type OneShotResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
};

export type ReleaseResult = {
  verdict: "ALREADY_APPLIED" | "STOP" | "BLOCKED";
  code: string;
  spawned: boolean;
  retryAttempted: false;
  imageGitSha: typeof IMAGE_GIT_SHA;
  appUnchanged: boolean | null;
};

export type ReleaseRequest = {
  attemptId: string;
  declared: TopologyObservation;
  databasePassword: string;
  recoveryClaim: unknown;
  databaseUrl?: unknown;
};

export type ReleaseDependencies = {
  git: GitBlobSource;
  destinationRoot: string;
  lockPath: string;
  readHistory: () => readonly PrismaMigrationRow[];
  readSchema: () => P1SchemaEvidence;
  inspectTopology: () => TopologyObservation;
  readDatabaseIdentity: () => { databaseName: string; roleName: string };
  readArchive: () => Buffer;
  readLiveCatalog: () => CatalogProbe;
  readRestoredCatalog: () => RestoredProbe;
  spawnOneShot: (plan: OneShotPlan) => OneShotResult;
};

/**
 * Applies the pinned P1 migration through a separate one-shot process.
 * This does not start the application and does not run docker-entrypoint.sh.
 * A second call after an ambiguous spawn does not retry.
 */
export function executeP1OnlyRelease(request: ReleaseRequest, deps: ReleaseDependencies): ReleaseResult {
  let spawned = false;
  let lock: { release: () => void } | null = null;
  try {
    assertPolicyIntact();
    if (request.databaseUrl !== undefined) {
      throw refusal("STOP", "DATABASE_URL_REJECTED", "A caller connection string is not target authority");
    }
    if (request.attemptId !== request.declared.attemptId || request.databasePassword.length < 8) {
      throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Release attempt is incomplete");
    }
    const observed = failClosed(
      () => deps.inspectTopology(),
      "RUNTIME_UNAUTHENTICATED",
      "Runtime inspect failed",
    );
    authenticateTopology(request.declared, observed);
    const identity = failClosed(
      () => deps.readDatabaseIdentity(),
      "RUNTIME_UNAUTHENTICATED",
      "Database identity probe failed",
    );
    if (
      identity.databaseName !== request.declared.databaseName ||
      identity.roleName !== request.declared.roleName
    ) {
      throw refusal("STOP", "DATABASE_MISMATCH", "Database probe does not match the declared target");
    }
    lock = acquireHostLock(deps.lockPath, request.attemptId);
    if (fs.existsSync(markerPath(deps.destinationRoot))) {
      return result("BLOCKED", "AMBIGUOUS_COMPLETION", false, null);
    }
    const before = classifyP1State({
      history: deps.readHistory(),
      schema: deps.readSchema(),
    });
    if (before.verdict === "ALREADY_APPLIED") {
      const again = deps.inspectTopology();
      if (!sameAppIdentity(request.declared.app, again.app) || again.db.id !== request.declared.db.id) {
        return result("BLOCKED", "APP_IDENTITY_CHANGED", false, false);
      }
      return result(before.verdict, before.code, false, true);
    }
    if (before.verdict !== "READY_FOR_DISPOSABLE_APPLY") {
      return result(before.verdict, before.code, false, null);
    }
    bindRecovery(
      request.recoveryClaim,
      deps.readArchive(),
      deps.readLiveCatalog(),
      deps.readRestoredCatalog(),
      request.attemptId,
    );
    verifyPinnedHistoricalPlusP1(deps.git);
    const set = materializeMigrationSet(deps.git, deps.destinationRoot);
    const observedDigest = hashMaterializedRoot(set.root);
    const again = classifyP1State({
      history: deps.readHistory(),
      schema: deps.readSchema(),
      preflight: { expectedDigest: set.digest, observedDigest },
    });
    if (again.verdict !== "READY_FOR_DISPOSABLE_APPLY") {
      return result(again.verdict, again.code, false, null);
    }
    revalidateMigrationSet(set);
    const immediate = failClosed(
      () => deps.inspectTopology(),
      "RUNTIME_UNAUTHENTICATED",
      "Runtime inspect failed before the one-shot",
    );
    authenticateTopology(request.declared, immediate);
    const plan = planOneShot(request, deps.destinationRoot);
    if (plan.argv.some((arg) => arg.includes("docker-entrypoint.sh") || arg === "resolve" || arg === "dev" || arg === "reset")) {
      throw refusal("STOP", "FORBIDDEN_PRISMA_COMMAND", "One-shot command is not migrate deploy");
    }
    if (plan.argv.includes(request.declared.app.id) || plan.argv.includes(request.declared.app.name)) {
      throw refusal("STOP", "APP_REPLACEMENT_FORBIDDEN", "One-shot plan names the running application");
    }
    spawned = true;
    let spawnResult: OneShotResult;
    try {
      spawnResult = deps.spawnOneShot(plan);
    } catch {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot);
    }
    if (spawnResult.status === null || spawnResult.signal) {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot);
    }
    if (spawnResult.status !== 0) {
      return record("STOP", "PRISMA_DEPLOY_FAILED", deps.destinationRoot);
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
        return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot);
      }
      const finalTopology = deps.inspectTopology();
      if (!sameAppIdentity(request.declared.app, finalTopology.app) || finalTopology.db.id !== request.declared.db.id) {
        return record("BLOCKED", "APP_IDENTITY_CHANGED", deps.destinationRoot);
      }
      return result("ALREADY_APPLIED", after.code, true, true);
    } catch {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot);
    }
  } catch (error) {
    if (spawned) {
      return record("BLOCKED", "AMBIGUOUS_COMPLETION", deps.destinationRoot);
    }
    if (error instanceof RunnerRefusal) {
      return result(error.verdict, error.code, false, null);
    }
    throw error;
  } finally {
    lock?.release();
  }
}

export function planOneShot(request: ReleaseRequest, sealedRoot: string): OneShotPlan {
  const url = new URL("postgresql://placeholder");
  url.username = request.declared.roleName;
  url.password = request.databasePassword;
  url.hostname = request.declared.db.name;
  url.port = "5432";
  url.pathname = `/${request.declared.databaseName}`;
  url.searchParams.set("schema", "public");
  url.searchParams.set("connect_timeout", "5");
  if (url.hostname !== request.declared.db.name || url.hostname === "127.0.0.1") {
    throw refusal("STOP", "DATABASE_URL_REJECTED", "One-shot target must be the inspected database container");
  }
  const argv = [
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    request.declared.networkName,
    "--entrypoint",
    "node",
    "--workdir",
    "/tmp",
    "-e",
    `DATABASE_URL=${url.toString()}`,
    "-v",
    `${dockerPath(sealedRoot)}:/sealed:ro`,
    ONE_SHOT_IMAGE,
    ...ONE_SHOT_COMMAND,
  ];
  return { argv, appContainerId: request.declared.app.id };
}

function failClosed<T>(fn: () => T, code: string, message: string): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof RunnerRefusal) throw error;
    throw refusal("STOP", code, message);
  }
}

function assertPolicyIntact(): void {
  if (
    EXECUTION_POLICY.allowProduction ||
    EXECUTION_POLICY.allowResolve ||
    EXECUTION_POLICY.allowSqlReplay ||
    EXECUTION_POLICY.allowRetry ||
    EXECUTION_POLICY.allowBypass
  ) {
    throw refusal("STOP", "POLICY_TAMPERED", "Execution policy is no longer disposable-only");
  }
}

function result(
  verdict: ReleaseResult["verdict"],
  code: string,
  spawned: boolean,
  appUnchanged: boolean | null,
): ReleaseResult {
  return {
    verdict,
    code,
    spawned,
    retryAttempted: false,
    imageGitSha: IMAGE_GIT_SHA,
    appUnchanged,
  };
}

function record(verdict: ReleaseResult["verdict"], code: string, root: string): ReleaseResult {
  try {
    fs.mkdirSync(root, { recursive: true });
    const target = markerPath(root);
    if (!fs.existsSync(target)) fs.writeFileSync(target, `${code}\n`, { flag: "wx" });
  } catch {
    return result("BLOCKED", "AMBIGUOUS_COMPLETION_UNRECORDED", true, null);
  }
  return result(verdict, code, true, code === "APP_IDENTITY_CHANGED" ? false : null);
}

function markerPath(root: string): string {
  return path.join(root, ".ambiguous-stop");
}

function dockerPath(value: string): string {
  return value.replaceAll("\\", "/");
}
