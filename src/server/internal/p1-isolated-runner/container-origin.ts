import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Stage A: disposable Docker object ownership.
 *
 * The factory generates the run id, nonce, and password, creates one
 * container, and keeps the full id returned by `docker run`. Inspect evidence
 * can confirm that id. It cannot be replaced by attestation JSON, a caller
 * supplied container id, or a caller supplied published port.
 *
 * This stage does not prove PostgreSQL identity. Binding a SQL connection to
 * the owned container requires all of the following, and this module performs
 * none of the SQL:
 * - connect only to the loopback host and port from `reconfirmOwnedContainer`;
 * - the nonce and container id come from this handle, not from attestation JSON;
 * - the existing read-only transaction still shows one backend pid and snapshot;
 * - `current_database` and `server_version_num` match this handle;
 * - the identity row echoes this handle's run id, nonce, and container id.
 * Structural classification stays blocked. `applyEnabled` stays false.
 * A compromised Docker daemon can forge inspect output. This module does not
 * claim protection against that daemon.
 *
 * Registry digest: when `RepoDigests` is empty, the image ID is still pinned
 * for this lifecycle and no digest is invented. See
 * `IMAGE_REPOSITORY_DIGEST_LIMITATION`.
 */

export const POSTGRES_IMAGE_REF = "postgres:17-alpine" as const;
export const OWNED_CONTAINER_LABEL = "stell22.p1.owned-container" as const;

export const ALLOWED_LOCAL_DOCKER_ENDPOINTS = [
  "unix:///var/run/docker.sock",
  "npipe:////./pipe/docker_engine",
  "npipe:////./pipe/dockerDesktopLinuxEngine",
] as const;

export const IMAGE_REPOSITORY_DIGEST_LIMITATION =
  "RepoDigests was empty. The image ID is pinned for this lifecycle. A registry digest was not available and was not invented.";

export const SQL_BINDING_PRECONDITIONS = [
  "Connect only through the loopback port from reconfirmOwnedContainer.",
  "Take the nonce and container id from the ownership handle.",
  "Keep the existing read-only backend pid and snapshot checks.",
  "Require current_database and PostgreSQL 17 before trusting an identity row.",
  "Require the identity row to echo the handle run id, nonce, and container id.",
  "Do not treat this Docker stage as SQL proof or apply authorization.",
] as const;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const DAEMON_ID = /^[A-Za-z0-9:._-]{8,256}$/;
const REPOSITORY_DIGEST = /^postgres@sha256:[0-9a-f]{64}$/;
const ownershipBrand = Symbol("stell22-p1-owned-container");

const REFUSAL_TEXT = {
  DOCKER_ENDPOINT_REMOTE: "Docker endpoint is remote or not a documented local socket.",
  DOCKER_ENDPOINT_UNDETERMINED: "Docker endpoint could not be determined.",
  DOCKER_ENDPOINT_AMBIGUOUS:
    "DOCKER_HOST and DOCKER_CONTEXT are both set, so the daemon endpoint is ambiguous.",
  DOCKER_ENDPOINT_CHANGED: "The Docker endpoint changed after the container was created.",
  DOCKER_UNAVAILABLE: "Docker daemon identity is unavailable.",
  DAEMON_IDENTITY_CHANGED: "Docker daemon identity changed during ownership.",
  IMAGE_INSPECT_FAILED: "The pinned PostgreSQL image could not be inspected.",
  IMAGE_ID_UNEXPECTED: "Container image identity does not match the inspected image.",
  CONTAINER_CREATE_FAILED: "Disposable container creation failed.",
  CONTAINER_ID_UNPROVEN: "Docker did not return a full container id.",
  INSPECT_ID_MISMATCH: "Inspected container id does not match the created container.",
  NAME_MISMATCH: "Container name does not match this disposable run.",
  LABEL_MISMATCH: "Container run label does not match this disposable run.",
  CONTAINER_STOPPED: "Container is not running.",
  CONTAINER_RESTARTED: "Container restart or process identity is not continuous.",
  CONTAINER_DISAPPEARED: "Owned container is no longer present.",
  PORT_NOT_LOOPBACK: "Published port is not bound to 127.0.0.1.",
  PORT_MAPPING_MISMATCH: "Published port mapping is missing or conflicting.",
  PORT_CHANGED: "Published loopback port changed after creation.",
  NETWORK_MODE_UNSUPPORTED: "Container network mode is not an isolated bridge.",
  OWNERSHIP_UNPROVEN: "Container ownership could not be established.",
  CLEANUP_REFUSED: "Cleanup refused because ownership was not reconfirmed.",
  CLEANUP_FAILED: "Owned container removal failed.",
} as const;

