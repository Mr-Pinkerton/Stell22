import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTHORIZATION_PHRASE, REJECTED_AUTHORIZATION_PHRASE } from "./decide.mjs";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
const IMAGE = "node:22-bookworm-slim";

function unixPath(file: string) {
  return file.replace(/\\/g, "/").replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

function quote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function pathWithoutNode(prefix: string) {
  const separator = path.delimiter;
  const names = process.platform === "win32" ? ["node", "node.exe"] : ["node"];
  const kept = (process.env.PATH ?? "").split(separator).filter((dir) => {
    if (!dir) return false;
    return names.every((name) => !fs.existsSync(path.join(dir, name)));
  });
  return [prefix, ...kept].join(separator);
}

function run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv, input?: Buffer | string) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: input instanceof Buffer ? undefined : "utf8",
    input,
    env,
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

describe.skipIf(!LIVE)("admin corrections decision runtime", () => {
  it("runs pinned decisions from the local image when the host has no node", () => {
    const image = run("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE]);
    expect(image.status, `${image.stdout ?? ""}${image.stderr ?? ""}`).toBe(0);
    const realDocker = run("sh", ["-c", "command -v docker"]);
    expect(realDocker.status).toBe(0);
    const dockerBin = String(realDocker.stdout).trim();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-runtime-"));
    const unixRoot = unixPath(root);
    const log = unixPath(path.join(root, "docker.log"));
    const wrapperDir = path.join(root, "bin");
    fs.mkdirSync(wrapperDir);
    fs.writeFileSync(
      path.join(wrapperDir, "docker"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> ${quote(log)}\nexec ${quote(dockerBin)} "$@"\n`,
    );
    fs.chmodSync(path.join(wrapperDir, "docker"), 0o755);
    const hostPath = pathWithoutNode(unixPath(wrapperDir));
    const nodeProbe = run("sh", ["-c", "command -v node || echo missing"], { ...process.env, PATH: hostPath, NODE_ENV: process.env.NODE_ENV ?? "test" });
    expect(String(nodeProbe.stdout)).toContain("missing");

    const migrations = path.join(root, "migrations");
    fs.mkdirSync(migrations);
    const archive = spawnSync("git", ["archive", "--format=tar", "origin/main", "prisma/migrations"], {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    });
    expect(archive.status, String(archive.stderr ?? "")).toBe(0);
    const extracted = spawnSync("tar", ["-xf", "-"], { cwd: migrations, input: archive.stdout, windowsHide: true });
    expect(extracted.status, String(extracted.stderr ?? "")).toBe(0);
    const inventory = unixPath(path.join(migrations, "prisma", "migrations"));

    const suffix = randomBytes(4).toString("hex");
    const container = `acrel-app-${suffix}`;
    const missing = "acrel-app-deadbee1";
    const started = run("docker", ["run", "-d", "--name", container, "--pull", "never", "--entrypoint", "sleep", IMAGE, "3600"]);
    expect(started.status, `${started.stdout ?? ""}${started.stderr ?? ""}`).toBe(0);
    try {
      const base = {
        ...process.env,
        PATH: hostPath,
        NODE_ENV: process.env.NODE_ENV ?? "test",
        TMPDIR: unixRoot,
        STELL22_ADMIN_CORRECTIONS_DISPOSABLE: "1",
        STELL22_ADMIN_CORRECTIONS_EXECUTE: "1",
        STELL22_ADMIN_CORRECTIONS_MAINTENANCE: "1",
        STELL22_ADMIN_CORRECTIONS_CI: "1",
        STELL22_ADMIN_CORRECTIONS_RESTORE: "",
        STELL22_ADMIN_CORRECTIONS_SHA: "c25c21cfadcc1ce7ad49eb55bb407de0f4826810",
        STELL22_AC_PHASE: "runtime-proof",
        STELL22_AC_DATABASE: "acrel_abcd1234",
        STELL22_AC_DB_CONTAINER: "acrel-db-abcd1234",
        STELL22_AC_INSPECT_USER: "acrel_boot",
        STELL22_AC_DECIDE: unixPath(path.join(process.cwd(), "src/server/internal/admin-corrections-release/decide.mjs")),
        STELL22_AC_INVENTORY_DIR: inventory,
      } satisfies NodeJS.ProcessEnv;

      fs.writeFileSync(path.join(root, "docker.log"), "");
      const rejected = run("sh", ["scripts/admin-corrections-release.sh"], {
        ...base,
        STELL22_ADMIN_CORRECTIONS_AUTHORIZATION: REJECTED_AUTHORIZATION_PHRASE,
        STELL22_AC_RUNTIME_CONTAINER: container,
      });
      const rejectedOut = `${rejected.stdout ?? ""}${rejected.stderr ?? ""}`;
      expect(rejected.status).not.toBe(0);
      expect(rejectedOut).toContain("RESULT=STOP_OWNER_GATE");
      expect(rejectedOut).not.toContain("RESULT=STOP_RUNTIME");
      expect(fs.readFileSync(path.join(root, "docker.log"), "utf8")).not.toMatch(/^stop /m);
      expect(run("docker", ["inspect", "-f", "{{.State.Running}}", container]).stdout).toContain("true");

      fs.writeFileSync(path.join(root, "docker.log"), "");
      const unavailable = run("sh", ["scripts/admin-corrections-release.sh"], {
        ...base,
        STELL22_ADMIN_CORRECTIONS_AUTHORIZATION: AUTHORIZATION_PHRASE,
        STELL22_AC_RUNTIME_CONTAINER: missing,
      });
      const unavailableOut = `${unavailable.stdout ?? ""}${unavailable.stderr ?? ""}`;
      expect(unavailable.status).not.toBe(0);
      expect(unavailableOut).toContain("RESULT=STOP_RUNTIME");
      expect(unavailableOut).not.toContain("RESULT=STOP_OWNER_GATE");
      expect(unavailableOut).not.toContain("migrate deploy");
      expect(fs.readFileSync(path.join(root, "docker.log"), "utf8")).not.toMatch(/^stop /m);
      expect(run("docker", ["inspect", "-f", "{{.State.Running}}", container]).stdout).toContain("true");

      fs.writeFileSync(path.join(root, "docker.log"), "");
      const accepted = run("sh", ["scripts/admin-corrections-release.sh"], {
        ...base,
        STELL22_ADMIN_CORRECTIONS_AUTHORIZATION: AUTHORIZATION_PHRASE,
        STELL22_AC_RUNTIME_CONTAINER: container,
      });
      const acceptedOut = `${accepted.stdout ?? ""}${accepted.stderr ?? ""}`;
      expect(accepted.status, acceptedOut).toBe(0);
      expect(acceptedOut).toContain("RESULT=RUNTIME_OK");
      expect(acceptedOut).toContain("PINNED_MIGRATIONS=47");
      expect(acceptedOut).toContain("MIGRATION_ATTEMPTED=0");
      expect(acceptedOut).not.toContain("migrate deploy");
      expect(run("docker", ["inspect", "-f", "{{.State.Running}}", container]).stdout).toContain("false");
      const trace = fs.readFileSync(path.join(root, "docker.log"), "utf8");
      const commands = trace.split(/\r?\n/).filter(Boolean);
      const runs = commands.filter((line) => line.startsWith("run "));
      expect(runs.length).toBeGreaterThan(1);
      for (const line of runs) {
        expect(line).toContain("--network none");
        expect(line).toContain("--read-only");
        expect(line).toContain("--pull never");
        expect(line).toContain("--entrypoint node");
        expect(line).not.toContain("--privileged");
        expect(line).not.toContain("docker.sock");
        expect(line).not.toContain("--env-file");
        expect(line).not.toContain("DATABASE_URL");
        for (const match of line.matchAll(/-v (\S+)/g)) {
          expect(match[1]).toMatch(/:ro$/);
        }
      }
      const stopAt = commands.findIndex((line) => line.startsWith("stop "));
      const runAfterStop = commands.slice(stopAt + 1).some((line) => line.startsWith("run ") && line.includes("/opt/stell22-ac/decide.mjs"));
      expect(stopAt).toBeGreaterThan(0);
      expect(runAfterStop).toBe(true);
    } finally {
      run("docker", ["rm", "-f", container]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
