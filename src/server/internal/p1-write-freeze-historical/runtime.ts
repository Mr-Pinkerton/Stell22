/**
 * Docker operations for the disposable historical application proof.
 * Commands that carry a password use an env file. Output is redacted.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { defaultOriginRuntime, resolveLocalDockerEndpoint } from "@/server/internal/p1-isolated-runner/container-origin";
import { releaseAppContainer } from "@/server/internal/p1-write-freeze-historical/cleanup";
import {
  APP_LABEL,
  HISTORICAL_APPLICATION_COMMIT,
  HISTORICAL_APPLICATION_TREE,
  type AppExpectation,
} from "@/server/internal/p1-write-freeze-historical/identity";
import type { DockerWorld, ExecResult } from "@/server/internal/p1-write-freeze-proof/lifecycle";

export function verifyHistoricalSource(): { commit: string; tree: string } {
  const commit = git(["rev-parse", HISTORICAL_APPLICATION_COMMIT]).trim();
  const tree = git(["rev-parse", `${HISTORICAL_APPLICATION_COMMIT}^{tree}`]).trim();
  if (commit !== HISTORICAL_APPLICATION_COMMIT || tree !== HISTORICAL_APPLICATION_TREE) {
    throw new Error("historical commit identity drifted");
  }
  const entry = git(["show", `${HISTORICAL_APPLICATION_COMMIT}:docker-entrypoint.sh`]);
  if (!entry.includes("npx prisma migrate deploy") || !entry.includes("npm run start")) {
    throw new Error("historical entrypoint bytes drifted");
  }
  return { commit, tree };
}

export function ensureNodeBase(): void {
  const present = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", "node:22-bookworm-slim"], {
    windowsHide: true,
    encoding: "utf8",
  });
  if (present.status === 0 && (present.stdout ?? "").trim().startsWith("sha256:")) return;
  const pulled = spawnSync("docker", ["pull", "node:22-bookworm-slim"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 300_000,
  });
  if (pulled.status !== 0) throw new Error("node:22-bookworm-slim is unavailable");
}

export async function buildHistoricalImage(tag: string): Promise<string> {
  if (!/^stell22-p1wf-hist-[0-9a-f-]{36}$/.test(tag)) throw new Error("refusing image tag");
  verifyHistoricalSource();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p1wf-hist-"));
  const tarPath = path.join(root, "source.tar");
  try {
    const archived = spawnSync(
      "git",
      ["-c", "core.autocrlf=false", "archive", "--format=tar", "-o", tarPath, HISTORICAL_APPLICATION_COMMIT],
      { windowsHide: true, encoding: "utf8" },
    );
    if (archived.status !== 0) throw new Error("historical archive failed");
    const extracted = spawnSync(
      "python",
      [
        "-c",
        "import tarfile, sys\nwith tarfile.open(sys.argv[1], 'r') as archive:\n    archive.extractall(sys.argv[2], filter='data')\n",
        tarPath,
        root,
      ],
      { windowsHide: true, encoding: "utf8" },
    );
    if (extracted.status !== 0) throw new Error("historical extract failed");
    fs.rmSync(tarPath, { force: true });
    const detail = await runBuild(tag, root);
    if (detail !== "") throw new Error(`historical image build failed ${detail}`);
    return imageId(tag);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runBuild(tag: string, root: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const context = root.replace(/\\/g, "/");
    const child = spawn("docker", ["build", "-t", tag, context], { windowsHide: true });
    let detail = "";
    const take = (chunk: Buffer) => {
      detail = `${detail}${chunk.toString("utf8")}`.slice(-1500);
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    child.on("error", reject);
    child.on("exit", (status) => {
      if (status === 0) resolve("");
      else resolve(`status=${status ?? "null"} ${detail}`);
    });
  });
}

export function imageId(ref: string): string {
  const inspected = spawnSync("docker", ["image", "inspect", "--format", "{{.Id}}", ref], {
    windowsHide: true,
    encoding: "utf8",
  });
  const id = (inspected.stdout ?? "").trim();
  if (inspected.status !== 0 || !/^sha256:[0-9a-f]{64}$/.test(id)) throw new Error("image id is missing");
  return id;
}

export function historicalFile(commit: string, file: string): string {
  if (commit !== HISTORICAL_APPLICATION_COMMIT) throw new Error("refusing historical file");
  return git(["show", `${commit}:${file}`]);
}

export function createStopped(args: readonly string[]): string {
  const child = spawnSync("docker", ["create", ...args], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 60_000,
  });
  const id = (child.stdout ?? "").trim();
  if (child.status !== 0 || !/^[0-9a-f]{64}$/.test(id)) throw new Error("docker create did not return a container id");
  return id;
}

export function copyFromContainer(containerId: string, containerPath: string): string {
  const file = path.join(os.tmpdir(), `p1wf-copy-${randomUUID()}`);
  try {
    const child = spawnSync("docker", ["cp", `${containerId}:${containerPath}`, file], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (child.status !== 0) throw new Error("docker cp failed");
    return fs.readFileSync(file, "utf8");
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export function runDetached(args: readonly string[]): string {
  const child = spawnSync("docker", ["run", "-d", ...args], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 180_000,
  });
  const id = (child.stdout ?? "").trim();
  if (child.status !== 0 || !/^[0-9a-f]{64}$/.test(id)) throw new Error("docker run did not return a container id");
  return id;
}

export function waitContainer(id: string, timeoutMs: number): number {
  const child = spawnSync("docker", ["wait", id], { windowsHide: true, encoding: "utf8", timeout: timeoutMs });
  if (child.status !== 0) throw new Error("docker wait failed");
  const code = Number((child.stdout ?? "").trim());
  if (!Number.isInteger(code)) throw new Error("docker wait returned no exit code");
  return code;
}

export function containerFacts(id: string): { running: boolean; startedAt: string; exitCode: number; pid: number } {
  const child = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Running}}|{{.State.StartedAt}}|{{.State.ExitCode}}|{{.State.Pid}}", id],
    { windowsHide: true, encoding: "utf8", timeout: 20_000 },
  );
  if (child.status !== 0) throw new Error("container inspect failed");
  const [running, startedAt, exitCode, pid] = (child.stdout ?? "").trim().split("|");
  return { running: running === "true", startedAt: startedAt ?? "", exitCode: Number(exitCode), pid: Number(pid) };
}

export function inspectDocument(id: string): unknown {
  const child = spawnSync("docker", ["inspect", id], { windowsHide: true, encoding: "utf8", timeout: 20_000 });
  if (child.status !== 0) throw new Error("docker inspect failed");
  const parsed: unknown = JSON.parse(child.stdout ?? "");
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("inspect did not return one container");
  return parsed[0];
}

export function redactedLogs(id: string, secrets: readonly string[]): string {
  const child = spawnSync("docker", ["logs", id], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return redact(`${child.stdout ?? ""}\n${child.stderr ?? ""}`, secrets);
}

export function writeUrlFile(user: "p1wf_app" | "p1wf_migrator", password: string, host: string): string {
  const url = `postgresql://${user}:${password}@${host}:5432/stell22`;
  const file = path.join(os.tmpdir(), `p1wf-hist-${randomUUID()}`);
  fs.writeFileSync(
    file,
    `DATABASE_URL=${url}\nNODE_ENV=production\nPORT=3000\nNEXT_TELEMETRY_DISABLED=1\n`,
    { mode: 0o600 },
  );
  return file;
}

export function removeOwnedApp(expected: AppExpectation, endpoint: string, daemonId: string, secrets: readonly string[]): string {
  const report = releaseAppContainer(expected, endpoint, daemonId, realWorld());
  return redact(`${report.removed ? "removed" : "preserved"}:${report.reason}`, secrets);
}

export function copyProbe(containerId: string, script: string): void {
  const file = path.join(os.tmpdir(), `p1wf-probe-${randomUUID()}.cjs`);
  fs.writeFileSync(file, script);
  try {
    const child = spawnSync("docker", ["cp", file, `${containerId}:/app/p1wf-probe.cjs`], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 20_000,
    });
    if (child.status !== 0) throw new Error("probe copy failed");
  } finally {
    fs.rmSync(file, { force: true });
  }
}

export function runProbe(containerId: string, mode: string, secrets: readonly string[]): { status: number | null; text: string } {
  const child = spawnSync("docker", ["exec", containerId, "node", "/app/p1wf-probe.cjs", mode], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 40_000,
    maxBuffer: 1_000_000,
  });
  return { status: child.status, text: redact(`${child.stdout ?? ""}\n${child.stderr ?? ""}`, secrets) };
}

export function startProbe(containerId: string, mode: string): ChildProcess {
  return spawn("docker", ["exec", containerId, "node", "/app/p1wf-probe.cjs", mode], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function realWorld(): DockerWorld {
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

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/postgresql:\/\/[^\s'"]+/g, "postgresql://[redacted]");
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

function git(args: readonly string[]): string {
  const child = spawnSync("git", [...args], { windowsHide: true, encoding: "utf8" });
  if (child.status !== 0) throw new Error(`git ${args[0]} failed`);
  return child.stdout ?? "";
}

export function appLabel(runId: string): string {
  return `${APP_LABEL}=${runId}`;
}
