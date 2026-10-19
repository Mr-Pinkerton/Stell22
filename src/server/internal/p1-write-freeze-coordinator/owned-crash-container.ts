/**
 * Test-owned container lifecycle for the disposable P1 crash proof.
 * SQL and cleanup use the captured container id. An uncertain resource is left
 * in place. This does not scan by label and does not prune.
 */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultOriginRuntime, resolveLocalDockerEndpoint } from "@/server/internal/p1-isolated-runner/container-origin";
import {
  releaseInvocation,
  type CleanupReport,
  type DockerWorld,
  type ExecResult,
  type Invocation,
} from "@/server/internal/p1-write-freeze-coordinator/cleanup";
import { COORDINATOR_LABEL, IMAGE_REF } from "@/server/internal/p1-write-freeze-coordinator/contract";
import {
  assertResourceName,
  evaluateInspect,
  namesForRun,
} from "@/server/internal/p1-write-freeze-coordinator/identity";

const FULL_ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export type CrashWorld = DockerWorld & {
  context(): string;
};

export type OwnedCrash = {
  endpoint: string;
  daemonId: string;
  context: string;
  imageId: string;
  invocation: Invocation;
};

export class OwnedCrashRefusal extends Error {
  constructor(
    readonly code: string,
    readonly report: CleanupReport,
  ) {
    super(code);
  }
}

export function createOwnedCrashContainer(world: CrashWorld): OwnedCrash {
  const endpoint = readEndpoint(world);
  const daemonId = readDaemon(world);
  const context = readContext(world);
  const imageId = readImageId(world);
  const names = namesForRun(randomUUID());
  assertResourceName(names.containerName);
  assertResourceName(names.networkName);
  assertResourceName(names.volumeName);
  const invocation: Invocation = {
    endpoint,
    daemonId,
    imageId,
    names,
    networkCreated: false,
    volumeCreated: false,
    containerId: null,
    containerPhase: "not-started",
  };
  const owned = { endpoint, daemonId, context, imageId, invocation };
  const label = `${COORDINATOR_LABEL}=${names.runId}`;
  assertCurrent(world, owned);
  if (world.exec(["network", "create", "--label", label, names.networkName]).status !== 0) {
    refuse(world, invocation, "CREATE_FAILED");
  }
  invocation.networkCreated = true;
  assertCurrent(world, owned);
  if (world.exec(["volume", "create", "--label", label, names.volumeName]).status !== 0) {
    refuse(world, invocation, "CREATE_FAILED");
  }
  invocation.volumeCreated = true;
  assertCurrent(world, owned);
  const envFile = writeEnvFile();
  let created: ExecResult;
  try {
    created = world.exec([
      "run",
      "-d",
      "--pull",
      "never",
      "--restart",
      "no",
      "--name",
      names.containerName,
      "--network",
      names.networkName,
      "--label",
      label,
      "--mount",
      `type=volume,source=${names.volumeName},target=/var/lib/postgresql/data`,
      "--env-file",
      envFile,
      IMAGE_REF,
    ]);
  } finally {
    fs.rmSync(envFile, { force: true });
  }
  if (created.status !== 0) {
    invocation.containerPhase = "ambiguous";
    refuse(world, invocation, "CREATE_FAILED");
  }
  const containerId = created.stdout.trim();
  if (!FULL_ID.test(containerId)) {
    invocation.containerPhase = "ambiguous";
    refuse(world, invocation, "MALFORMED_ID");
  }
  invocation.containerId = containerId;
  invocation.containerPhase = "ambiguous";
  const inspected = world.exec(["inspect", containerId]);
  const document = parseOne(inspected);
  const verdict = document === undefined ? { ok: false as const, code: "MALFORMED" } : evaluateInspect(document, { ...names, containerId, imageId }, "mutate");
  if (!verdict.ok) refuse(world, invocation, verdict.code);
  assertCurrent(world, owned);
  invocation.containerPhase = "confirmed";
  return owned;
}

export function execOwned(world: CrashWorld, owned: OwnedCrash, command: readonly string[]): ExecResult {
  if (command.length === 0 || owned.invocation.containerId === null) {
    throw new OwnedCrashRefusal("OWNERSHIP_UNPROVEN", preserved("OWNERSHIP_UNPROVEN", owned.invocation));
  }
  assertCurrent(world, owned);
  const containerId = owned.invocation.containerId;
  const inspected = world.exec(["inspect", containerId]);
  const document = parseOne(inspected);
  const verdict = document === undefined
    ? { ok: false as const, code: "MALFORMED" }
    : evaluateInspect(document, { ...owned.invocation.names, containerId, imageId: owned.imageId }, "mutate");
  if (!verdict.ok) throw new OwnedCrashRefusal(verdict.code, preserved(verdict.code, owned.invocation));
  assertCurrent(world, owned);
  return world.exec(["exec", containerId, ...command]);
}

