/**
 * Identity-bound Docker helpers for the disposable writer container.
 * Deletion uses the captured id and refuses a mismatched inspect.
 */

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Cluster } from "@/server/internal/p1-write-freeze-coordinator/cluster";
import { reconfirm } from "@/server/internal/p1-write-freeze-coordinator/cluster";
import {
  APP_IMAGE_REF,
  FORBIDDEN_RESOURCE_NAMES,
  NAME_PREFIX,
  PROOF_LABEL,
} from "@/server/internal/p1-offline-writer-admission/contract";

export type OwnedApp = {
  proofId: string;
  containerId: string;
  containerName: string;
  volumeName: string;
  imageId: string;
};

export type DockerExec = {
  status: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  errorCode?: string | null;
};

type Exec = DockerExec;

export type WriterInspectFields = {
  id: string;
  name: string;
  image: string;
  imageId: string;
  label: string;
  project: string;
  policy: string;
  running: string;
  ports: string;
  networks: string;
};

export type ContainerInspectVerdict = {
  gone: boolean;
  reason: "absent" | "present" | "daemon" | "endpoint" | "cli" | "timeout" | "unknown";
};

export function createAdmissionVolume(cluster: Cluster, proofId: string): string {
  assertProofId(proofId);
  reconfirm(cluster);
  const volumeName = `${NAME_PREFIX}vol-${proofId.slice(0, 8)}`;
  assertOwnedName(volumeName);
  const created = docker(["volume", "create", "--label", `${PROOF_LABEL}=${proofId}`, volumeName], []);
  if (created.status !== 0 || created.stdout.trim() !== volumeName) {
    throw new Error(`admission volume was not created ${trim(created.stderr)}`);
  }
  if (!volumeMatches(volumeName, proofId)) throw new Error("admission volume inspect mismatch");
  return volumeName;
}

export function createWriterContainer(
  cluster: Cluster,
  proofId: string,
  volumeName: string,
  database: string,
  password: string,
): OwnedApp {
  assertProofId(proofId);
  assertDatabase(database);
  reconfirm(cluster);
  if (!volumeMatches(volumeName, proofId)) throw new Error("refusing writer volume");
  const containerName = `${NAME_PREFIX}app-${proofId.slice(0, 8)}`;
  assertOwnedName(containerName);
  const envFile = writeEnv(cluster.containerName, database, password);
  let created: Exec;
  try {
    created = docker(
      [
        "run",
        "-d",
        "--pull",
        "never",
        "--restart",
        "unless-stopped",
        "--name",
        containerName,
        "--network",
        cluster.networkName,
        "--label",
        `${PROOF_LABEL}=${proofId}`,
        "--mount",
        `type=volume,source=${volumeName},target=/admission`,
        "--env-file",
        envFile,
        "--entrypoint",
        "sh",
        APP_IMAGE_REF,
        "-c",
        writerScript(),
      ],
      [password],
    );
  } finally {
    fs.rmSync(envFile, { force: true });
  }
  const containerId = created.stdout.trim();
  if (created.status !== 0 || !/^[0-9a-f]{64}$/.test(containerId)) {
    throw new Error(`writer container was not created ${trim(created.stderr)}`);
  }
  const owned = { proofId, containerId, containerName, volumeName, imageId: cluster.imageId };
  if (!containerMatches(cluster, owned)) {
    removeContainerIfMatches(cluster, owned);
    throw new Error("writer container inspect mismatch");
  }
  if (publishedPorts(containerId) !== "") throw new Error("writer container published a port");
  return owned;
}

export function publishedPorts(containerId: string): string {
  assertId(containerId);
  const result = docker(["port", containerId], []);
  if (result.status !== 0) throw new Error(`docker port failed ${trim(result.stderr)}`);
  return result.stdout.trim();
}

