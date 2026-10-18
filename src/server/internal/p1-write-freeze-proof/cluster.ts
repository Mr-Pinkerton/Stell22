import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultOriginRuntime, resolveLocalDockerEndpoint } from "@/server/internal/p1-isolated-runner/container-origin";
import {
  IMAGE_REF,
  PROOF_LABEL,
  assertDatabaseName,
  assertResourceName,
  evaluateInspect,
  namesForRun,
  networkCleanupAllowed,
  volumeCleanupAllowed,
  type OwnedExpectation,
} from "@/server/internal/p1-write-freeze-proof/identity";

export type SqlRole = "bootstrap" | "breakglass" | "app" | "migrator";

const heldSessions: ChildProcess[] = [];
let heldErrors = "";

const ROLE_NAME: Record<SqlRole, string> = {
  bootstrap: "stell22",
  breakglass: "p1wf_breakglass",
  app: "p1wf_app",
  migrator: "p1wf_migrator",
};

export type Cluster = {
  runId: string;
  containerId: string;
  containerName: string;
  networkName: string;
  volumeName: string;
  imageId: string;
  daemonId: string;
  endpoint: string;
  passwords: Record<SqlRole, string>;
};

export type SqlOutcome = {
  status: number | null;
  signal: NodeJS.Signals | null;
  sqlstate: string | null;
  stdout: string;
  stderr: string;
};

export function createCluster(): Cluster {
  const endpoint = resolveLocalDockerEndpoint(defaultOriginRuntime());
  const imageId = docker(["image", "inspect", "--format", "{{.Id}}", IMAGE_REF]).stdout.trim();
  if (!imageId.startsWith("sha256:")) throw new Error("postgres:17-alpine is not available locally");
  const daemonId = docker(["info", "--format", "{{.ID}}"]).stdout.trim();
  if (daemonId.length < 8) throw new Error("docker daemon id is missing");
  const names = namesForRun(randomUUID());
  assertResourceName(names.containerName);
  assertResourceName(names.networkName);
  assertResourceName(names.volumeName);
  const passwords = {
    bootstrap: secret(),
    breakglass: secret(),
    app: secret(),
    migrator: secret(),
  };
  const label = `${PROOF_LABEL}=${names.runId}`;
  let network = false;
  let volume = false;
  let containerId = "";
  try {
    docker(["network", "create", "--label", label, names.networkName]);
    network = true;
    docker(["volume", "create", "--label", label, names.volumeName]);
    volume = true;
    const envFile = writeEnvFile(passwords.bootstrap);
    try {
      const created = docker([
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
      containerId = created.stdout.trim();
    } finally {
      fs.rmSync(envFile, { force: true });
    }
    if (!/^[0-9a-f]{64}$/.test(containerId)) throw new Error("docker did not return a container id");
    const cluster: Cluster = {
      ...names,
      containerId,
      imageId,
      daemonId,
      endpoint,
      passwords,
    };
    waitReady(cluster);
    reconfirmDocker(cluster);
    const marked = runSql(
      cluster,
      "bootstrap",
      `COMMENT ON DATABASE stell22 IS 'p1wf-run:${cluster.runId}';`,
      "stell22",
      { probe: false },
    );
    if (marked.status !== 0) {
      throw new Error(`disposable identity comment failed status=${marked.status ?? "null"} sqlstate=${marked.sqlstate ?? "none"} ${marked.stderr.slice(0, 400)}`);
    }
    reconfirm(cluster);
    return cluster;
  } catch (error) {
    const listed = spawnSync(
      "docker",
      ["ps", "-aq", "--no-trunc", "--filter", `label=${label}`],
      { windowsHide: true, encoding: "utf8" },
    );
    for (const id of (listed.stdout ?? "").split(/\s+/).filter((item) => /^[0-9a-f]{64}$/.test(item))) {
      spawnSync("docker", ["rm", "-f", id], { windowsHide: true, encoding: "utf8" });
    }
    if (volume) spawnSync("docker", ["volume", "rm", names.volumeName], { windowsHide: true });
    if (network) spawnSync("docker", ["network", "rm", names.networkName], { windowsHide: true });
    throw redactError(error, Object.values(passwords));
  }
}

export function destroyCluster(cluster: Cluster): void {
  stopHeldSessions();
  const problems: string[] = [];
  for (const step of [removeContainer, removeVolume, removeNetwork]) {
    try {
      step(cluster);
    } catch (error) {
      problems.push(redact(error instanceof Error ? error.message : "cleanup failed", secrets(cluster)));
    }
  }
  if (problems.length > 0) throw new Error(problems.join("; "));
}

export function reconfirm(cluster: Cluster): void {
  reconfirmDocker(cluster);
  const probe = runSql(
    cluster,
    "bootstrap",
    "SELECT current_database() AS db, current_setting('server_version_num') AS version_num, pg_catalog.shobj_description(oid, 'pg_database') AS note FROM pg_database WHERE datname = current_database();",
    "stell22",
    { probe: true },
  );
  if (probe.status !== 0) throw new Error("identity probe failed");
  const text = probe.stdout.replace(/\s+/g, " ");
  if (!text.includes("stell22") || !text.includes(`p1wf-run:${cluster.runId}`) || !/17\d{4}/.test(text)) {
    throw new Error("identity probe does not match this cluster");
  }
}

function reconfirmDocker(cluster: Cluster): void {
  const endpoint = resolveLocalDockerEndpoint(defaultOriginRuntime());
  if (endpoint !== cluster.endpoint) throw new Error("docker endpoint changed");
  const daemonId = docker(["info", "--format", "{{.ID}}"]).stdout.trim();
  if (daemonId !== cluster.daemonId) throw new Error("docker daemon changed");
  const inspected = inspectContainer(cluster);
  const verdict = evaluateInspect(inspected, expectation(cluster), "mutate");
  if (!verdict.ok) throw new Error(`refusing container: ${verdict.code}`);
}

export function sql(cluster: Cluster, role: SqlRole, statement: string, database = "stell22"): SqlOutcome {
  assertDatabaseName(database);
  reconfirm(cluster);
  return runSql(cluster, role, statement, database, { probe: false });
}

export function sqlBare(cluster: Cluster, role: SqlRole, statement: string): SqlOutcome {
  reconfirm(cluster);
  return runSql(cluster, role, statement, "stell22", { probe: true });
}

export function containerLogs(cluster: Cluster): string {
  reconfirm(cluster);
  const child = spawnSync("docker", ["logs", "--tail", "80", cluster.containerId], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 15_000,
  });
  return redact(`${child.stdout ?? ""}\n${child.stderr ?? ""}`, secrets(cluster));
}

export function containerIp(cluster: Cluster): string {
  reconfirm(cluster);
  const inspected = docker([
    "inspect",
    "--format",
    "{{range.NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    cluster.containerId,
  ]);
  const ip = inspected.stdout.trim();
  if (!/^(10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)\d+\.\d+$/.test(ip)) {
    throw new Error("container address is not a private bridge address");
  }
  return ip;
}

export function sqlWithPassword(
  cluster: Cluster,
  role: SqlRole,
  password: string,
  statement: string,
  host = "127.0.0.1",
): SqlOutcome {
  if (host !== "127.0.0.1" && !/^(10\.|172\.(1[6-9]|2\d|3[0-1])\.|192\.168\.)\d+\.\d+$/.test(host)) {
    throw new Error("refusing authentication host");
  }
  reconfirm(cluster);
  const child = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      `PGPASSWORD=${password}`,
      cluster.containerId,
      "psql",
      "-X",
      "-h",
      host,
      "-U",
      ROLE_NAME[role],
      "-d",
      "stell22",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=verbose",
      "-f",
      "-",
    ],
    {
      windowsHide: true,
      encoding: "utf8",
      input: statement,
      timeout: 15_000,
      maxBuffer: 1_000_000,
    },
  );
  return outcome(child, [...secrets(cluster), password]);
}

