import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * Offline regression tests for scripts/backup-db.sh.
 * Docker is a PATH mock. Fixtures imitate a plain SQL dump; they are not
 * evidence that an archive can be restored.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const STAMP = "2026-01-02_03-04-05";
const ARCHIVE_NAME = `stell22_${STAMP}.sql.gz`;
const CHECKSUM_NAME = `${ARCHIVE_NAME}.sha256`;
const LEGACY_NAME = "stell22_2000-01-01_00-00-00.sql.gz";
const LEGACY_BYTES = "legacy-bytes";
const FIXTURE_SENTINEL = "STELL22_FIXTURE_ROW_9f3c";
const COMPLETE_DUMP = [
  "-- PostgreSQL database dump",
  "SET client_encoding = 'UTF8';",
  `SELECT '${FIXTURE_SENTINEL}';`,
  "-- PostgreSQL database dump complete",
  "",
].join("\n");

const suiteTemps: string[] = [];
const testTemps: string[] = [];

let baseMockPosix = "";
let realDate = "";
let realGzip = "";
let realSha256 = "";
let realLn = "";

type ShellName = "sh" | "dash";

type RunResult = {
  status: number;
  stdout: string;
  stderr: string;
  combined: string;
  backupDir: string;
  dockerLog: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function runShell(command: string, args: readonly string[] = []): SpawnSyncReturns<string> {
  return spawnSync("sh", ["-c", command, "sh", ...args], { encoding: "utf8" });
}

function commandPath(name: string): string {
  const found = runShell('command -v "$1"', [name]);
  if (found.status !== 0 || !found.stdout.trim()) {
    throw new Error(`required command not found: ${name}`);
  }
  return found.stdout.trim();
}

function rememberTemp(bucket: string[], posixPath: string): string {
  if (!posixPath.startsWith("/tmp/stell22-backup")) {
    throw new Error(`refusing to track unexpected temp path: ${posixPath}`);
  }
  bucket.push(posixPath);
  return posixPath;
}

function makePosixTemp(bucket: string[]): string {
  const created = runShell("mktemp -d /tmp/stell22-backup.XXXXXX");
  if (created.status !== 0) {
    throw new Error(created.stderr || "mktemp failed");
  }
  return rememberTemp(bucket, created.stdout.trim());
}

function makeNodeTemp(bucket: string[]): { win: string; posix: string } {
  const posix = makePosixTemp(bucket);
  if (process.platform !== "win32") {
    return { win: posix, posix };
  }
  const win = spawnSync("cygpath", ["-w", posix], { encoding: "utf8" });
  if (win.status !== 0 || !win.stdout.trim()) {
    throw new Error(win.stderr || "cygpath -w failed");
  }
  return { win: win.stdout.trim(), posix };
}

function removeTemps(bucket: string[]): void {
  while (bucket.length > 0) {
    const dir = bucket.pop();
    if (!dir?.startsWith("/tmp/stell22-backup")) {
      continue;
    }
    runShell('rm -rf "$1"', [dir]);
  }
}

function writeExec(
  dir: { win: string; posix: string },
  name: string,
  lines: readonly string[],
): void {
  writeFileSync(path.join(dir.win, name), ["#!/bin/sh", ...lines, ""].join("\n"), "utf8");
  const chmod = runShell('chmod 755 "$1"', [`${dir.posix}/${name}`]);
  if (chmod.status !== 0) {
    throw new Error(chmod.stderr || `chmod failed for ${name}`);
  }
}

function posixExists(filePath: string): boolean {
  return runShell('test -e "$1"', [filePath]).status === 0;
}

function readPosix(filePath: string): string {
  const read = runShell('cat "$1"', [filePath]);
  if (read.status !== 0) {
    throw new Error(read.stderr || `cannot read ${filePath}`);
  }
  return read.stdout;
}

function listNames(dir: string, pattern: string): string[] {
  const listed = runShell('find "$1" -maxdepth 1 -type f -name "$2" -printf "%f\\n"', [
    dir,
    pattern,
  ]);
  if (listed.status !== 0) {
    throw new Error(listed.stderr || "find failed");
  }
  return listed.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .sort();
}

function placeLegacy(backupDir: string): void {
  const legacyPath = `${backupDir}/${LEGACY_NAME}`;
  const written = runShell('umask 077; printf %s "$2" > "$1"', [legacyPath, LEGACY_BYTES]);
  if (written.status !== 0) {
    throw new Error(written.stderr || "failed to write legacy backup");
  }
  const touched = runShell('touch -d "2000-01-01 00:00:00" "$1"', [legacyPath]);
  if (touched.status !== 0) {
    throw new Error(touched.stderr || "failed to age legacy backup");
  }
}

function expectLegacyUntouched(backupDir: string): void {
  expect(readPosix(`${backupDir}/${LEGACY_NAME}`)).toBe(LEGACY_BYTES);
}

function expectNoPublication(backupDir: string): void {
  expect(listNames(backupDir, "stell22_*.sql.gz")).toEqual([LEGACY_NAME]);
  expect(posixExists(`${backupDir}/${ARCHIVE_NAME}`)).toBe(false);
  expect(posixExists(`${backupDir}/${CHECKSUM_NAME}`)).toBe(false);
  expect(listNames(backupDir, "*.sha256")).toEqual([]);
}

function expectNoTemp(backupDir: string): void {
  const left = runShell('find "$1" \\( -name ".stell22-backup.*" -o -name "dump.sql" \\) -print', [
    backupDir,
  ]);
  if (left.status !== 0) {
    throw new Error(left.stderr || "find temp leftovers failed");
  }
  expect(left.stdout.trim()).toBe("");
}

// Windows Git bash reports 644 to a later process even after chmod 600.
// Linux keeps the mode, and CI asserts 600 there.
function posixModePersists(): boolean {
  const dir = makePosixTemp(testTemps);
  const probe = `${dir}/mode-probe`;
  const created = runShell('umask 077; echo x > "$1"; chmod 600 "$1"', [probe]);
  if (created.status !== 0) {
    return false;
  }
  return runShell('stat -c %a "$1"', [probe]).stdout.trim() === "600";
}

function expectNoDumpLeak(result: RunResult): void {
  expect(result.combined).not.toContain(FIXTURE_SENTINEL);
  expect(result.combined).not.toContain("BACKUP SUCCESS");
  expect(result.combined).not.toContain("RETENTION SUSPENDED");
}

function runBackup(options: {
  backupDir: string;
  shell?: ShellName;
  dumpMode?: string;
  extraPath?: string;
  lnLog?: string;
}): RunResult {
  const shell = options.shell ?? "sh";
  const dockerLog = `${options.backupDir}/docker-calls.log`;
  const pathPrefix = [options.extraPath, baseMockPosix].filter((entry) => entry).join(":");
  const result = spawnSync(
    shell,
    ["-c", 'export PATH="$1:$PATH"; exec "$0" scripts/backup-db.sh', shell, pathPrefix],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
        Path: process.env.Path,
        HOME: process.env.HOME,
        SystemRoot: process.env.SystemRoot,
        SYSTEMROOT: process.env.SYSTEMROOT,
        COMSPEC: process.env.COMSPEC,
        PATHEXT: process.env.PATHEXT,
        TMP: process.env.TMP,
        TEMP: process.env.TEMP,
        BACKUP_DIR: options.backupDir,
        DB_USER: "stell22",
        DB_NAME: "stell22",
        STELL22_BACKUP_TEST_DUMP: options.dumpMode ?? "ok",
        STELL22_BACKUP_DOCKER_LOG: dockerLog,
        ...(options.lnLog ? { STELL22_BACKUP_LN_LOG: options.lnLog } : {}),
        DOCKER_HOST: "unix:///tmp/stell22-backup-no-such.sock",
      },
    },
  );
  if (result.error) {
    throw result.error;
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    status: result.status ?? 1,
    stdout,
    stderr,
    combined: `${stdout}\n${stderr}`,
    backupDir: options.backupDir,
    dockerLog: posixExists(dockerLog) ? readPosix(dockerLog).trim() : "",
  };
}