export type ContainerOriginCode = keyof typeof REFUSAL_TEXT;

export type ContainerResourceDisposition =
  | { readonly kind: "not-created" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "removed"; readonly containerId: string }
  | {
      readonly kind: "orphaned";
      readonly containerId: string;
      readonly cleanup: "refused" | "failed";
    };

const NOT_CREATED: ContainerResourceDisposition = { kind: "not-created" };

export class ContainerOriginRefusal extends Error {
  readonly code: ContainerOriginCode;
  readonly disposition: ContainerResourceDisposition;

  constructor(code: ContainerOriginCode, disposition: ContainerResourceDisposition = NOT_CREATED) {
    super(REFUSAL_TEXT[code]);
    this.name = "ContainerOriginRefusal";
    this.code = code;
    this.disposition = disposition;
  }
}

export type OriginRuntime = {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string;
  readFile(filePath: string): string;
  execFileSync(
    command: string,
    args: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
  ): string;
  randomUUID(): string;
  randomBytes(size: number): Buffer;
};

export type DockerOwnershipProof =
  | {
      ok: true;
      containerId: string;
      name: string;
      runId: string;
      imageId: string;
      host: "127.0.0.1";
      port: number;
      startedAt: string;
      pid: number;
    }
  | { ok: false; code: ContainerOriginCode };

export type OwnedContainerHandle = {
  readonly [ownershipBrand]: true;
  readonly runId: string;
  readonly containerId: string;
  readonly containerName: string;
  readonly daemonId: string;
  readonly endpoint: string;
  readonly imageId: string;
  readonly imageRef: typeof POSTGRES_IMAGE_REF;
  readonly repositoryDigests: readonly string[];
  readonly repositoryDigestStatus: "RECORDED" | "UNAVAILABLE";
  readonly repositoryDigestLimitation: string | null;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly startedAt: string;
  readonly pid: number;
  readonly nonce: string;
  readonly password: string;
  readonly databaseName: string;
  readonly user: "p1disp";
};

export type OwnedConnection = {
  host: "127.0.0.1";
  port: number;
  user: "p1disp";
  databaseName: string;
  password: string;
  nonce: string;
  runId: string;
  containerId: string;
  containerName: string;
};

type ProofExpectation = {
  creationId: string;
  expectedName: string;
  expectedRunId: string;
  expectedImageId: string;
  expectedDaemonId: string;
  observedDaemonId: string;
  expectedStartedAt: string | null;
  expectedPid: number | null;
  expectedPort: number | null;
  inspectDocument: unknown;
};

export function defaultOriginRuntime(): OriginRuntime {
  return {
    platform: process.platform,
    env: process.env,
    homedir: homedir(),
    readFile: (filePath) => fs.readFileSync(filePath, "utf8"),
    execFileSync: (command, args, env) =>
      execFileSync(command, [...args], {
        encoding: "utf8",
        windowsHide: true,
        env: childEnv(env),
      }),
    randomUUID,
    randomBytes,
  };
}

