import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SENTINEL = "STELL22_FIXTURE_ROW_9f3c";
const SECRET = "aws-secret-Zz9Qq7Lm2";
const PRIVATE_KEY = "AGE-SECRET-KEY-1FAKEPRIVATEKEYVALUE";
const DB_PASSWORD = "secret-db-password";
const RECIPIENT = "age1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
const BUCKET = "stell22-offsite-test";
const PREFIX = "stell22/offsite/v1";
const DAY = "2026-11-22";
const ARCHIVE = "stell22_2026-11-22_03-00-01.sql.gz";
const LEGACY = "legacy-2099-bytes";

const suiteTemps: string[] = [];
const testTemps: string[] = [];
let mockBin = "";

const COMPLETE_DUMP = [
  "-- PostgreSQL database dump",
  "SET client_encoding = 'UTF8';",
  `SELECT '${SENTINEL}';`,
  "-- PostgreSQL database dump complete",
  "",
].join("\n");

function runShell(command: string, args: readonly string[] = []): SpawnSyncReturns<string> {
  return spawnSync("sh", ["-c", command, "sh", ...args], { encoding: "utf8" });
}

function rememberTemp(bucket: string[], posixPath: string): string {
  if (!posixPath.startsWith("/tmp/stell22-offsite")) {
    throw new Error(`refusing to track unexpected temp path: ${posixPath}`);
  }
  bucket.push(posixPath);
  return posixPath;
}

function makePosixTemp(bucket: string[]): string {
  const created = runShell("mktemp -d /tmp/stell22-offsite.XXXXXX");
  if (created.status !== 0) {
    throw new Error(created.stderr || "mktemp failed");
  }
  return rememberTemp(bucket, created.stdout.trim());
}

function toWin(posix: string): string {
  if (process.platform !== "win32") {
    return posix;
  }
  const win = spawnSync("cygpath", ["-w", posix], { encoding: "utf8" });
  if (win.status !== 0 || !win.stdout.trim()) {
    throw new Error(win.stderr || "cygpath -w failed");
  }
  return win.stdout.trim();
}

function writeExec(dirPosix: string, name: string, lines: readonly string[]): void {
  writeFileSync(path.join(toWin(dirPosix), name), ["#!/bin/sh", ...lines, ""].join("\n"), "utf8");
  const chmod = runShell('chmod 755 "$1"', [`${dirPosix}/${name}`]);
  if (chmod.status !== 0) {
    throw new Error(chmod.stderr || `chmod failed for ${name}`);
  }
}

function readPosix(filePath: string): string {
  const read = runShell('cat "$1"', [filePath]);
  if (read.status !== 0) {
    throw new Error(read.stderr || `cannot read ${filePath}`);
  }
  return read.stdout;
}

function posixExists(filePath: string): boolean {
  return runShell('test -e "$1"', [filePath]).status === 0;
}

function removeTemps(bucket: string[]): void {
  while (bucket.length > 0) {
    const dir = bucket.pop();
    if (!dir?.startsWith("/tmp/stell22-offsite")) {
      continue;
    }
    runShell('rm -rf "$1"', [dir]);
  }
}

function field(text: string, name: string): string {
  const line = text.split(/\r?\n/).find((item) => item.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1) : "";
}

function objectPath(awsRoot: string, key: string): string {
  return `${awsRoot}/${BUCKET}/${key}`;
}

function dayKey(kind: "archive.age" | "manifest.json" | "SUCCESS"): string {
  return `${PREFIX}/daily/${DAY}/${kind}`;
}

type RunOptions = {
  backupDir: string;
  stateDir: string;
  awsRoot: string;
  realProducer?: boolean;
  dumpMode?: string;
  producerMode?: string;
  awsFail?: string;
  ageFail?: boolean;
  dateMode?: "ok" | "utc";
  lowDisk?: boolean;
  recipient?: string;
  omitRecipient?: boolean;
  clock?: string;
  epoch?: string;
  maxAge?: string;
  producerLog?: string;
  awsLog?: string;
  ageLog?: string;
  dockerLog?: string;
  dbLog?: string;
  sleepSeconds?: string;
  hooks?: boolean;
  externalLocation?: string;
};

function logPaths(options: RunOptions) {
  return {
    producerLog: options.producerLog ?? `${options.stateDir}/producer.log`,
    awsLog: options.awsLog ?? `${options.stateDir}/aws.log`,
    ageLog: options.ageLog ?? `${options.stateDir}/age.log`,
    dockerLog: options.dockerLog ?? `${options.stateDir}/docker.log`,
    dbLog: options.dbLog ?? `${options.stateDir}/db.log`,
  };
}