export function requestProcessCrash(cluster: Cluster, owned: OwnedApp): void {
  reconfirm(cluster);
  if (!containerMatches(cluster, owned)) throw new Error("refusing process crash request");
  const result = docker(
    ["exec", "-u", "root", owned.containerId, "sh", "-c", "printf '%s\\n' \"$1\" > /admission/crash", "sh", "1"],
    [],
  );
  if (result.status !== 0) throw new Error(`process crash request failed ${trim(result.stderr)}`);
}

export function writeAdmissionFile(cluster: Cluster, owned: OwnedApp, state: "open" | "closed"): void {
  reconfirm(cluster);
  if (!containerMatches(cluster, owned)) throw new Error("refusing admission write");
  const result = docker(
    ["exec", "-u", "root", owned.containerId, "sh", "-c", "printf '%s\\n' \"$1\" > /admission/state && chmod 644 /admission/state", "sh", state],
    [],
  );
  if (result.status !== 0) throw new Error(`admission file write failed ${trim(result.stderr)}`);
}

export function readAdmissionFile(cluster: Cluster, owned: OwnedApp): string {
  reconfirm(cluster);
  if (!containerMatches(cluster, owned, false)) throw new Error("refusing admission read");
  const result = docker(["exec", owned.containerId, "cat", "/admission/state"], []);
  if (result.status !== 0) throw new Error(`admission file read failed ${trim(result.stderr)}`);
  return result.stdout.trim();
}

export function containerState(cluster: Cluster, owned: OwnedApp): {
  running: boolean;
  status: string;
  restartPolicy: string;
  restartCount: number;
  startedAt: string;
} {
  reconfirm(cluster);
  if (!containerMatches(cluster, owned, false)) throw new Error("refusing container state read");
  const result = docker(
    [
      "inspect",
      "--format",
      "{{.State.Running}}|{{.State.Status}}|{{.HostConfig.RestartPolicy.Name}}|{{.RestartCount}}|{{.State.StartedAt}}",
      owned.containerId,
    ],
    [],
  );
  if (result.status !== 0) throw new Error(`writer inspect failed ${trim(result.stderr)}`);
  const [running, status, restartPolicy, restartCount, startedAt] = result.stdout.trim().split("|");
  return {
    running: running === "true",
    status: status ?? "",
    restartPolicy: restartPolicy ?? "",
    restartCount: Number(restartCount ?? "NaN"),
    startedAt: startedAt ?? "",
  };
}

export function killWriter(cluster: Cluster, owned: OwnedApp): void {
  reconfirm(cluster);
  if (!containerMatches(cluster, owned)) throw new Error("refusing kill");
  const result = docker(["kill", owned.containerId], []);
  if (result.status !== 0) throw new Error(`docker kill failed ${trim(result.stderr)}`);
}

export function stopWriter(cluster: Cluster, owned: OwnedApp): void {
  reconfirm(cluster);
  if (!containerMatches(cluster, owned)) throw new Error("refusing stop");
  const result = docker(["stop", owned.containerId], []);
  if (result.status !== 0) throw new Error(`docker stop failed ${trim(result.stderr)}`);
}

export function startWriter(cluster: Cluster, owned: OwnedApp): void {
  reconfirm(cluster);
  if (!containerMatches(cluster, owned, false)) throw new Error("refusing start");
  const result = docker(["start", owned.containerId], []);
  if (result.status !== 0) throw new Error(`docker start failed ${trim(result.stderr)}`);
}