export function resolveLocalDockerEndpoint(runtime: OriginRuntime): string {
  const host = present(runtime.env.DOCKER_HOST);
  const context = present(runtime.env.DOCKER_CONTEXT);
  if (host !== undefined && context !== undefined) {
    throw new ContainerOriginRefusal("DOCKER_ENDPOINT_AMBIGUOUS");
  }
  if (host !== undefined) return allowEndpoint(host);
  const contextName = selectedContextName(runtime);
  const metaPath = contextMetaPath(runtime, contextName);
  const meta = readOptional(runtime, metaPath);
  if (meta === undefined) {
    if (contextName !== "default") {
      throw new ContainerOriginRefusal("DOCKER_ENDPOINT_UNDETERMINED");
    }
    return allowEndpoint(platformDefaultEndpoint(runtime.platform));
  }
  return allowEndpoint(endpointFromMeta(meta));
}

export function proveContainerOwnership(input: ProofExpectation): DockerOwnershipProof {
  if (
    input.observedDaemonId !== input.expectedDaemonId ||
    !DAEMON_ID.test(input.expectedDaemonId)
  ) {
    return { ok: false, code: "DAEMON_IDENTITY_CHANGED" };
  }
  const row = inspectRow(input.inspectDocument);
  if (row === "absent") return { ok: false, code: "CONTAINER_DISAPPEARED" };
  if (row === "malformed") return { ok: false, code: "OWNERSHIP_UNPROVEN" };
  if (!CONTAINER_ID.test(input.creationId) || row.id !== input.creationId) {
    return { ok: false, code: "INSPECT_ID_MISMATCH" };
  }
  const expectedName = disposableName(input.expectedRunId);
  if (!expectedName || input.expectedName !== expectedName || row.name !== expectedName) {
    return { ok: false, code: "NAME_MISMATCH" };
  }
  if (row.label !== input.expectedRunId) return { ok: false, code: "LABEL_MISMATCH" };
  if (row.imageId !== input.expectedImageId || !IMAGE_ID.test(input.expectedImageId)) {
    return { ok: false, code: "IMAGE_ID_UNEXPECTED" };
  }
  if (row.imageRef !== POSTGRES_IMAGE_REF) return { ok: false, code: "IMAGE_ID_UNEXPECTED" };
  if (!row.running) return { ok: false, code: "CONTAINER_STOPPED" };
  if (
    (input.expectedStartedAt !== null && row.startedAt !== input.expectedStartedAt) ||
    (input.expectedPid !== null && row.pid !== input.expectedPid)
  ) {
    return { ok: false, code: "CONTAINER_RESTARTED" };
  }
  if (row.networkMode !== "bridge" && row.networkMode !== "default") {
    return { ok: false, code: "NETWORK_MODE_UNSUPPORTED" };
  }
  if (row.binding === "mismatch") return { ok: false, code: "PORT_MAPPING_MISMATCH" };
  if (row.binding === "wildcard") return { ok: false, code: "PORT_NOT_LOOPBACK" };
  if (input.expectedPort !== null && row.binding.port !== input.expectedPort) {
    return { ok: false, code: "PORT_CHANGED" };
  }
  return {
    ok: true,
    containerId: row.id,
    name: row.name,
    runId: input.expectedRunId,
    imageId: row.imageId,
    host: "127.0.0.1",
    port: row.binding.port,
    startedAt: row.startedAt,
    pid: row.pid,
  };
}

