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
  type OwnedExpectation,
} from "@/server/internal/p1-write-freeze-proof/identity";
import {
  formatCleanupReport,
  releaseInvocation,
  type DockerWorld,
  type ExecResult,
  type Invocation,
} from "@/server/internal/p1-write-freeze-proof/lifecycle";

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
  const world = realWorld();
  const endpoint = world.endpoint();
  const image = world.exec(["image", "inspect", "--format", "{{.Id}}", IMAGE_REF]);
  const imageId = image.stdout.trim();
  if (image.status !== 0 || !/^sha256:[0-9a-f]{64}$/.test(imageId)) {
    throw new Error("postgres:17-alpine is not available locally");
  }
  const daemonId = world.daemonId();
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
  const label = `${PROOF_LABEL}=${names.runId}`;
  try {
    assertSameBinding(invocation, world);
    const network = world.exec(["network", "create", "--label", label, names.networkName]);
    if (network.status !== 0) throw new Error("docker network failed");
    invocation.networkCreated = true;
    assertSameBinding(invocation, world);
    const volume = world.exec(["volume", "create", "--label", label, names.volumeName]);
    if (volume.status !== 0) throw new Error("docker volume failed");
    invocation.volumeCreated = true;
    assertSameBinding(invocation, world);
    const envFile = writeEnvFile(passwords.bootstrap);
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
    } catch (error) {
      invocation.containerPhase = "ambiguous";
      throw error;
    } finally {
      fs.rmSync(envFile, { force: true });
    }
    if (created.status !== 0) {
      invocation.containerPhase = "ambiguous";
      throw new Error("docker run failed");
    }
    const containerId = created.stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(containerId)) {
      invocation.containerPhase = "ambiguous";
      throw new Error("docker did not return a container id");
    }
    invocation.containerId = containerId;
    invocation.containerPhase = "ambiguous";
    assertSameBinding(invocation, world);
    const inspected = world.exec(["inspect", containerId]);
    if (inspected.status !== 0) throw new Error("docker inspect failed");
    let parsed: unknown;
    try {
      parsed = JSON.parse(inspected.stdout);
    } catch {
      throw new Error("inspect did not return one container");
    }
    if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("inspect did not return one container");
    const owned = evaluateInspect(parsed[0], expectationFrom(invocation, containerId), "cleanup");
    if (!owned.ok) throw new Error(`refusing container: ${owned.code}`);
    invocation.containerPhase = "confirmed";
    const running = evaluateInspect(parsed[0], expectationFrom(invocation, containerId), "mutate");
    if (!running.ok) throw new Error(`refusing container: ${running.code}`);
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
      throw new Error(
        `disposable identity comment failed status=${marked.status ?? "null"} sqlstate=${marked.sqlstate ?? "none"} ${marked.stderr.slice(0, 400)}`,
      );
    }
    reconfirm(cluster);
    return cluster;
  } catch (error) {
    const report = releaseInvocation(invocation, world);
    const message = error instanceof Error ? error.message : "cluster creation failed";
    throw redactError(
      new Error(`phase=${invocation.containerPhase} ${message}; ${formatCleanupReport(report)}`),
      Object.values(passwords),
    );
  }
}

export function destroyCluster(cluster: Cluster): void {
  stopHeldSessions();
  const invocation: Invocation = {
    endpoint: cluster.endpoint,
    daemonId: cluster.daemonId,
    imageId: cluster.imageId,
    names: {
      runId: cluster.runId,
      containerName: cluster.containerName,
      networkName: cluster.networkName,
      volumeName: cluster.volumeName,
    },
    networkCreated: true,
    volumeCreated: true,
    containerId: cluster.containerId,
    containerPhase: "confirmed",
  };
  const report = releaseInvocation(invocation, realWorld());
  if (report.preserved.length > 0 || report.failures.length > 0) {
    throw new Error(redactProofText(formatCleanupReport(report), secrets(cluster)));
  }
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
  return withPasswordFile(password, (envFile) => {
    const child = spawnSync(
      "docker",
      proofExecArgs(envFile, cluster.containerId, [
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
      ], true),
      {
        windowsHide: true,
        encoding: "utf8",
        input: statement,
        timeout: 15_000,
        maxBuffer: 1_000_000,
      },
    );
    return outcome(child, [...secrets(cluster), password]);
  });
}

