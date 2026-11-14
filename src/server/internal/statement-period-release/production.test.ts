import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_NAME, MIGRATION_SHA256, readMigrationInventory } from "./decide.mjs";
import { classifyHistory, classifyRoles, classifyWriters } from "./production.mjs";

const SCRIPT = "scripts/statement-period-release.sh";
const directories: string[] = [];
const approved = "a".repeat(40);

type InventoryRow = { name: string; sha256: string };

function writeExecutable(file: string, body: string) {
  fs.writeFileSync(file, body.replace(/\r\n/g, "\n"), { mode: 0o755 });
}

function historyText(rows: InventoryRow[]) {
  return `${rows.map((row) => `${row.name}|${row.sha256}|true|false|1`).join("\n")}\n`;
}

function run(env: Record<string, string>) {
  const child = spawnSync("sh", [SCRIPT], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: child.status, out: `${child.stdout}${child.stderr}` };
}

function harness(options: {
  history?: string;
  historyAfter?: string;
  sessions?: string;
  processes?: string;
  sha?: string;
  origin?: string;
  migrateExit?: string;
  healthExit?: string;
  sticky?: string;
  imageSum?: string;
  roles?: string;
  user?: string;
  backupFail?: boolean;
  database?: string;
  dbContainer?: string;
  appContainer?: string;
  facts?: string;
  execute?: string;
  authorization?: string;
} = {}) {
  const inventory = readMigrationInventory(path.join(process.cwd(), "prisma", "migrations")) as InventoryRow[];
  const pending = inventory.filter((row) => row.name !== MIGRATION_NAME);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "statement-release-"));
  directories.push(root);
  const historyFile = path.join(root, "history.txt");
  const historyAfter = path.join(root, "history-after.txt");
  const sessions = path.join(root, "sessions.txt");
  const processes = path.join(root, "processes.txt");
  const roles = path.join(root, "roles.txt");
  const log = path.join(root, "docker.log");
  fs.writeFileSync(historyFile, options.history ?? historyText(pending));
  fs.writeFileSync(historyAfter, options.historyAfter ?? historyText(inventory));
  fs.writeFileSync(sessions, options.sessions ?? "stell22|stell22-statement-inspect|client backend\n");
  fs.writeFileSync(processes, options.processes ?? "");
  fs.writeFileSync(roles, options.roles ?? "serverVersionNum=170011\nmigratorLogin=true\nmigratorSuper=false\nappInsert=false\n");
  fs.writeFileSync(log, "");
  writeExecutable(path.join(root, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$STELL22_STATEMENT_MOCK_LOG"
case "$*" in
  *sha256sum*) printf '%s\\n' "$STELL22_STATEMENT_MOCK_IMAGE_SUM  migration.sql" ;;
  *"prisma migrate deploy"*) exit "$STELL22_STATEMENT_MOCK_MIGRATE_EXIT" ;;
  *current_user*) printf '%s\\n' "$STELL22_STATEMENT_MOCK_USER" ;;
  *statement-writer-probe*) printf '%s\\n' 'ERROR: 42501 permission denied' >&2; exit 1 ;;
  *serverVersionNum*) cat "$STELL22_STATEMENT_MOCK_ROLES" ;;
  *pg_stat_activity*) cat "$STELL22_STATEMENT_MOCK_SESSIONS" ;;
  *information_schema*)
    if [ "$STELL22_STATEMENT_MOCK_STICKY" != 1 ] && grep -q 'prisma migrate deploy' "$STELL22_STATEMENT_MOCK_LOG"; then printf '4\\n'; else printf '0\\n'; fi
    ;;
  *_prisma_migrations*)
    if [ "$STELL22_STATEMENT_MOCK_STICKY" != 1 ] && grep -q 'prisma migrate deploy' "$STELL22_STATEMENT_MOCK_LOG"; then cat "$STELL22_STATEMENT_MOCK_HISTORY_AFTER"; else cat "$STELL22_STATEMENT_MOCK_HISTORY"; fi
    ;;
  *"Statement"*) printf '357\\n' ;;
  *Entrypoint*) printf '%s\\n' '["./docker-entrypoint-app-only.sh"]' ;;
  *.Image*) printf '%s\\n' 'sha256:${"a".repeat(64)}' ;;
  *api/health*) exit "$STELL22_STATEMENT_MOCK_HEALTH_EXIT" ;;
esac
exit 0
`);
  writeExecutable(path.join(root, "git"), `#!/bin/sh
case "$*" in
  *origin/main*) printf '%s\\n' "$STELL22_STATEMENT_MOCK_ORIGIN" ;;
  *HEAD*) printf '%s\\n' "$STELL22_STATEMENT_MOCK_HEAD" ;;
esac
exit 0
`);
  writeExecutable(path.join(root, "ps"), `#!/bin/sh