export function createOwnedDisposableContainer(
  runtime: OriginRuntime = defaultOriginRuntime(),
): OwnedContainerHandle {
  const endpoint = resolveLocalDockerEndpoint(runtime);
  const daemonId = readDaemonId(runtime, endpoint);
  const image = inspectImage(runtime, endpoint);
  requireDaemon(runtime, endpoint, daemonId);
  const runId = runtime.randomUUID().toLowerCase();
  if (!RUN_ID.test(runId)) throw new ContainerOriginRefusal("OWNERSHIP_UNPROVEN");
  const password = runtime.randomBytes(24).toString("hex");
  const nonce = runtime.randomBytes(24).toString("hex");
  const containerName = disposableName(runId);
  if (!containerName || password.length < 16 || nonce.length < 32) {
    throw new ContainerOriginRefusal("OWNERSHIP_UNPROVEN");
  }
  const databaseName = `p1disp_${runId.replaceAll("-", "")}`;
  let containerId: string;
  try {
    containerId = runContainer(runtime, endpoint, {
      containerName,
      runId,
      password,
      databaseName,
    });
  } catch (error) {
    if (
      error instanceof ContainerOriginRefusal &&
      (error.code === "CONTAINER_CREATE_FAILED" || error.code === "CONTAINER_ID_UNPROVEN")
    ) {
      throw new ContainerOriginRefusal(error.code, { kind: "ambiguous" });
    }
    throw error;
  }
  try {
    requireDaemon(runtime, endpoint, daemonId);
    const inspected = readInspect(runtime, endpoint, containerId, "OWNERSHIP_UNPROVEN");
    const proof = proveContainerOwnership({
      creationId: containerId,
      expectedName: containerName,
      expectedRunId: runId,
      expectedImageId: image.id,
      expectedDaemonId: daemonId,
      observedDaemonId: daemonId,
      expectedStartedAt: null,
      expectedPid: null,
      expectedPort: null,
      inspectDocument: inspected,
    });
    if (!proof.ok) throw new ContainerOriginRefusal(proof.code);
    requireDaemon(runtime, endpoint, daemonId);
    return Object.freeze({
      [ownershipBrand]: true as const,
      runId,
      containerId: proof.containerId,
      containerName,
      daemonId,
      endpoint,
      imageId: image.id,
      imageRef: POSTGRES_IMAGE_REF,
      repositoryDigests: image.repositoryDigests,
      repositoryDigestStatus: image.repositoryDigestStatus,
      repositoryDigestLimitation: image.repositoryDigestLimitation,
      host: proof.host,
      port: proof.port,
      startedAt: proof.startedAt,
      pid: proof.pid,
      nonce,
      password,
      databaseName,
      user: "p1disp" as const,
    });
  } catch (error) {
    const code = error instanceof ContainerOriginRefusal ? error.code : "OWNERSHIP_UNPROVEN";
    throw abandonCreated(
      runtime,
      endpoint,
      { containerId, containerName, runId, imageId: image.id, daemonId },
      code,
    );
  }
}

export function reconfirmOwnedContainer(
  handle: OwnedContainerHandle,
  runtime: OriginRuntime = defaultOriginRuntime(),
): OwnedConnection {
  assertHandle(handle);
  reconfirmProof(handle, runtime);
  return connectionFrom(handle);
}

export function removeOwnedDisposableContainer(
  handle: OwnedContainerHandle,
  runtime: OriginRuntime = defaultOriginRuntime(),
): void {
  assertHandle(handle);
  try {
    reconfirmProof(handle, runtime);
  } catch (error) {
    const code = error instanceof ContainerOriginRefusal ? error.code : "CLEANUP_REFUSED";
    throw new ContainerOriginRefusal(code, {
      kind: "orphaned",
      containerId: handle.containerId,
      cleanup: "refused",
    });
  }
  try {
    callDocker(runtime, handle.endpoint, ["rm", "-f", handle.containerId]);
  } catch {
    throw new ContainerOriginRefusal("CLEANUP_FAILED", {
      kind: "orphaned",
      containerId: handle.containerId,
      cleanup: "failed",
    });
  }
}

function reconfirmProof(
  handle: OwnedContainerHandle,
  runtime: OriginRuntime,
): DockerOwnershipProof {
  const endpoint = resolveLocalDockerEndpoint(runtime);
  if (endpoint !== handle.endpoint) throw new ContainerOriginRefusal("DOCKER_ENDPOINT_CHANGED");
  const daemonId = readDaemonId(runtime, endpoint);
  if (daemonId !== handle.daemonId) throw new ContainerOriginRefusal("DAEMON_IDENTITY_CHANGED");
  const inspected = readInspect(runtime, endpoint, handle.containerId, "CONTAINER_DISAPPEARED");
  const proof = proveContainerOwnership({
    creationId: handle.containerId,
    expectedName: handle.containerName,
    expectedRunId: handle.runId,
    expectedImageId: handle.imageId,
    expectedDaemonId: handle.daemonId,
    observedDaemonId: daemonId,
    expectedStartedAt: handle.startedAt,
    expectedPid: handle.pid,
    expectedPort: handle.port,
    inspectDocument: inspected,
  });
  if (!proof.ok) throw new ContainerOriginRefusal(proof.code);
  requireDaemon(runtime, endpoint, handle.daemonId);
  return proof;
}

