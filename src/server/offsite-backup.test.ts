import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
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

function holdLock(stateDir: string, epoch: number): void {
  const lock = `${stateDir}/offsite.lock`;
  const created = runShell('if [ ! -e "$1" ]; then : > "$1"; fi && mkdir "$1.lockdir"', [lock]);
  if (created.status !== 0) {
    throw new Error(created.stderr || "cannot hold the offsite lock");
  }
  writeFileSync(path.join(toWin(stateDir), "offsite-run.started"), `${epoch}\n`, "utf8");
  const fresh = Math.floor(Date.now() / 1000);
  utimesSync(toWin(lock), fresh, fresh);
}

function relocateVerifiedDay(awsRoot: string, from: string, to: string): void {
  const fromDir = objectPath(awsRoot, `${PREFIX}/daily/${from}`);
  const toDir = objectPath(awsRoot, `${PREFIX}/daily/${to}`);
  const copied = runShell('mkdir -p "$2" && cp "$1/archive.age" "$2/archive.age"', [fromDir, toDir]);
  if (copied.status !== 0) {
    throw new Error(copied.stderr || "cannot copy the verified archive");
  }
  const manifest = readPosix(`${fromDir}/manifest.json`).replaceAll(
    `"backupDate": "${from}"`,
    `"backupDate": "${to}"`,
  );
  writeFileSync(path.join(toWin(toDir), "manifest.json"), manifest, "utf8");
  const digest = runShell('sha256sum "$1"', [`${toDir}/manifest.json`]);
  if (digest.status !== 0) {
    throw new Error(digest.stderr || "cannot hash the relocated manifest");
  }
  const manifestSha = digest.stdout.trim().split(/\s+/)[0] ?? "";
  const marker = readPosix(`${fromDir}/SUCCESS`)
    .replaceAll(`backupDate=${from}`, `backupDate=${to}`)
    .replace(/^manifestSha256=.*$/m, `manifestSha256=${manifestSha}`);
  writeFileSync(path.join(toWin(toDir), "SUCCESS"), marker, "utf8");
}

