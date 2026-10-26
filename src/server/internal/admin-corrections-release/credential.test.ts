import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTHORIZATION_PHRASE } from "./decide.mjs";

const SCRIPT = "scripts/admin-corrections-release.sh";
const PASSWORD = "valid-migrator-password-24";
const directories: string[] = [];

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    NODE_ENV: process.env.NODE_ENV ?? "test",
    STELL22_ADMIN_CORRECTIONS_DISPOSABLE: "1",
    STELL22_ADMIN_CORRECTIONS_EXECUTE: "1",
    STELL22_ADMIN_CORRECTIONS_MAINTENANCE: "1",
    STELL22_ADMIN_CORRECTIONS_AUTHORIZATION: AUTHORIZATION_PHRASE,
    STELL22_ADMIN_CORRECTIONS_CI: "1",
    STELL22_ADMIN_CORRECTIONS_SHA: `${"ab".repeat(16)}${"cd".repeat(4)}`,
    STELL22_AC_PHASE: "credential-gate",
    STELL22_AC_DATABASE: "acrel_abcd1234",
    STELL22_AC_DB_CONTAINER: "acrel-db-abcd1234",
    STELL22_AC_APP_CONTAINER: "acrel-app-abcd1234",
    STELL22_AC_INSPECT_USER: "acrel_boot",
    ...extra,
  };
}

function writeEnv(contents: string, mode = 0o600) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-credential-"));
  directories.push(root);
  const file = path.join(root, "server.env");
  fs.writeFileSync(file, contents.replace(/\r\n/g, "\n"), { mode });
  fs.chmodSync(file, mode);
  return { root, file: file.replace(/\\/g, "/") };
}

function run(extra: Record<string, string>) {
  const child = spawnSync("sh", [SCRIPT], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: baseEnv(extra),
    windowsHide: true,
  });
  return { status: child.status ?? 1, out: `${child.stdout ?? ""}${child.stderr ?? ""}` };
}