function connectionFrom(handle: OwnedContainerHandle): OwnedConnection {
  return {
    host: handle.host,
    port: handle.port,
    user: handle.user,
    databaseName: handle.databaseName,
    password: handle.password,
    nonce: handle.nonce,
    runId: handle.runId,
    containerId: handle.containerId,
    containerName: handle.containerName,
  };
}

function assertHandle(handle: OwnedContainerHandle): void {
  if (!handle || handle[ownershipBrand] !== true || !CONTAINER_ID.test(handle.containerId)) {
    throw new ContainerOriginRefusal("OWNERSHIP_UNPROVEN");
  }
}

function runContainer(
  runtime: OriginRuntime,
  endpoint: string,
  input: { containerName: string; runId: string; password: string; databaseName: string },
): string {
  let stdout: string;
  try {
    stdout = callDocker(runtime, endpoint, [
      "run",
      "-d",
      "--pull",
      "never",
      "--name",
      input.containerName,
      "--label",
      `${OWNED_CONTAINER_LABEL}=${input.runId}`,
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_USER=p1disp",
      "-e",
      `POSTGRES_PASSWORD=${input.password}`,
      "-e",
      `POSTGRES_DB=${input.databaseName}`,
      POSTGRES_IMAGE_REF,
    ]);
  } catch {
    throw new ContainerOriginRefusal("CONTAINER_CREATE_FAILED");
  }
  const containerId = stdout.trim();
  if (!CONTAINER_ID.test(containerId)) throw new ContainerOriginRefusal("CONTAINER_ID_UNPROVEN");
  return containerId;
}

function inspectImage(
  runtime: OriginRuntime,
  endpoint: string,
): {
  id: string;
  repositoryDigests: readonly string[];
  repositoryDigestStatus: "RECORDED" | "UNAVAILABLE";
  repositoryDigestLimitation: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(callDocker(runtime, endpoint, ["image", "inspect", POSTGRES_IMAGE_REF]));
  } catch {
    throw new ContainerOriginRefusal("IMAGE_INSPECT_FAILED");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    !parsed[0] ||
    typeof parsed[0] !== "object"
  ) {
    throw new ContainerOriginRefusal("IMAGE_INSPECT_FAILED");
  }
  const row = parsed[0] as { Id?: unknown; RepoDigests?: unknown };
  if (typeof row.Id !== "string" || !IMAGE_ID.test(row.Id)) {
    throw new ContainerOriginRefusal("IMAGE_INSPECT_FAILED");
  }
  if (row.RepoDigests == null || (Array.isArray(row.RepoDigests) && row.RepoDigests.length === 0)) {
    return {
      id: row.Id,
      repositoryDigests: [],
      repositoryDigestStatus: "UNAVAILABLE",
      repositoryDigestLimitation: IMAGE_REPOSITORY_DIGEST_LIMITATION,
    };
  }
  if (!Array.isArray(row.RepoDigests) || row.RepoDigests.some((item) => typeof item !== "string")) {
    throw new ContainerOriginRefusal("IMAGE_ID_UNEXPECTED");
  }
  const digests = row.RepoDigests.filter((item): item is string => typeof item === "string");
  if (digests.length === 0 || digests.some((item) => !REPOSITORY_DIGEST.test(item))) {
    throw new ContainerOriginRefusal("IMAGE_ID_UNEXPECTED");
  }
  return {
    id: row.Id,
    repositoryDigests: digests,
    repositoryDigestStatus: "RECORDED",
    repositoryDigestLimitation: null,
  };
}

