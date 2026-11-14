import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts", "beget-production-recovery.sh");
const scriptSource = readFileSync(scriptPath, "utf8");
const productionBackupSha =
  scriptSource.match(/^BACKUP_SHA=([0-9a-f]{64})$/m)?.[1] ?? "";
const APP_PW = "SyntheticAppPassword0000000001";
const MIG_PW = "SyntheticMigratorPassword00002";
const DB_PW = "SyntheticPostgresPassword00003";
const SENTINEL = "DO_NOT_PRINT_SYNTHETIC_SECRET";

const temps: string[] = [];

function runShell(
  command: string,
  args: readonly string[] = [],
  env?: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  return spawnSync("sh", ["-c", command, "sh", ...args], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function makePosixTemp(): string {
  const created = runShell("mktemp -d /tmp/stell22-beget-recovery.XXXXXX");
  if (created.status !== 0) throw new Error(created.stderr || "mktemp failed");
  const posix = created.stdout.trim();
  if (!posix.startsWith("/tmp/stell22-beget-recovery.")) throw new Error(`unexpected temp ${posix}`);
  temps.push(posix);
  return posix;
}

function toWin(posix: string): string {
  if (process.platform !== "win32") return posix;
  const win = spawnSync("cygpath", ["-w", posix], { encoding: "utf8" });
  if (win.status !== 0 || !win.stdout.trim()) throw new Error(win.stderr || "cygpath failed");
  return win.stdout.trim();
}

function writeExec(posixDir: string, name: string, lines: readonly string[]): void {
  writeFileSync(path.join(toWin(posixDir), name), ["#!/bin/sh", ...lines, ""].join("\n"), "utf8");
  const chmod = runShell('chmod 755 "$1"', [`${posixDir}/${name}`]);
  if (chmod.status !== 0) throw new Error(chmod.stderr || "chmod failed");
}

function writeText(posixPath: string, text: string): void {
  writeFileSync(toWin(posixPath), text.replace(/\r\n/g, "\n"), "utf8");
}

function field(text: string, key: string): string {
  const match = text.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match?.[1] ?? "";
}

function resultOf(result: SpawnSyncReturns<string>): string {
  return field(`${result.stdout ?? ""}\n${result.stderr ?? ""}`, "RESULT");
}

function sha256Text(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function gitIdentity(project: string): { sha: string; tree: string } {
  const sha = runShell('git -C "$1" rev-parse HEAD', [project]);
  const tree = runShell('git -C "$1" rev-parse "HEAD^{tree}"', [project]);
  if (sha.status !== 0 || tree.status !== 0) throw new Error(sha.stderr || tree.stderr || "git rev-parse failed");
  return { sha: sha.stdout.trim(), tree: tree.stdout.trim() };
}

function makeProject(): string {
  const dir = makePosixTemp();
  writeText(`${dir}/README`, "synthetic recovery project\n");
  const init = runShell(
    'git -C "$1" init -q && git -C "$1" add README && git -C "$1" -c user.email=stell22-test@example.com -c user.name=stell22-test commit -q -m init',
    [dir],
  );
  if (init.status !== 0) throw new Error(init.stderr || init.stdout || "git init failed");
  return dir;
}

function packArchive(sql: string): { file: string; sha: string; dir: string } {
  const dir = makePosixTemp();
  writeText(`${dir}/plain.sql`, sql);
  const packed = runShell(
    'gzip -c "$1/plain.sql" > "$1/synthetic.sql.gz" && sha256sum -t "$1/synthetic.sql.gz"',
    [dir],
  );
  if (packed.status !== 0) throw new Error(packed.stderr || "gzip failed");
  const sha = packed.stdout.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`bad archive sha ${sha}`);
  return { file: `${dir}/synthetic.sql.gz`, sha, dir };
}

function fingerprints(column: string, constraint: string): { column: string; constraint: string } {
  const dir = makePosixTemp();
  writeText(`${dir}/column.tsv`, column);
  writeText(`${dir}/constraint.tsv`, constraint);
  const run = runShell(
    'mark=$(printf "\\036"); { cat "$1/column.tsv"; printf "%s" "$mark"; cat "$1/constraint.tsv"; } | node "$2" --stdin',
    [dir, path.join(repoRoot, "scripts", "production-backup-restore-fingerprint.mjs").replace(/\\/g, "/")],
  );
  if (run.status !== 0) throw new Error(run.stderr || "fingerprint helper failed");
  return {
    column: field(run.stdout, "column_fingerprint"),
    constraint: field(run.stdout, "constraint_fingerprint"),
  };
}

function writeDocker(bin: string, root: string): void {
  writeExec(bin, "docker", [
    `root=${root}`,
    'printf "%s\\n" "$*" >> "$root/docker.log"',
    'cmd=$1',
    "shift",
    'case "$cmd" in',
    "  version) exit 0 ;;",
    "  pull) exit 0 ;;",
    "  image)",
    "    sub=$1; shift",
    '    [ "$sub" = inspect ] || exit 1',
    "    fmt=",
    '    while [ $# -gt 0 ]; do',
    '      case "$1" in',
    "        --format) fmt=$2; shift 2 ;;",
    "        *) shift ;;",
    "      esac",
    "    done",
    '    case "$fmt" in',
    '      "{{.Architecture}}") cat "$root/arch" ;;',
    '      "{{.Os}}") printf "%s\\n" linux ;;',
    '      "{{range .Config.Env}}{{println .}}{{end}}") printf "%s\\n" "PG_MAJOR=$(cat "$root/pgmajor")" "PG_VERSION=17.12" ;;',
    "      *) exit 1 ;;",
    "    esac ;;",
    "  run)",
    '    text="$*"',
    '    case "$text" in',
    '      *"--version"*) cat "$root/pgversion" ;;',
    "      *) printf '%s\\n' deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef ;;",
    "    esac ;;",
    "  ps)",
    '    if [ -f "$root/containers" ]; then cat "$root/containers"; fi ;;',
    "  volume)",
    "    sub=$1; shift",
    '    case "$sub" in',
    '      ls) if [ -f "$root/volumes" ]; then cat "$root/volumes"; fi ;;',
    '      create) printf "%s\\n" "$1" >> "$root/created-volumes"; printf "%s\\n" "$1" ;;',
    "      *) exit 1 ;;",
    "    esac ;;",
    "  network)",
    "    sub=$1; shift",
    '    case "$sub" in',
    '      ls) if [ -f "$root/networks" ]; then cat "$root/networks"; fi ;;',
    "      create) printf '%s\\n' harnessnet ;;",
    "      *) exit 1 ;;",
    "    esac ;;",
    "  inspect)",
    '    printf "%s\\n" "{}" ;;',
    "  exec)",
    '    all="$*"',
    "    sql=",
    "    stdin=0",
    '    case "$all" in',
    "      *pg_isready*) exit 0 ;;",
    "    esac",
    '    while [ $# -gt 0 ]; do',
    '      case "$1" in',
    "        -c) sql=$2; shift 2 ;;",
    "        -f) stdin=1; shift 2 ;;",
    "        *) shift ;;",
    "      esac",
    "    done",
    '    if [ "$stdin" = 1 ]; then',
    '      cat > "$root/last-stdin.sql"',
    '      sql=$(cat "$root/last-stdin.sql")',
    "    fi",
    '    printf "%s\\n" "$sql" >> "$root/sql.log"',
    '    case "$sql" in',
    '      *pg_attribute*) cat "$root/column.tsv" ;;',
    '      *pg_get_constraintdef*) cat "$root/constraint.tsv" ;;',
    '      *"CREATE ROLE"*) touch "$root/roles-created"; exit 0 ;;',
    '      *"ALTER ROLE"*)',
    '        touch "$root/passwords-set"; exit 0 ;;',
    '      *"PostgreSQL database dump"*|*"SELECT 1;"*)',
    '        if [ -f "$root/fail-restore" ]; then exit 1; fi',
    '        touch "$root/restored"; exit 0 ;;',
    '      *writer_exclusion_probe*)',
    '        if [ -f "$root/app-can-ddl" ]; then exit 0; fi',
    '        printf "%s\\n" "ERROR:  permission denied (SQLSTATE 42501)" >&2',
    "        exit 1 ;;",
    '      *TRUNCATE*)',
    '        if [ -f "$root/bad-history" ]; then printf "%s\\n" no; else printf "%s\\n" yes; fi ;;',
    '      *has_schema_privilege*)',
    '        if [ -f "$root/bad-privilege" ]; then printf "%s\\n" no; else printf "%s\\n" yes; fi ;;',
    "      *has_table_privilege*) printf '%s\\n' 0 ;;",
    '      *pg_authid*)',
    '        if [ -f "$root/passwords-set" ]; then',
    "          printf '%s\\n' 'stell22_app|0000100|pw' 'stell22_migrator|0000100|pw'",
    "        else",
    "          printf '%s\\n' 'stell22_app|0000000|nopw' 'stell22_migrator|0000000|nopw'",
    "        fi ;;",
    '      *rolcanlogin*)',
    '        if [ -f "$root/stuck-roles" ]; then printf "%s\\n" 0; exit 0; fi',
    '        if [ -f "$root/roles-created" ]; then printf "%s\\n" 2; else printf "%s\\n" 0; fi ;;',
    "      *pg_auth_members*) printf '%s\\n' 0 ;;",
    "      *\"<> 'stell22_migrator'\"*) printf '%s\\n' 0 ;;",
    "      *\"r.rolname = 'stell22_migrator'\"*) cat \"$root/tables\" ;;",
    "      *\"r.rolname = 'stell22_app'\"*) printf '%s\\n' 0 ;;",
    '      *relkind*)',
    '        if [ -f "$root/restored" ]; then cat "$root/tables"; else printf "%s\\n" 0; fi ;;',
    '      *pg_constraint*) cat "$root/constraints" ;;',
    '      *"rolled_back_at IS NOT NULL"*) cat "$root/incomplete" ;;',
    '      *"20261105120000_statement_period_coverage"*) printf "%s\\n" 0 ;;',
    '      *"20261010210000_psr_p3_s2_b_batch_receipt_provenance"*) printf "%s\\n" 1 ;;',
    '      *"ORDER BY migration_name"*) cat "$root/names" ;;',
    "      *_prisma_migrations*) cat \"$root/migrations\" ;;",
    '      *query_to_xml*) cat "$root/rows" ;;',
    '      *datdba*) printf "%s\\n" stell22 ;;',
    '      *nspowner*) printf "%s\\n" stell22 ;;',
    '      *pg_auth_members*) printf "%s\\n" 0 ;;',
    "      *) exit 1 ;;",
    "    esac ;;",
    "  *) exit 1 ;;",
    "esac",
  ]);
}

type Ready = {
  project: string;
  sha: string;
  tree: string;
  backup: string;
  backupSha: string;
  state: string;
  bin: string;
  root: string;
  columnFp: string;
  constraintFp: string;
  migrationSha: string;
};

function readyFixture(options?: { sql?: string; failRestore?: boolean }): Ready {
  const project = makeProject();
  const identity = gitIdentity(project);
  const packed = packArchive(options?.sql ?? "-- PostgreSQL database dump\nSELECT 1;\n");
  const column = "public\u001fItem\u001fid\u001finteger\u001fNO\u001f0\u001f\u001f0\u001f\u001f0\u001f\u001f0\u001f\n";
  const prints = fingerprints(column, "");
  const names = "20260629154204_init\n";
  const state = makePosixTemp();
  const bin = makePosixTemp();
  const root = makePosixTemp();
  writeText(`${root}/arch`, "amd64\n");
  writeText(`${root}/pgmajor`, "17\n");
  writeText(`${root}/pgversion`, "postgres (PostgreSQL) 17.12\n");
  writeText(`${root}/column.tsv`, column);
  writeText(`${root}/constraint.tsv`, "");
  writeText(`${root}/tables`, "1\n");
  writeText(`${root}/constraints`, "1\n");
  writeText(`${root}/migrations`, "1\n");
  writeText(`${root}/incomplete`, "0\n");
  writeText(`${root}/rows`, "1\n");
  writeText(`${root}/names`, names);
  writeText(`${root}/docker.log`, "");
  writeText(`${root}/sql.log`, "");
  if (options?.failRestore) writeText(`${root}/fail-restore`, "1\n");
  writeDocker(bin, root);
  return {
    project,
    sha: identity.sha,
    tree: identity.tree,
    backup: packed.file,
    backupSha: packed.sha,
    state,
    bin,
    root,
    columnFp: prints.column,
    constraintFp: prints.constraint,
    migrationSha: sha256Text(names),
  };
}

function harnessEnv(ready: Ready, over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${ready.bin}:${process.env.PATH ?? ""}`,
    STELL22_BEGET_RECOVERY_EXECUTE: "1",
    STELL22_BEGET_RECOVERY_AUTHORIZATION: "OWNER_AUTHORIZES_BEGET_RECOVERY_HARNESS",
    STELL22_BEGET_RECOVERY_HARNESS: "1",
    STELL22_BEGET_RECOVERY_EMPTY_DESTINATION: "CONFIRMED",
    STELL22_BEGET_RECOVERY_SHA: ready.sha,
    STELL22_BEGET_RECOVERY_TREE: ready.tree,
    STELL22_BEGET_RECOVERY_PROJECT: ready.project,
    STELL22_BEGET_RECOVERY_BACKUP: ready.backup,
    STELL22_BEGET_RECOVERY_BACKUP_SHA: ready.backupSha,
    STELL22_BEGET_RECOVERY_STATE: ready.state,
    STELL22_BEGET_RECOVERY_VOLUME: "stell22-beget-harness-volume",
    STELL22_BEGET_RECOVERY_CONTAINER: "stell22-beget-harness-db",
    STELL22_BEGET_RECOVERY_NETWORK: "stell22-beget-harness-net",
    STELL22_BEGET_RECOVERY_POSTGRES_PASSWORD: DB_PW,
    STELL22_BEGET_RECOVERY_APP_PASSWORD: APP_PW,
    STELL22_BEGET_RECOVERY_MIGRATOR_PASSWORD: MIG_PW,
    STELL22_BEGET_RECOVERY_EXPECT_TABLES: "1",
    STELL22_BEGET_RECOVERY_EXPECT_CONSTRAINTS: "1",
    STELL22_BEGET_RECOVERY_EXPECT_MIGRATIONS: "1",
    STELL22_BEGET_RECOVERY_EXPECT_ROWS: "1",
    STELL22_BEGET_RECOVERY_EXPECT_MIGRATION_SHA: ready.migrationSha,
    STELL22_BEGET_RECOVERY_EXPECT_COLUMN_FP: ready.columnFp,
    STELL22_BEGET_RECOVERY_EXPECT_CONSTRAINT_FP: ready.constraintFp,
    ...over,
  };
}

function invoke(env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync("sh", [scriptPath], { encoding: "utf8", env });
}

afterAll(() => {
  for (const dir of temps) {
    runShell('case "$1" in /tmp/stell22-beget-recovery.*) rm -rf "$1" ;; esac', [dir]);
  }
});

describe("beget production recovery operator", { timeout: 20000 }, () => {
  it("parses as POSIX sh and does not call disabled or disposable executors", () => {
    const syntax = runShell('sh -n "$1"', [scriptPath]);
    expect(syntax.status).toBe(0);
    const calls = runShell(
      'awk \'BEGIN { c = 0 } /^[[:space:]]*#/ { next } { if (index($0, "restore-db.sh") || index($0, "production-backup-restore.sh") || index($0, "db-role-bootstrap.sh") || index($0, "statement-period-release.sh") || index($0, "migrate deploy") || index($0, "volume rm") || index($0, "docker rm")) c++ } END { print c }\' "$1"',
      [scriptPath],
    );
    expect(calls.stdout.trim()).toBe("0");
    expect(readFileSync(path.join(repoRoot, "scripts", "restore-db.sh"), "utf8")).toMatch(
      /production restore не разрешён/,
    );
  });

  it("refuses when authorization is absent", () => {
    const result = invoke({ ...process.env });
    expect(result.status).not.toBe(0);
    expect(resultOf(result)).toBe("REFUSED_AUTHORIZATION");
    expect(`${result.stdout}${result.stderr}`).not.toContain(APP_PW);
  });

  it("refuses a wrong authorization phrase", () => {
    const result = invoke({
      ...process.env,
      STELL22_BEGET_RECOVERY_EXECUTE: "1",
      STELL22_BEGET_RECOVERY_AUTHORIZATION: "OWNER_AUTHORIZES_SOMETHING_ELSE",
    });
    expect(resultOf(result)).toBe("REFUSED_AUTHORIZATION");
  });

  it("refuses the production phrase on a host that is not the accepted VPS", () => {
    const result = invoke({
      ...process.env,
      STELL22_BEGET_RECOVERY_EXECUTE: "1",
      STELL22_BEGET_RECOVERY_AUTHORIZATION: "OWNER_AUTHORIZES_BEGET_INITIAL_RECOVERY_20261028",
    });
    expect(result.status).not.toBe(0);
    expect(resultOf(result)).toBe("REFUSED_HOST");
    expect(result.stdout).toContain("APPLICATION_STARTED=NO");
  });

  it("refuses a checkout SHA that is not the supplied SHA", () => {
    const ready = readyFixture();
    const result = invoke(harnessEnv(ready, { STELL22_BEGET_RECOVERY_SHA: "a".repeat(40) }));
    expect(resultOf(result)).toBe("REFUSED_SHA");
    expect(readFileSync(toWin(`${ready.root}/docker.log`), "utf8")).toBe("");
  });

  it("refuses a backup whose SHA256 is not the approved digest", () => {
    const ready = readyFixture();
    const result = invoke(
      harnessEnv(ready, { STELL22_BEGET_RECOVERY_BACKUP_SHA: "b".repeat(64) }),
    );
    expect(resultOf(result)).toBe("REFUSED_CHECKSUM");
  });

  it("refuses the production archive digest in the harness", () => {
    expect(productionBackupSha).toMatch(/^[0-9a-f]{64}$/);
    const ready = readyFixture();
    const result = invoke(
      harnessEnv(ready, { STELL22_BEGET_RECOVERY_BACKUP_SHA: productionBackupSha }),
    );
    expect(resultOf(result)).toBe("REFUSED_ARCHIVE");
  });

  it("refuses a corrupted gzip payload", () => {
    const ready = readyFixture();
    writeText(ready.backup, "this is not a gzip payload\n");
    const sha = sha256Text("this is not a gzip payload\n");
    const result = invoke(harnessEnv(ready, { STELL22_BEGET_RECOVERY_BACKUP_SHA: sha }));
    expect(resultOf(result)).toBe("REFUSED_GZIP");
  });

  it("refuses an existing production volume without deleting it", () => {
    const ready = readyFixture();
    writeText(`${ready.root}/volumes`, "stell22_db-data\n");
    const result = invoke(harnessEnv(ready));
    expect(resultOf(result)).toBe("REFUSED_EXISTING");
    expect(readFileSync(toWin(`${ready.root}/docker.log`), "utf8")).not.toContain("volume create");
  });

  it("refuses a PostgreSQL image that is not major 17 on amd64", () => {
    const ready = readyFixture();
    writeText(`${ready.root}/pgmajor`, "16\n");
    writeText(`${ready.root}/pgversion`, "postgres (PostgreSQL) 16.9\n");
    const result = invoke(harnessEnv(ready));
    expect(resultOf(result)).toBe("REFUSED_POSTGRES_IDENTITY");
    expect(readFileSync(toWin(`${ready.root}/docker.log`), "utf8")).not.toContain("volume create");
  });

  it("stops on a psql restore error and does not retry or delete the database", () => {
    const ready = readyFixture({ failRestore: true });
    const first = invoke(harnessEnv(ready));
    expect(resultOf(first)).toBe("FAILED_RESTORE_SQL");
    expect(first.stdout).toContain("CLEANUP=NO");
    expect(first.stdout).toContain("RETRY=NO");
    const created = readFileSync(toWin(`${ready.root}/sql.log`), "utf8");
    expect(created).toContain("SELECT 1;");
    const second = invoke(harnessEnv(ready));
    expect(resultOf(second)).toBe("REFUSED_PARTIAL");
    const sqlAfter = readFileSync(toWin(`${ready.root}/sql.log`), "utf8");
    expect(sqlAfter.split("SELECT 1;").length - 1).toBe(1);
    expect(readFileSync(toWin(`${ready.root}/docker.log`), "utf8")).not.toContain("volume rm");
  });

  it("stops when migration history is incomplete and does not set role passwords", () => {
    const ready = readyFixture();
    writeText(`${ready.root}/incomplete`, "1\n");
    const result = invoke(harnessEnv(ready));
    expect(resultOf(result)).toBe("INSPECT_MISMATCH");
    expect(readFileSync(toWin(`${ready.root}/sql.log`), "utf8")).not.toContain("ALTER ROLE");
    expect(result.stdout).toContain("MIGRATION_47_48=NOT_APPLIED");
  });

  it("stops when the column fingerprint does not match", () => {
    const ready = readyFixture();
    const result = invoke(
      harnessEnv(ready, { STELL22_BEGET_RECOVERY_EXPECT_COLUMN_FP: "c".repeat(64) }),
    );
    expect(resultOf(result)).toBe("INSPECT_MISMATCH");
    expect(readFileSync(toWin(`${ready.root}/sql.log`), "utf8")).not.toContain("ALTER ROLE");
  });

  it("stops when the restore roles are missing", () => {
    const ready = readyFixture();
    writeText(`${ready.root}/stuck-roles`, "1\n");
    const result = invoke(harnessEnv(ready));
    expect(resultOf(result)).toBe("REFUSED_ROLE");
  });

  it("stops when the app role can change migration history", () => {
    const ready = readyFixture();
    writeText(`${ready.root}/app-can-ddl`, "1\n");
    const result = invoke(harnessEnv(ready));
    expect(resultOf(result)).toBe("REFUSED_APP_DDL");
    expect(result.stdout).toContain("APPLICATION_STARTED=NO");
    expect(result.stdout).toContain("CADDY_STARTED=NO");
  });

  it("leaves PostgreSQL ready and does not start the application", () => {
    const ready = readyFixture();
    const result = invoke(harnessEnv(ready));
    expect(result.status).toBe(0);
    expect(resultOf(result)).toBe("RECOVERY_READY");
    expect(result.stdout).toContain("APPLICATION_STARTED=NO");
    expect(result.stdout).toContain("CADDY_STARTED=NO");
    expect(result.stdout).toContain("MIGRATION_47_48=NOT_APPLIED");
    expect(result.stdout).toContain("DNS_CHANGED=NO");
    const log = readFileSync(toWin(`${ready.root}/docker.log`), "utf8");
    expect(log).not.toContain("stell22-app");
    expect(log).not.toContain("stell22-caddy");
    expect(log).not.toContain("migrate deploy");
    expect(log).not.toContain("prisma migrate");
    expect(log).not.toContain(" -p ");
    expect(log).not.toContain("--publish");
    expect(`${result.stdout}${result.stderr}`).not.toContain(DB_PW);
    expect(`${result.stdout}${result.stderr}`).not.toContain(APP_PW);
    expect(`${result.stdout}${result.stderr}`).not.toContain(MIG_PW);
    expect(`${result.stdout}${result.stderr}`).not.toContain(SENTINEL);
  });
});