export function startBackgroundSql(cluster: Cluster, role: SqlRole, statement: string): void {
  reconfirm(cluster);
  const child = spawn(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${cluster.passwords[role]}`,
      cluster.containerId,
      "psql",
      "-X",
      "-h",
      "127.0.0.1",
      "-U",
      ROLE_NAME[role],
      "-d",
      "stell22",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  heldSessions.push(child);
  const record = (chunk: string) => {
    heldErrors = redact(`${heldErrors}${chunk}`, secrets(cluster)).slice(-2000);
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  child.on("exit", (code) => {
    record(`\nheld-exit:${code ?? "null"}\n`);
  });
}

export function backgroundErrors(): string {
  return heldErrors;
}

function stopHeldSessions(): void {
  for (const child of heldSessions) {
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {
        // The owned container removal ends the server session.
      }
    }
  }
  heldSessions.length = 0;
}

export function pgDump(cluster: Cluster, role: SqlRole, args: readonly string[]): SqlOutcome {
  reconfirm(cluster);
  const child = spawnSync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${cluster.passwords[role]}`,
      cluster.containerId,
      "pg_dump",
      "-h",
      "127.0.0.1",
      "-U",
      ROLE_NAME[role],
      "-d",
      "stell22",
      ...args,
    ],
    { windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return outcome(child, secrets(cluster));
}

export function roleName(role: SqlRole): string {
  return ROLE_NAME[role];
}

function runSql(
  cluster: Cluster,
  role: SqlRole,
  statement: string,
  database: string,
  options: { probe: boolean },
): SqlOutcome {
  const script = options.probe
    ? statement
    : `SET statement_timeout = '8s';\nSET lock_timeout = '3s';\n${statement}`;
  const child = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      `PGPASSWORD=${cluster.passwords[role]}`,
      cluster.containerId,
      "psql",
      "-X",
      "-h",
      "127.0.0.1",
      "-U",
      ROLE_NAME[role],
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "VERBOSITY=verbose",
      "-A",
      "-t",
      "-F",
      "|",
      "-f",
      "-",
    ],
    { windowsHide: true, encoding: "utf8", input: script, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return outcome(child, secrets(cluster));
}

function waitReady(cluster: Cluster): void {
  let detail = "no TCP login attempt";
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const child = spawnSync(
      "docker",
      ["exec", cluster.containerId, "pg_isready", "-h", "127.0.0.1", "-U", "stell22", "-d", "stell22"],
      { windowsHide: true, encoding: "utf8", timeout: 5_000 },
    );
    if (child.status === 0) {
      const probe = runSql(cluster, "bootstrap", "SELECT 1;", "stell22", { probe: true });
      if (probe.status === 0) return;
      detail = probe.stderr.slice(0, 300);
    }
    sleep(500);
  }
  throw new Error(`disposable postgres did not accept a TCP login: ${detail}`);
}