function readDaemonId(runtime: OriginRuntime, endpoint: string): string {
  let stdout: string;
  try {
    stdout = callDocker(runtime, endpoint, ["info", "--format", "{{.ID}}"]);
  } catch {
    throw new ContainerOriginRefusal("DOCKER_UNAVAILABLE");
  }
  const daemonId = stdout.trim();
  if (!DAEMON_ID.test(daemonId)) throw new ContainerOriginRefusal("DOCKER_UNAVAILABLE");
  return daemonId;
}

function requireDaemon(runtime: OriginRuntime, endpoint: string, expected: string): void {
  const actual = readDaemonId(runtime, endpoint);
  if (actual !== expected) throw new ContainerOriginRefusal("DAEMON_IDENTITY_CHANGED");
}

function readInspect(
  runtime: OriginRuntime,
  endpoint: string,
  containerId: string,
  missingCode: "OWNERSHIP_UNPROVEN" | "CONTAINER_DISAPPEARED",
): unknown {
  try {
    return JSON.parse(callDocker(runtime, endpoint, ["inspect", containerId]));
  } catch {
    throw new ContainerOriginRefusal(missingCode);
  }
}

const STRIPPED_DOCKER_ENV = new Set([
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_TLS",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
]);

// docker/cli resolveContextName uses -H, then a nonempty DOCKER_HOST, before
// DOCKER_CONTEXT. The published docs say DOCKER_CONTEXT wins, so both values
// are refused before any command. --host together with --context is a CLI
// error, so each child gets -H and the same DOCKER_HOST and no DOCKER_CONTEXT.
function callDocker(runtime: OriginRuntime, endpoint: string, args: readonly string[]): string {
  return runtime.execFileSync(
    "docker",
    ["-H", endpoint, ...args],
    pinnedEnv(runtime.env, endpoint),
  );
}

function pinnedEnv(
  base: Readonly<Record<string, string | undefined>>,
  endpoint: string,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(base)) {
    if (STRIPPED_DOCKER_ENV.has(key)) continue;
    env[key] = value;
  }
  env.DOCKER_HOST = endpoint;
  return env;
}

function childEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") child[key] = value;
  }
  return child as NodeJS.ProcessEnv;
}

function present(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  return value;
}

function abandonCreated(
  runtime: OriginRuntime,
  endpoint: string,
  created: {
    containerId: string;
    containerName: string;
    runId: string;
    imageId: string;
    daemonId: string;
  },
  original: ContainerOriginCode,
): ContainerOriginRefusal {
  return new ContainerOriginRefusal(original, releaseIfOwned(runtime, endpoint, created));
}

function releaseIfOwned(
  runtime: OriginRuntime,
  endpoint: string,
  created: {
    containerId: string;
    containerName: string;
    runId: string;
    imageId: string;
    daemonId: string;
  },
): ContainerResourceDisposition {
  const orphaned = {
    kind: "orphaned" as const,
    containerId: created.containerId,
    cleanup: "refused" as const,
  };
  let current: string;
  try {
    current = resolveLocalDockerEndpoint(runtime);
  } catch {
    return orphaned;
  }
  if (current !== endpoint) return orphaned;
  let daemonId: string;
  try {
    daemonId = readDaemonId(runtime, endpoint);
  } catch {
    return orphaned;
  }
  if (daemonId !== created.daemonId) return orphaned;
  let inspected: unknown;
  try {
    inspected = readInspect(runtime, endpoint, created.containerId, "OWNERSHIP_UNPROVEN");
  } catch {
    return orphaned;
  }
  const proof = proveContainerOwnership({
    creationId: created.containerId,
    expectedName: created.containerName,
    expectedRunId: created.runId,
    expectedImageId: created.imageId,
    expectedDaemonId: created.daemonId,
    observedDaemonId: daemonId,
    expectedStartedAt: null,
    expectedPid: null,
    expectedPort: null,
    inspectDocument: inspected,
  });
  if (!proof.ok) return orphaned;
  try {
    callDocker(runtime, endpoint, ["rm", "-f", created.containerId]);
  } catch {
    return { kind: "orphaned", containerId: created.containerId, cleanup: "failed" };
  }
  return { kind: "removed", containerId: created.containerId };
}