function buildEnv(options: RunOptions): NodeJS.ProcessEnv {
  const { producerLog, awsLog, ageLog, dockerLog, dbLog } = logPaths(options);
  for (const file of [producerLog, awsLog, ageLog, dockerLog, dbLog]) {
    if (!posixExists(file)) {
      runShell(': > "$1"', [file]);
    }
  }
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: `${mockBin}:${process.env.PATH ?? ""}`,
    Path: process.env.Path,
    HOME: process.env.HOME,
    SystemRoot: process.env.SystemRoot,
    SYSTEMROOT: process.env.SYSTEMROOT,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    OFFSITE_ENDPOINT: "https://storage.yandexcloud.net",
    OFFSITE_BUCKET: BUCKET,
    OFFSITE_REGION: "ru-central1",
    OFFSITE_PREFIX: PREFIX,
    OFFSITE_BACKUP_DIR: options.backupDir,
    OFFSITE_STATE_DIR: options.stateDir,
    OFFSITE_MIN_FREE_KB: "1",
    OFFSITE_MAX_AGE_HOURS: options.maxAge ?? "36",
    OFFSITE_GRACE_HHMM: "0330",
    OFFSITE_LOOKBACK_DAYS: "3",
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: SECRET,
    AWS_DEFAULT_REGION: "ru-central1",
    STELL22_DECOY_PRIVATE: PRIVATE_KEY,
    DATABASE_URL: `postgres://stell22:${DB_PASSWORD}@127.0.0.1/stell22`,
    DOCKER_HOST: "unix:///tmp/stell22-offsite-no-such.sock",
    STELL22_AWS_LOG: awsLog,
    STELL22_AWS_ROOT: options.awsRoot,
    STELL22_AWS_FAIL: options.awsFail ?? "",
    STELL22_AGE_LOG: ageLog,
    STELL22_AGE_FAIL: options.ageFail ? "1" : "",
    STELL22_OFFSITE_DATE_MODE: options.dateMode ?? "ok",
    STELL22_OFFSITE_CLOCK: options.clock ?? "0400",
    STELL22_OFFSITE_EPOCH: options.epoch ?? "1763776801",
    STELL22_DF_MODE: options.lowDisk ? "low" : "ok",
    STELL22_PRODUCER_LOG: producerLog,
    STELL22_PRODUCER_MODE: options.producerMode ?? "ok",
    STELL22_PRODUCER_SLEEP: options.sleepSeconds ?? "4",
    STELL22_BACKUP_TEST_DUMP: options.dumpMode ?? "ok",
    STELL22_BACKUP_DOCKER_LOG: dockerLog,
    STELL22_DB_LOG: dbLog,
    STELL22_DOCKER_REFUSE: options.realProducer ? "" : "1",
  };
  if (!options.omitRecipient) {
    env.OFFSITE_AGE_RECIPIENT = options.recipient ?? RECIPIENT;
  }
  if (options.hooks) {
    env.STELL22_OFFSITE_TEST_HOOKS = "1";
    env.OFFSITE_ENVIRONMENT = "synthetic";
    env.STELL22_OFFSITE_PRODUCER = `${mockBin}/producer`;
  }
  if (options.externalLocation) {
    env.OFFSITE_EXTERNAL_LOCATION = options.externalLocation;
  }
  return env;
}

function runOffsite(script: string, options: RunOptions) {
  const env = buildEnv(options);
  const { producerLog, awsLog, ageLog, dockerLog, dbLog } = logPaths(options);
  const result = spawnSync("sh", [script], {
    cwd: repoRoot,
    encoding: "utf8",
    env,
  });
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
    awsLog: readPosix(awsLog),
    ageLog: readPosix(ageLog),
    producerLog: readPosix(producerLog),
    dockerLog: readPosix(dockerLog),
    dbLog: readPosix(dbLog),
    env,
  };
}

function freshDirs(): { backupDir: string; stateDir: string; awsRoot: string } {
  const backupDir = makePosixTemp(testTemps);
  const stateDir = makePosixTemp(testTemps);
  const awsRoot = makePosixTemp(testTemps);
  runShell('printf %s "$2" > "$1/stell22_2099-01-01_00-00-00.sql.gz"', [backupDir, LEGACY]);
  return { backupDir, stateDir, awsRoot };
}