function dropLocalEvidence(dirs: { backupDir: string; stateDir: string }): void {
  const removed = runShell('rm -f "$1/$2" "$3/last-run.env" && rm -rf "$3/attempts" "$3/work"', [
    dirs.backupDir,
    ARCHIVE,
    dirs.stateDir,
  ]);
  if (removed.status !== 0) {
    throw new Error(removed.stderr || "cannot drop local backup evidence");
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
  ageMode?: string;
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
  endpoint?: string;
  region?: string;
  lockMode?: string;
  ssdDates?: string;
  ssdRoot?: string;
  privateKey?: boolean;
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
    OFFSITE_ENDPOINT: options.endpoint ?? "https://s3.ru-6.storage.selcloud.ru",
    OFFSITE_BUCKET: BUCKET,
    OFFSITE_REGION: options.region ?? "ru-6",
    OFFSITE_PREFIX: PREFIX,
    OFFSITE_BACKUP_DIR: options.backupDir,
    OFFSITE_STATE_DIR: options.stateDir,
    OFFSITE_MIN_FREE_KB: "1",
    OFFSITE_MAX_AGE_HOURS: options.maxAge ?? "36",
    OFFSITE_GRACE_HHMM: "0330",
    OFFSITE_LOOKBACK_DAYS: "3",
    AWS_ACCESS_KEY_ID: "test-access-key",
    AWS_SECRET_ACCESS_KEY: SECRET,
    AWS_DEFAULT_REGION: options.region ?? "ru-6",
    STELL22_LOCK_MODE: options.lockMode ?? "",
    OFFSITE_SSD_DATES: options.ssdDates ?? "",
    OFFSITE_SSD_ROOT: options.ssdRoot ?? "",
    ...(options.privateKey ? { AGE_SECRET_KEY: PRIVATE_KEY } : {}),
    STELL22_DECOY_PRIVATE: PRIVATE_KEY,
    DATABASE_URL: `postgres://stell22:${DB_PASSWORD}@127.0.0.1/stell22`,
    DOCKER_HOST: "unix:///tmp/stell22-offsite-no-such.sock",
    STELL22_AWS_LOG: awsLog,
    STELL22_AWS_ROOT: options.awsRoot,
    STELL22_AWS_FAIL: options.awsFail ?? "",
    STELL22_AGE_LOG: ageLog,
    STELL22_AGE_FAIL: options.ageMode ?? (options.ageFail ? "1" : ""),
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
      'case "${STELL22_AGE_FAIL:-}" in',
      "  1)",
      '    echo "age forced failure" >&2',
      "    exit 1",
      "    ;;",
      "  partial)",
      '    if [ -z "$out" ]; then echo "missing output" >&2; exit 1; fi',
      "    printf '%s\\n' 'partial-ciphertext' > \"$out\"",
      '    echo "age interrupted" >&2',
      "    exit 1",
      "    ;;",
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
      "bucket= key= body= endpoint= match= dest= region=",
      'while [ $# -gt 0 ]; do',
      '  case "$1" in',
      "    --bucket) bucket=$2; shift 2 ;;",
      "    --key) key=$2; shift 2 ;;",
      "    --body) body=$2; shift 2 ;;",
      "    --endpoint-url) endpoint=$2; shift 2 ;;",
      "    --region) region=$2; shift 2 ;;",
      "    --if-none-match) match=$2; shift 2 ;;",
      "    --content-type) shift 2 ;;",
      '    -*) echo "bad aws arg $1" >&2; exit 97 ;;',
      "    *) dest=$1; shift ;;",
      "  esac",
      "done",
      'if [ "$endpoint" != "https://s3.ru-6.storage.selcloud.ru" ]; then echo "bad endpoint" >&2; exit 97; fi',
      'if [ "$region" != "ru-6" ]; then echo "bad region" >&2; exit 97; fi',
      'lock=${STELL22_LOCK_MODE:-ok}',
      'store="$root/$bucket/$key"',
      'case "$sub" in',
      "  get-bucket-versioning)",
      '    case "$lock" in',
      "      versioning-error) echo 'versioning access denied' >&2; exit 1 ;;",
      "      no-versioning) printf '%s\\n' '{\"Status\":\"Suspended\"}' ;;",
      "      versioning-missing) printf '%s\\n' '{}' ;;",
      "      *) printf '%s\\n' '{\"Status\":\"Enabled\"}' ;;",
      "    esac",
      "    ;;",
      "  get-object-lock-configuration)",
      '    case "$lock" in',
      "      lock-error) echo 'lock access denied' >&2; exit 1 ;;",
      "      no-lock) echo 'ObjectLockConfigurationNotFoundError' >&2; exit 1 ;;",
      '      governance) printf \'%s\\n\' \'{"ObjectLockConfiguration":{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"GOVERNANCE","Days":90}}}}\' ;;',
      '      short-retention) printf \'%s\\n\' \'{"ObjectLockConfiguration":{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":89}}}}\' ;;',
      '      no-retention) printf \'%s\\n\' \'{"ObjectLockConfiguration":{"ObjectLockEnabled":"Enabled"}}\' ;;',
      '      *) printf \'%s\\n\' \'{"ObjectLockConfiguration":{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":90}}}}\' ;;',
      "    esac",
      "    ;;",
      "  get-bucket-lifecycle-configuration)",
      '    case "$lock" in',
      "      lifecycle-error) echo 'lifecycle access denied' >&2; exit 1 ;;",
      '      lifecycle-delete) printf \'%s\\n\' \'{"Rules":[{"Expiration":{"Days":30}}]}\' ;;',
      "      *) echo 'NoSuchLifecycleConfiguration' >&2; exit 1 ;;",
      "    esac",
      "    ;;",
      "  delete-object|delete-bucket)",
      '    echo "delete refused" >&2',
      "    exit 97",
      "    ;;",
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
      "  fail) exit 1 ;;",
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
    expect(result.awsLog).toContain("https://s3.ru-6.storage.selcloud.ru");
    expect(result.awsLog).toContain("--region ru-6");
    expect(result.awsLog).toContain("get-bucket-versioning");
    expect(result.awsLog).toContain("get-object-lock-configuration");
    expect(result.awsLog).toContain("get-bucket-lifecycle-configuration");
    expect(result.awsLog).not.toContain("delete-object");
    expect(result.awsLog).not.toContain("storage.yandexcloud.net");
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
    expect(health.status).toBe(32);
    expect(field(health.stdout, "STATUS")).toBe("FAILED");
    expect(field(health.stdout, "REASON")).toBe("marker-failure");
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

  it("calculates month, year, February, and 08/09 dates in dash", () => {
    const lib = readFileSync(path.join(repoRoot, "scripts/offsite-backup-lib.sh"), "utf8");
    expect(lib).not.toContain("10#");
    const dirs = freshDirs();
    const probe = `${dirs.stateDir}/calendar.sh`;
    writeFileSync(
      toWin(probe),
      [
        "set -eu",
        ". scripts/offsite-backup-lib.sh",
        "offsite_prev_day 2026-03-01",
        "offsite_prev_day 2024-03-01",
        "offsite_prev_day 1900-03-01",
        "offsite_prev_day 2000-03-01",
        "offsite_prev_day 2026-01-01",
        "offsite_prev_day 2026-05-01",
        "offsite_prev_day 2026-08-01",
        "offsite_prev_day 2026-09-01",
        "offsite_prev_day 2026-08-09",
        "offsite_prev_day 2026-09-08",
        "offsite_prev_day 2026-10-01",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = spawnSync("sh", ["-c", 'dash "$1"', "sh", probe], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      [
        "2026-02-28",
        "2024-02-29",
        "1900-02-28",
        "2000-02-29",
        "2025-12-31",
        "2026-04-30",
        "2026-07-31",
        "2026-08-31",
        "2026-08-08",
        "2026-09-07",
        "2026-09-30",
        "",
      ].join("\n"),
    );
  });

  it("rejects a missed Moscow day after grace without claiming verification", () => {
    const dirs = freshDirs();
    const created = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true });
    expect(created.status).toBe(0);
    relocateVerifiedDay(dirs.awsRoot, DAY, "2026-11-21");
    const removed = runShell('rm -rf "$1"', [objectPath(dirs.awsRoot, `${PREFIX}/daily/${DAY}`)]);
    expect(removed.status).toBe(0);
    dropLocalEvidence(dirs);
    const external = runOffsite("scripts/offsite-backup-external-check.sh", {
      ...dirs,
      clock: "0400",
      externalLocation: "independent",
    });
    expect(external.status).toBe(30);
    expect(field(external.stdout, "STATUS")).toBe("MISSING_BACKUP");
    expect(field(external.stdout, "REASON")).toBe("missed");
    expect(external.stdout).not.toContain("STATUS=OFFSITE_VERIFIED");
    expect(field(external.stdout, "VPS_LOSS_VISIBILITY")).toBe("independent");
  });

  it("rejects an old confirmed copy from the external check", () => {
    const dirs = freshDirs();
    const created = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, epoch: "1000" });
    expect(created.status).toBe(0);
    dropLocalEvidence(dirs);
    const external = runOffsite("scripts/offsite-backup-external-check.sh", {
      ...dirs,
      epoch: String(1000 + 10 * 3600),
      maxAge: "1",
      externalLocation: "independent",
    });
    expect(external.status).toBe(33);
    expect(field(external.stdout, "STATUS")).toBe("MISSING_BACKUP");
    expect(field(external.stdout, "REASON")).toBe("stale");
    expect(external.stdout).not.toContain("STATUS=OFFSITE_VERIFIED");
    expect(field(external.stdout, "VPS_LOSS_VISIBILITY")).toBe("independent");
  });

  it("accepts a fresh remote copy without local VPS evidence", () => {
    const dirs = freshDirs();
    const created = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true });
    expect(created.status).toBe(0);
    dropLocalEvidence(dirs);
    const external = runOffsite("scripts/offsite-backup-external-check.sh", {
      ...dirs,
      externalLocation: "independent",
    });
    expect(external.status).toBe(0);
    expect(field(external.stdout, "STATUS")).toBe("OFFSITE_VERIFIED");
    expect(field(external.stdout, "BACKUP_DATE")).toBe(DAY);
    expect(field(external.stdout, "VPS_LOSS_VISIBILITY")).toBe("independent");
    expect(external.stdout).not.toContain("STATUS=MISSING_BACKUP");
  });

  it("treats a lock held within the time limit as running", () => {
    const dirs = freshDirs();
    holdLock(dirs.stateDir, 1763776801);
    const health = runOffsite("scripts/offsite-backup-health.sh", { ...dirs, epoch: "1763776801" });
    expect(health.status).toBe(0);
    expect(field(health.stdout, "STATUS")).toBe("RUNNING");
    expect(field(health.stdout, "REASON")).toBe("in-progress");
    expect(health.stdout).not.toContain("STATUS=OFFSITE_VERIFIED");
    expect(posixExists(`${dirs.stateDir}/offsite.lock.lockdir`)).toBe(true);
    expect(posixExists(`${dirs.stateDir}/offsite.lock`)).toBe(true);
  });

  it("rejects a lock held longer than the allowed duration", () => {
    const dirs = freshDirs();
    holdLock(dirs.stateDir, 1763776801 - 100000);
    const health = runOffsite("scripts/offsite-backup-health.sh", { ...dirs, epoch: "1763776801" });
    expect(health.status).toBe(35);
    expect(field(health.stdout, "STATUS")).toBe("FAILED");
    expect(field(health.stdout, "REASON")).toBe("run-exceeded");
    expect(health.stdout).not.toContain("STATUS=OFFSITE_VERIFIED");
    expect(health.stdout).not.toContain("STATUS=RUNNING");
    expect(posixExists(`${dirs.stateDir}/offsite.lock.lockdir`)).toBe(true);
    expect(posixExists(`${dirs.stateDir}/offsite.lock`)).toBe(true);
  });

  it("restores errexit after an allowed aws failure", () => {
    const dirs = freshDirs();
    const probe = `${dirs.stateDir}/errexit.sh`;
    writeFileSync(
      toWin(probe),
      [
        "set -eu",
        ". scripts/offsite-backup-lib.sh",
        "offsite_aws s3api head-object --bucket stell22-offsite-test --key missing/object --endpoint-url https://s3.ru-6.storage.selcloud.ru --region ru-6",
        "printf '%s\\n' \"AWS_RC=$AWS_RC\"",
        "false",
        "printf '%s\\n' STILL_RUNNING",
        "",
      ].join("\n"),
      "utf8",
    );
    const result = spawnSync("sh", ["-c", 'dash "$1"', "sh", probe], {
      cwd: repoRoot,
      encoding: "utf8",
      env: buildEnv(dirs),
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("AWS_RC=1");
    expect(result.stdout ?? "").not.toContain("STILL_RUNNING");
    expect(`${result.stdout ?? ""}\n${result.stderr ?? ""}`).not.toContain("STATUS=OFFSITE_VERIFIED");
  });

  it("reports today's failure instead of yesterday's verified copy", () => {
    const dirs = freshDirs();
    const yesterday = "2026-11-21";
    const created = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true });
    expect(created.status).toBe(0);
    relocateVerifiedDay(dirs.awsRoot, DAY, yesterday);
    const removed = runShell(
      'rm -rf "$1" && rm -f "$2/attempts/$3.env" "$4/$5" "$4/$5.sha256"',
      [
        objectPath(dirs.awsRoot, `${PREFIX}/daily/${DAY}`),
        dirs.stateDir,
        DAY,
        dirs.backupDir,
        ARCHIVE,
      ],
    );
    expect(removed.status).toBe(0);
    const failed = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      producerMode: "fail",
      clock: "0310",
      producerLog: `${dirs.stateDir}/producer-fail.log`,
      awsLog: `${dirs.stateDir}/aws-fail.log`,
    });
    expect(failed.status).toBe(14);
    expect(field(failed.stdout, "REASON")).toBe("producer-failure");
    const health = runOffsite("scripts/offsite-backup-health.sh", { ...dirs, clock: "0310" });
    expect(health.status).toBe(32);
    expect(field(health.stdout, "STATUS")).toBe("FAILED");
    expect(field(health.stdout, "REASON")).toBe("producer-failure");
    expect(field(health.stdout, "BACKUP_DATE")).toBe(DAY);
    expect(health.stdout).not.toContain("STATUS=OFFSITE_VERIFIED");
    expect(readPosix(objectPath(dirs.awsRoot, `${PREFIX}/daily/${yesterday}/SUCCESS`))).toContain(
      "status=OFFSITE_VERIFIED",
    );
    const retried = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      clock: "0310",
      producerLog: `${dirs.stateDir}/producer-retry.log`,
      awsLog: `${dirs.stateDir}/aws-retry.log`,
    });
    expect(retried.status).toBe(0);
    expect(field(retried.stdout, "STATUS")).toBe("OFFSITE_VERIFIED");
    const after = runOffsite("scripts/offsite-backup-health.sh", { ...dirs, clock: "0310" });
    expect(after.status).toBe(0);
    expect(field(after.stdout, "STATUS")).toBe("OFFSITE_VERIFIED");
    expect(field(after.stdout, "BACKUP_DATE")).toBe(DAY);
    expect(readPosix(objectPath(dirs.awsRoot, `${PREFIX}/daily/${yesterday}/SUCCESS`))).toContain(
      "status=OFFSITE_VERIFIED",
    );
    expectLegacy(dirs.backupDir);
  });

  it("retries encryption after a partial age output without publishing it", () => {
    const dirs = freshDirs();
    const legacy = readPosix(`${dirs.backupDir}/stell22_2099-01-01_00-00-00.sql.gz`);
    const failed = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, ageMode: "partial" });
    expect(failed.status).toBe(17);
    expect(field(failed.stdout, "REASON")).toBe("encryption-failure");
    expect(failed.awsLog).not.toContain("put-object");
    expect(posixExists(`${dirs.stateDir}/work/${DAY}/archive.age`)).toBe(false);
    const leftovers = runShell(
      'find "$1" -type f \\( -name archive.age -o -name "cipher.*" \\)',
      [`${dirs.stateDir}/work`],
    );
    expect(leftovers.stdout.trim()).toBe("");
    expect(readPosix(`${dirs.backupDir}/stell22_2099-01-01_00-00-00.sql.gz`)).toBe(legacy);
    const localArchive = readPosix(`${dirs.backupDir}/${ARCHIVE}`);
    const retried = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      producerLog: `${dirs.stateDir}/producer-retry.log`,
      awsLog: `${dirs.stateDir}/aws-retry.log`,
    });
    expect(retried.status).toBe(0);
    expect(field(retried.stdout, "STATUS")).toBe("OFFSITE_VERIFIED");
    expect(retried.producerLog).toBe("");
    expect(retried.awsLog).toContain("put-object");
    expect(readPosix(`${dirs.backupDir}/${ARCHIVE}`)).toBe(localArchive);
    expect(readPosix(`${dirs.backupDir}/stell22_2099-01-01_00-00-00.sql.gz`)).toBe(legacy);
    const remote = readPosix(objectPath(dirs.awsRoot, dayKey("archive.age")));
    const again = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      producerLog: `${dirs.stateDir}/producer-again.log`,
      awsLog: `${dirs.stateDir}/aws-again.log`,
    });
    expect(again.status).toBe(0);
    expect(field(again.stdout, "ALREADY")).toBe("1");
    expect(again.awsLog).not.toContain("put-object");
    expect(readPosix(objectPath(dirs.awsRoot, dayKey("archive.age")))).toBe(remote);
  });

  it("keeps the lock owner's start time when a contender is refused", async () => {
    const dirs = freshDirs();
    const holder = spawn("sh", ["scripts/offsite-backup.sh"], {
      cwd: repoRoot,
      env: buildEnv({
        ...dirs,
        hooks: true,
        producerMode: "sleep",
        sleepSeconds: "20",
        epoch: "1000",
      }),
    });
    const finished = new Promise<number>((resolve) => {
      holder.on("exit", (code) => resolve(code ?? 1));
    });
    const started = `${dirs.stateDir}/offsite-run.started`;
    try {
      let seen = false;
      for (let i = 0; i < 50; i += 1) {
        if (posixExists(started) && readPosix(started).trim() === "1000") {
          seen = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(seen).toBe(true);
      const contender = runOffsite("scripts/offsite-backup.sh", {
        ...dirs,
        hooks: true,
        epoch: "200000",
        producerLog: `${dirs.stateDir}/producer-contender.log`,
        awsLog: `${dirs.stateDir}/aws-contender.log`,
      });
      expect(contender.status).toBe(13);
      expect(field(contender.stdout, "REASON")).toBe("concurrent");
      expect(contender.producerLog).toBe("");
      expect(readPosix(started).trim()).toBe("1000");
      expect(holder.exitCode).toBeNull();
      const health = runOffsite("scripts/offsite-backup-health.sh", { ...dirs, epoch: "200000" });
      expect(health.status).toBe(35);
      expect(field(health.stdout, "STATUS")).toBe("FAILED");
      expect(field(health.stdout, "REASON")).toBe("run-exceeded");
      expect(health.stdout).not.toContain("STATUS=OFFSITE_VERIFIED");
      expect(health.stdout).not.toContain("STATUS=RUNNING");
      expect(readPosix(started).trim()).toBe("1000");
      expect(holder.exitCode).toBeNull();
      expect(posixExists(`${dirs.stateDir}/offsite.lock.lockdir`)).toBe(true);
    } finally {
      if (holder.exitCode === null) {
        holder.kill();
      }
      await finished;
    }
  });

  it("refuses an endpoint that is not Selectel ru-6", () => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      endpoint: "https://storage.yandexcloud.net",
    });
    expect(result.status).toBe(10);
    expect(field(result.stdout, "STATUS")).toBe("FAILED");
    expect(field(result.stdout, "REASON")).toBe("configuration");
    expect(field(result.stdout, "RESTORE_VERIFIED")).toBe("0");
    expect(result.stdout).not.toContain("STATUS=OFFSITE_VERIFIED");
    expect(result.awsLog).not.toContain("put-object");
    expect(result.awsLog).not.toContain("get-bucket-versioning");
    expectLegacy(dirs.backupDir);
  });

  it.each(["us-east-1", "eu-central-1", "ru-central1", "ru-1", "ru-7"])(
    "refuses region %s",
    (region) => {
      const dirs = freshDirs();
      const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, region });
      expect(result.status).toBe(10);
      expect(field(result.stdout, "REASON")).toBe("configuration");
      expect(result.stdout).not.toContain("STATUS=OFFSITE_VERIFIED");
      expect(result.awsLog).not.toContain("put-object");
      expectLegacy(dirs.backupDir);
    },
  );

  it.each([
    "no-versioning",
    "versioning-missing",
    "versioning-error",
    "no-lock",
    "lock-error",
    "governance",
    "short-retention",
    "no-retention",
    "lifecycle-delete",
    "lifecycle-error",
  ])("refuses bucket protection mode %s before upload", (lockMode) => {
    const dirs = freshDirs();
    const result = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true, lockMode });
    expect(result.status).toBe(10);
    expect(field(result.stdout, "STATUS")).toBe("FAILED");
    expect(field(result.stdout, "REASON")).toBe("bucket-protection");
    expect(field(result.stdout, "RESTORE_VERIFIED")).toBe("0");
    expect(result.stdout).not.toContain("STATUS=OFFSITE_VERIFIED");
    expect(result.awsLog).not.toContain("put-object");
    expect(result.awsLog).not.toContain("delete-object");
    expect(posixExists(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toBe(false);
    expectLegacy(dirs.backupDir);
  });

  it("retries a matching object without overwrite or deletion", () => {
    const dirs = freshDirs();
    const first = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      awsFail: "marker-put",
    });
    expect(first.status).toBe(23);
    const cipher = readPosix(objectPath(dirs.awsRoot, dayKey("archive.age")));
    const second = runOffsite("scripts/offsite-backup.sh", {
      ...dirs,
      hooks: true,
      awsLog: `${dirs.stateDir}/aws-retry.log`,
      producerLog: `${dirs.stateDir}/producer-retry.log`,
    });
    expect(second.status).toBe(0);
    expect(field(second.stdout, "STATUS")).toBe("OFFSITE_VERIFIED");
    expect(second.awsLog).toContain("--if-none-match *");
    expect(second.awsLog).not.toContain("delete-object");
    expect(readPosix(objectPath(dirs.awsRoot, dayKey("archive.age")))).toBe(cipher);
    expect(readPosix(objectPath(dirs.awsRoot, dayKey("SUCCESS")))).toContain("status=OFFSITE_VERIFIED");
  });

  it("copies a verified day onto an independent directory and refuses overwrite", () => {
    const dirs = freshDirs();
    const created = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true });
    expect(created.status).toBe(0);
    const ssd = makePosixTemp(testTemps);
    const copied = runOffsite("scripts/offsite-ssd-export.sh", {
      ...dirs,
      ssdDates: DAY,
      ssdRoot: ssd,
      awsLog: `${dirs.stateDir}/aws-ssd.log`,
    });
    expect(copied.status).toBe(0);
    expect(field(copied.stdout, "STATUS")).toBe("SSD_COPIED");
    expect(field(copied.stdout, "RESTORE_VERIFIED")).toBe("0");
    expect(copied.stdout).not.toContain("STATUS=OFFSITE_VERIFIED");
    const remoteCipher = readPosix(objectPath(dirs.awsRoot, dayKey("archive.age")));
    expect(readPosix(`${ssd}/daily/${DAY}/archive.age`)).toBe(remoteCipher);
    expect(readPosix(`${ssd}/daily/${DAY}/manifest.json`)).toBe(
      readPosix(objectPath(dirs.awsRoot, dayKey("manifest.json"))),
    );
    expect(readPosix(`${ssd}/daily/${DAY}/SUCCESS`)).toContain("status=OFFSITE_VERIFIED");
    expect(copied.awsLog).not.toContain("put-object");
    expect(copied.awsLog).not.toContain("delete-object");
    expect(copied.combined).not.toContain(PRIVATE_KEY);

    const again = runOffsite("scripts/offsite-ssd-export.sh", {
      ...dirs,
      ssdDates: DAY,
      ssdRoot: ssd,
      awsLog: `${dirs.stateDir}/aws-ssd-again.log`,
    });
    expect(again.status).toBe(0);
    expect(readPosix(`${ssd}/daily/${DAY}/archive.age`)).toBe(remoteCipher);

    runShell('printf %s different > "$1"', [`${ssd}/daily/${DAY}/archive.age`]);
    const refused = runOffsite("scripts/offsite-ssd-export.sh", {
      ...dirs,
      ssdDates: DAY,
      ssdRoot: ssd,
      awsLog: `${dirs.stateDir}/aws-ssd-refuse.log`,
    });
    expect(refused.status).not.toBe(0);
    expect(field(refused.stdout, "REASON")).toBe("destination-mismatch");
    expect(readPosix(`${ssd}/daily/${DAY}/archive.age`)).toBe("different");
    expect(refused.awsLog).not.toContain("delete-object");
  });

  it("fails the SSD set when a selected date has no success marker", () => {
    const dirs = freshDirs();
    const created = runOffsite("scripts/offsite-backup.sh", { ...dirs, hooks: true });
    expect(created.status).toBe(0);
    const ssd = makePosixTemp(testTemps);
    const result = runOffsite("scripts/offsite-ssd-export.sh", {
      ...dirs,
      ssdDates: `${DAY} 2026-11-21`,
      ssdRoot: ssd,
      awsLog: `${dirs.stateDir}/aws-ssd-gap.log`,
    });
    expect(result.status).not.toBe(0);
    expect(field(result.stdout, "REASON")).toBe("incomplete-set");
    expect(result.stdout).not.toContain("STATUS=SSD_COPIED");
    expect(posixExists(`${ssd}/daily/2026-11-21/SUCCESS`)).toBe(false);
    expect(result.awsLog).not.toContain("delete-object");
  });

  it("refuses to export when a private age key is present", () => {
    const dirs = freshDirs();
    const ssd = makePosixTemp(testTemps);
    const result = runOffsite("scripts/offsite-ssd-export.sh", {
      ...dirs,
      ssdDates: DAY,
      ssdRoot: ssd,
      privateKey: true,
    });
    expect(result.status).toBe(10);
    expect(field(result.stdout, "REASON")).toBe("private-key-refused");
    expect(result.combined).not.toContain(PRIVATE_KEY);
    expect(result.awsLog).not.toContain("get-object");
    expect(posixExists(`${ssd}/daily/${DAY}/archive.age`)).toBe(false);
  });
});