function expectSecretFree(out: string) {
  expect(out).not.toContain(PASSWORD);
  expect(out).not.toContain("postgresql://");
  expect(out).not.toContain("DATABASE_URL=");
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("admin corrections migrator credential", () => {
  it("reads one private password before checkout, image build, or app shutdown", () => {
    const script = fs.readFileSync(SCRIPT, "utf8");
    const prepare = script.indexOf("if ! prepare_migrator_credential; then");
    expect(prepare).toBeGreaterThan(0);
    expect(prepare).toBeLessThan(script.indexOf("checkout_after_gate ||"));
    expect(prepare).toBeLessThan(script.indexOf('docker compose -f "$COMPOSE_FILE" build app'));
    expect(script.indexOf("if ! prove_runtime; then")).toBeGreaterThan(0);
    expect(script.indexOf("if ! prove_runtime; then")).toBeLessThan(prepare);
    expect(script.indexOf("probe_login production")).toBeLessThan(script.indexOf('docker stop "$app_container"'));
    expect(script).not.toContain("python scripts/release-migrator-url.py");
    expect(script).not.toContain(". ./.env");
    expect(script).not.toContain('. "$env_file"');
    const workflow = fs.readFileSync(".github/workflows/release-admin-corrections.yml", "utf8");
    expect(workflow).toContain('git show "${EXPECTED_SHA}:scripts/release-credential.py"');
    expect(workflow).toContain('git show "${EXPECTED_SHA}:scripts/release-migrator-url.py"');
    expect(workflow).not.toContain("MIGRATOR_DB_PASSWORD");
    const env = writeEnv(`OTHER=ignored\nMIGRATOR_DB_PASSWORD=${PASSWORD}\n`);
    const dockerLog = path.join(env.root, "docker.log");
    const bin = path.join(env.root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + `'${dockerLog.replace(/\\/g, "/")}'` + "\nexit 99\n");
    fs.chmodSync(path.join(bin, "docker"), 0o755);
    const ready = run({
      PATH: `${bin.replace(/\\/g, "/")}${path.delimiter}${process.env.PATH ?? ""}`,
      STELL22_AC_ENV_FILE: env.file,
      STELL22_AC_HEAD: "ea7c58f0598df9ea21ffe676a69e3348154e6520",
    });
    expect(ready.status, ready.out).toBe(0);
    expect(ready.out).toContain("RESULT=CREDENTIAL_READY");
    expect(ready.out).toContain("APP_STOPPED=0");
    expect(ready.out).toContain("MIGRATION_ATTEMPTED=0");
    expect(ready.out).toContain("RETRY_MIGRATION=NO");
    expect(ready.out).toContain("DATABASE_RESTORE=NO");
    expect(ready.out).not.toContain("migrate deploy");
    expect(fs.existsSync(dockerLog)).toBe(false);
    expectSecretFree(ready.out);
  });

  it("stops before shutdown when the credential file or assignment is unusable", () => {
    const missing = run({ STELL22_AC_ENV_FILE: path.join(os.tmpdir(), "ac-credential-missing.env").replace(/\\/g, "/") });
    expect(missing.status).not.toBe(0);
    expect(missing.out).toContain("RESULT=STOP_CREDENTIAL");
    expect(missing.out).toContain("MISSING_FILE");
    expect(missing.out).toContain("APP_UNCHANGED=YES");
    expect(missing.out).toContain("MIGRATION_ATTEMPTED=0");
    expect(missing.out).toContain("RETRY_MIGRATION=NO");
    expect(missing.out).toContain("DATABASE_RESTORE=NO");
    expect(missing.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(missing.out).not.toContain("migrate deploy");
    expect(missing.out).not.toContain("python: not found");
    expect(missing.out).not.toContain("docker stop");

    const absent = writeEnv("APP_DB_PASSWORD=valid-migrator-password-24\n");
    const absentResult = run({ STELL22_AC_ENV_FILE: absent.file });
    expect(absentResult.out).toContain("RESULT=STOP_CREDENTIAL");
    expect(absentResult.out).toContain("MISSING");

    const empty = writeEnv("MIGRATOR_DB_PASSWORD=\n");
    const emptyResult = run({ STELL22_AC_ENV_FILE: empty.file });
    expect(emptyResult.out).toContain("EMPTY");
    expect(emptyResult.out).toContain("RESULT=STOP_CREDENTIAL");

    const duplicate = writeEnv(`MIGRATOR_DB_PASSWORD=${PASSWORD}\nMIGRATOR_DB_PASSWORD=${PASSWORD}\n`);
    const duplicateResult = run({ STELL22_AC_ENV_FILE: duplicate.file });
    expect(duplicateResult.out).toContain("DUPLICATE");
    expect(duplicateResult.out).toContain("RESULT=STOP_CREDENTIAL");
    expectSecretFree(duplicateResult.out);

    const invalid = writeEnv("MIGRATOR_DB_PASSWORD=short+password\n");
    const invalidResult = run({ STELL22_AC_ENV_FILE: invalid.file });
    expect(invalidResult.out).toContain("FORMAT");
    expect(invalidResult.out).toContain("RESULT=STOP_CREDENTIAL");
    expect(invalidResult.out).not.toContain("short+password");
  });

  it("rejects a group-readable file and a file owned by someone else", () => {
    const loose = writeEnv(`MIGRATOR_DB_PASSWORD=${PASSWORD}\n`, 0o644);
    const looseResult = run({ STELL22_AC_ENV_FILE: loose.file });
    if (process.platform === "win32") {
      expect(looseResult.out).not.toContain(PASSWORD);
    } else {
      expect(looseResult.status).not.toBe(0);
      expect(looseResult.out).toContain("PERMISSION");
      expect(looseResult.out).toContain("RESULT=STOP_CREDENTIAL");
      expectSecretFree(looseResult.out);
    }
    if (process.platform !== "win32" && fs.existsSync("/etc/passwd")) {
      const owned = spawnSync("python3", ["scripts/release-credential.py", "/etc/passwd"], { encoding: "utf8" });
      expect(owned.status).not.toBe(0);
      expect(`${owned.stdout ?? ""}`).toBe("");
      expect(`${owned.stderr ?? ""}`).toMatch(/OWNER|PERMISSION/);
    }
  });

  it("uses python3 when python is absent and does not retry a failed credential read", () => {
    const env = writeEnv("MIGRATOR_DB_PASSWORD=short\n");
    const bin = path.join(env.root, "bin");
    fs.mkdirSync(bin);
    const real = spawnSync(
      "sh",
      ["-c", "if python3 -c 'import sys' >/dev/null 2>&1; then command -v python3; elif python -c 'import sys' >/dev/null 2>&1; then command -v python; else exit 1; fi"],
      { encoding: "utf8" },
    );
    expect(real.status).toBe(0);
    const interpreter = real.stdout.trim();
    fs.writeFileSync(
      path.join(bin, "python3"),
      `#!/bin/sh\necho PYTHON3_WRAPPER=1 >&2\nexec '${interpreter.replace(/'/g, `'\\''`)}' "$@"\n`,
    );
    fs.chmodSync(path.join(bin, "python3"), 0o755);
    const shellDir = process.platform === "win32"
      ? path.dirname(String(spawnSync("where", ["sh"], { encoding: "utf8" }).stdout).split(/\r?\n/).find((line) => line.trim()) ?? "")
      : "/usr/bin";
    const hostPath = [bin, shellDir, "/bin", path.dirname(process.execPath)].join(path.delimiter);
    const probe = spawnSync("sh", ["-c", "command -v python || echo missing; command -v python3"], {
      encoding: "utf8",
      env: {
        PATH: hostPath,
        SystemRoot: process.env.SystemRoot,
        HOME: process.env.HOME,
        COMSPEC: process.env.COMSPEC,
        PATHEXT: process.env.PATHEXT,
        NODE_ENV: process.env.NODE_ENV ?? "test",
      },
    });
    expect(probe.stdout).toContain("python3");
    if (process.platform === "win32") expect(`${probe.stdout ?? ""}`).toContain("missing");
    const failed = run({ PATH: hostPath, STELL22_AC_ENV_FILE: env.file });
    expect(failed.status, failed.out).not.toBe(0);
    expect(failed.out).toContain("PYTHON3_WRAPPER=1");
    expect(failed.out.match(/PYTHON3_WRAPPER=1/g)).toHaveLength(1);
    expect(failed.out).toContain("FORMAT");
    expect(failed.out).toContain("RESULT=STOP_CREDENTIAL");
    expect(failed.out).not.toContain("python: not found");
    expect(failed.out).not.toContain("migrate deploy");
    expect(failed.out).toContain("RETRY_MIGRATION=NO");
    expect(failed.out).toContain("DATABASE_RESTORE=NO");
    expect(failed.out).toContain("OLD_IMAGE_RESTART=NO");
  });

  it("reads the pinned credential script when checkout already matches the target and the worktree script is wrong", () => {
    const env = writeEnv(`MIGRATOR_DB_PASSWORD=${PASSWORD}\n`);
    const extract = path.join(env.root, "extract");
    const server = path.join(env.root, "server");
    fs.mkdirSync(extract);
    fs.mkdirSync(path.join(server, "scripts"), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(extract, "admin-corrections-release.sh"));
    fs.copyFileSync("scripts/release-credential.py", path.join(extract, "release-credential.py"));
    fs.copyFileSync("scripts/release-migrator-url.py", path.join(extract, "release-migrator-url.py"));
    fs.writeFileSync(
      path.join(server, "scripts", "release-credential.py"),
      "import sys\nsys.stderr.write('WRONG_TREE\\n')\nraise SystemExit(1)\n",
    );
    const repo = process.cwd().replace(/\\/g, "/");
    const dockerLog = path.join(env.root, "docker.log");
    const bin = path.join(env.root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> " + `'${dockerLog.replace(/\\/g, "/")}'` + "\nexit 99\n");
    fs.chmodSync(path.join(bin, "docker"), 0o755);
    const child = spawnSync("sh", [path.join(extract, "admin-corrections-release.sh").replace(/\\/g, "/")], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: baseEnv({
        PATH: `${bin.replace(/\\/g, "/")}${path.delimiter}${process.env.PATH ?? ""}`,
        STELL22_AC_APP_DIR: server.replace(/\\/g, "/"),
        STELL22_AC_ENV_FILE: env.file,
        STELL22_AC_HEAD: "ea7c58f0598df9ea21ffe676a69e3348154e6520",
        STELL22_ADMIN_CORRECTIONS_SHA: "ea7c58f0598df9ea21ffe676a69e3348154e6520",
        STELL22_AC_DECIDE: `${repo}/src/server/internal/admin-corrections-release/decide.mjs`,
        STELL22_AC_DIAGNOSTICS: `${repo}/scripts/release-diagnostics.sh`,
      }),
      windowsHide: true,
    });
    const out = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    expect(child.status ?? 1, out).toBe(0);
    expect(out).toContain("RESULT=CREDENTIAL_READY");
    expect(out).toContain("APP_STOPPED=0");
    expect(out).toContain("MIGRATION_ATTEMPTED=0");
    expect(out).toContain("OLD_IMAGE_RESTART=NO");
    expect(out).not.toContain("WRONG_TREE");
    expect(out).not.toContain("migrate deploy");
    expect(out).not.toContain("docker stop");
    expect(fs.existsSync(dockerLog)).toBe(false);
    expectSecretFree(out);
  });
});
