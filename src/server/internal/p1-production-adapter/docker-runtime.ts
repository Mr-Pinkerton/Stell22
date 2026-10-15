import { spawnSync } from "node:child_process";
import { CONTAINER_ID } from "@/server/internal/p1-production-adapter/contract";
import type { ContainerFact } from "@/server/internal/p1-production-adapter/identity";
import { CATALOG_SQL } from "@/server/internal/p1-production-adapter/catalog";
import { parseCatalog, type CatalogBundle } from "@/server/internal/p1-production-adapter/catalog";

const LOCAL_ENDPOINTS = new Set([
  "unix:///var/run/docker.sock",
  "npipe:////./pipe/docker_engine",
  "npipe:////./pipe/dockerDesktopLinuxEngine",
]);

export function assertLocalDockerEndpoint(env: Readonly<Record<string, string | undefined>>): void {
  const host = env.DOCKER_HOST;
  if (host && !LOCAL_ENDPOINTS.has(host)) {
    throw new Error("Docker endpoint is remote");
  }
  if (host && env.DOCKER_CONTEXT) {
    throw new Error("Docker endpoint is ambiguous");
  }
}

export function readDaemonId(env: Readonly<Record<string, string | undefined>> = process.env): string {
  assertLocalDockerEndpoint(env);
  return docker(["info", "--format", "{{.ID}}"], env).trim();
}

export function inspectContainer(
  nameOrId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ContainerFact {
  assertLocalDockerEndpoint(env);
  const raw = docker(["inspect", nameOrId], env);
  const parsed = JSON.parse(raw) as unknown;
  return containerFactFromInspect(parsed);
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
  assertLocalDockerEndpoint(env);
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
    { input: CATALOG_SQL, encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024, env: childEnv(env) },
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
  assertLocalDockerEndpoint(env);
  const child = spawnSync(
    "docker",
    ["exec", containerId, "pg_dump", "-U", role, "--no-owner", "--no-acl", database],
    { windowsHide: true, timeout: 120_000, maxBuffer: 64 * 1024 * 1024, env: childEnv(env) },
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
  assertLocalDockerEndpoint(env);
  const child = spawnSync(
    "docker",
    ["exec", "-i", containerId, "psql", "-U", role, "-d", database, "-v", "ON_ERROR_STOP=1"],
    { input: sql, windowsHide: true, timeout: 180_000, maxBuffer: 64 * 1024 * 1024, env: childEnv(env) },
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

function docker(args: readonly string[], env: Readonly<Record<string, string | undefined>>): string {
  const child = spawnSync("docker", [...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env: childEnv(env),
  });
  if (child.status !== 0) throw new Error(`${args[0] ?? "docker"} failed`);
  return child.stdout;
}

function childEnv(env: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next;
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