function inspectContainer(cluster: Cluster): unknown {
  const result = docker(["inspect", cluster.containerId]);
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("inspect did not return one container");
  return parsed[0];
}

function removeContainer(cluster: Cluster): void {
  const result = spawnSync("docker", ["inspect", cluster.containerId], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.status !== 0) return;
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("cleanup inspect malformed");
  const verdict = evaluateInspect(parsed[0], expectation(cluster), "cleanup");
  if (!verdict.ok) throw new Error(`cleanup refused: ${verdict.code}`);
  const removed = spawnSync("docker", ["rm", "-f", cluster.containerId], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (removed.status !== 0) throw new Error("owned container removal failed");
}

function removeVolume(cluster: Cluster): void {
  const result = spawnSync("docker", ["volume", "inspect", cluster.volumeName], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.status !== 0) return;
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("volume inspect malformed");
  const verdict = volumeCleanupAllowed(parsed[0], expectation(cluster));
  if (!verdict.ok) throw new Error(`volume cleanup refused: ${verdict.code}`);
  const removed = spawnSync("docker", ["volume", "rm", cluster.volumeName], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (removed.status !== 0) throw new Error("owned volume removal failed");
}

function removeNetwork(cluster: Cluster): void {
  const result = spawnSync("docker", ["network", "inspect", cluster.networkName], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.status !== 0) return;
  const parsed: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("network inspect malformed");
  const verdict = networkCleanupAllowed(parsed[0], expectation(cluster));
  if (!verdict.ok) throw new Error(`network cleanup refused: ${verdict.code}`);
  const removed = spawnSync("docker", ["network", "rm", cluster.networkName], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (removed.status !== 0) throw new Error("owned network removal failed");
}

function expectation(cluster: Cluster): OwnedExpectation {
  return {
    runId: cluster.runId,
    containerId: cluster.containerId,
    containerName: cluster.containerName,
    networkName: cluster.networkName,
    volumeName: cluster.volumeName,
    imageId: cluster.imageId,
  };
}

function docker(args: readonly string[]): { stdout: string } {
  const child = spawnSync("docker", [...args], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (child.status !== 0) {
    throw new Error(`docker ${args[0]} failed`);
  }
  return { stdout: child.stdout ?? "" };
}

function writeEnvFile(password: string): string {
  const file = path.join(os.tmpdir(), `p1wf-env-${randomUUID()}`);
  fs.writeFileSync(
    file,
    `POSTGRES_USER=stell22\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=stell22\nPOSTGRES_HOST_AUTH_METHOD=scram-sha-256\n`,
    { mode: 0o600 },
  );
  return file;
}

function secret(): string {
  return randomBytes(24).toString("hex");
}

function secrets(cluster: Cluster): string[] {
  return Object.values(cluster.passwords);
}

function outcome(
  child: { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string },
  secretValues: string[],
): SqlOutcome {
  const stderr = redact(child.stderr ?? "", secretValues);
  return {
    status: child.status,
    signal: child.signal,
    sqlstate: parseSqlState(stderr),
    stdout: redact(child.stdout ?? "", secretValues),
    stderr,
  };
}

function parseSqlState(stderr: string): string | null {
  const match = stderr.match(/(?:ERROR|FATAL):\s+([0-9A-Z]{5}):/);
  return match?.[1] ?? null;
}

function redact(text: string, secretValues: string[]): string {
  let out = text;
  for (const secretValue of secretValues) {
    if (secretValue.length > 0) out = out.split(secretValue).join("[redacted]");
  }
  return out;
}

function redactError(error: unknown, secretValues: string[]): Error {
  const message = error instanceof Error ? error.message : "cluster creation failed";
  return new Error(redact(message, secretValues));
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