export function releaseOwned(world: CrashWorld, owned: OwnedCrash): CleanupReport {
  try {
    if (world.endpoint() !== owned.endpoint) return preserved("ENDPOINT_CHANGED", owned.invocation);
    if (world.daemonId() !== owned.daemonId) return preserved("DAEMON_CHANGED", owned.invocation);
    if (world.context() !== owned.context) return preserved("CONTEXT_CHANGED", owned.invocation);
  } catch {
    return preserved("ENDPOINT_UNREADABLE", owned.invocation);
  }
  return releaseInvocation(owned.invocation, world);
}

export function realCrashWorld(): CrashWorld {
  return {
    endpoint: () => resolveLocalDockerEndpoint(defaultOriginRuntime()),
    daemonId: () => {
      const result = docker(["info", "--format", "{{.ID}}"]);
      const daemonId = result.stdout.trim();
      if (result.status !== 0 || daemonId.length < 8) throw new OwnedCrashRefusal("ENDPOINT_UNREADABLE", emptyReport());
      return daemonId;
    },
    context: () => {
      const result = docker(["context", "show"]);
      const context = result.stdout.trim();
      if (result.status !== 0 || context.length === 0) throw new OwnedCrashRefusal("ENDPOINT_UNREADABLE", emptyReport());
      return context;
    },
    exec: (args) => docker(args),
  };
}

function refuse(world: CrashWorld, invocation: Invocation, code: string): never {
  throw new OwnedCrashRefusal(code, releaseInvocation(invocation, world));
}

function assertCurrent(world: CrashWorld, owned: OwnedCrash): void {
  let endpoint = "";
  let daemonId = "";
  let context = "";
  try {
    endpoint = world.endpoint();
    daemonId = world.daemonId();
    context = world.context();
  } catch (error) {
    if (error instanceof OwnedCrashRefusal) throw error;
    throw new OwnedCrashRefusal("ENDPOINT_UNREADABLE", preserved("ENDPOINT_UNREADABLE", owned.invocation));
  }
  if (endpoint !== owned.endpoint) throw new OwnedCrashRefusal("ENDPOINT_CHANGED", preserved("ENDPOINT_CHANGED", owned.invocation));
  if (daemonId !== owned.daemonId) throw new OwnedCrashRefusal("DAEMON_CHANGED", preserved("DAEMON_CHANGED", owned.invocation));
  if (context !== owned.context) throw new OwnedCrashRefusal("CONTEXT_CHANGED", preserved("CONTEXT_CHANGED", owned.invocation));
}

function readEndpoint(world: CrashWorld): string {
  try {
    return world.endpoint();
  } catch (error) {
    if (error instanceof OwnedCrashRefusal) throw error;
    throw new OwnedCrashRefusal("ENDPOINT_UNREADABLE", emptyReport());
  }
}

function readDaemon(world: CrashWorld): string {
  try {
    const daemonId = world.daemonId();
    if (daemonId.length < 8) throw new OwnedCrashRefusal("ENDPOINT_UNREADABLE", emptyReport());
    return daemonId;
  } catch (error) {
    if (error instanceof OwnedCrashRefusal) throw error;
    throw new OwnedCrashRefusal("ENDPOINT_UNREADABLE", emptyReport());
  }
}

function readContext(world: CrashWorld): string {
  try {
    const context = world.context();
    if (context.length === 0) throw new OwnedCrashRefusal("ENDPOINT_UNREADABLE", emptyReport());
    return context;
  } catch (error) {
    if (error instanceof OwnedCrashRefusal) throw error;
    throw new OwnedCrashRefusal("ENDPOINT_UNREADABLE", emptyReport());
  }
}

function readImageId(world: CrashWorld): string {
  const image = world.exec(["image", "inspect", "--format", "{{.Id}}", IMAGE_REF]);
  const imageId = image.stdout.trim();
  if (image.status !== 0 || !IMAGE_ID.test(imageId)) {
    throw new OwnedCrashRefusal("IMAGE_UNAVAILABLE", emptyReport());
  }
  return imageId;
}

function preserved(reason: string, invocation: Invocation): CleanupReport {
  const report: CleanupReport = { removed: [], preserved: [], failures: [] };
  if (invocation.containerPhase !== "not-started") report.preserved.push({ resource: "container", reason });
  if (invocation.volumeCreated) report.preserved.push({ resource: "volume", reason });
  if (invocation.networkCreated) report.preserved.push({ resource: "network", reason });
  return report;
}

function emptyReport(): CleanupReport {
  return { removed: [], preserved: [], failures: [] };
}

function parseOne(result: ExecResult): unknown | undefined {
  if (result.status !== 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(parsed) || parsed.length !== 1) return undefined;
    return parsed[0];
  } catch {
    return undefined;
  }
}

function writeEnvFile(): string {
  const file = path.join(os.tmpdir(), `p1wc-crash-env-${randomUUID()}`);
  fs.writeFileSync(file, "POSTGRES_USER=stell22\nPOSTGRES_DB=stell22\nPOSTGRES_HOST_AUTH_METHOD=trust\n", { mode: 0o600 });
  return file;
}

function docker(args: readonly string[]): ExecResult {
  const child = spawnSync("docker", [...args], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}