export function removeOwned(cluster: Cluster, owned: OwnedApp): { container: "removed" | "preserved"; volume: "removed" | "preserved" } {
  const endpoint = cluster.endpoint;
  const daemonId = cluster.daemonId;
  let container: "removed" | "preserved" = "preserved";
  let volume: "removed" | "preserved" = "preserved";
  try {
    reconfirm(cluster);
  } catch {
    return { container, volume };
  }
  const info = docker(["info", "--format", "{{.ID}}"], []);
  const observedDaemonId = info.status === 0 ? info.stdout.trim() : "";
  const boundary = {
    reconfirmOk: true,
    observedDaemonId,
    expectedDaemonId: daemonId,
    observedEndpoint: cluster.endpoint,
    expectedEndpoint: endpoint,
  };
  if (removalGate({ ...boundary, containerAccepted: true }) !== "remove") return { container, volume };
  if (removalGate({ ...boundary, containerAccepted: containerMatches(cluster, owned, false) }) !== "remove") {
    return { container, volume };
  }
  const removed = docker(["rm", "-f", owned.containerId], []);
  container = containerRemovalResult(removed.status);
  if (container !== "removed") return { container, volume };
  try {
    reconfirm(cluster);
  } catch {
    return { container, volume };
  }
  if (volumeMatches(owned.volumeName, owned.proofId)) {
    const removedVolume = docker(["volume", "rm", owned.volumeName], []);
    volume = removedVolume.status === 0 ? "removed" : "preserved";
  }
  return { container, volume };
}

export function writerLogs(owned: OwnedApp, secrets: readonly string[]): string {
  assertId(owned.containerId);
  const result = docker(["logs", "--tail", "50", owned.containerId], secrets);
  return `${result.stdout}\n${result.stderr}`.slice(-900);
}

export type ClusterBinding = { ok: true } | { ok: false; reason: "endpoint" | "daemon" | "reconfirm" };

export function readReconfirmFailure(error: unknown): ClusterBinding {
  const message = error instanceof Error ? error.message : "";
  if (message === "docker endpoint changed") return { ok: false, reason: "endpoint" };
  if (message === "docker daemon changed") return { ok: false, reason: "daemon" };
  return { ok: false, reason: "reconfirm" };
}

export function boundContainerAbsence(binding: ClusterBinding, containerId: string, inspect: DockerExec | null): ContainerInspectVerdict {
  assertId(containerId);
  if (!binding.ok || inspect === null) return { gone: false, reason: "unknown" };
  return classifyContainerInspect(containerId, inspect);
}

export function containerGone(cluster: Cluster, containerId: string): boolean {
  assertId(containerId);
  let binding: ClusterBinding = { ok: true };
  try {
    reconfirm(cluster);
  } catch (error) {
    binding = readReconfirmFailure(error);
  }
  if (!binding.ok) return false;
  return boundContainerAbsence(binding, containerId, docker(["inspect", containerId], [])).gone;
}

