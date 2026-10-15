import { spawnSync } from "node:child_process";
import { CONTAINER_ID, DAEMON_ID } from "@/server/internal/p1-production-adapter/contract";
import type { ContainerFact } from "@/server/internal/p1-production-adapter/identity";
import { CATALOG_SQL } from "@/server/internal/p1-production-adapter/catalog";
import { parseCatalog, type CatalogBundle } from "@/server/internal/p1-production-adapter/catalog";
import { refusal, RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";

const LOCAL_ENDPOINTS = new Set([
  "unix:///var/run/docker.sock",
  "npipe:////./pipe/docker_engine",
  "npipe:////./pipe/dockerDesktopLinuxEngine",
]);

const ENV_ALLOW = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "TMPDIR",
] as const;

export type DockerRun = (args: readonly string[], env: NodeJS.ProcessEnv) => string;

export type DockerSession = {
  endpoint: string;
  daemonId: string;
  env: NodeJS.ProcessEnv;
};

export type VolumeMount = {
  type: string;
  name: string | null;
  source: string | null;
  destination: string;
};

/**
 * Resolves the Docker CLI endpoint that commands will actually use.
 * DOCKER_HOST alone is not enough: an unset host still follows the active context.
 * The returned env is the only env later Docker commands may inherit.
 */
export function resolveDockerSession(
  env: Readonly<Record<string, string | undefined>> = process.env,
  run: DockerRun = defaultDockerRun,
): DockerSession {
  const host = blank(env.DOCKER_HOST);
  const context = blank(env.DOCKER_CONTEXT);
  if (host && context) {
    throw refusal("STOP", "DOCKER_ENDPOINT_AMBIGUOUS", "DOCKER_HOST and DOCKER_CONTEXT disagree");
  }
  const discovery = restrictedEnv(null);
  let endpoint = host;
  if (!endpoint) {
    const name = context ?? run(["context", "show"], discovery).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw refusal("STOP", "DOCKER_ENDPOINT_UNRECOGNIZED", "Docker context name is not usable");
    }
    endpoint = contextHost(run(["context", "inspect", name], discovery));
  }
  assertLocalEndpoint(endpoint);
  const bound = restrictedEnv(endpoint);
  const daemonId = run(["info", "--format", "{{.ID}}"], bound).trim();
  if (!DAEMON_ID.test(daemonId)) {
    throw refusal("STOP", "DOCKER_ENDPOINT_UNTRUSTED", "Docker daemon identity is not usable");
  }
  return { endpoint, daemonId, env: bound };
}

export function readDaemonId(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return resolveDockerSession(env).daemonId;
}

