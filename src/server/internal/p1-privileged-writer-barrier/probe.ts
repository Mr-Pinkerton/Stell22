/**
 * Docker and psql probes for one coordinator-owned disposable cluster.
 * Removal uses only an id this file just received from docker run.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IMAGE_REF } from "@/server/internal/p1-write-freeze-coordinator/contract";
import type { Cluster } from "@/server/internal/p1-write-freeze-coordinator/cluster";

export type ProbeResult = {
  status: number | null;
  sqlstate: string | null;
  sqlstateInferred: boolean;
  stdout: string;
  stderr: string;
};

const children: ChildProcess[] = [];
const HBA_PATH = "/var/lib/postgresql/data/pg_hba.conf";
const PGDATA = "/var/lib/postgresql/data";

export function psql(
  cluster: Cluster,
  secrets: readonly string[],
  user: string,
  password: string,
  database: string,
  statement: string,
  transport: "tcp" | "socket",
): ProbeResult {
  assertDatabase(database);
  assertContainer(cluster);
  return withPassword(password, secrets, (envFile) => {
    const args = ["exec", "-i", "--env-file", envFile, cluster.containerId, "psql", "-X", "-U", user, "-d", database];
    if (transport === "tcp") args.push("-h", "127.0.0.1");
    args.push("-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-A", "-t", "-f", "-");
    return run(args, secrets, statement, 20_000);
  });
}

export function startScript(
  cluster: Cluster,
  secrets: readonly string[],
  user: string,
  password: string,
  database: string,
  statement: string,
): void {
  assertDatabase(database);
  assertContainer(cluster);
  const envFile = writePassword(password);
  const child = spawn(
    "docker",
    [
      "exec",
      "--env-file",
      envFile,
      cluster.containerId,
      "psql",
      "-X",
      "-h",
      "127.0.0.1",
      "-U",
      user,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  child.on("exit", () => {
    fs.rmSync(envFile, { force: true });
  });
  children.push(child);
}

export function stopScripts(): void {
  for (const child of children) stopChild(child);
  children.length = 0;
}

export function readHba(cluster: Cluster): string {
  assertContainer(cluster);
  const result = run(["exec", cluster.containerId, "cat", HBA_PATH], [], undefined, 10_000);
  if (result.status !== 0) throw new Error(`read pg_hba failed ${result.stderr.slice(0, 200)}`);
  return result.stdout;
}

export function writeHba(cluster: Cluster, body: string, user: "root" | "postgres"): void {
  assertContainer(cluster);
  if (!body.endsWith("\n")) throw new Error("pg_hba must end with a newline");
  const script =
    user === "root"
      ? `cat > ${HBA_PATH} && chown postgres:postgres ${HBA_PATH} && chmod 600 ${HBA_PATH}`
      : `cat > ${HBA_PATH} && chmod 600 ${HBA_PATH}`;
  const result = run(["exec", "-i", "-u", user, cluster.containerId, "sh", "-c", script], [], body, 10_000);
  if (result.status !== 0) throw new Error(`write pg_hba failed ${result.stderr.slice(0, 300)}`);
}

export function reloadConfig(cluster: Cluster): void {
  assertContainer(cluster);
  const result = run(["exec", "-u", "postgres", cluster.containerId, "pg_ctl", "reload", "-D", PGDATA], [], undefined, 15_000);
  if (result.status !== 0) throw new Error(`reload failed ${result.stderr.slice(0, 300)}`);
}

export function publishedPorts(cluster: Cluster): string {
  assertContainer(cluster);
  const result = run(["port", cluster.containerId], [], undefined, 10_000);
  if (result.status !== 0) throw new Error(`docker port failed ${result.stderr.slice(0, 200)}`);
  return result.stdout.trim();
}

export function startedAt(cluster: Cluster): string {
  assertContainer(cluster);
  const result = run(["inspect", "--format", "{{.State.StartedAt}}", cluster.containerId], [], undefined, 10_000);
  if (result.status !== 0 || result.stdout.trim().length < 20) throw new Error("StartedAt missing");
  return result.stdout.trim();
}

export function restartContainer(cluster: Cluster): void {
  assertContainer(cluster);
  const stopped = run(["stop", cluster.containerId], [], undefined, 40_000);
  if (stopped.status !== 0) throw new Error(`docker stop failed ${stopped.stderr.slice(0, 200)}`);
  const started = run(["start", cluster.containerId], [], undefined, 40_000);
  if (started.status !== 0) throw new Error(`docker start failed ${started.stderr.slice(0, 200)}`);
}

export function serverLogs(cluster: Cluster): string {
  assertContainer(cluster);
  const result = run(["logs", "--tail", "500", cluster.containerId], [], undefined, 15_000);
  return `${result.stdout}\n${result.stderr}`;
}

export function walDump(cluster: Cluster, startLsn: string): ProbeResult {
  assertContainer(cluster);
  if (!/^[0-9A-F]+\/[0-9A-F]+$/i.test(startLsn)) throw new Error("wal start is not an lsn");
  return run(
    ["exec", "-u", "postgres", cluster.containerId, "pg_waldump", "-p", `${PGDATA}/pg_wal`, "-s", startLsn],
    [],
    undefined,
    20_000,
  );
}

export function siblingSql(
  cluster: Cluster,
  secrets: readonly string[],
  user: string,
  password: string,
  database: string,
  statement: string,
): ProbeResult {
  assertDatabase(database);
  assertContainer(cluster);
  const name = `stell22-p1pb-client-${randomBytes(4).toString("hex")}`;
  const created = run(
    [
      "run",
      "-d",
      "--pull",
      "never",
      "--restart",
      "no",
      "--name",
      name,
      "--network",
      cluster.networkName,
      "--label",
      `stell22.p1.privileged-writer-barrier=${cluster.runId}`,
      "--entrypoint",
      "sleep",
      IMAGE_REF,
      "60",
    ],
    secrets,
    undefined,
    30_000,
  );
  const id = created.stdout.trim();
  if (created.status !== 0 || !/^[0-9a-f]{64}$/.test(id)) {
    throw new Error(`sibling container was not created ${created.stderr.slice(0, 200)}`);
  }
  try {
    assertClient(cluster, id, name);
    return withPassword(password, secrets, (envFile) =>
      run(
        [
          "exec",
          "-i",
          "--env-file",
          envFile,
          id,
          "psql",
          "-X",
          "-h",
          cluster.containerName,
          "-U",
          user,
          "-d",
          database,
          "-v",
          "ON_ERROR_STOP=1",
          "-v",
          "VERBOSITY=verbose",
          "-A",
          "-t",
          "-c",
          statement,
        ],
        secrets,
        undefined,
        20_000,
      ),
    );
  } finally {
    if (clientMatches(cluster, id, name)) {
      run(["rm", "-f", id], [], undefined, 20_000);
    }
  }
}

export function pgDump(cluster: Cluster, secrets: readonly string[], user: string, password: string, database: string): ProbeResult {
  assertDatabase(database);
  assertContainer(cluster);
  return withPassword(password, secrets, (envFile) =>
    run(
      [
        "exec",
        "--env-file",
        envFile,
        cluster.containerId,
        "pg_dump",
        "-h",
        "127.0.0.1",
        "-U",
        user,
        "-d",
        database,
        "--no-owner",
        "--no-acl",
        "-f",
        "/tmp/p1pb-dump.sql",
      ],
      secrets,
      undefined,
      30_000,
    ),
  );
}

function assertDatabase(database: string): void {
  if (!/^p1wc_[0-9a-f]{8}$/.test(database)) throw new Error("refusing database outside the disposable contract");
}

function assertContainer(cluster: Cluster): void {
  if (!/^[0-9a-f]{64}$/.test(cluster.containerId)) throw new Error("container id is not full");
  const result = run(
    ["inspect", "--format", "{{.Name}}\n{{.Config.Image}}\n{{.Id}}", cluster.containerId],
    [],
    undefined,
    10_000,
  );
  if (result.status !== 0) throw new Error("docker inspect failed");
  const [name, image, id] = result.stdout.split(/\r?\n/);
  if (name !== `/${cluster.containerName}`) throw new Error("container name drifted");
  if (image !== "postgres:17-alpine" && image !== "docker.io/library/postgres:17-alpine") {
    throw new Error("container image drifted");
  }
  if (normalizeId(id ?? "") !== cluster.containerId) throw new Error("container id drifted");
}

function assertClient(cluster: Cluster, id: string, name: string): void {
  if (!clientMatches(cluster, id, name)) throw new Error("refusing sibling container");
}

function clientMatches(cluster: Cluster, id: string, name: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(id) || !/^stell22-p1pb-client-[0-9a-f]{8}$/.test(name)) return false;
  const result = run(
    [
      "inspect",
      "--format",
      "{{.Name}}\n{{.Config.Image}}\n{{.Image}}\n{{index .Config.Labels \"stell22.p1.privileged-writer-barrier\"}}\n{{index .Config.Labels \"com.docker.compose.project\"}}",
      id,
    ],
    [],
    undefined,
    10_000,
  );
  if (result.status !== 0) return false;
  const lines = result.stdout.replace(/\r/g, "").split("\n");
  const gotName = lines[0] ?? "";
  const image = lines[1] ?? "";
  const imageId = lines[2] ?? "";
  const label = lines[3] ?? "";
  const project = lines[4] ?? "";
  return (
    gotName === `/${name}` &&
    (image === "postgres:17-alpine" || image === "docker.io/library/postgres:17-alpine") &&
    imageId === cluster.imageId &&
    label === cluster.runId &&
    (project === "" || project === "<no value>")
  );
}

function withPassword(password: string, secrets: readonly string[], fn: (envFile: string) => ProbeResult): ProbeResult {
  const envFile = writePassword(password);
  try {
    return fn(envFile);
  } finally {
    fs.rmSync(envFile, { force: true });
  }
}

function writePassword(password: string): string {
  const file = path.join(os.tmpdir(), `p1pb-pg-${randomBytes(8).toString("hex")}`);
  fs.writeFileSync(file, `PGPASSWORD=${password}\nPGCONNECT_TIMEOUT=5\n`, { mode: 0o600 });
  return file;
}

function run(args: readonly string[], secrets: readonly string[], input: string | undefined, timeout: number): ProbeResult {
  const child = spawnSync("docker", [...args], {
    windowsHide: true,
    encoding: "utf8",
    input,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stderr = redact(child.stderr ?? "", secrets);
  const parsed = inferSqlState(stderr);
  return {
    status: child.status,
    sqlstate: parsed.code,
    sqlstateInferred: parsed.inferred,
    stdout: redact(child.stdout ?? "", secrets),
    stderr,
  };
}

export function inferSqlState(stderr: string): { code: string | null; inferred: boolean } {
  const match = stderr.match(/(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/);
  if (match?.[1]) return { code: match[1], inferred: false };
  if (stderr.includes("pg_hba.conf rejects connection")) return { code: "28000", inferred: true };
  return { code: null, inferred: false };
}

function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function normalizeId(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value.trim();
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { windowsHide: true });
    return;
  }
  child.kill("SIGKILL");
}