function runSignalPublication(signal: "TERM" | "KILL"): {
  backupDir: string;
  archive: string;
  checksum: string;
  combined: string;
} {
  const backupDir = makePosixTemp(testTemps);
  placeLegacy(backupDir);
  const result = runBackup({
    backupDir,
    dumpMode: "ok",
    extraPath: writeExtraMocks({ ln: signalAfterChecksumLink(signal) }),
  });
  return {
    backupDir,
    archive: `${backupDir}/${ARCHIVE_NAME}`,
    checksum: `${backupDir}/${CHECKSUM_NAME}`,
    combined: result.combined,
  };
}

function rejectBackup(options: {
  dumpMode?: string;
  extra?: Record<string, readonly string[]>;
}): RunResult {
  const backupDir = makePosixTemp(testTemps);
  placeLegacy(backupDir);
  const extraPath = options.extra ? writeExtraMocks(options.extra) : undefined;
  const result = runBackup({
    backupDir,
    dumpMode: options.dumpMode ?? "ok",
    extraPath,
  });
  expect(result.status).not.toBe(0);
  expectNoDumpLeak(result);
  expectLegacyUntouched(backupDir);
  expectNoPublication(backupDir);
  expectNoTemp(backupDir);
  return result;
}

function writeExtraMocks(commands: Record<string, readonly string[]>): string {
  const dir = makeNodeTemp(testTemps);
  for (const [name, lines] of Object.entries(commands)) {
    writeExec(dir, name, lines);
  }
  return dir.posix;
}

