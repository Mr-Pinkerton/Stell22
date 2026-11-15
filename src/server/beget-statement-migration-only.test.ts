import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATION_NAME, MIGRATION_SHA256, readMigrationInventory } from "./internal/statement-period-release/decide.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scriptPath = path.join(repoRoot, "scripts", "beget-statement-migration-only.sh");
const scriptSource = readFileSync(scriptPath, "utf8");
const PASSWORD = "SyntheticMigratorPassword00002";
const IMAGE = "postgres:17-alpine";
const IMAGE_ID = `sha256:${"c".repeat(64)}`;
const DATABASE = "p1disp_statement_migration";
const PROJECT = "p1disp_statement_migration";
const VOLUME = "p1disp_statement_migration_data";
const CONTAINER = "p1disp_statement_migration_db";
const NETWORK = "p1disp_statement_migration_net";
const PRODUCTION_IMAGE = "postgres@sha256:005c5c37db96c1e6652a79ea31f9886402fba81ac95dc2db897739121dd7f8f2";

const temps: string[] = [];

function runShell(command: string, args: readonly string[] = []): SpawnSyncReturns<string> {
  return spawnSync("sh", ["-c", command, "sh", ...args], { encoding: "utf8" });
}

function makePosixTemp(): string {
  const created = runShell("mktemp -d /tmp/stell22-migration-only.XXXXXX");
  if (created.status !== 0) throw new Error(created.stderr || "mktemp failed");
  const posix = created.stdout.trim();
  if (!posix.startsWith("/tmp/stell22-migration-only.")) throw new Error(`unexpected temp ${posix}`);
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

function historyLine(row: { name: string; sha256: string }, finished = "t"): string {
  return `${row.name}|${row.sha256}|${finished}|f|1`;
}

function gitIdentity(project: string): { sha: string; tree: string } {
  const sha = runShell('git -C "$1" rev-parse HEAD', [project]);
  const tree = runShell('git -C "$1" rev-parse "HEAD^{tree}"', [project]);
  if (sha.status !== 0 || tree.status !== 0) throw new Error(sha.stderr || tree.stderr || "git rev-parse failed");
  return { sha: sha.stdout.trim(), tree: tree.stdout.trim() };
}

type Ready = {
  project: string;
  sha: string;
  tree: string;
  state: string;
  root: string;
  bin: string;
  recovery: string;
  attempt: string;
  credentials: string;
  recoveryText: string;
};

function writeDocker(bin: string, root: string): void {
  writeExec(bin, "ps", [`cat "${root}/ps.txt"`]);
  writeExec(bin, "docker", [
    `root=${root}`,
    'printf "%s\\n" "$*" >> "$root/docker.log"',
    "cmd=$1",
    "shift",
    'case "$cmd" in',
    "  version) exit 0 ;;",
    "  build) exit 0 ;;",
    "  ps)",
    '    if [ -f "$root/containers" ]; then cat "$root/containers"; fi ;;',
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
    '      "{{.Id}}") cat "$root/image-id" ;;',
    "      *Entrypoint*) printf '%s\\n' '[\"node\"]' ;;",
    "      *'.Config.Cmd'*) printf '%s\\n' '[\"node\"]' ;;",
    "      *) exit 1 ;;",
    "    esac ;;",
    "  inspect)",
    "    fmt=",
    '    while [ $# -gt 0 ]; do',
    '      case "$1" in',
    "        --format) fmt=$2; shift 2 ;;",
    "        *) shift ;;",
    "      esac",
    "    done",
    '    case "$fmt" in',
    "      '{{.State.Running}}')",
    '        if [ -f "$root/stopped" ]; then printf "%s\\n" false; else printf "%s\\n" true; fi ;;',
    "      *'.State.Health'*)",
    '        if [ -f "$root/unhealthy" ]; then printf "%s\\n" unhealthy; else printf "%s\\n" healthy; fi ;;',
    '      *compose.project*) cat "$root/project" ;;',
    "      *compose.service*) printf '%s\\n' db ;;",
    "      *compose.oneoff*) printf '%s\\n' False ;;",
    "      *'.Config.Image'*) cat \"$root/image\" ;;",
    "      *'.Mounts'*) cat \"$root/mount\" ;;",
    "      *'.NetworkSettings.Networks'*) cat \"$root/network\" ;;",
    "      *PortBindings*)",
    '        if [ -f "$root/ports" ]; then cat "$root/ports"; else printf "%s\\n" "{}"; fi ;;',
    "      *) exit 1 ;;",
    "    esac ;;",
    "  exec)",
    '    case " $* " in',
    '      *" -U stell22 "*) ;;',
    "      *) exit 1 ;;",
    "    esac",
    '    sql=$(cat)',
    '    printf "%s\\n" "$sql" >> "$root/sql.log"',
    '    case "$sql" in',
    "      *stell22-migration-history*)",
    '        if [ -f "$root/migrated" ]; then cat "$root/history-after"; else cat "$root/history-before"; fi ;;',
    "      *stell22-migration-roles*) cat \"$root/roles\" ;;",
    "      *stell22-migration-sessions*)",
    '        if [ -f "$root/sessions" ]; then cat "$root/sessions"; fi ;;',
    "      *stell22-migration-statement-count*)",
    '        if [ -f "$root/migrated" ] && [ -f "$root/fail-rows" ]; then printf "%s\\n" 9; else cat "$root/rows"; fi ;;',
    "      *stell22-migration-columns*)",
    '        if [ -f "$root/migrated" ] && [ ! -f "$root/fail-post" ]; then cat "$root/columns-after"; fi ;;',
    "      *stell22-migration-index*)",
    '        if [ -f "$root/migrated" ] && [ ! -f "$root/fail-post" ]; then printf "%s\\n" 1; else printf "%s\\n" 0; fi ;;',
    "      *stell22-migration-check*)",
    '        if [ -f "$root/migrated" ] && [ ! -f "$root/fail-post" ]; then cat "$root/check-after"; fi ;;',
    "      *) exit 1 ;;",
    "    esac ;;",
    "  run)",
    "    prev=",
    "    envfile=",
    '    for arg in "$@"; do',
    '      if [ "$prev" = "--env-file" ]; then envfile=$arg; fi',
    "      prev=$arg",
    "    done",
    '    if [ -n "$envfile" ]; then cp "$envfile" "$root/seen.env"; fi',
    '    text="$*"',
    '    case "$text" in',
    "      *'migrate deploy'*)",
    '        if [ -f "$root/fail-migrate" ]; then exit 1; fi',
    '        touch "$root/migrated"',
    "        exit 0 ;;",
    "      *find*) cat \"$root/find-count\" ;;",
    "      *migration.sql*) cat \"$root/migration.sql\" ;;",
    "      *) exit 1 ;;",
    "    esac ;;",
    "  *) exit 1 ;;",
    "esac",
  ]);
}

function readyFixture(): Ready {
  const project = makePosixTemp();
  writeText(`${project}/README`, "synthetic migration project\n");
  const init = runShell(
    'git -C "$1" init -q && git -C "$1" add README && git -C "$1" -c user.email=stell22-test@example.com -c user.name=stell22-test commit -q -m init',
    [project],
  );
  if (init.status !== 0) throw new Error(init.stderr || init.stdout || "git init failed");
  const identity = gitIdentity(project);
  const inventory = readMigrationInventory(path.join(repoRoot, "prisma", "migrations")) as Array<{ name: string; sha256: string }>;
  const before = inventory.filter((row) => row.name !== MIGRATION_NAME).map((row) => historyLine(row)).join("\n");
  const after = inventory.map((row) => historyLine(row)).join("\n");
  const state = makePosixTemp();
  const root = makePosixTemp();
  const bin = makePosixTemp();
  const recoveryText = `phase=READY\nvolume=${VOLUME}\ncontainer=${CONTAINER}\n`;
  writeText(`${state}/beget-recovery.state`, recoveryText);
  writeText(`${state}/credentials.env`, `STELL22_BEGET_RECOVERY_MIGRATOR_PASSWORD=${PASSWORD}\n`);
  const secured = runShell('chmod 600 "$1" "$2"', [`${state}/beget-recovery.state`, `${state}/credentials.env`]);
  if (secured.status !== 0) throw new Error(secured.stderr || "chmod failed");
  writeText(`${root}/containers`, `${CONTAINER}\n`);
  writeText(`${root}/project`, `${PROJECT}\n`);
  writeText(`${root}/image`, `${IMAGE}\n`);
  writeText(`${root}/mount`, `${VOLUME} /var/lib/postgresql/data\n`);
  writeText(`${root}/network`, `${NETWORK}\n`);
  writeText(`${root}/image-id`, `${IMAGE_ID}\n`);
  writeText(`${root}/history-before`, `${before}\n`);
  writeText(`${root}/history-after`, `${after}\n`);
  writeText(`${root}/roles`, "serverVersionNum=170012\nmigratorLogin=true\nmigratorSuper=false\nappInsert=false\n");
  writeText(`${root}/rows`, "3\n");
  writeText(`${root}/columns-after`, "contentKey|YES\nperiodEnd|YES\nperiodStart|YES\nsource|YES\n");
  writeText(`${root}/check-after`, "CHECK ((source IS DISTINCT FROM 'BANK_1C' OR (periodStart IS NOT NULL AND periodEnd IS NOT NULL AND periodStart <= periodEnd)))\n");
  writeText(`${root}/find-count`, "48\n");
  writeText(`${root}/ps.txt`, "ps-stub\n");
  writeFileSync(toWin(`${root}/migration.sql`), readFileSync(path.join(repoRoot, "prisma", "migrations", MIGRATION_NAME, "migration.sql")));
  writeDocker(bin, root);
  return {
    project,
    sha: identity.sha,
    tree: identity.tree,
    state,
    root,
    bin,
    recovery: `${state}/beget-recovery.state`,
    attempt: `${state}/beget-migration-only.state`,
    credentials: `${state}/credentials.env`,
    recoveryText,
  };
}

function harnessEnv(ready: Ready, over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${ready.bin}:${process.env.PATH ?? ""}`,
    STELL22_BEGET_MIGRATION_EXECUTE: "1",
    STELL22_BEGET_MIGRATION_AUTHORIZATION: "OWNER_AUTHORIZES_BEGET_MIGRATION_HARNESS",
    STELL22_BEGET_MIGRATION_HARNESS: "1",
    STELL22_BEGET_MIGRATION_SCOPE: MIGRATION_NAME,
    STELL22_BEGET_MIGRATION_SHA: ready.sha,
    STELL22_BEGET_MIGRATION_TREE: ready.tree,
    STELL22_BEGET_MIGRATION_PROJECT: ready.project,
    STELL22_BEGET_MIGRATION_STATE: ready.state,
    STELL22_BEGET_MIGRATION_RECOVERY_STATE: ready.recovery,
    STELL22_BEGET_MIGRATION_ATTEMPT: ready.attempt,
    STELL22_BEGET_MIGRATION_CREDENTIALS: ready.credentials,
    STELL22_BEGET_MIGRATION_COMPOSE_PROJECT: PROJECT,
    STELL22_BEGET_MIGRATION_VOLUME: VOLUME,
    STELL22_BEGET_MIGRATION_CONTAINER: CONTAINER,
    STELL22_BEGET_MIGRATION_NETWORK: NETWORK,
    STELL22_BEGET_MIGRATION_DATABASE: DATABASE,
    STELL22_BEGET_MIGRATION_EXPECT_IMAGE: IMAGE,
    ...over,
  };
}

function invoke(env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync("sh", [scriptPath], { encoding: "utf8", env });
}

function migrateCount(root: string): number {
  const logPath = toWin(`${root}/docker.log`);
  try {
    return readFileSync(logPath, "utf8").split("migrate deploy").length - 1;
  } catch {
    return 0;
  }
}

afterAll(() => {
  for (const dir of temps) {
    runShell('case "$1" in /tmp/stell22-migration-only.*) rm -rf "$1" ;; esac', [dir]);
  }
});

describe("beget statement migration-only operator", { timeout: 60_000 }, () => {
  it("parses as POSIX sh and does not start the release or recovery operators", () => {
    const syntax = runShell('sh -n "$1"', [scriptPath]);
    expect(syntax.status).toBe(0);
    const calls = runShell(
      'awk \'BEGIN { c = 0 } /^[[:space:]]*#/ { next } { if (index($0, "statement-period-release.sh") || index($0, "beget-production-recovery.sh") || index($0, "docker compose") || index($0, "compose up")) c++ } END { print c }\' "$1"',
      [scriptPath],
    );
    expect(calls.stdout.trim()).toBe("0");
    expect(scriptSource).toContain("psql -X -U stell22 ");
    expect(scriptSource).not.toContain("-U postgres");
    expect(scriptSource).toContain("prisma@6.19.3");
    expect(scriptSource).toContain("openssl");
    expect(readFileSync(path.join(repoRoot, "scripts", "beget-production-recovery.sh"), "utf8")).toContain("psql -X -U stell22 ");
    expect(readFileSync(path.join(repoRoot, "docker-compose.prod.yml"), "utf8")).toContain("POSTGRES_USER: stell22");
    expect(scriptSource).toContain(MIGRATION_SHA256);
    expect(scriptSource).toContain("sha256:005c5c37db96c1e6652a79ea31f9886402fba81ac95dc2db897739121dd7f8f2");
    expect(scriptSource).toContain("OWNER_AUTHORIZES_BEGET_INITIAL_RECOVERY_20261028");
    expect(scriptSource).not.toContain('auth = "$REJECTED_RECOVERY" ] &&');
  });

  it("refuses when authorization is absent or belongs to another operator", () => {
    const missing = invoke({ ...process.env });
    expect(missing.status).not.toBe(0);
    expect(resultOf(missing)).toBe("REFUSED_AUTHORIZATION");
    const ready = readyFixture();
    const recovery = invoke(harnessEnv(ready, {
      STELL22_BEGET_MIGRATION_AUTHORIZATION: "OWNER_AUTHORIZES_BEGET_INITIAL_RECOVERY_20261028",
    }));
    const release = invoke(harnessEnv(ready, {
      STELL22_BEGET_MIGRATION_AUTHORIZATION: "OWNER_AUTHORIZES_STATEMENT_PERIOD_47_48",
    }));
    expect(resultOf(recovery)).toBe("REFUSED_AUTHORIZATION");
    expect(resultOf(release)).toBe("REFUSED_AUTHORIZATION");
    expect(`${recovery.stdout}${release.stdout}`).not.toContain(PASSWORD);
    expect(migrateCount(ready.root)).toBe(0);
  });

  it("rejects an administrative SQL user other than stell22", () => {
    const ready = readyFixture();
    const docker = `${ready.bin}/docker`;
    const rejected = runShell(
      'printf "%s\\n" "/* stell22-migration-history */" | "$1" exec -i db psql -X -U postgres -d db -f -',
      [docker],
    );
    const migrator = runShell(
      'printf "%s\\n" "/* stell22-migration-history */" | "$1" exec -i db psql -X -U stell22_migrator -d db -f -',
      [docker],
    );
    const accepted = runShell(
      'printf "%s\\n" "/* stell22-migration-history */" | "$1" exec -i db psql -X -U stell22 -d db -f -',
      [docker],
    );
    expect(rejected.status).not.toBe(0);
    expect(migrator.status).not.toBe(0);
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toContain("|t|f|1");
    expect(rejected.stdout).toBe("");
    expect(migrator.stdout).toBe("");
  });

  it("refuses the production phrase on a host that is not the accepted VPS", () => {
    const result = invoke({
      ...process.env,
      STELL22_BEGET_MIGRATION_EXECUTE: "1",
      STELL22_BEGET_MIGRATION_AUTHORIZATION: "OWNER_AUTHORIZES_BEGET_MIGRATION_ONLY_47_48",
      STELL22_BEGET_MIGRATION_SCOPE: MIGRATION_NAME,
      STELL22_BEGET_MIGRATION_SHA: "a".repeat(40),
      STELL22_BEGET_MIGRATION_TREE: "b".repeat(40),
    });
    expect(result.status).not.toBe(0);
    expect(resultOf(result)).toBe("REFUSED_HOST");
    expect(result.stdout).toContain("APPLICATION_STARTED=NO");
    expect(result.stdout).toContain("CADDY_STARTED=NO");
  });

  it("refuses a mismatched Git SHA or tree", () => {
    const ready = readyFixture();
    const sha = invoke(harnessEnv(ready, { STELL22_BEGET_MIGRATION_SHA: "a".repeat(40) }));
    const tree = invoke(harnessEnv(ready, { STELL22_BEGET_MIGRATION_TREE: "b".repeat(40) }));
    expect(resultOf(sha)).toBe("REFUSED_SHA");
    expect(resultOf(tree)).toBe("REFUSED_TREE");
    expect(migrateCount(ready.root)).toBe(0);
  });

  it("refuses the wrong Docker identity, a missing database, and an unhealthy database", () => {
    const ready = readyFixture();
    writeText(`${ready.root}/project`, "stell22\n");
    const wrong = invoke(harnessEnv(ready));
    expect(resultOf(wrong)).toBe("REFUSED_DOCKER");
    writeText(`${ready.root}/project`, `${PROJECT}\n`);
    writeText(`${ready.root}/containers`, "");
    const missing = invoke(harnessEnv(ready));
    expect(resultOf(missing)).toBe("REFUSED_DATABASE");
    writeText(`${ready.root}/containers`, `${CONTAINER}\n`);
    writeText(`${ready.root}/unhealthy`, "1\n");
    const unhealthy = invoke(harnessEnv(ready));
    expect(resultOf(unhealthy)).toBe("REFUSED_DATABASE");
    const productionName = invoke(harnessEnv(ready, { STELL22_BEGET_MIGRATION_CONTAINER: "stell22-db-prod" }));
    expect(resultOf(productionName)).toBe("REFUSED_DOCKER");
    const productionImage = invoke(harnessEnv(ready, { STELL22_BEGET_MIGRATION_EXPECT_IMAGE: PRODUCTION_IMAGE }));
    expect(resultOf(productionImage)).toBe("REFUSED_DOCKER");
    const removed = runShell('rm -f "$1"', [`${ready.root}/unhealthy`]);
    expect(removed.status).toBe(0);
    writeText(`${ready.root}/ports`, '{"5432/tcp":[{"HostPort":"5432"}]}\n');
    const published = invoke(harnessEnv(ready));
    expect(resultOf(published)).toBe("REFUSED_DOCKER");
    expect(migrateCount(ready.root)).toBe(0);
  });

  it("refuses a missing or unready recovery state without modifying one that exists", () => {
    const ready = readyFixture();
    const removed = runShell('rm -f "$1"', [ready.recovery]);
    expect(removed.status).toBe(0);
    const missing = invoke(harnessEnv(ready));
    expect(resultOf(missing)).toBe("REFUSED_RECOVERY");
    writeText(ready.recovery, "phase=WORKING\n");
    const working = invoke(harnessEnv(ready));
    expect(resultOf(working)).toBe("REFUSED_RECOVERY");
    expect(readFileSync(toWin(ready.recovery), "utf8")).toBe("phase=WORKING\n");
  });

  it("refuses a running application or Caddy", () => {
    const ready = readyFixture();
    writeText(`${ready.root}/containers`, `${CONTAINER}\nstell22-app\n`);
    const app = invoke(harnessEnv(ready));
    expect(resultOf(app)).toBe("REFUSED_APP");
    writeText(`${ready.root}/containers`, `${CONTAINER}\nstell22-caddy\n`);
    const caddy = invoke(harnessEnv(ready));
    expect(resultOf(caddy)).toBe("REFUSED_APP");
    expect(app.stdout).toContain("APPLICATION_STARTED=NO");
    expect(caddy.stdout).toContain("CADDY_STARTED=NO");
    expect(migrateCount(ready.root)).toBe(0);
  });

  it("refuses incomplete history, multiple pending migrations, and an already applied target", () => {
    const ready = readyFixture();
    const before = readFileSync(toWin(`${ready.root}/history-before`), "utf8");
    writeText(`${ready.root}/history-before`, before.replace("|t|f|1", "|f|f|1"));
    const incomplete = invoke(harnessEnv(ready));
    expect(resultOf(incomplete)).toBe("REFUSED_HISTORY");
    expect(field(incomplete.stdout ?? "", "DECISION")).toBe("STOP_INCOMPLETE");
    const lines = before.trim().split("\n");
    writeText(`${ready.root}/history-before`, `${lines.slice(3).join("\n")}\n`);
    const pending = invoke(harnessEnv(ready));
    expect(resultOf(pending)).toBe("REFUSED_HISTORY");
    expect(field(pending.stdout ?? "", "DECISION")).toBe("STOP_PENDING");
    writeText(`${ready.root}/history-before`, readFileSync(toWin(`${ready.root}/history-after`), "utf8"));
    const applied = invoke(harnessEnv(ready));
    expect(resultOf(applied)).toBe("REFUSED_ALREADY_APPLIED");
    expect(field(applied.stdout ?? "", "DECISION")).toBe("STOP_ALREADY_APPLIED");
    expect(migrateCount(ready.root)).toBe(0);
  });

  it("refuses a migration checksum mismatch before writing an attempt", () => {
    const ready = readyFixture();
    writeText(`${ready.root}/migration.sql`, "nope\n");
    const result = invoke(harnessEnv(ready));
    expect(resultOf(result)).toBe("REFUSED_CHECKSUM");
    expect(migrateCount(ready.root)).toBe(0);
    const attempt = runShell('if [ -e "$1" ]; then printf exists; fi', [ready.attempt]);
    expect(attempt.stdout).toBe("");
  });

  it("refuses missing or insecure migrator credentials", () => {
    const ready = readyFixture();
    const removed = runShell('rm -f "$1"', [ready.credentials]);
    expect(removed.status).toBe(0);
    const missing = invoke(harnessEnv(ready));
    expect(resultOf(missing)).toBe("REFUSED_CREDENTIALS");
    writeText(ready.credentials, `STELL22_BEGET_RECOVERY_MIGRATOR_PASSWORD=${PASSWORD}\n`);
    writeExec(ready.bin, "stat", [
      'case "$*" in',
      "  *-c\\ %a*|*-c\\ %A*) printf '%s\\n' 644 ;;",
      "  *) printf '%s\\n' 0 ;;",
      "esac",
    ]);
    const insecure = invoke(harnessEnv(ready));
    expect(resultOf(insecure)).toBe("REFUSED_CREDENTIALS");
    expect(`${missing.stdout}${insecure.stdout}`).not.toContain(PASSWORD);
  });

  it("refuses an unexpected database writer", () => {
    const ready = readyFixture();
    writeText(`${ready.root}/sessions`, "intruder|psql|client backend\n");
    const result = invoke(harnessEnv(ready));
    expect(resultOf(result)).toBe("REFUSED_WRITER");
    expect(migrateCount(ready.root)).toBe(0);
  });

  it("does not retry after a migration failure", () => {
    const ready = readyFixture();
    writeText(`${ready.root}/fail-migrate`, "1\n");
    const failed = invoke(harnessEnv(ready));
    expect(failed.status).not.toBe(0);
    expect(resultOf(failed)).toBe("MIGRATION_FAILED");
    expect(migrateCount(ready.root)).toBe(1);
    const again = invoke(harnessEnv(ready));
    expect(resultOf(again)).toBe("REFUSED_EXISTING_ATTEMPT");
    expect(field(again.stdout ?? "", "OUTCOME")).toBe("UNCERTAIN");
    expect(migrateCount(ready.root)).toBe(1);
    expect(again.stdout).toContain("RETRY_MIGRATION=NO");
  });

  it("preserves an uncertain attempt after an interrupted migration", () => {
    const ready = readyFixture();
    writeText(ready.attempt, "phase=ATTEMPTED\noutcome=UNRECORDED\n");
    const secured = runShell('chmod 600 "$1"', [ready.attempt]);
    expect(secured.status).toBe(0);
    const result = invoke(harnessEnv(ready));
    expect(resultOf(result)).toBe("REFUSED_EXISTING_ATTEMPT");
    expect(field(result.stdout ?? "", "PHASE")).toBe("ATTEMPTED");
    expect(field(result.stdout ?? "", "OUTCOME")).toBe("UNCERTAIN");
    expect(migrateCount(ready.root)).toBe(0);
    expect(readFileSync(toWin(ready.attempt), "utf8")).toContain("phase=ATTEMPTED");
  });

  it("keeps the attempt when post-migration verification fails", () => {
    const ready = readyFixture();
    writeText(`${ready.root}/fail-post`, "1\n");
    const result = invoke(harnessEnv(ready));
    expect(result.status).not.toBe(0);
    expect(resultOf(result)).toBe("POST_VERIFY_FAILED");
    expect(migrateCount(ready.root)).toBe(1);
    const again = invoke(harnessEnv(ready));
    expect(resultOf(again)).toBe("REFUSED_EXISTING_ATTEMPT");
    expect(migrateCount(ready.root)).toBe(1);
    expect(readFileSync(toWin(ready.recovery), "utf8")).toBe(ready.recoveryText);
  });

  it("applies the synthetic 47 to 48 transition once and leaves the application stopped", () => {
    const ready = readyFixture();
    const result = invoke(harnessEnv(ready));
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(resultOf(result)).toBe("MIGRATION_READY");
    expect(field(result.stdout ?? "", "MIGRATIONS_BEFORE")).toBe("47");
    expect(field(result.stdout ?? "", "MIGRATIONS_AFTER")).toBe("48");
    expect(field(result.stdout ?? "", "INCOMPLETE")).toBe("0");
    expect(field(result.stdout ?? "", "PENDING")).toBe("0");
    expect(field(result.stdout ?? "", "TARGET")).toBe(MIGRATION_NAME);
    expect(field(result.stdout ?? "", "TARGET_SHA256")).toBe(MIGRATION_SHA256);
    expect(field(result.stdout ?? "", "STATEMENT_ROWS_UNCHANGED")).toBe("YES");
    expect(result.stdout).toContain("APPLICATION_STARTED=NO");
    expect(result.stdout).toContain("CADDY_STARTED=NO");
    expect(result.stdout).toContain("FEATURE_ACTIVATION=NO");
    expect(result.stdout).not.toContain(PASSWORD);
    expect(migrateCount(ready.root)).toBe(1);
    const log = readFileSync(toWin(`${ready.root}/docker.log`), "utf8");
    expect(log).toContain(`container:${CONTAINER}`);
    expect(log).toContain("--env-file");
    expect(log).toContain("migrate deploy");
    expect(log.split("\n").some((line) => line.startsWith("compose"))).toBe(false);
    expect(log).not.toContain(PASSWORD);
    const seen = readFileSync(toWin(`${ready.root}/seen.env`), "utf8");
    expect(seen).toContain("stell22_migrator:");
    expect(seen).toContain(`@127.0.0.1:5432/${DATABASE}?schema=public`);
    expect(seen).not.toContain("@127.0.0.1:5432/stell22?");
    expect(readFileSync(toWin(ready.attempt), "utf8")).toContain("phase=READY");
    expect(readFileSync(toWin(ready.recovery), "utf8")).toBe(ready.recoveryText);
    const again = invoke(harnessEnv(ready));
    expect(resultOf(again)).toBe("REFUSED_EXISTING_ATTEMPT");
    expect(field(again.stdout ?? "", "OUTCOME")).toBe("RECORDED");
    expect(migrateCount(ready.root)).toBe(1);
  });
});