export function classifyContainerInspect(containerId: string, result: DockerExec): ContainerInspectVerdict {
  assertId(containerId);
  if (result.errorCode === "ETIMEDOUT" || (result.status === null && result.signal)) return { gone: false, reason: "timeout" };
  if (result.errorCode === "ENOENT") return { gone: false, reason: "cli" };
  if (result.status === null) return { gone: false, reason: "unknown" };
  if (result.status === 0) return { gone: false, reason: "present" };
  const text = `${result.stderr}\n${result.stdout}`;
  if (/cannot connect to the docker daemon|error during connect|is the docker daemon running/i.test(text)) {
    return { gone: false, reason: "daemon" };
  }
  if (/context ["'].+["'] (?:does not exist|not found)|unable to resolve docker endpoint|invalid endpoint|current context/i.test(text)) {
    return { gone: false, reason: "endpoint" };
  }
  if (/command not found|executable file not found|not recognized as an internal or external command/i.test(text)) {
    return { gone: false, reason: "cli" };
  }
  const stdout = result.stdout.trim();
  const absentText = new RegExp(`no such (?:object|container):\\s*${containerId}\\b`, "i");
  const stdoutIsMarker = stdout === "" || stdout === "[]";
  const stdoutIsOnlyTheError = absentText.test(stdout) && !stdout.includes("{");
  const absent =
    result.status === 1 &&
    !result.signal &&
    !/no such file/i.test(text) &&
    absentText.test(text) &&
    (stdoutIsMarker || stdoutIsOnlyTheError);
  if (absent) return { gone: true, reason: "absent" };
  return { gone: false, reason: "unknown" };
}

export function writerIdentityAccepted(
  networkName: string,
  owned: OwnedApp,
  fields: WriterInspectFields,
  requireRunning = true,
): boolean {
  const networkOk = fields.networks.split(/\s+/).includes(networkName);
  return (
    fields.id === owned.containerId &&
    fields.name === `/${owned.containerName}` &&
    (fields.image === APP_IMAGE_REF || fields.image === `docker.io/library/${APP_IMAGE_REF}`) &&
    fields.imageId === owned.imageId &&
    fields.label === owned.proofId &&
    (fields.project === "" || fields.project === "<no value>") &&
    fields.policy === "unless-stopped" &&
    (!requireRunning || fields.running === "true") &&
    (fields.ports === "null" || fields.ports === "{}" || fields.ports === "") &&
    networkOk &&
    owned.containerName.startsWith(NAME_PREFIX)
  );
}

export function volumeIdentityAccepted(volumeName: string, proofId: string, name: string, label: string, project: string): boolean {
  try {
    assertOwnedName(volumeName);
  } catch {
    return false;
  }
  return name === volumeName && label === proofId && (project === "" || project === "<no value>");
}

export function removalGate(input: {
  reconfirmOk: boolean;
  observedDaemonId: string;
  expectedDaemonId: string;
  observedEndpoint: string;
  expectedEndpoint: string;
  containerAccepted: boolean;
}): "remove" | "preserve" {
  if (!input.reconfirmOk) return "preserve";
  if (input.observedDaemonId !== input.expectedDaemonId) return "preserve";
  if (input.observedEndpoint !== input.expectedEndpoint) return "preserve";
  if (!input.containerAccepted) return "preserve";
  return "remove";
}

export function containerRemovalResult(status: number | null): "removed" | "preserved" {
  return status === 0 ? "removed" : "preserved";
}

export function removeVolumeIfMatches(cluster: Cluster, volumeName: string, proofId: string): "removed" | "preserved" {
  try {
    reconfirm(cluster);
  } catch {
    return "preserved";
  }
  if (!volumeMatches(volumeName, proofId)) return "preserved";
  const removed = docker(["volume", "rm", volumeName], []);
  return removed.status === 0 ? "removed" : "preserved";
}

export function runningForeignCount(ownIds: readonly string[]): { foreign: number; sample: string[] } {
  const result = docker(["ps", "--no-trunc", "--format", "{{.ID}} {{.Names}}"], []);
  if (result.status !== 0) throw new Error("docker ps failed");
  const own = new Set(ownIds);
  const foreign: string[] = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const id = trimmed.slice(0, 64);
    const name = trimmed.slice(65);
    if (!own.has(id)) foreign.push(name);
  }
  return { foreign: foreign.length, sample: foreign.slice(0, 8) };
}

function containerMatches(cluster: Cluster, owned: OwnedApp, requireRunning = true): boolean {
  const result = docker(
    [
      "inspect",
      "--format",
      [
        "{{.Id}}",
        "{{.Name}}",
        "{{.Config.Image}}",
        "{{.Image}}",
        `{{index .Config.Labels "${PROOF_LABEL}"}}`,
        "{{index .Config.Labels \"com.docker.compose.project\"}}",
        "{{.HostConfig.RestartPolicy.Name}}",
        "{{.State.Running}}",
        "{{json .HostConfig.PortBindings}}",
        "{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{end}}",
      ].join("|"),
      owned.containerId,
    ],
    [],
  );
  if (result.status !== 0) return false;
  const fields = parseWriterInspect(result.stdout);
  if (!fields) return false;
  return writerIdentityAccepted(cluster.networkName, owned, fields, requireRunning);
}