export function inspectContainer(
  nameOrId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ContainerFact {
  const session = resolveDockerSession(env);
  const raw = docker(["inspect", nameOrId], session.env);
  const parsed = JSON.parse(raw) as unknown;
  return containerFactFromInspect(parsed);
}

export function inspectMounts(
  nameOrId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): VolumeMount[] {
  const session = resolveDockerSession(env);
  const raw = docker(["inspect", nameOrId], session.env);
  return mountsFromInspect(JSON.parse(raw) as unknown);
}

export function containerFactFromInspect(document: unknown): ContainerFact {
  const row = Array.isArray(document) ? document[0] : document;
  if (row === null || typeof row !== "object") throw new Error("malformed inspect");
  const record = row as Record<string, unknown>;
  const state = objectOf(record.State);
  const config = objectOf(record.Config);
  const hostConfig = objectOf(record.HostConfig);
  const networkSettings = objectOf(record.NetworkSettings);
  const id = text(record.Id);
  const image = text(record.Image);
  const networks = objectOf(networkSettings.Networks);
  return {
    id,
    imageId: image.startsWith("sha256:") ? image : `sha256:${image}`,
    imageRef: text(config.Image),
    startedAt: text(state.StartedAt),
    running: state.Running === true,
    name: text(record.Name).replace(/^\//, ""),
    entrypoint: stringList(config.Entrypoint),
    command: stringList(config.Cmd),
    publishedDbPort: portPublished(hostConfig.PortBindings) || portPublished(networkSettings.Ports),
    networks: Object.entries(networks).map(([name, value]) => {
      const network = objectOf(value);
      const aliases = Array.isArray(network.Aliases) ? network.Aliases.filter((item) => typeof item === "string") : [];
      return { name, aliases };
    }),
  };
}

export function readCatalog(
  containerId: string,
  role: string,
  database: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CatalogBundle {
  assertContainerId(containerId);
  const session = resolveDockerSession(env);
  if (!/^[A-Za-z0-9_]+$/.test(role) || !/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error("refusing database identity");
  }
  if (CATALOG_SQL.includes(";") || !CATALOG_SQL.trimStart().startsWith("SELECT")) {
    throw new Error("refusing statement");
  }
  // The accepted P1 probe reads catalogs with search_path=pg_catalog.
  // Pretty trigger deparse then qualifies public, which the contract requires.
  const child = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      "PGOPTIONS=-c search_path=pg_catalog",
      containerId,
      "psql",
      "-U",
      role,
      "-d",
      database,
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    { input: CATALOG_SQL, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: session.env },
  );
  if (child.status !== 0) {
    throw new Error(`catalog read failed: ${(child.stderr || "").slice(0, 500)}`);
  }
  return parseCatalog(JSON.parse(child.stdout));
}

export function dumpDatabase(
  containerId: string,
  role: string,
  database: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Buffer {
  assertContainerId(containerId);
  const session = resolveDockerSession(env);
  const child = spawnSync(
    "docker",
    ["exec", containerId, "pg_dump", "-U", role, "--no-owner", "--no-acl", database],
    { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: session.env },
  );
  if (child.status !== 0) throw new Error("pg_dump failed");
  return Buffer.from(child.stdout);
}

export function restoreArchive(
  containerId: string,
  role: string,
  database: string,
  sql: Buffer,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  assertContainerId(containerId);
  const session = resolveDockerSession(env);
  const child = spawnSync(
    "docker",
    ["exec", "-i", containerId, "psql", "-U", role, "-d", database, "-v", "ON_ERROR_STOP=1"],
    { input: sql, windowsHide: true, timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: session.env },
  );
  if (child.status !== 0) {
    const stderr = Buffer.isBuffer(child.stderr) ? child.stderr.toString("utf8") : String(child.stderr ?? "");
    throw new Error(`restore failed (${child.status ?? "null"}): ${stderr.slice(0, 800)}`);
  }
  return 0;
}

function portPublished(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value !== "object") return true;
  const record = value as Record<string, unknown>;
  const binding = record["5432/tcp"];
  return Array.isArray(binding) && binding.length > 0;
}

function assertContainerId(value: string): void {
  if (!CONTAINER_ID.test(value)) throw new Error("refusing container id");
}

export function mountsFromInspect(document: unknown): VolumeMount[] {
  const row = Array.isArray(document) ? document[0] : document;
  if (row === null || typeof row !== "object") return [];
  const mounts = (row as Record<string, unknown>).Mounts;
  if (!Array.isArray(mounts)) return [];
  return mounts.map((item) => {
    const mount = objectOf(item);
    return {
      type: text(mount.Type),
      name: typeof mount.Name === "string" ? mount.Name : null,
      source: typeof mount.Source === "string" ? mount.Source : null,
      destination: text(mount.Destination),
    };
  });
}

function docker(args: readonly string[], env: NodeJS.ProcessEnv): string {
  const child = spawnSync("docker", [...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env,
  });
  if (child.status !== 0) throw new Error(`${args[0] ?? "docker"} failed`);
  return child.stdout;
}

function defaultDockerRun(args: readonly string[], env: NodeJS.ProcessEnv): string {
  try {
    return docker(args, env);
  } catch (error) {
    if (error instanceof RunnerRefusal) throw error;
    throw refusal("STOP", "DOCKER_ENDPOINT_UNTRUSTED", "Docker endpoint could not be resolved");
  }
}

function assertLocalEndpoint(endpoint: string): void {
  const lowered = endpoint.toLowerCase();
  if (
    lowered.startsWith("ssh://") ||
    lowered.startsWith("tcp://") ||
    lowered.startsWith("http://") ||
    lowered.startsWith("https://") ||
    lowered.startsWith("fd://")
  ) {
    throw refusal("STOP", "DOCKER_ENDPOINT_REMOTE", "Docker endpoint is remote");
  }
  if (!LOCAL_ENDPOINTS.has(endpoint)) {
    throw refusal("STOP", "DOCKER_ENDPOINT_UNRECOGNIZED", "Docker endpoint is not a known local socket");
  }
}

function contextHost(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw refusal("STOP", "DOCKER_ENDPOINT_UNTRUSTED", "Docker context inspect is not usable");
  }
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  if (row === null || typeof row !== "object") {
    throw refusal("STOP", "DOCKER_ENDPOINT_UNTRUSTED", "Docker context inspect is not usable");
  }
  const endpoints = (row as Record<string, unknown>).Endpoints;
  if (endpoints === null || typeof endpoints !== "object") {
    throw refusal("STOP", "DOCKER_ENDPOINT_UNTRUSTED", "Docker context has no endpoint");
  }
  const dockerEndpoint = (endpoints as Record<string, unknown>).docker;
  if (dockerEndpoint === null || typeof dockerEndpoint !== "object") {
    throw refusal("STOP", "DOCKER_ENDPOINT_UNTRUSTED", "Docker context has no endpoint");
  }
  const host = (dockerEndpoint as Record<string, unknown>).Host;
  if (typeof host !== "string" || host.length === 0) {
    throw refusal("STOP", "DOCKER_ENDPOINT_UNTRUSTED", "Docker context has no endpoint");
  }
  return host;
}

function restrictedEnv(endpoint: string | null): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV };
  for (const key of ENV_ALLOW) {
    const value = process.env[key];
    if (value !== undefined) next[key] = value;
  }
  if (endpoint) next.DOCKER_HOST = endpoint;
  return next;
}

function blank(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  return value.trim();
}

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed inspect");
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("malformed inspect");
  return value;
}

function stringList(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("malformed inspect");
  return value as string[];
}