function selectedContextName(runtime: OriginRuntime): string {
  const fromEnv = runtime.env.DOCKER_CONTEXT;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) {
    if (fromEnv !== fromEnv.trim() || /\s/.test(fromEnv)) {
      throw new ContainerOriginRefusal("DOCKER_ENDPOINT_UNDETERMINED");
    }
    return fromEnv;
  }
  const configPath = path.join(configDir(runtime), "config.json");
  const config = readOptional(runtime, configPath);
  if (config === undefined) return "default";
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch {
    throw new ContainerOriginRefusal("DOCKER_ENDPOINT_UNDETERMINED");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ContainerOriginRefusal("DOCKER_ENDPOINT_UNDETERMINED");
  }
  const current = (parsed as { currentContext?: unknown }).currentContext;
  if (current === undefined) return "default";
  if (typeof current !== "string" || current.trim().length === 0 || /\s/.test(current)) {
    throw new ContainerOriginRefusal("DOCKER_ENDPOINT_UNDETERMINED");
  }
  return current;
}

function endpointFromMeta(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ContainerOriginRefusal("DOCKER_ENDPOINT_UNDETERMINED");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ContainerOriginRefusal("DOCKER_ENDPOINT_UNDETERMINED");
  }
  const endpoints = (parsed as { Endpoints?: unknown }).Endpoints;
  if (!endpoints || typeof endpoints !== "object") {
    throw new ContainerOriginRefusal("DOCKER_ENDPOINT_UNDETERMINED");
  }
  const docker = (endpoints as { docker?: unknown }).docker;
  if (!docker || typeof docker !== "object") {
    throw new ContainerOriginRefusal("DOCKER_ENDPOINT_UNDETERMINED");
  }
  const host = (docker as { Host?: unknown }).Host;
  if (typeof host !== "string" || host.length === 0) {
    throw new ContainerOriginRefusal("DOCKER_ENDPOINT_UNDETERMINED");
  }
  return host;
}

function allowEndpoint(endpoint: string): string {
  if (
    !ALLOWED_LOCAL_DOCKER_ENDPOINTS.includes(
      endpoint as (typeof ALLOWED_LOCAL_DOCKER_ENDPOINTS)[number],
    )
  ) {
    throw new ContainerOriginRefusal("DOCKER_ENDPOINT_REMOTE");
  }
  return endpoint;
}

function platformDefaultEndpoint(platform: NodeJS.Platform): string {
  return platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";
}

function configDir(runtime: OriginRuntime): string {
  const configured = runtime.env.DOCKER_CONFIG;
  if (typeof configured === "string" && configured.trim().length > 0) return configured;
  return path.join(runtime.homedir, ".docker");
}

function contextMetaPath(runtime: OriginRuntime, contextName: string): string {
  const digest = createHash("sha256").update(contextName).digest("hex");
  return path.join(configDir(runtime), "contexts", "meta", digest, "meta.json");
}

function readOptional(runtime: OriginRuntime, filePath: string): string | undefined {
  try {
    return runtime.readFile(filePath);
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw new ContainerOriginRefusal("DOCKER_ENDPOINT_UNDETERMINED");
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === "ENOENT",
  );
}

function disposableName(runId: string): string | null {
  if (!RUN_ID.test(runId)) return null;
  return `stell22-p1-disposable-${runId}`;
}

type InspectedRow = {
  id: string;
  name: string;
  imageId: string;
  imageRef: string;
  label: string | null;
  running: boolean;
  startedAt: string;
  pid: number;
  networkMode: string;
  binding: { port: number } | "mismatch" | "wildcard";
};