function gzipIntegrityMock(): readonly string[] {
  return [
    'for arg in "$@"; do',
    '  if [ "$arg" = "-t" ]; then',
    '    echo "gzip integrity forced failure" >&2',
    "    exit 1",
    "  fi",
    "done",
    `exec ${shellQuote(realGzip)} "$@"`,
  ];
}

function checksumCreateMock(): readonly string[] {
  return ['echo "sha256sum forced failure" >&2', "exit 1"];
}

function checksumVerifyMock(): readonly string[] {
  return [
    'if [ "${1-}" = "-c" ]; then',
    '  echo "sha256sum -c forced failure" >&2',
    "  exit 1",
    "fi",
    `exec ${shellQuote(realSha256)} "$@"`,
  ];
}

function publishMock(): readonly string[] {
  return ['echo "publication forced failure" >&2', "exit 1"];
}

function diskFullMock(): readonly string[] {
  return [
    "printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
    "printf '%s\\n' 'mock 1024 1024 0 100% /tmp'",
    "exit 0",
  ];
}

function deniedWriteMock(): readonly string[] {
  return ['echo "mktemp: permission denied" >&2', "exit 1"];
}

function orderedLn(logPath: string): readonly string[] {
  return [
    `printf '%s\\n' "$2" >> ${shellQuote(logPath)}`,
    `exec ${shellQuote(realLn)} "$@"`,
  ];
}

function failArchiveLn(): readonly string[] {
  return [
    'case "$2" in',
    "  *.sha256)",
    `    printf '%s\\n' "$2" >> "\${STELL22_BACKUP_LN_LOG:?}"`,
    `    exec ${shellQuote(realLn)} "$@"`,
    "    ;;",
    "esac",
    'echo "archive publication forced failure" >&2',
    "exit 1",
  ];
}

function signalAfterChecksumLink(signal: "TERM" | "KILL"): readonly string[] {
  return [
    'case "$2" in',
    "  *.sha256)",
    `    ${shellQuote(realLn)} "$@" || exit 1`,
    '    cmdline=$(tr \'\\0\' \' \' < "/proc/$PPID/cmdline" 2>/dev/null || true)',
    '    case "$cmdline" in',
    "      *backup-db.sh*) ;;",
    '      *) echo "refusing to signal parent" >&2; exit 97 ;;',
    "    esac",
    `    kill -s ${signal} "$PPID"`,
    "    sleep 2",
    "    exit 0",
    "    ;;",
    "esac",
    `exec ${shellQuote(realLn)} "$@"`,
  ];
}

function findDeleteGuard(): readonly string[] {
  return [
    'printf "%s\\n" "$*" >> "${STELL22_BACKUP_FIND_LOG:?}"',
    'case " $* " in',
    '  *" -delete "*|*" -delete") exit 99 ;;',
    "esac",
    "exit 0",
  ];
}

