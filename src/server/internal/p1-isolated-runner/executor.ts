import fs from "node:fs";
import path from "node:path";
import { EXECUTION_POLICY } from "@/server/internal/p1-isolated-runner/contract";
import {
  classifyP1State,
  type PrismaMigrationRow,
} from "@/server/internal/p1-isolated-runner/classify";
import {
  authenticateDisposableTarget,
  type DisposableAttestation,
  type DisposableProbeResult,
} from "@/server/internal/p1-isolated-runner/disposable-target";
import { buildChildEnv } from "@/server/internal/p1-isolated-runner/env";
import { acquireHostLock } from "@/server/internal/p1-isolated-runner/lock";
import {
  hashMaterializedRoot,
  materializeMigrationSet,
  revalidateMigrationSet,
  type GitBlobSource,
} from "@/server/internal/p1-isolated-runner/migration-set";
import { refusal, RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";
import type { P1SchemaEvidence } from "@/server/internal/p1-isolated-runner/schema-contract";

export const PRISMA_DEPLOY_COMMAND = ["migrate", "deploy", "--schema"] as const;

export type PrismaSpawnRequest = {
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
};

export type PrismaSpawnResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
};

export type ApplyResult = {
  verdict: "ALREADY_APPLIED" | "READY_FOR_DISPOSABLE_APPLY" | "STOP" | "BLOCKED";
  code: string;
  spawned: boolean;
  retryAttempted: false;
};

export type ApplyDependencies = {
  git: GitBlobSource;
  destinationRoot: string;
  lockPath: string;
  parentEnv: Readonly<Record<string, string | undefined>>;
  readHistory: () => readonly PrismaMigrationRow[];
  readSchema: () => P1SchemaEvidence;
  probeIdentity: (attestation: DisposableAttestation) => DisposableProbeResult;
  spawnPrisma: (request: PrismaSpawnRequest) => PrismaSpawnResult;
};

/**
 * One Prisma deploy against an already authenticated disposable target.
 * The window between the last revalidation and process start is not atomic.
 * A failed or ambiguous spawn is not retried.
 */
export function executeDisposableApply(
  rawAttestation: unknown,
  deps: ApplyDependencies,
): ApplyResult {
  let spawned = false;
  let lock: { release: () => void } | null = null;
  try {
    assertPolicyIntact();
    const target = authenticateDisposableTarget(rawAttestation, deps.probeIdentity);
    lock = acquireHostLock(deps.lockPath, target.runId);
    if (fs.existsSync(markerPath(deps.destinationRoot))) {
      return stopped("BLOCKED", "AMBIGUOUS_COMPLETION", false);
    }
    const before = classifyP1State({
      history: deps.readHistory(),
      schema: deps.readSchema(),
    });
    if (before.verdict !== "READY_FOR_DISPOSABLE_APPLY") {
      return stopped(before.verdict, before.code, false);
    }
    const set = materializeMigrationSet(deps.git, deps.destinationRoot);
    const observed = hashMaterializedRoot(set.root);
    const again = classifyP1State({
      history: deps.readHistory(),
      schema: deps.readSchema(),
      preflight: { expectedDigest: set.digest, observedDigest: observed },
    });
    if (again.verdict !== "READY_FOR_DISPOSABLE_APPLY") {
      return stopped(again.verdict, again.code, false);
    }
    revalidateMigrationSet(set);
    const relativeSchema = path.relative(set.root, set.schemaPath);
    if (relativeSchema.startsWith("..") || path.isAbsolute(relativeSchema)) {
      throw refusal(
        "STOP",
        "SCHEMA_PATH_ESCAPE",
        "Prisma schema path escaped the sealed directory",
      );
    }
    const args = [...PRISMA_DEPLOY_COMMAND, set.schemaPath];
    if (args.some((arg) => arg === "resolve" || arg === "dev" || arg === "reset")) {
      throw refusal("STOP", "FORBIDDEN_PRISMA_COMMAND", "Prisma command is not migrate deploy");
    }
    const env = buildChildEnv(deps.parentEnv, target.connectionUrl);
    spawned = true;
    let result: PrismaSpawnResult;
    try {
      result = deps.spawnPrisma({ args, env, cwd: set.root });
    } catch {
      writeMarker(deps.destinationRoot, "ambiguous\n");
      return stopped("BLOCKED", "AMBIGUOUS_COMPLETION", true);
    }
    if (result.status === null || result.signal) {
      writeMarker(deps.destinationRoot, "ambiguous\n");
      return stopped("BLOCKED", "AMBIGUOUS_COMPLETION", true);
    }
    if (result.status !== 0) {
      writeMarker(deps.destinationRoot, "failed\n");
      return stopped("STOP", "PRISMA_DEPLOY_FAILED", true);
    }
    revalidateMigrationSet(set);
    const after = classifyP1State({
      history: deps.readHistory(),
      schema: deps.readSchema(),
    });
    if (after.verdict !== "ALREADY_APPLIED") {
      writeMarker(deps.destinationRoot, "ambiguous\n");
      return stopped("BLOCKED", "AMBIGUOUS_COMPLETION", true);
    }
    return stopped("ALREADY_APPLIED", after.code, true);
  } catch (error) {
    if (error instanceof RunnerRefusal) {
      return stopped(error.verdict, error.code, spawned);
    }
    throw error;
  } finally {
    lock?.release();
  }
}

function stopped(verdict: ApplyResult["verdict"], code: string, spawned: boolean): ApplyResult {
  return { verdict, code, spawned, retryAttempted: false };
}

function markerPath(root: string): string {
  return path.join(root, ".ambiguous-stop");
}

function writeMarker(root: string, contents: string): void {
  fs.mkdirSync(root, { recursive: true });
  const target = markerPath(root);
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, contents, { flag: "wx" });
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