function expectSecretFree(text: string): void {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(PRIVATE_KEY);
  expect(text).not.toContain(DB_PASSWORD);
  expect(text).not.toContain(SENTINEL);
  expect(text).not.toContain("STATUS=RESTORE_VERIFIED");
}

function expectLegacy(backupDir: string): void {
  expect(readPosix(`${backupDir}/stell22_2099-01-01_00-00-00.sql.gz`)).toBe(LEGACY);
}

describe("daily offsite backup", { timeout: 60_000 }, () => {
  beforeAll(() => {
    mockBin = makePosixTemp(suiteTemps);
    writeExec(mockBin, "date", [
      'fmt=${1:-}',
      'mode=${STELL22_OFFSITE_DATE_MODE:-ok}',
      'if [ "$mode" = "utc" ]; then',
      '  case "$fmt" in',
      "    +%z) printf '%s\\n' '+0000'; exit 0 ;;",
      "  esac",
      "fi",
      'case "$fmt" in',
      "  +%z)",
      '    if [ "${TZ:-}" = "Europe/Moscow" ]; then printf \'%s\\n\' \'+0300\'; else printf \'%s\\n\' \'+0000\'; fi',
      "    ;;",
      "  +%Y-%m-%d|+%F)",
      '    if [ "${TZ:-}" = "Europe/Moscow" ]; then printf \'%s\\n\' \'2026-11-22\'; else printf \'%s\\n\' \'2026-11-21\'; fi',
      "    ;;",
      "  +%Y-%m-%d_%H-%M-%S) printf '%s\\n' '2026-11-22_03-00-01' ;;",
      "  +%Y-%m-%dT%H:%M:%SZ) printf '%s\\n' '2026-11-22T00:00:01Z' ;;",
      '  +%H%M) printf \'%s\\n\' "${STELL22_OFFSITE_CLOCK:-0400}" ;;',
      '  +%s) printf \'%s\\n\' "${STELL22_OFFSITE_EPOCH:-1763776801}" ;;',
      '  *) echo "unexpected date format: $fmt" >&2; exit 97 ;;',
      "esac",
    ]);
    writeExec(mockBin, "df", [
      "printf '%s\\n' 'Filesystem 1024-blocks Used Available Capacity Mounted on'",
      'if [ "${STELL22_DF_MODE:-ok}" = "low" ]; then',
      "  printf '%s\\n' 'mock 1024 1024 0 100% /tmp'",
      "else",
      "  printf '%s\\n' 'mock 999999999 0 999999999 0% /tmp'",
      "fi",
      "exit 0",
    ]);
    writeExec(mockBin, "flock", [
      "nonblock=0",
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      "    -n) nonblock=1; shift ;;",
      "    -x|-s) shift ;;",
      '    *) break ;;',
      "  esac",
      "done",
      'file=$1',
      "shift",
      'dir="${file}.lockdir"',
      'if ! mkdir "$dir" 2>/dev/null; then',
      "  exit 1",
      "fi",
      '"$@"',
      "rc=$?",
      'rmdir "$dir" || true',
      'exit "$rc"',
    ]);
    writeExec(mockBin, "age", [
      "set -eu",
      'printf \'%s\\n\' "$*" >> "${STELL22_AGE_LOG:?}"',
      'if [ "${STELL22_AGE_FAIL:-}" = "1" ]; then',
      '  echo "age forced failure" >&2',
      "  exit 1",
      "fi",
      "recipient=",
      "out=",
      "input=",
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      "    -r) recipient=$2; shift 2 ;;",
      "    -o) out=$2; shift 2 ;;",
      '    *) input=$1; shift ;;',
      "  esac",
      "done",
      'case "$recipient" in',
      '  age1*) ;;',
      '  *) echo "missing recipient" >&2; exit 1 ;;',
      "esac",
      'case "$recipient" in',
      '  *SECRET*) echo "refusing secret" >&2; exit 1 ;;',
      "esac",
      "{",
      "  printf '%s\\n' 'age-mock-v1'",
      '  sha256sum "$input" | awk \'{ print $1 }\'',
      '  wc -c < "$input" | tr -d \'[:space:]\'',
      '} > "$out"',
    ]);
    writeExec(mockBin, "aws", [
      "set -eu",
      'printf \'%s\\n\' "$*" >> "${STELL22_AWS_LOG:?}"',
      'root=${STELL22_AWS_ROOT:?}',
      'fail=${STELL22_AWS_FAIL:-}',
      'if [ "${1:-}" != "s3api" ]; then echo "refusing $*" >&2; exit 97; fi',
      "sub=$2",
      "shift 2",
      "bucket= key= body= endpoint= match= dest=",
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      "    --bucket) bucket=$2; shift 2 ;;",
      "    --key) key=$2; shift 2 ;;",
      "    --body) body=$2; shift 2 ;;",
      "    --endpoint-url) endpoint=$2; shift 2 ;;",
      "    --region) shift 2 ;;",
      "    --if-none-match) match=$2; shift 2 ;;",
      "    --content-type) shift 2 ;;",
      '    -*) echo "bad aws arg $1" >&2; exit 97 ;;',
      "    *) dest=$1; shift ;;",
      "  esac",
      "done",
      'if [ "$endpoint" != "https://storage.yandexcloud.net" ]; then echo "bad endpoint" >&2; exit 97; fi',
      'store="$root/$bucket/$key"',
      'case "$sub" in',
      "  put-object)",
      '    if [ "$match" != "*" ]; then echo "missing if-none-match" >&2; exit 97; fi',
      '    case "$key:$fail" in',
      "      */SUCCESS:marker-put) echo 'marker put forced' >&2; exit 1 ;;",
      "    esac",
      '    if [ "$fail" = "put" ]; then echo "upload forced" >&2; exit 1; fi',
      '    if [ -e "$store" ]; then echo "PreconditionFailed 412" >&2; exit 1; fi',
      '    mkdir -p "$(dirname "$store")"',
      '    cp "$body" "$store"',
      "    printf '%s\\n' '{\"ETag\": \"not-a-sha256\"}'",
      "    ;;",
      "  head-object)",
      '    if [ ! -e "$store" ]; then echo "404 Not Found" >&2; exit 1; fi',
      '    if [ "$fail" = "head" ]; then echo "head forced" >&2; exit 1; fi',
      '    size=$(wc -c < "$store" | tr -d \'[:space:]\')',
      "    printf '{\"ContentLength\": %s, \"ETag\": \"not-a-sha256\"}\\n' \"$size\"",
      "    ;;",
      "  get-object)",
      '    if [ -z "$dest" ]; then echo "missing dest" >&2; exit 97; fi',
      '    if [ ! -e "$store" ]; then echo "404 Not Found" >&2; exit 1; fi',
      '    case "$fail" in',
      "      get) echo 'get forced' >&2; exit 1 ;;",
      "      corrupt-get) printf '%s\\n' 'corrupt-bytes' > \"$dest\"; exit 0 ;;",
      "      manifest-get)",
      '        case "$key" in */manifest.json) echo "manifest get forced" >&2; exit 1 ;; esac',
      "        ;;",
      "      manifest-corrupt)",
      '        case "$key" in */manifest.json) printf \'%s\\n\' \'{bad\' > "$dest"; exit 0 ;; esac',
      "        ;;",
      "    esac",
      '    cp "$store" "$dest"',
      "    printf '%s\\n' '{\"ETag\": \"not-a-sha256\"}'",
      "    ;;",
      '  *) echo "refusing $sub" >&2; exit 97 ;;',
      "esac",
    ]);
    writeExec(mockBin, "producer", [
      "set -eu",
      'printf \'%s\\n\' run >> "${STELL22_PRODUCER_LOG:?}"',
      'mode=${STELL22_PRODUCER_MODE:-ok}',
      'dir=${BACKUP_DIR:?}',
      `name=${ARCHIVE}`,
      'if [ "$mode" = "sleep" ]; then',
      '  sleep "${STELL22_PRODUCER_SLEEP:-4}"',
      "  mode=ok",
      "fi",
      'case "$mode" in',
      "  ok)",
      `    printf 'fixture %s\\n' '${SENTINEL}' | gzip -c > "$dir/$name"`,
      '    (CDPATH= cd "$dir" && sha256sum "$name" > "$name.sha256")',
      '    printf \'%s\\n\' "[backup] BACKUP SUCCESS: $dir/$name"',
      "    ;;",
      "  missing)",
      '    printf \'%s\\n\' "[backup] BACKUP SUCCESS: $dir/$name"',
      "    ;;",
      "  bad-checksum)",
      `    printf 'fixture %s\\n' '${SENTINEL}' | gzip -c > "$dir/$name"`,
      '    printf \'%s\\n\' "0000000000000000000000000000000000000000000000000000000000000000  $name" > "$dir/$name.sha256"',
      '    printf \'%s\\n\' "[backup] BACKUP SUCCESS: $dir/$name"',
      "    ;;",
      '  *) echo "unknown producer mode" >&2; exit 1 ;;',
      "esac",
    ]);
    writeExec(mockBin, "docker", [
      "set -eu",
      'if [ "${STELL22_DOCKER_REFUSE:-}" = "1" ]; then',
      '  printf \'%s\\n\' "$*" >> "${STELL22_DB_LOG:?}"',
      '  echo "refusing docker" >&2',
      "  exit 99",
      "fi",
      'printf \'%s\\n\' "$*" >> "${STELL22_BACKUP_DOCKER_LOG:?}"',
      'case " $* " in',
      '  *" pg_dump "*) ;;',
      '  *) echo "refusing docker call: $*" >&2; exit 98 ;;',
      "esac",
      'mode=${STELL22_BACKUP_TEST_DUMP:-ok}',
      'case "$mode" in',
      "  ok)",
      "    cat <<'EOF'",
      ...COMPLETE_DUMP.split("\n").slice(0, -1),
      "EOF",
      "    ;;",
      "  fail-empty) exit 1 ;;",
      '  *) echo "unknown dump mode" >&2; exit 97 ;;',
      "esac",
    ]);
    writeExec(mockBin, "psql", [
      'printf \'%s\\n\' "$*" >> "${STELL22_DB_LOG:?}"',
      'echo "refusing psql" >&2',
      "exit 99",
    ]);
    writeExec(mockBin, "pg_dump", [
      'printf \'%s\\n\' "$*" >> "${STELL22_DB_LOG:?}"',
      'echo "refusing pg_dump" >&2',
      "exit 99",
    ]);
  });

  afterEach(() => {
    removeTemps(testTemps);
  });

  afterAll(() => {
    removeTemps(suiteTemps);
  });

  it("runs a synthetic pipeline through the existing producer", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, realProducer: true });
    expect(result.status).toBe(0);
    expect(field(result.stdout, "STATUS")).toBe("OFFSITE_VERIFIED");
    expect(field(result.stdout, "ALREADY")).toBe("0");
    expect(field(result.stdout, "RESTORE_VERIFIED")).toBe("0");
    expect(field(result.stdout, "BACKUP_DATE")).toBe(DAY);
    expect(result.dockerLog).toContain("pg_dump");
    expect(result.dbLog).toBe("");
    expect(result.ageLog).not.toContain("2099");
    expect(result.awsLog.match(/put-object/g)?.length).toBe(3);
    expect(result.awsLog).toContain("--if-none-match *");
    const cipher = readPosix(objectPath(dirs.awsRoot, dayKey("archive.age")));
    expect(cipher.startsWith("age-mock-v1\n")).toBe(true);
    expect(cipher).not.toContain(SENTINEL);
    expect(readPosix(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toContain("status=OFFSITE_VERIFIED");
    expect(readPosix(objectPath(dirs.awsRoot, dayKey("manifest.json")))).not.toContain(SENTINEL);
    expectLegacy(dirs.backupDir);
    expectSecretFree(`${result.combined}\n${result.awsLog}\n${result.ageLog}`);
  });

  it("stops when the producer pg_dump fails", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      realProducer: true,
      dumpMode: "fail-empty",
    });
    expect(result.status).toBe(14);
    expect(field(result.stdout, "STATUS")).toBe("FAILED");
    expect(field(result.stdout, "REASON")).toBe("producer-failure");
    expect(result.awsLog).not.toContain("put-object");
    expect(posixExists(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toBe(false);
    expectLegacy(dirs.backupDir);
    expectSecretFree(result.combined);
  });

  it("refuses a success line without a published archive", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      producerMode: "missing",
    });
    expect(result.status).toBe(15);
    expect(field(result.stdout, "REASON")).toBe("missing-archive");
    expect(result.awsLog).not.toContain("put-object");
    expectLegacy(dirs.backupDir);
  });

  it("refuses a corrupted checksum", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      producerMode: "bad-checksum",
    });
    expect(result.status).toBe(16);
    expect(field(result.stdout, "REASON")).toBe("checksum-failure");
    expect(result.awsLog).not.toContain("put-object");
    expectLegacy(dirs.backupDir);
  });

  it("stops on encryption failure and keeps the existing archive", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, ageFail: true });
    expect(result.status).toBe(17);
    expect(field(result.stdout, "REASON")).toBe("encryption-failure");
    expect(result.awsLog).not.toContain("put-object");
    expect(posixExists(`${dirs.backupDir}/${ARCHIVE}`)).toBe(true);
    expectLegacy(dirs.backupDir);
  });

  it("stops on upload failure", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, awsFail: "put" });
    expect(result.status).toBe(18);
    expect(field(result.stdout, "REASON")).toBe("upload-failure");
    expect(posixExists(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toBe(false);
    expectLegacy(dirs.backupDir);
  });

  it("stops when remote HEAD fails after upload", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, awsFail: "head" });
    expect(result.status).toBe(19);
    expect(field(result.stdout, "REASON")).toBe("remote-head-failure");
    expect(posixExists(objectPath(dirs.awsRoot, dayKey("archive.age")))).toBe(true);
    expect(posixExists(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toBe(false);
    expectLegacy(dirs.backupDir);
  });

  it("stops when remote GET fails", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, awsFail: "get" });
    expect(result.status).toBe(20);
    expect(field(result.stdout, "REASON")).toBe("remote-get-failure");
    expect(posixExists(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toBe(false);
  });

  it("stops when the downloaded ciphertext does not match", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      awsFail: "corrupt-get",
    });
    expect(result.status).toBe(21);
    expect(field(result.stdout, "REASON")).toBe("remote-checksum-mismatch");
    expect(readPosix(objectPath(dirs.awsRoot, dayKey("archive.age"))).startsWith("age-mock-v1\n")).toBe(
      true,
    );
    expect(posixExists(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toBe(false);
  });

  it("stops on an invalid manifest", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      awsFail: "manifest-corrupt",
    });
    expect(result.status).toBe(22);
    expect(field(result.stdout, "REASON")).toBe("manifest-failure");
    expect(posixExists(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toBe(false);
  });

  it("resumes after an interruption before the success marker", () => {
    const dirs = freshDirs();
    const first = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      awsFail: "marker-put",
    });
    expect(first.status).toBe(23);
    expect(posixExists(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toBe(false);
    const before = readPosix(objectPath(dirs.awsRoot, dayKey("archive.age")));
    const health = runOffsite("scripts/offsite-backup-health.sh", { ...dirs, hooks: true });
    expect(health.status).toBe(31);
    expect(field(health.stdout, "STATUS")).toBe("INCOMPLETE");
    const second = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      awsLog: `${dirs.stateDir}/aws-resume.log`,
      producerLog: `${dirs.stateDir}/producer-resume.log`,
    });
    expect(second.status).toBe(0);
    expect(field(second.stdout, "STATUS")).toBe("OFFSITE_VERIFIED");
    expect(second.producerLog).toBe("");
    expect(readPosix(objectPath(dirs.awsRoot, dayKey("archive.age")))).toBe(before);
    expect(readPosix(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toContain("OFFSITE_VERIFIED");
  });

  it("does not upload again after a confirmed success", () => {
    const dirs = freshDirs();
    const first = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true });
    expect(first.status).toBe(0);
    const producerLines = first.producerLog.trim().split("\n").length;
    const second = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      awsLog: `${dirs.stateDir}/aws-again.log`,
    });
    expect(second.status).toBe(0);
    expect(field(second.stdout, "ALREADY")).toBe("1");
    expect(field(second.stdout, "RESTORE_VERIFIED")).toBe("0");
    expect(second.awsLog).not.toContain("put-object");
    expect(first.producerLog.trim().split("\n").length).toBe(producerLines);
  });

  it("rejects a concurrent second run", async () => {
    const dirs = freshDirs();
    const firstEnv = buildEnv({
      ...dirs,
      hooks: true,
      producerMode: "sleep",
      sleepSeconds: "8",
    });
    const child = spawn("sh", ["scripts/offsite-backup.sh"], {
      cwd: repoRoot,
      env: firstEnv,
    });
    const finished = new Promise<number>((resolve) => {
      child.on("exit", (code) => resolve(code ?? 1));
    });
    const lock = `${dirs.stateDir}/offsite.lock.lockdir`;
    let seen = false;
    try {
      for (let i = 0; i < 50; i += 1) {
        if (posixExists(lock)) {
          seen = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(seen).toBe(true);
      const second = runOffsite("scripts/offsite-backup.sh", {
        ...dirs,
        hooks: true,
        producerLog: `${dirs.stateDir}/producer-second.log`,
        awsLog: `${dirs.stateDir}/aws-second.log`,
      });
      expect(second.status).toBe(13);
      expect(field(second.stdout, "REASON")).toBe("concurrent");
      expect(second.producerLog).toBe("");
      expect(await finished).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill();
      }
    }
  });

  it("retries after an upload failure without dropping the local archive", () => {
    const dirs = freshDirs();
    const first = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, awsFail: "put" });
    expect(first.status).toBe(18);
    const local = readPosix(`${dirs.backupDir}/${ARCHIVE}`);
    const second = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      producerLog: `${dirs.stateDir}/producer-retry.log`,
    });
    expect(second.status).toBe(0);
    expect(second.producerLog).toBe("");
    expect(readPosix(`${dirs.backupDir}/${ARCHIVE}`)).toBe(local);
    expectLegacy(dirs.backupDir);
  });

  it("does not overwrite an existing immutable object", () => {
    const dirs = freshDirs();
    const key = dayKey("archive.age");
    const store = objectPath(dirs.awsRoot, key);
    runShell('mkdir -p "$(dirname "$1")"', [store]);
    runShell('printf %s immutable-not-ciphertext > "$1"', [store]);
    const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true });
    expect(result.status).toBe(21);
    expect(field(result.stdout, "REASON")).toBe("remote-checksum-mismatch");
    expect(readPosix(store)).toBe("immutable-not-ciphertext");
    expect(posixExists(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toBe(false);
    expectLegacy(dirs.backupDir);
  });

  it("reports a missing daily backup", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup-health.sh", { ...dirs, clock: "0400" });
    expect(result.status).toBe(30);
    expect(field(result.stdout, "STATUS")).toBe("MISSING_BACKUP");
  });

  it("reports producer failure from the health check", () => {
    const dirs = freshDirs();
    const failed = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      realProducer: true,
      dumpMode: "fail-empty",
    });
    expect(failed.status).toBe(14);
    const health = runOffsite("scripts/offsite-backup-health.sh", { ...dirs });
    expect(health.status).toBe(32);
    expect(field(health.stdout, "STATUS")).toBe("FAILED");
    expect(field(health.stdout, "REASON")).toBe("producer-failure");
  });

  it("reports a stale confirmed copy", () => {
    const dirs = freshDirs();
    const created = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, epoch: "1000" });
    expect(created.status).toBe(0);
    const health = runOffsite("scripts/offsite-backup-health.sh", {
      ...dirs,
      epoch: String(1000 + 10 * 3600),
      maxAge: "1",
    });
    expect(health.status).toBe(33);
    expect(field(health.stdout, "REASON")).toBe("stale");
  });

  it("checks the latest copy from outside the VPS and refuses a VPS-local claim", () => {
    const dirs = freshDirs();
    const created = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true });
    expect(created.status).toBe(0);
    const external = runOffsite("scripts/offsite-backup-external-check.sh", {
      ...dirs,
      externalLocation: "independent",
    });
    expect(external.status).toBe(0);
    expect(field(external.stdout, "STATUS")).toBe("OFFSITE_VERIFIED");
    expect(field(external.stdout, "VPS_LOSS_VISIBILITY")).toBe("independent");
    expect(field(external.stdout, "RESTORE_VERIFIED")).toBe("0");
    const refused = runOffsite("scripts/offsite-backup-external-check.sh", {
      ...dirs,
      externalLocation: "vps",
    });
    expect(refused.status).toBe(34);
    expect(field(refused.stdout, "REASON")).toBe("vps-cannot-detect-own-loss");
  });

  it("rejects a timezone that is not Moscow +0300", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, dateMode: "utc", hooks: true });
    expect(result.status).toBe(24);
    expect(field(result.stdout, "REASON")).toBe("timezone");
    expect(result.producerLog).toBe("");
    expect(result.awsLog).toBe("");
  });

  it("stops before the producer when disk space is low", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, lowDisk: true });
    expect(result.status).toBe(12);
    expect(field(result.stdout, "REASON")).toBe("low-disk");
    expect(result.producerLog).toBe("");
    expect(posixExists(`${dirs.backupDir}/${ARCHIVE}`)).toBe(false);
    expectLegacy(dirs.backupDir);
  });

  it("stops when the encryption recipient is missing", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, omitRecipient: true });
    expect(result.status).toBe(25);
    expect(field(result.stdout, "REASON")).toBe("missing-recipient");
    expect(result.awsLog).toBe("");
    expect(result.producerLog).toBe("");
  });

  it("does not call a database client", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true });
    expect(result.status).toBe(0);
    expect(result.dbLog).toBe("");
    expect(result.dockerLog).toBe("");
    expect(result.combined).not.toContain(DB_PASSWORD);
  });

  it("classifies retention without deleting", () => {
    const dates: string[] = [];
    const cursor = new Date(Date.UTC(2026, 10, 22));
    for (let i = 0; i < 40; i += 1) {
      const day = new Date(cursor);
      day.setUTCDate(cursor.getUTCDate() - i);
      dates.push(day.toISOString().slice(0, 10));
    }
    dates.push("2025-09-03", "2025-09-02", "2025-09-01");
    const input = `${dates.join("\n")}\n`;
    const listed = spawnSync("sh", ["scripts/offsite-backup-retention-plan.sh", "--scope", "remote"], {
      cwd: repoRoot,
      encoding: "utf8",
      input,
    });
    expect(listed.status).toBe(0);
    expect(listed.stdout).toContain("DELETION=SUSPENDED");
    expect(listed.stdout.split("\n").filter((line) => line.startsWith("KEEP daily "))).toHaveLength(30);
    expect(listed.stdout).toContain("KEEP monthly 2026-10-23");
    expect(listed.stdout).toContain("KEEP monthly 2025-09-03");
    expect(listed.stdout).toContain("CANDIDATE 2026-10-22");
    expect(listed.stdout).toContain("CANDIDATE 2025-09-01");
    expect(listed.stdout).toContain("KEEP daily 2026-11-22");
    expect(listed.stdout).toContain("KEEP daily 2026-10-24");

    const dummyDir = makePosixTemp(testTemps);
    runShell('printf %s keep-me > "$1/archive.sql.gz"', [dummyDir]);
    const denied = spawnSync(
      "sh",
      ["scripts/offsite-backup-retention-plan.sh", "--scope", "remote", "--delete"],
      { cwd: repoRoot, encoding: "utf8", input },
    );
    expect(denied.status).toBe(2);
    expect(denied.stdout).toContain("DELETION_SUSPENDED");
    expect(readPosix(`${dummyDir}/archive.sql.gz`)).toBe("keep-me");

    const partial = spawnSync("sh", ["scripts/offsite-backup-retention-plan.sh", "--scope", "remote"], {
      cwd: repoRoot,
      encoding: "utf8",
      input: "partial 2020-01-01\n2026-11-22\n",
    });
    expect(partial.status).not.toBe(0);
    expect(partial.stdout).not.toContain("CANDIDATE");
    expect(partial.stdout).toContain("unverified-object");
  });

  it("pins the systemd calendar to 03:00 Europe/Moscow", () => {
    const timer = readFileSync(path.join(repoRoot, "deploy/systemd/stell22-offsite-backup.timer"), "utf8");
    const service = readFileSync(
      path.join(repoRoot, "deploy/systemd/stell22-offsite-backup.service"),
      "utf8",
    );
    const failure = readFileSync(
      path.join(repoRoot, "deploy/systemd/stell22-offsite-backup-onfailure.service"),
      "utf8",
    );
    expect(timer).toContain("OnCalendar=*-*-* 03:00:00 Europe/Moscow");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("RandomizedDelaySec=0");
    expect(timer).toContain("AccuracySec=1us");
    expect(service).toContain("OnFailure=stell22-offsite-backup-onfailure.service");
    expect(service).toContain("TimeoutStartSec=6h");
    expect(failure).toContain("scripts/offsite-backup-health.sh");
    const direct = spawnSync(
      "systemd-analyze",
      ["calendar", "--iterations=2", "*-*-* 03:00:00 Europe/Moscow"],
      { encoding: "utf8" },
    );
    const viaWsl =
      direct.status === 0
        ? direct
        : spawnSync(
            "wsl",
            ["-e", "systemd-analyze", "calendar", "--iterations=2", "*-*-* 03:00:00 Europe/Moscow"],
            { encoding: "utf8" },
          );
    if (viaWsl.status === 0) {
      expect(`${viaWsl.stdout}\n${viaWsl.stderr}`).toContain("03:00:00");
    }
  });
});