cat "$STELL22_STATEMENT_MOCK_PROCESSES"
`);
  writeExecutable(path.join(root, "backup"), options.backupFail
    ? "#!/bin/sh\nprintf '%s\\n' 'BACKUP FAILED'\nexit 1\n"
    : `#!/bin/sh
dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
base=stell22_fixture.sql.gz
printf 'statement-backup-marker\\n' > "$dir/$base"
(CDPATH= cd "$dir" && sha256sum "$base" > "$base.sha256")
printf '[backup] BACKUP SUCCESS: %s/%s\\n' "$dir" "$base"
`);
  const unix = root.replace(/\\/g, "/");
  return {
    log,
    env: {
      PATH: `${unix}:${process.env.PATH ?? ""}`,
      STELL22_STATEMENT_RELEASE_EXECUTE: options.execute ?? "1",
      STELL22_STATEMENT_RELEASE_AUTHORIZATION: options.authorization ?? "OWNER_AUTHORIZES_STATEMENT_PERIOD_47_48",
      STELL22_STATEMENT_RELEASE_SHA: options.sha ?? approved,
      STELL22_STATEMENT_PHASE: "fixture",
      STELL22_STATEMENT_DATABASE: options.database ?? "stmt_0123456789ab",
      STELL22_STATEMENT_DB_CONTAINER: options.dbContainer ?? "stmt-db-0123456789ab",
      STELL22_STATEMENT_APP_CONTAINER: options.appContainer ?? "stmt-app-0123456789ab",
      STELL22_STATEMENT_BACKUP_BIN: `${unix}/backup`,
      STELL22_MIGRATOR_PASSWORD: "a".repeat(24),
      STELL22_APP_DB_PASSWORD: "b".repeat(24),
      STELL22_STATEMENT_MOCK_LOG: log,
      STELL22_STATEMENT_MOCK_HISTORY: historyFile,
      STELL22_STATEMENT_MOCK_HISTORY_AFTER: historyAfter,
      STELL22_STATEMENT_MOCK_SESSIONS: sessions,
      STELL22_STATEMENT_MOCK_PROCESSES: processes,
      STELL22_STATEMENT_MOCK_ROLES: roles,
      STELL22_STATEMENT_MOCK_HEAD: options.sha ?? approved,
      STELL22_STATEMENT_MOCK_ORIGIN: options.origin ?? options.sha ?? approved,
      STELL22_STATEMENT_MOCK_IMAGE_SUM: options.imageSum ?? MIGRATION_SHA256,
      STELL22_STATEMENT_MOCK_MIGRATE_EXIT: options.migrateExit ?? "0",
      STELL22_STATEMENT_MOCK_HEALTH_EXIT: options.healthExit ?? "0",
      STELL22_STATEMENT_MOCK_STICKY: options.sticky ?? "0",
      STELL22_STATEMENT_MOCK_USER: options.user ?? "stell22_migrator",
      ...(options.facts ? { STELL22_STATEMENT_FACTS: options.facts } : {}),
    },
  };
}

describe("statement production release executor", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("classifies observed history and current writers without a facts document", () => {
    const inventory = readMigrationInventory(path.join(process.cwd(), "prisma", "migrations")) as InventoryRow[];
    const pending = historyText(inventory.filter((row) => row.name !== MIGRATION_NAME));
    expect(classifyHistory("history-preflight", pending)).toBe("OFFLINE_HISTORY_CONTRACT_MATCHED");
    const mismatched = pending.replace(inventory[0]?.sha256 ?? "", "d".repeat(64));
    expect(classifyHistory("history-preflight", mismatched)).toBe("STOP_CHECKSUM");
    expect(classifyHistory("history-post", historyText(inventory))).toBe("POST_MIGRATION_VERIFIED");
    expect(classifyRoles("serverVersionNum=170011\nmigratorLogin=true\nmigratorSuper=false\nappInsert=false\n")).toBe("ROLES_OBSERVED");
    expect(classifyWriters("SESSIONS\nintruder|psql|client backend\nPROCESSES\n")).toBe("STOP_WRITER");
    const locked = spawnSync(process.execPath, ["src/server/internal/statement-period-release/production.mjs", "facts.json"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    expect(locked.status).not.toBe(0);
    expect(locked.stdout).toContain("RESULT=STOP_LOCKED");
    expect(locked.stdout).not.toContain("RELEASE_APPLIED");
  });

  it("stays locked without owner authorization or a supplied facts file", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).not.toContain("migrate resolve");
    expect(source).not.toContain("pg_hba");
    const denied = run({ STELL22_STATEMENT_RELEASE_EXECUTE: "", STELL22_STATEMENT_RELEASE_AUTHORIZATION: "" });
    expect(denied.out).toContain("RESULT=STOP_OWNER_GATE");
    expect(denied.out).toContain("MIGRATE_CALLS=0");
    const facts = harness({ facts: path.join(os.tmpdir(), "statement-facts.json") });
    const supplied = run(facts.env);
    expect(supplied.out).toContain("RESULT=STOP_LOCKED");
    expect(fs.readFileSync(facts.log, "utf8")).not.toContain("prisma migrate deploy");
  });

  it("refuses the wrong SHA, history, and checksum before migrate", () => {
    const inventory = readMigrationInventory(path.join(process.cwd(), "prisma", "migrations")) as InventoryRow[];
    const wrongSha = harness({ sha: "b".repeat(40), origin: approved });
    wrongSha.env.STELL22_STATEMENT_MOCK_HEAD = approved;
    const sha = run(wrongSha.env);
    expect(sha.out).toContain("RESULT=STOP_SHA");
    expect(fs.readFileSync(wrongSha.log, "utf8")).not.toContain("prisma migrate deploy");

    const other = inventory.find((row) => row.name !== MIGRATION_NAME);
    if (!other) throw new Error("comparison migration is missing");
    const foreign = harness({ history: historyText(inventory.filter((row) => row.name !== other.name)) });
    expect(run(foreign.env).out).toContain("RESULT=STOP_PENDING_NAME");
    expect(fs.readFileSync(foreign.log, "utf8")).not.toContain("prisma migrate deploy");

    const pending = historyText(inventory.filter((row) => row.name !== MIGRATION_NAME));
    const mismatch = harness({ history: pending.replace(inventory[0]?.sha256 ?? "", "d".repeat(64)) });
    expect(run(mismatch.env).out).toContain("RESULT=STOP_CHECKSUM");
    expect(fs.readFileSync(mismatch.log, "utf8")).not.toContain("prisma migrate deploy");
  });

  it("stops for a conflicting writer and does not migrate", () => {
    const writer = harness({ sessions: "stell22|stell22-statement-inspect|client backend\nintruder|psql|client backend\n" });
    expect(run(writer.env).out).toContain("RESULT=STOP_WRITER");
    expect(fs.readFileSync(writer.log, "utf8")).not.toContain("prisma migrate deploy");
    const backup = harness({ processes: "sh scripts/backup-db.sh\n" });
    expect(run(backup.env).out).toContain("RESULT=STOP_WRITER");
    expect(fs.readFileSync(backup.log, "utf8")).not.toContain("prisma migrate deploy");
    const named = harness({ database: "stell22", dbContainer: "stell22-db-prod", appContainer: "stell22-app" });
    expect(run(named.env).out).toContain("RESULT=STOP_LOCKED");
  });

  it("runs one migration only after the live gates and verifies 48/0", () => {
    const spec = harness({});
    const result = run(spec.env);
    expect(result.status).toBe(0);
    expect(result.out).toContain("RESULT=RELEASE_APPLIED");
    expect(result.out).toContain("MIGRATE_CALLS=1");
    expect(result.out).toContain("STATEMENT_ROWS_UNCHANGED=YES");
    expect(result.out).toContain("FREEZE_PASS=NO");
    expect(result.out).toContain("PRODUCTION_AUTHORIZED=NO");
    expect(result.out).toContain("FUTURE_PRIVILEGED_WRITES_PROVEN_IMPOSSIBLE=NO");
    expect(result.out).toContain("DATABASE_RESTORE=NO");
    const log = fs.readFileSync(spec.log, "utf8");
    expect(log.match(/prisma migrate deploy/g)).toHaveLength(1);
    expect(log.indexOf("stop ")).toBeGreaterThan(-1);
    expect(log.indexOf("stop ")).toBeLessThan(log.indexOf("prisma migrate deploy"));
    expect(log.indexOf("prisma migrate deploy")).toBeLessThan(log.indexOf("compose"));
  });

  it("does not retry after an uncertain migration and does not restore", () => {
    const failed = harness({ migrateExit: "1" });
    const failure = run(failed.env);
    expect(failure.status).not.toBe(0);
    expect(failure.out).toContain("RESULT=FORWARD_RECOVERY");
    expect(failure.out).toContain("RETRY_MIGRATION=NO");
    expect(failure.out).toContain("SCHEMA_RESTORE=NO");
    expect(failure.out).toContain("MIGRATE_CALLS=1");
    expect(fs.readFileSync(failed.log, "utf8").match(/prisma migrate deploy/g)).toHaveLength(1);
    expect(fs.readFileSync(failed.log, "utf8")).not.toContain("compose");

    const sticky = harness({ sticky: "1" });
    const unverified = run(sticky.env);
    expect(unverified.out).toContain("RESULT=FORWARD_RECOVERY");
    expect(unverified.out).toContain("MIGRATE_CALLS=1");
    expect(fs.readFileSync(sticky.log, "utf8")).not.toContain("compose");
  });
});