describe("backup-db.sh fail-closed producer", { timeout: 30_000 }, () => {
  beforeAll(() => {
    realDate = commandPath("date");
    realGzip = commandPath("gzip");
    realSha256 = commandPath("sha256sum");
    realLn = commandPath("ln");
    const bin = makeNodeTemp(suiteTemps);
    writeExec(bin, "date", [
      'if [ "${1-}" = "+%Y-%m-%d_%H-%M-%S" ]; then',
      "  printf '%s\\n' '2026-01-02_03-04-05'",
      "  exit 0",
      "fi",
      `exec ${shellQuote(realDate)} "$@"`,
    ]);
    writeExec(bin, "docker", [
      "set -eu",
      "log=${STELL22_BACKUP_DOCKER_LOG:?}",
      'printf "%s\\n" "$*" >> "$log"',
      'case " $* " in',
      '  *" pg_dump "*) ;;',
      "  *)",
      '    echo "refusing docker call: $*" >&2',
      "    exit 98",
      "    ;;",
      "esac",
      "mode=${STELL22_BACKUP_TEST_DUMP:-ok}",
      'case "$mode" in',
      "  ok)",
      "    cat <<'EOF'",
      ...COMPLETE_DUMP.split("\n").slice(0, -1),
      "EOF",
      "    ;;",
      "  fail-empty)",
      "    exit 1",
      "    ;;",
      "  fail-partial)",
      "    cat <<'EOF'",
      ...COMPLETE_DUMP.split("\n").slice(0, -1),
      "EOF",
      "    exit 1",
      "    ;;",
      "  incomplete)",
      "    printf '%s\\n' '-- PostgreSQL database dump'",
      `    printf '%s\\n' "SELECT '${FIXTURE_SENTINEL}';"`,
      "    ;;",
      "  *)",
      '    echo "unknown dump mode: $mode" >&2',
      "    exit 97",
      "    ;;",
      "esac",
    ]);
    baseMockPosix = bin.posix;
  });

  afterEach(() => {
    removeTemps(testTemps);
  });

  afterAll(() => {
    removeTemps(suiteTemps);
  });

  it("publishes a valid archive and checksum after a successful pg_dump", () => {
    const backupDir = makePosixTemp(testTemps);
    placeLegacy(backupDir);
    const result = runBackup({ backupDir, dumpMode: "ok" });

    expect(result.status).toBe(0);
    expect(result.combined.match(/BACKUP SUCCESS/g)).toEqual(["BACKUP SUCCESS"]);
    expect(result.combined).toContain("RETENTION SUSPENDED");
    expect(result.combined).toContain("disk usage will grow");
    expect(result.combined).toContain("NOT RESTORE-VERIFIED");
    expect(result.combined).toContain("RETENTION_DAYS=14");
    expect(result.combined).not.toContain(FIXTURE_SENTINEL);
    expectLegacyUntouched(backupDir);

    const archive = `${backupDir}/${ARCHIVE_NAME}`;
    const checksum = `${backupDir}/${CHECKSUM_NAME}`;
    expect(posixExists(archive)).toBe(true);
    expect(posixExists(checksum)).toBe(true);

    const plain = runShell('gzip -dc "$1"', [archive]);
    expect(plain.status).toBe(0);
    expect(plain.stdout).toBe(COMPLETE_DUMP);
    const integrity = runShell('gzip -t "$1"', [archive]);
    expect(integrity.status).toBe(0);

    const recorded = readPosix(checksum).trim().split(/\s+/)[0];
    const independent = runShell('sha256sum "$1"', [archive]).stdout.trim().split(/\s+/)[0];
    expect(recorded).toMatch(/^[0-9a-f]{64}$/);
    expect(recorded).toBe(independent);
    const checked = runShell('cd "$1" && sha256sum -c "$2"', [backupDir, CHECKSUM_NAME]);
    expect(checked.status).toBe(0);

    if (posixModePersists()) {
      expect(runShell('stat -c %a "$1"', [archive]).stdout.trim()).toBe("600");
      expect(runShell('stat -c %a "$1"', [checksum]).stdout.trim()).toBe("600");
    }
    expectNoTemp(backupDir);
    expect(result.dockerLog).toBe(
      "compose -f docker-compose.prod.yml exec -T db pg_dump -U stell22 stell22",
    );
  });

  it("rejects pg_dump that exits nonzero without output", () => {
    const result = rejectBackup({ dumpMode: "fail-empty" });
    expect(result.dockerLog).toContain("pg_dump");
  });

  it("rejects pg_dump that exits nonzero after writing a complete-looking dump", () => {
    const result = rejectBackup({ dumpMode: "fail-partial" });
    expect(result.dockerLog).toContain("pg_dump");
  });

  it("rejects a zero exit when the plain SQL dump is incomplete", () => {
    rejectBackup({ dumpMode: "incomplete" });
  });

  it("does not publish when gzip fails", () => {
    rejectBackup({
      extra: { gzip: ['echo "gzip forced failure" >&2', "exit 1"] },
    });
  });

  it("does not publish when the gzip integrity check fails", () => {
    rejectBackup({ extra: { gzip: gzipIntegrityMock() } });
  });

  it("does not publish when the checksum cannot be created", () => {
    rejectBackup({ extra: { sha256sum: checksumCreateMock() } });
  });

  it("does not publish when checksum verification fails", () => {
    rejectBackup({ extra: { sha256sum: checksumVerifyMock() } });
  });

  it("does not publish when archive publication fails", () => {
    rejectBackup({ extra: { ln: publishMock() } });
  });

  it("does not overwrite an existing archive name", () => {
    const backupDir = makePosixTemp(testTemps);
    placeLegacy(backupDir);
    const existing = `${backupDir}/${ARCHIVE_NAME}`;
    const written = runShell('printf %s "$2" > "$1"', [existing, "existing-archive"]);
    expect(written.status).toBe(0);

    const result = runBackup({ backupDir, dumpMode: "ok" });

    expect(result.status).not.toBe(0);
    expectNoDumpLeak(result);
    expect(readPosix(existing)).toBe("existing-archive");
    expectLegacyUntouched(backupDir);
    expect(posixExists(`${backupDir}/${CHECKSUM_NAME}`)).toBe(false);
    expectNoTemp(backupDir);
  });

  it("stops on disk-full and on denied temp creation without touching existing archives", () => {
    const disk = rejectBackup({ extra: { df: diskFullMock() } });
    expect(disk.dockerLog).toBe("");

    const denied = rejectBackup({ extra: { mktemp: deniedWriteMock() } });
    expect(denied.dockerLog).toBe("");
  });

  it("keeps the previous backup after every failed attempt", () => {
    const modes = ["fail-empty", "fail-partial", "incomplete"] as const;
    for (const dumpMode of modes) {
      const result = rejectBackup({ dumpMode });
      expect(result.status).not.toBe(0);
    }
    rejectBackup({ extra: { gzip: ['echo "gzip forced failure" >&2', "exit 1"] } });
    rejectBackup({ extra: { gzip: gzipIntegrityMock() } });
    rejectBackup({ extra: { sha256sum: checksumCreateMock() } });
    rejectBackup({ extra: { sha256sum: checksumVerifyMock() } });
    rejectBackup({ extra: { ln: publishMock() } });
    rejectBackup({ extra: { df: diskFullMock() } });
    rejectBackup({ extra: { mktemp: deniedWriteMock() } });
  }, 60_000);

  it("does not run retention after a failed backup", () => {
    const findLog = `${makePosixTemp(testTemps)}/find.log`;
    const backupDir = makePosixTemp(testTemps);
    placeLegacy(backupDir);
    const extraPath = writeExtraMocks({ find: findDeleteGuard() });
    const result = spawnSync(
      "sh",
      [
        "-c",
        'export PATH="$1:$PATH"; export STELL22_BACKUP_FIND_LOG="$2"; exec sh scripts/backup-db.sh',
        "sh",
        extraPath + ":" + baseMockPosix,
        findLog,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
          Path: process.env.Path,
          HOME: process.env.HOME,
          SystemRoot: process.env.SystemRoot,
          SYSTEMROOT: process.env.SYSTEMROOT,
          COMSPEC: process.env.COMSPEC,
          PATHEXT: process.env.PATHEXT,
          BACKUP_DIR: backupDir,
          DB_USER: "stell22",
          DB_NAME: "stell22",
          STELL22_BACKUP_TEST_DUMP: "fail-empty",
          STELL22_BACKUP_DOCKER_LOG: `${backupDir}/docker-calls.log`,
          DOCKER_HOST: "unix:///tmp/stell22-backup-no-such.sock",
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.status).not.toBe(99);
    expect(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).not.toContain("BACKUP SUCCESS");
    expectLegacyUntouched(backupDir);
    expect(posixExists(findLog) ? readPosix(findLog) : "").not.toContain("-delete");
  });

  it("writes a checksum that matches the published archive", () => {
    const backupDir = makePosixTemp(testTemps);
    const result = runBackup({ backupDir, dumpMode: "ok" });
    expect(result.status).toBe(0);
    const archive = `${backupDir}/${ARCHIVE_NAME}`;
    const recorded = readPosix(`${backupDir}/${CHECKSUM_NAME}`).trim().split(/\s+/)[0];
    const independent = runShell('sha256sum "$1"', [archive]).stdout.trim().split(/\s+/)[0];
    expect(recorded).toBe(independent);
    expect(runShell('cd "$1" && sha256sum -c "$2"', [backupDir, CHECKSUM_NAME]).status).toBe(0);
  });

  it("does not print BACKUP SUCCESS when a required step fails", () => {
    const failed = rejectBackup({ dumpMode: "fail-partial" });
    expect(failed.combined).not.toContain("BACKUP SUCCESS");
    const gzipFailed = rejectBackup({
      extra: { gzip: ['echo "gzip forced failure" >&2', "exit 1"] },
    });
    expect(gzipFailed.combined).not.toContain("BACKUP SUCCESS");
  });

  it("removes temporary dump files after a handled failure", () => {
    const wroteBytes = rejectBackup({ dumpMode: "fail-partial" });
    expect(wroteBytes.status).not.toBe(0);
    expectNoTemp(wroteBytes.backupDir);
    const gzipFailed = rejectBackup({
      extra: { gzip: ['echo "gzip forced failure" >&2', "exit 1"] },
    });
    expectNoTemp(gzipFailed.backupDir);
  });

  it("produces the same successful archive under sh and dash", () => {
    const dash = runShell("command -v dash");
    expect(dash.status).toBe(0);

    for (const shell of ["sh", "dash"] as const) {
      const backupDir = makePosixTemp(testTemps);
      const result = runBackup({ backupDir, shell, dumpMode: "ok" });
      expect(result.status).toBe(0);
      expect(result.combined).toContain("BACKUP SUCCESS");
      const plain = runShell('gzip -dc "$1"', [`${backupDir}/${ARCHIVE_NAME}`]);
      expect(plain.stdout).toBe(COMPLETE_DUMP);
      expect(runShell('cd "$1" && sha256sum -c "$2"', [backupDir, CHECKSUM_NAME]).status).toBe(0);
    }
  });

  it("publishes the checksum before the archive", () => {
    const backupDir = makePosixTemp(testTemps);
    placeLegacy(backupDir);
    const log = `${backupDir}/ln-order.log`;
    const result = runBackup({
      backupDir,
      dumpMode: "ok",
      extraPath: writeExtraMocks({ ln: orderedLn(log) }),
    });
    expect(result.status).toBe(0);
    expect(readPosix(log).trim().split("\n")).toEqual([
      `${backupDir}/${CHECKSUM_NAME}`,
      `${backupDir}/${ARCHIVE_NAME}`,
    ]);
    expectLegacyUntouched(backupDir);
  });

  it("leaves no archive when checksum publication fails", () => {
    const backupDir = makePosixTemp(testTemps);
    placeLegacy(backupDir);
    const result = runBackup({
      backupDir,
      dumpMode: "ok",
      extraPath: writeExtraMocks({ ln: publishMock() }),
    });
    expect(result.status).not.toBe(0);
    expectNoDumpLeak(result);
    expect(posixExists(`${backupDir}/${ARCHIVE_NAME}`)).toBe(false);
    expect(posixExists(`${backupDir}/${CHECKSUM_NAME}`)).toBe(false);
    expectLegacyUntouched(backupDir);
  });

  it("removes the new checksum when archive publication fails", () => {
    const backupDir = makePosixTemp(testTemps);
    placeLegacy(backupDir);
    const log = `${backupDir}/ln-archive-fail.log`;
    const result = runBackup({
      backupDir,
      dumpMode: "ok",
      extraPath: writeExtraMocks({ ln: failArchiveLn() }),
      lnLog: log,
    });
    expect(result.status).not.toBe(0);
    expectNoDumpLeak(result);
    expect(readPosix(log).trim()).toBe(`${backupDir}/${CHECKSUM_NAME}`);
    expect(posixExists(`${backupDir}/${ARCHIVE_NAME}`)).toBe(false);
    expect(posixExists(`${backupDir}/${CHECKSUM_NAME}`)).toBe(false);
    expectLegacyUntouched(backupDir);
    expectNoTemp(backupDir);
  });

  it("cleans a checksum when SIGTERM arrives before the archive link", () => {
    const observed = runSignalPublication("TERM");
    expect(observed.combined).not.toContain("BACKUP SUCCESS");
    expect(posixExists(observed.archive)).toBe(false);
    expect(posixExists(observed.checksum)).toBe(false);
    expectLegacyUntouched(observed.backupDir);
  });

  it("leaves no archive when SIGKILL arrives before the archive link", () => {
    const observed = runSignalPublication("KILL");
    expect(observed.combined).not.toContain("BACKUP SUCCESS");
    expect(posixExists(observed.archive)).toBe(false);
    expect(posixExists(observed.checksum)).toBe(true);
    expect(readPosix(observed.checksum).length).toBeGreaterThan(0);
    expectLegacyUntouched(observed.backupDir);
  });

  it("does not overwrite or delete an existing archive name", () => {
    const backupDir = makePosixTemp(testTemps);
    placeLegacy(backupDir);
    const existing = `${backupDir}/${ARCHIVE_NAME}`;
    expect(runShell('printf %s "$2" > "$1"', [existing, "existing-archive"]).status).toBe(0);
    const result = runBackup({ backupDir, dumpMode: "ok" });
    expect(result.status).not.toBe(0);
    expectNoDumpLeak(result);
    expect(readPosix(existing)).toBe("existing-archive");
    expect(posixExists(`${backupDir}/${CHECKSUM_NAME}`)).toBe(false);
    expectLegacyUntouched(backupDir);
  });

  it("does not overwrite or delete an existing checksum", () => {
    const backupDir = makePosixTemp(testTemps);
    placeLegacy(backupDir);
    const existing = `${backupDir}/${CHECKSUM_NAME}`;
    expect(runShell('printf %s "$2" > "$1"', [existing, "existing-checksum"]).status).toBe(0);
    const result = runBackup({ backupDir, dumpMode: "ok" });
    expect(result.status).not.toBe(0);
    expectNoDumpLeak(result);
    expect(readPosix(existing)).toBe("existing-checksum");
    expect(posixExists(`${backupDir}/${ARCHIVE_NAME}`)).toBe(false);
    expectLegacyUntouched(backupDir);
  });

  it("publishes both names only after the checksum is in place", () => {
    const backupDir = makePosixTemp(testTemps);
    placeLegacy(backupDir);
    const log = `${backupDir}/ln-success.log`;
    const result = runBackup({
      backupDir,
      dumpMode: "ok",
      extraPath: writeExtraMocks({ ln: orderedLn(log) }),
    });
    expect(result.status).toBe(0);
    const order = readPosix(log).trim().split("\n");
    expect(order[0]).toBe(`${backupDir}/${CHECKSUM_NAME}`);
    expect(order[1]).toBe(`${backupDir}/${ARCHIVE_NAME}`);
    expect(posixExists(`${backupDir}/${ARCHIVE_NAME}`)).toBe(true);
    expect(runShell('cd "$1" && sha256sum -c "$2"', [backupDir, CHECKSUM_NAME]).status).toBe(0);
    expectLegacyUntouched(backupDir);
  });

  it("creates no final names when pg_dump fails before publication", () => {
    const result = rejectBackup({ dumpMode: "fail-empty" });
    expect(listNames(result.backupDir, "stell22_*.sql.gz")).toEqual([LEGACY_NAME]);
    expect(listNames(result.backupDir, "*.sha256")).toEqual([]);
  });

  it("never reaches a real docker daemon or a production database", () => {
    const backupDir = makePosixTemp(testTemps);
    const result = runBackup({ backupDir, dumpMode: "ok" });
    expect(result.status).toBe(0);
    expect(result.dockerLog).toBe(
      "compose -f docker-compose.prod.yml exec -T db pg_dump -U stell22 stell22",
    );
    expect(result.combined).not.toContain("Cannot connect to the Docker daemon");
    expect(result.combined).not.toContain("stell22-backup-no-such.sock");
    expect(result.combined).not.toContain(FIXTURE_SENTINEL);
    expect(result.dockerLog).not.toContain("postgresql://");
  });
});