export function startBackgroundSql(cluster: Cluster, role: SqlRole, statement: string): void {
  reconfirm(cluster);
  const envFile = writePasswordFile(cluster.passwords[role]);
  let child: ChildProcess;
  try {
    child = spawn(
      "docker",
      proofExecArgs(envFile, cluster.containerId, [
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
      ], false),
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    fs.rmSync(envFile, { force: true });
    throw error;
  }
  child.on("exit", () => {
    fs.rmSync(envFile, { force: true });
  });
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
  return withPasswordFile(cluster.passwords[role], (envFile) => {
    const child = spawnSync(
      "docker",
      proofExecArgs(envFile, cluster.containerId, [
        "pg_dump",
        "-h",
        "127.0.0.1",
        "-U",
        ROLE_NAME[role],
        "-d",
        "stell22",
        ...args,
      ], false),
      { windowsHide: true, encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return outcome(child, secrets(cluster));
  });
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
  return withPasswordFile(cluster.passwords[role], (envFile) => {
    const child = spawnSync(
      "docker",
      proofExecArgs(envFile, cluster.containerId, [
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
      ], true),
      { windowsHide: true, encoding: "utf8", input: script, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return outcome(child, secrets(cluster));
  });
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("inspect did not return one container");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("inspect did not return one container");
  return parsed[0];
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

export function proofExecArgs(
  envFile: string,
  containerId: string,
  command: readonly string[],
  stdin: boolean,
): string[] {
  const args = ["exec"];
  if (stdin) args.push("-i");
  args.push("--env-file", envFile, containerId, ...command);
  return args;
}

function realWorld(): DockerWorld {
  return {
    endpoint: () => resolveLocalDockerEndpoint(defaultOriginRuntime()),
    daemonId: () => {
      const result = execRaw(["info", "--format", "{{.ID}}"]);
      const daemonId = result.stdout.trim();
      if (result.status !== 0 || daemonId.length < 8) throw new Error("docker daemon id is missing");
      return daemonId;
    },
    exec: (args) => execRaw(args),
  };
}

function execRaw(args: readonly string[]): ExecResult {
  const child = spawnSync("docker", [...args], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: child.status, stdout: child.stdout ?? "", stderr: "" };
}

function assertSameBinding(invocation: Invocation, world: DockerWorld): void {
  if (world.endpoint() !== invocation.endpoint) throw new Error("docker endpoint changed");
  if (world.daemonId() !== invocation.daemonId) throw new Error("docker daemon changed");
}

function expectationFrom(invocation: Invocation, containerId: string): OwnedExpectation {
  return { ...invocation.names, containerId, imageId: invocation.imageId };
}

function docker(args: readonly string[]): { stdout: string } {
  const result = execRaw(args);
  if (result.status !== 0) throw new Error(`docker ${args[0]} failed`);
  return { stdout: result.stdout };
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

function writePasswordFile(password: string): string {
  const file = path.join(os.tmpdir(), `p1wf-pg-${randomUUID()}`);
  fs.writeFileSync(file, `PGPASSWORD=${password}\n`, { mode: 0o600 });
  return file;
}

function withPasswordFile<T>(password: string, fn: (envFile: string) => T): T {
  const file = writePasswordFile(password);
  try {
    return fn(file);
  } finally {
    fs.rmSync(file, { force: true });
  }
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

export function redactProofText(text: string, secretValues: readonly string[]): string {
  let out = text;
  for (const secretValue of secretValues) {
    if (secretValue.length > 0) out = out.split(secretValue).join("[redacted]");
  }
  return out;
}

function redact(text: string, secretValues: readonly string[]): string {
  return redactProofText(text, secretValues);
}

function redactError(error: unknown, secretValues: string[]): Error {
  const message = error instanceof Error ? error.message : "cluster creation failed";
  return new Error(redact(message, secretValues));
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