function volumeMatches(volumeName: string, proofId: string): boolean {
  assertOwnedName(volumeName);
  const result = docker(
    ["volume", "inspect", "--format", `{{.Name}}|{{index .Labels "${PROOF_LABEL}"}}|{{index .Labels "com.docker.compose.project"}}`, volumeName],
    [],
  );
  if (result.status !== 0) return false;
  const [name, label, project] = result.stdout.trim().split("|");
  return volumeIdentityAccepted(volumeName, proofId, name ?? "", label ?? "", project ?? "");
}

function removeContainerIfMatches(cluster: Cluster, owned: OwnedApp): void {
  if (containerMatches(cluster, owned, false)) docker(["rm", "-f", owned.containerId], []);
}

function writerScript(): string {
  return [
    "set -eu",
    "echo \"target=${PGHOST}/${PGDATABASE}\"",
    "while true; do",
    "  if [ -f /admission/crash ]; then rm -f /admission/crash; exit 137; fi",
    "  state=open",
    "  if [ -f /admission/state ]; then state=$(tr -d '\\r\\n' < /admission/state); fi",
    "  if [ \"$state\" = closed ]; then sleep 0.4; continue; fi",
    "  psql -X -v ON_ERROR_STOP=1 -h \"$PGHOST\" -U \"$PGUSER\" -d \"$PGDATABASE\" -c \"INSERT INTO p1owa_write (id, channel, marker) SELECT COALESCE((SELECT MAX(id) FROM p1owa_write WHERE id >= 3000 AND id < 8000), 2999) + 1, 'restart-loop', current_database()\" || true",
    "  sleep 0.4",
    "done",
  ].join("\n");
}

function writeEnv(host: string, database: string, password: string): string {
  const file = path.join(os.tmpdir(), `p1owa-env-${randomBytes(8).toString("hex")}`);
  fs.writeFileSync(file, `PGPASSWORD=${password}\nPGHOST=${host}\nPGUSER=p1wc_app\nPGDATABASE=${database}\nPGCONNECT_TIMEOUT=5\n`, {
    mode: 0o600,
  });
  return file;
}

function docker(args: readonly string[], secrets: readonly string[]): Exec {
  const child = spawnSync("docker", [...args], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 40_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const errorCode = child.error && "code" in child.error ? String(child.error.code ?? "") : null;
  return {
    status: child.status,
    stdout: redact(child.stdout ?? "", secrets),
    stderr: redact(child.stderr ?? "", secrets),
    signal: child.signal,
    errorCode: errorCode === "" ? null : errorCode,
  };
}

function parseWriterInspect(stdout: string): WriterInspectFields | null {
  const lines = stdout.replace(/\r/g, "").trim().split("|");
  if (lines.length < 10) return null;
  const [id, name, image, imageId, label, project, policy, running, ports, networks] = lines;
  return {
    id: id ?? "",
    name: name ?? "",
    image: image ?? "",
    imageId: imageId ?? "",
    label: label ?? "",
    project: project ?? "",
    policy: policy ?? "",
    running: running ?? "",
    ports: ports ?? "",
    networks: networks ?? "",
  };
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function assertProofId(proofId: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(proofId)) {
    throw new Error("refusing proof id");
  }
}

function assertDatabase(database: string): void {
  if (!/^p1wc_[0-9a-f]{8}$/.test(database)) throw new Error("refusing database");
}

function assertId(containerId: string): void {
  if (!/^[0-9a-f]{64}$/.test(containerId)) throw new Error("refusing container id");
}

function assertOwnedName(name: string): void {
  const bare = name.replace(/^\//, "").toLowerCase();
  if (FORBIDDEN_RESOURCE_NAMES.some((forbidden) => forbidden === bare)) throw new Error("refusing production resource name");
  if (!bare.startsWith(NAME_PREFIX)) throw new Error("refusing resource outside the disposable prefix");
}

function trim(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 240);
}
