import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const checkoutScript = path.join(repoRoot, "scripts", "release-checkout.sh");
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function posixPath(file: string): string {
  if (process.platform !== "win32") return file;
  const converted = spawnSync("sh", ["-c", 'cygpath -u "$1"', "sh", file], { encoding: "utf8" });
  if (converted.status !== 0) throw new Error(converted.stderr);
  return converted.stdout.trim();
}

function git(repo: string, args: string[]): string {
  const result = spawnSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "stell22-test",
      GIT_AUTHOR_EMAIL: "stell22-test@example.com",
      GIT_COMMITTER_NAME: "stell22-test",
      GIT_COMMITTER_EMAIL: "stell22-test@example.com",
    },
  });
  if (result.status !== 0) {
    throw new Error(gitText(result));
  }
  return result.stdout;
}

function gitText(result: SpawnSyncReturns<string>): string {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function initRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "stell22-checkout-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "--local", "core.autocrlf", "false"]);
  git(repo, ["config", "--local", "user.email", "stell22-test@example.com"]);
  git(repo, ["config", "--local", "user.name", "stell22-test"]);
  return repo;
}

function writeRepoFile(repo: string, relative: string, body: Buffer | string): void {
  const full = path.join(repo, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function commit(repo: string, message: string): string {
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function blob(spec: string): Buffer {
  const result = spawnSync("git", ["show", spec], { cwd: repoRoot, encoding: "buffer" });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout;
}

function runCheckout(repo: string, arg: string, extra: Record<string, string> = {}): SpawnSyncReturns<string> {
  const command = extra.STELL22_WRAPPER
    ? 'export PATH="$STELL22_WRAPPER:$PATH"; exec "$1" "$2"'
    : 'exec "$1" "$2"';
  return spawnSync("sh", ["-c", command, "sh", checkoutScript, arg], {
    cwd: repo,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      ...extra,
      GIT_AUTHOR_NAME: "stell22-test",
      GIT_AUTHOR_EMAIL: "stell22-test@example.com",
      GIT_COMMITTER_NAME: "stell22-test",
      GIT_COMMITTER_EMAIL: "stell22-test@example.com",
    },
  });
}

function statusLines(repo: string): string[] {
  return git(repo, ["status", "--porcelain=v1"]).split("\n").filter((line) => line.length > 0);
}

function fileHash(repo: string, relative: string): string {
  return sha256(fs.readFileSync(path.join(repo, relative)));
}

function statField(repo: string, relative: string, format: string): string {
  const result = spawnSync("stat", ["-c", format, path.join(repo, relative)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function assertProtected(repo: string, relative: string, bytes: Buffer, mode: string, uid: string, gid: string): void {
  const full = path.join(repo, relative);
  expect(sha256(fs.readFileSync(full))).toBe(sha256(bytes));
  expect(statField(repo, relative, "%a")).toBe(mode);
  expect(statField(repo, relative, "%u")).toBe(uid);
  expect(statField(repo, relative, "%g")).toBe(gid);
  const text = fs.readFileSync(full, "utf8");
  expect(text).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
}

function recoveryPath(repo: string): string {
  const gitDir = spawnSync("sh", ["-c", "git rev-parse --absolute-git-dir"], {
    cwd: repo,
    encoding: "utf8",
  }).stdout.trim();
  const native = process.platform === "win32"
    ? spawnSync("sh", ["-c", 'cygpath -w "$1"', "sh", gitDir], { encoding: "utf8" }).stdout.trim()
    : gitDir;
  return path.join(native, "stell22-release-checkout");
}

function recoveryExists(repo: string): boolean {
  return fs.existsSync(recoveryPath(repo));
}

function removeRepo(repo: string): void {
  fs.rmSync(repo, { recursive: true, force: true });
}

function wrapperEnv(body: string, values: Record<string, string>): { dir: string; env: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stell22-git-wrapper-"));
  const file = path.join(dir, "git");
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return {
    dir,
    env: {
      STELL22_WRAPPER: posixPath(dir),
      STELL22_REAL_GIT: realGit,
      ...values,
    },
  };
}

const wrapperBody = `#!/bin/sh
real="$STELL22_REAL_GIT"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--detach" ] && [ -n "\${STELL22_FAIL_SHA:-}" ] && [ "$arg" = "$STELL22_FAIL_SHA" ]; then
    "$real" -c advice.detachedHead=false checkout --detach "$arg" >/dev/null
    exit 1
  fi
  prev=$arg
done
exec "$real" "$@"
`;

function twoCommits(repo: string, originalBackup: Buffer, originalRestore: Buffer, releaseBackup: Buffer, releaseRestore: Buffer): { original: string; release: string } {
  writeRepoFile(repo, "scripts/backup-db.sh", originalBackup);
  writeRepoFile(repo, "scripts/restore-db.sh", originalRestore);
  writeRepoFile(repo, "README", "base\n");
  const original = commit(repo, "original");
  writeRepoFile(repo, "scripts/backup-db.sh", releaseBackup);
  writeRepoFile(repo, "scripts/restore-db.sh", releaseRestore);
  writeRepoFile(repo, "README", "release\n");
  const release = commit(repo, "release");
  git(repo, ["checkout", "--detach", original]);
  return { original, release };
}

describe("protected release checkout", () => {
  const backupAtFix = blob("5d9270b:scripts/backup-db.sh");
  const releaseBackup = blob("HEAD:scripts/backup-db.sh");
  const releaseRestore = blob("HEAD:scripts/restore-db.sh");
  const safetyExit = Buffer.from("#!/bin/sh\necho \"restore refused\" >&2\nexit 1\n");

  it("preserves backup-db.sh bytes from 5d9270b", () => {
    const repo = initRepo();
    try {
      const { release } = twoCommits(repo, Buffer.from("original-backup\n"), releaseRestore, releaseBackup, releaseRestore);
      writeRepoFile(repo, "scripts/backup-db.sh", backupAtFix);
      fs.chmodSync(path.join(repo, "scripts/backup-db.sh"), 0o700);
      const mode = statField(repo, "scripts/backup-db.sh", "%a");
      const uid = statField(repo, "scripts/backup-db.sh", "%u");
      const gid = statField(repo, "scripts/backup-db.sh", "%g");
      const result = runCheckout(repo, release);
      expect(gitText(result)).toContain("RESULT=CHECKOUT_PRESERVED");
      expect(gitText(result)).toContain(`HEAD=${release}`);
      expect(result.status).toBe(0);
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(release);
      assertProtected(repo, "scripts/backup-db.sh", backupAtFix, mode, uid, gid);
      assertProtected(repo, "scripts/restore-db.sh", releaseRestore, statField(repo, "scripts/restore-db.sh", "%a"), statField(repo, "scripts/restore-db.sh", "%u"), statField(repo, "scripts/restore-db.sh", "%g"));
      expect(statusLines(repo)).toEqual([" M scripts/backup-db.sh"]);
      expect(recoveryExists(repo)).toBe(false);
    } finally {
      removeRepo(repo);
    }
  }, 20_000);

  it("preserves a restore script that exits", () => {
    const repo = initRepo();
    try {
      const { release } = twoCommits(repo, releaseBackup, Buffer.from("original-restore\n"), releaseBackup, releaseRestore);
      writeRepoFile(repo, "scripts/restore-db.sh", safetyExit);
      const mode = statField(repo, "scripts/restore-db.sh", "%a");
      const uid = statField(repo, "scripts/restore-db.sh", "%u");
      const gid = statField(repo, "scripts/restore-db.sh", "%g");
      const result = runCheckout(repo, release);
      expect(result.status).toBe(0);
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(release);
      assertProtected(repo, "scripts/restore-db.sh", safetyExit, mode, uid, gid);
      expect(fileHash(repo, "scripts/backup-db.sh")).toBe(sha256(releaseBackup));
      expect(statusLines(repo)).toEqual([" M scripts/restore-db.sh"]);
    } finally {
      removeRepo(repo);
    }
  }, 20_000);

  it("preserves backup-db.sh with an extra line", () => {
    const repo = initRepo();
    const extra = Buffer.concat([backupAtFix, Buffer.from("# stell22-protected-extra\n")]);
    try {
      const { release } = twoCommits(repo, Buffer.from("original-backup\n"), releaseRestore, releaseBackup, releaseRestore);
      writeRepoFile(repo, "scripts/backup-db.sh", extra);
      const mode = statField(repo, "scripts/backup-db.sh", "%a");
      const uid = statField(repo, "scripts/backup-db.sh", "%u");
      const gid = statField(repo, "scripts/backup-db.sh", "%g");
      const result = runCheckout(repo, release);
      expect(result.status).toBe(0);
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(release);
      assertProtected(repo, "scripts/backup-db.sh", extra, mode, uid, gid);
      expect(statusLines(repo)).toEqual([" M scripts/backup-db.sh"]);
    } finally {
      removeRepo(repo);
    }
  }, 20_000);

  it("leaves both scripts clean when they already match the release", () => {
    const repo = initRepo();
    try {
      writeRepoFile(repo, "scripts/backup-db.sh", releaseBackup);
      writeRepoFile(repo, "scripts/restore-db.sh", releaseRestore);
      writeRepoFile(repo, "README", "base\n");
      const original = commit(repo, "original");
      writeRepoFile(repo, "README", "release\n");
      const release = commit(repo, "release");
      git(repo, ["checkout", "--detach", original]);
      const result = runCheckout(repo, release);
      expect(result.status).toBe(0);
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(release);
      expect(fileHash(repo, "scripts/backup-db.sh")).toBe(sha256(releaseBackup));
      expect(fileHash(repo, "scripts/restore-db.sh")).toBe(sha256(releaseRestore));
      expect(statusLines(repo)).toEqual([]);
      expect(gitText(result)).not.toContain("<<<<<<<");
    } finally {
      removeRepo(repo);
    }
  }, 20_000);

  it("rolls back when checkout fails", () => {
    const repo = initRepo();
    const server = Buffer.from("case5-server-bytes\n");
    try {
      const { original, release } = twoCommits(repo, Buffer.from("original-backup\n"), releaseRestore, releaseBackup, releaseRestore);
      writeRepoFile(repo, "scripts/backup-db.sh", server);
      const mode = statField(repo, "scripts/backup-db.sh", "%a");
      const uid = statField(repo, "scripts/backup-db.sh", "%u");
      const gid = statField(repo, "scripts/backup-db.sh", "%g");
      const wrapped = wrapperEnv(wrapperBody, { STELL22_FAIL_SHA: release });
      const result = runCheckout(repo, release, wrapped.env);
      fs.rmSync(wrapped.dir, { recursive: true, force: true });
      expect(result.status).not.toBe(0);
      expect(gitText(result)).toContain("RESULT=STOP_CHECKOUT");
      expect(gitText(result)).not.toContain("RESULT=CHECKOUT_PRESERVED");
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(original);
      assertProtected(repo, "scripts/backup-db.sh", server, mode, uid, gid);
      expect(recoveryExists(repo)).toBe(false);
    } finally {
      removeRepo(repo);
    }
  }, 20_000);

  it("preserves an existing untracked mail.log", () => {
    const repo = initRepo();
    const mail = Buffer.from("mail-fixture\n");
    try {
      writeRepoFile(repo, "scripts/backup-db.sh", releaseBackup);
      writeRepoFile(repo, "scripts/restore-db.sh", releaseRestore);
      writeRepoFile(repo, "README", "base\n");
      const original = commit(repo, "original");
      writeRepoFile(repo, "README", "release\n");
      const release = commit(repo, "release");
      git(repo, ["checkout", "--detach", original]);
      writeRepoFile(repo, "mail.log", mail);
      fs.chmodSync(path.join(repo, "mail.log"), 0o600);
      const mode = statField(repo, "mail.log", "%a");
      const result = runCheckout(repo, release);
      expect(result.status).toBe(0);
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(release);
      expect(fileHash(repo, "mail.log")).toBe(sha256(mail));
      expect(statField(repo, "mail.log", "%a")).toBe(mode);
      expect(statusLines(repo)).toEqual(["?? mail.log"]);
      expect(gitText(result)).not.toContain("mail-fixture");
    } finally {
      removeRepo(repo);
    }
  }, 20_000);

  it("keeps the same bytes across two checkouts", () => {
    const repo = initRepo();
    const preserved = Buffer.from("protected-bytes\n");
    try {
      writeRepoFile(repo, "scripts/backup-db.sh", preserved);
      writeRepoFile(repo, "scripts/restore-db.sh", preserved);
      writeRepoFile(repo, "README", "base\n");
      const original = commit(repo, "original");
      writeRepoFile(repo, "scripts/backup-db.sh", Buffer.from("release-one\n"));
      writeRepoFile(repo, "scripts/restore-db.sh", Buffer.from("release-one\n"));
      const first = commit(repo, "first");
      writeRepoFile(repo, "scripts/backup-db.sh", Buffer.from("release-two\n"));
      writeRepoFile(repo, "scripts/restore-db.sh", Buffer.from("release-two\n"));
      const second = commit(repo, "second");
      git(repo, ["checkout", "--detach", original]);
      const mode = statField(repo, "scripts/backup-db.sh", "%a");
      const uid = statField(repo, "scripts/backup-db.sh", "%u");
      const gid = statField(repo, "scripts/backup-db.sh", "%g");
      const firstRun = runCheckout(repo, first);
      const secondRun = runCheckout(repo, second);
      expect(firstRun.status).toBe(0);
      expect(secondRun.status).toBe(0);
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(second);
      assertProtected(repo, "scripts/backup-db.sh", preserved, mode, uid, gid);
      assertProtected(repo, "scripts/restore-db.sh", preserved, mode, uid, gid);
      expect(gitText(secondRun)).not.toContain("<<<<<<<");
      expect(recoveryExists(repo)).toBe(false);
    } finally {
      removeRepo(repo);
    }
  }, 20_000);

  it("preserves a clean script that differs from the release commit", () => {
    const repo = initRepo();
    const originalBytes = Buffer.from("case8-original\n");
    try {
      const { release } = twoCommits(repo, originalBytes, releaseRestore, Buffer.from("case8-release\n"), releaseRestore);
      expect(statusLines(repo)).toEqual([]);
      const mode = statField(repo, "scripts/backup-db.sh", "%a");
      const uid = statField(repo, "scripts/backup-db.sh", "%u");
      const gid = statField(repo, "scripts/backup-db.sh", "%g");
      const result = runCheckout(repo, release);
      expect(result.status).toBe(0);
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(release);
      assertProtected(repo, "scripts/backup-db.sh", originalBytes, mode, uid, gid);
      expect(statusLines(repo)).toEqual([" M scripts/backup-db.sh"]);
    } finally {
      removeRepo(repo);
    }
  }, 20_000);

  it("recovers an interrupted checkout from the private record", () => {
    const repo = initRepo();
    const server = Buffer.from("interrupted-server-bytes\n");
    try {
      const { original, release } = twoCommits(repo, Buffer.from("original-backup\n"), releaseRestore, releaseBackup, releaseRestore);
      writeRepoFile(repo, "scripts/backup-db.sh", server);
      const backupMode = statField(repo, "scripts/backup-db.sh", "%a");
      const backupUid = statField(repo, "scripts/backup-db.sh", "%u");
      const backupGid = statField(repo, "scripts/backup-db.sh", "%g");
      const restoreMode = statField(repo, "scripts/restore-db.sh", "%a");
      const restoreUid = statField(repo, "scripts/restore-db.sh", "%u");
      const restoreGid = statField(repo, "scripts/restore-db.sh", "%g");
      const restoreBytes = fs.readFileSync(path.join(repo, "scripts/restore-db.sh"));
      git(repo, ["checkout", "--", "scripts/backup-db.sh"]);
      git(repo, ["checkout", "--detach", release]);
      const record = recoveryPath(repo);
      fs.mkdirSync(record, { mode: 0o700 });
      const plant = (name: string, bytes: Buffer, mode: string, uid: string, gid: string) => {
        fs.writeFileSync(path.join(record, `${name}.body`), bytes);
        fs.writeFileSync(path.join(record, `${name}.sha256`), `${sha256(bytes)}\n`);
        fs.writeFileSync(path.join(record, `${name}.mode`), `${mode}\n`);
        fs.writeFileSync(path.join(record, `${name}.uid`), `${uid}\n`);
        fs.writeFileSync(path.join(record, `${name}.gid`), `${gid}\n`);
      };
      plant("backup", server, backupMode, backupUid, backupGid);
      plant("restore", restoreBytes, restoreMode, restoreUid, restoreGid);
      fs.writeFileSync(path.join(record, "original-head"), `${original}\n`);
      fs.writeFileSync(path.join(record, "mail.exists"), "0\n");
      fs.writeFileSync(path.join(record, "state"), "switching\n");
      const recovered = runCheckout(repo, "--recover");
      expect(gitText(recovered)).toContain("RESULT=STOP_CHECKOUT");
      expect(recovered.status).not.toBe(0);
      expect(gitText(recovered)).not.toContain("RESULT=CHECKOUT_PRESERVED");
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(original);
      assertProtected(repo, "scripts/backup-db.sh", server, backupMode, backupUid, backupGid);
      expect(recoveryExists(repo)).toBe(false);
    } finally {
      removeRepo(repo);
    }
  }, 20_000);

  it.each(["HUP", "INT", "TERM"] as const)("stops on %s and keeps the original bytes", (signal) => {
    const repo = initRepo();
    const server = Buffer.from(`signal-${signal}\n`);
    try {
      const { original, release } = twoCommits(repo, Buffer.from("original-backup\n"), releaseRestore, releaseBackup, releaseRestore);
      writeRepoFile(repo, "scripts/backup-db.sh", server);
      const mode = statField(repo, "scripts/backup-db.sh", "%a");
      const uid = statField(repo, "scripts/backup-db.sh", "%u");
      const gid = statField(repo, "scripts/backup-db.sh", "%g");
      const result = runCheckout(repo, release, { STELL22_CHECKOUT_SIGNAL_SELF: signal });
      expect(result.status).not.toBe(0);
      expect(gitText(result)).toContain("RESULT=STOP_CHECKOUT");
      expect(gitText(result)).not.toContain("RESULT=CHECKOUT_PRESERVED");
      expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(original);
      assertProtected(repo, "scripts/backup-db.sh", server, mode, uid, gid);
      expect(recoveryExists(repo)).toBe(false);
    } finally {
      removeRepo(repo);
    }
  }, 20_000);

  it("redacts a failure log and does not print the secret", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stell22-redact-"));
    const file = path.join(dir, "image-build.log");
    fs.writeFileSync(file, "DATABASE_URL=postgresql://stell22_app:stell22-test-secret@db/stell22\nAPP_DB_PASSWORD=stell22-test-secret\nbuild failed\n");
    try {
      const result = spawnSync("sh", ["-c", '. ./scripts/release-diagnostics.sh; release_redact_file "$1"', "sh", file], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      const text = fs.readFileSync(file, "utf8");
      expect(result.status).toBe(0);
      expect(text).not.toContain("stell22-test-secret");
      expect(text).toContain("REDACTED");
      expect(text).toContain("build failed");
      expect(`${result.stdout}${result.stderr}`).not.toContain("stell22-test-secret");
      if (process.platform !== "win32") {
        expect(statField(dir, "image-build.log", "%a")).toBe("600");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parses the release shell scripts", () => {
    expect(spawnSync("sh", ["-n", "scripts/release-checkout.sh"], { cwd: repoRoot }).status).toBe(0);
    expect(spawnSync("sh", ["-n", "scripts/release-role-split.sh"], { cwd: repoRoot }).status).toBe(0);
    expect(spawnSync("sh", ["-n", "scripts/release-diagnostics.sh"], { cwd: repoRoot }).status).toBe(0);
  });
});