function inspectRow(document: unknown): InspectedRow | "absent" | "malformed" {
  if (document === null || (Array.isArray(document) && document.length === 0)) return "absent";
  if (
    !Array.isArray(document) ||
    document.length !== 1 ||
    !document[0] ||
    typeof document[0] !== "object"
  ) {
    return "malformed";
  }
  const record = document[0] as Record<string, unknown>;
  if (typeof record.Id !== "string" || !CONTAINER_ID.test(record.Id)) return "malformed";
  if (typeof record.Name !== "string" || !record.Name.startsWith("/")) return "malformed";
  if (typeof record.Image !== "string") return "malformed";
  const config = record.Config;
  const state = record.State;
  const hostConfig = record.HostConfig;
  if (!config || typeof config !== "object" || !state || typeof state !== "object")
    return "malformed";
  if (!hostConfig || typeof hostConfig !== "object") return "malformed";
  const imageRef = (config as { Image?: unknown }).Image;
  const labels = (config as { Labels?: unknown }).Labels;
  const running = (state as { Running?: unknown }).Running;
  const status = (state as { Status?: unknown }).Status;
  const startedAt = (state as { StartedAt?: unknown }).StartedAt;
  const pid = (state as { Pid?: unknown }).Pid;
  const networkMode = (hostConfig as { NetworkMode?: unknown }).NetworkMode;
  if (typeof imageRef !== "string" || typeof startedAt !== "string" || startedAt.length === 0) {
    return "malformed";
  }
  if (typeof networkMode !== "string" || networkMode.length === 0) return "malformed";
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 0) return "malformed";
  const labelValue =
    labels && typeof labels === "object"
      ? (labels as Record<string, unknown>)[OWNED_CONTAINER_LABEL]
      : undefined;
  return {
    id: record.Id,
    name: record.Name.slice(1),
    imageId: record.Image,
    imageRef,
    label: typeof labelValue === "string" ? labelValue : null,
    running: running === true && status === "running" && pid > 0,
    startedAt,
    pid,
    networkMode,
    binding: readBinding(record),
  };
}

function readBinding(record: Record<string, unknown>): InspectedRow["binding"] {
  const hostConfig = record.HostConfig;
  const network = record.NetworkSettings;
  if (!hostConfig || typeof hostConfig !== "object" || !network || typeof network !== "object") {
    return "mismatch";
  }
  const requestedMap = (hostConfig as { PortBindings?: unknown }).PortBindings;
  const publishedMap = (network as { Ports?: unknown }).Ports;
  if (!singlePortKey(requestedMap) || !singlePortKey(publishedMap)) return "mismatch";
  const requested = portList(requestedMap);
  const published = portList(publishedMap);
  if (!requested || !published || requested.length !== 1 || published.length !== 1)
    return "mismatch";
  const request = requested[0];
  const actual = published[0];
  if (!request || !actual || request.hostIp !== actual.hostIp || actual.hostPort === null) {
    return "mismatch";
  }
  if (request.hostPort !== null && request.hostPort !== actual.hostPort) return "mismatch";
  if (actual.hostIp !== "127.0.0.1") return "wildcard";
  return { port: actual.hostPort };
}

function singlePortKey(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value as object);
  return keys.length === 1 && keys[0] === "5432/tcp";
}

function portList(value: unknown): { hostIp: string; hostPort: number | null }[] | null {
  if (!value || typeof value !== "object") return null;
  const ports = (value as Record<string, unknown>)["5432/tcp"];
  if (!Array.isArray(ports)) return null;
  const bindings = [];
  for (const entry of ports) {
    if (!entry || typeof entry !== "object") return null;
    const hostIp = (entry as { HostIp?: unknown }).HostIp;
    const hostPort = (entry as { HostPort?: unknown }).HostPort;
    if (typeof hostIp !== "string" || hostIp.length === 0) return null;
    if (typeof hostPort !== "string") return null;
    if (hostPort.length === 0) {
      bindings.push({ hostIp, hostPort: null });
      continue;
    }
    if (!/^[0-9]+$/.test(hostPort)) return null;
    const port = Number(hostPort);
    if (port < 1 || port > 65535) return null;
    bindings.push({ hostIp, hostPort: port });
  }
  return bindings;
}
