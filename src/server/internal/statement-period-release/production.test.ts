import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATION_NAME, MIGRATION_SHA256, readMigrationInventory } from "./decide.mjs";
import { classifyHistory, classifyImage, classifyRoles, classifyWriters } from "./production.mjs";

const SCRIPT = "scripts/statement-period-release.sh";
const directories: string[] = [];
const approved = "a".repeat(40);
const legacyImage = `sha256:${"a".repeat(64)}`;
const builtImage = `sha256:${"b".repeat(64)}`;
const shiftedImage = `sha256:${"c".repeat(64)}`;

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
  sessionsAfter?: string;
  processes?: string;
  sha?: string;
  origin?: string;
  migrateExit?: string;
  healthExit?: string;
  healthFails?: string;
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
  sqlstate?: string;
  historyDrift?: string;
  imageShift?: string;
} = {}) {
  const inventory = readMigrationInventory(path.join(process.cwd(), "prisma", "migrations")) as InventoryRow[];
  const pending = inventory.filter((row) => row.name !== MIGRATION_NAME);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "statement-release-"));
  directories.push(root);
  const historyFile = path.join(root, "history.txt");
  const historyAfter = path.join(root, "history-after.txt");
  const sessions = path.join(root, "sessions.txt");
  const sessionsAfter = path.join(root, "sessions-after.txt");
  const processes = path.join(root, "processes.txt");
  const roles = path.join(root, "roles.txt");
  const log = path.join(root, "docker.log");
  const healthCount = path.join(root, "health-count.txt");
  fs.writeFileSync(historyFile, options.history ?? historyText(pending));
  fs.writeFileSync(historyAfter, options.historyAfter ?? historyText(inventory));
  fs.writeFileSync(sessions, options.sessions ?? "stell22_app|next-server|client backend\nstell22|stell22-statement-inspect|client backend\n");
  fs.writeFileSync(sessionsAfter, options.sessionsAfter ?? "stell22|stell22-statement-inspect|client backend\n");
  fs.writeFileSync(processes, options.processes ?? "");
  fs.writeFileSync(roles, options.roles ?? "serverVersionNum=170011\nmigratorLogin=true\nmigratorSuper=false\nappInsert=false\n");
  fs.writeFileSync(log, "");
  writeExecutable(path.join(root, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$STELL22_STATEMENT_MOCK_LOG"
case "$*" in
  *"format json"*)
    printf '%s\\n' '{"name":"stell22","services":{"app":{"image":"stell22-statement-built"},"db":{"image":"postgres:17-alpine"},"caddy":{"image":"caddy:2-alpine"}}}'
    ;;
  *--images*)
    printf '%s\\n' 'stell22-statement-built'
    ;;
  *sha256sum*) printf '%s\\n' "$STELL22_STATEMENT_MOCK_IMAGE_SUM  migration.sql" ;;
  *"prisma migrate deploy"*) exit "$STELL22_STATEMENT_MOCK_MIGRATE_EXIT" ;;
  *statement-writer-probe*)
    case "$*" in
      *VERBOSITY=verbose*)
        if [ -n "$STELL22_STATEMENT_MOCK_SQLSTATE" ]; then
          printf 'ERROR:  %s: permission denied\\n' "$STELL22_STATEMENT_MOCK_SQLSTATE" >&2
          exit 1
        fi
        ;;
    esac
    printf '%s\\n' 'ERROR: permission denied' >&2
    exit 1
    ;;
  *current_user*) printf '%s\\n' "$STELL22_STATEMENT_MOCK_USER" ;;
  *serverVersionNum*) cat "$STELL22_STATEMENT_MOCK_ROLES" ;;
  *pg_stat_activity*)
    if grep -q 'stop ' "$STELL22_STATEMENT_MOCK_LOG"; then cat "$STELL22_STATEMENT_MOCK_SESSIONS_AFTER"; else cat "$STELL22_STATEMENT_MOCK_SESSIONS"; fi
    ;;
  *information_schema*)
    if [ "$STELL22_STATEMENT_MOCK_STICKY" != 1 ] && grep -q 'prisma migrate deploy' "$STELL22_STATEMENT_MOCK_LOG"; then printf '4\\n'; else printf '0\\n'; fi
    ;;
  *_prisma_migrations*)
    if [ "$STELL22_STATEMENT_MOCK_STICKY" != 1 ] && grep -q 'prisma migrate deploy' "$STELL22_STATEMENT_MOCK_LOG"; then
      cat "$STELL22_STATEMENT_MOCK_HISTORY_AFTER"
    elif [ "$STELL22_STATEMENT_MOCK_HISTORY_DRIFT" = 1 ] && grep -q 'stop ' "$STELL22_STATEMENT_MOCK_LOG"; then
      printf '%s\\n' 'drift|deadbeef|true|false|1'
    else
      cat "$STELL22_STATEMENT_MOCK_HISTORY"
    fi
    ;;
  *"Statement"*) printf '357\\n' ;;
  *Entrypoint*) printf '%s\\n' '["./docker-entrypoint-app-only.sh"]' ;;
  *.Id*) printf '%s\\n' "$STELL22_STATEMENT_MOCK_BUILT" ;;
  *.Image*)
    if grep -q 'stop ' "$STELL22_STATEMENT_MOCK_LOG"; then
      if [ "$STELL22_STATEMENT_MOCK_IMAGE_SHIFT" = 1 ]; then
        printf '%s\\n' "$STELL22_STATEMENT_MOCK_SHIFTED"
      elif grep -q 'up -d' "$STELL22_STATEMENT_MOCK_LOG"; then
        printf '%s\\n' "$STELL22_STATEMENT_MOCK_BUILT"
      else
        printf '%s\\n' "$STELL22_STATEMENT_MOCK_LEGACY"
      fi
    else
      printf '%s\\n' "$STELL22_STATEMENT_MOCK_LEGACY"
    fi
    ;;
  *api/health*)
    n=0
    if [ -f "$STELL22_STATEMENT_MOCK_HEALTH_COUNT" ]; then n=$(cat "$STELL22_STATEMENT_MOCK_HEALTH_COUNT"); fi
    n=$((n + 1))
    printf '%s\\n' "$n" > "$STELL22_STATEMENT_MOCK_HEALTH_COUNT"
    if [ "$n" -le "$STELL22_STATEMENT_MOCK_HEALTH_FAILS" ]; then exit 1; fi
    exit "$STELL22_STATEMENT_MOCK_HEALTH_EXIT"
    ;;
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
      MIGRATOR_DB_PASSWORD: "a".repeat(24),
      APP_DB_PASSWORD: "b".repeat(24),
      STELL22_STATEMENT_MOCK_LOG: log,
      STELL22_STATEMENT_MOCK_HISTORY: historyFile,
      STELL22_STATEMENT_MOCK_HISTORY_AFTER: historyAfter,
      STELL22_STATEMENT_MOCK_SESSIONS: sessions,
      STELL22_STATEMENT_MOCK_SESSIONS_AFTER: sessionsAfter,
      STELL22_STATEMENT_MOCK_PROCESSES: processes,
      STELL22_STATEMENT_MOCK_ROLES: roles,
      STELL22_STATEMENT_MOCK_HEAD: options.sha ?? approved,
      STELL22_STATEMENT_MOCK_ORIGIN: options.origin ?? options.sha ?? approved,
      STELL22_STATEMENT_MOCK_IMAGE_SUM: options.imageSum ?? MIGRATION_SHA256,
      STELL22_STATEMENT_MOCK_MIGRATE_EXIT: options.migrateExit ?? "0",
      STELL22_STATEMENT_MOCK_HEALTH_EXIT: options.healthExit ?? "0",
      STELL22_STATEMENT_MOCK_HEALTH_FAILS: options.healthFails ?? "0",
      STELL22_STATEMENT_MOCK_HEALTH_COUNT: healthCount,
      STELL22_STATEMENT_MOCK_STICKY: options.sticky ?? "0",
      STELL22_STATEMENT_MOCK_USER: options.user ?? "stell22_migrator",
      STELL22_STATEMENT_MOCK_SQLSTATE: options.sqlstate ?? "42501",
      STELL22_STATEMENT_MOCK_HISTORY_DRIFT: options.historyDrift ?? "0",
      STELL22_STATEMENT_MOCK_IMAGE_SHIFT: options.imageShift ?? "0",
      STELL22_STATEMENT_MOCK_LEGACY: legacyImage,
      STELL22_STATEMENT_MOCK_BUILT: builtImage,
      STELL22_STATEMENT_MOCK_SHIFTED: shiftedImage,
      ...(options.facts ? { STELL22_STATEMENT_FACTS: options.facts } : {}),
    },
  };
}

function lines(log: string) {
  return fs.readFileSync(log, "utf8").split(/\r?\n/);
}

function lineIndex(log: string, pattern: RegExp) {
  return lines(log).findIndex((line) => pattern.test(line));
}

describe("statement production release executor", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("classifies observed history, the built image, and writers without a facts document", () => {
    const inventory = readMigrationInventory(path.join(process.cwd(), "prisma", "migrations")) as InventoryRow[];
    const pending = historyText(inventory.filter((row) => row.name !== MIGRATION_NAME));
    expect(classifyHistory("history-preflight", pending)).toBe("OFFLINE_HISTORY_CONTRACT_MATCHED");
    const mismatched = pending.replace(inventory[0]?.sha256 ?? "", "d".repeat(64));
    expect(classifyHistory("history-preflight", mismatched)).toBe("STOP_CHECKSUM");
    expect(classifyHistory("history-post", historyText(inventory))).toBe("POST_MIGRATION_VERIFIED");
    expect(classifyRoles("serverVersionNum=170011\nmigratorLogin=true\nmigratorSuper=false\nappInsert=false\n")).toBe("ROLES_OBSERVED");
    const image = [
      'entrypoint=["./docker-entrypoint-app-only.sh"]',
      `migrationSha256=${MIGRATION_SHA256}`,
      "composeUser=stell22_app",
      "migrateOnStart=0",
      `builtImageId=${builtImage}`,
      `legacyImageId=${legacyImage}`,
    ].join("\n");
    expect(classifyImage(image)).toBe("IMAGE_OBSERVED");
    expect(classifyImage(image.replace(builtImage, legacyImage))).toBe("STOP_IMAGE");
    expect(classifyWriters("SESSIONS\nstell22_app|next-server|client backend\nPROCESSES\n", "before")).toBe("WRITERS_CURRENTLY_CLEAR");
    expect(classifyWriters("SESSIONS\nstell22_app|next-server|client backend\nPROCESSES\n", "after")).toBe("STOP_WRITER");
    expect(classifyWriters("SESSIONS\nintruder|psql|client backend\nPROCESSES\n", "before")).toBe("STOP_WRITER");
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
    expect(source).toContain("release-built-image-id.sh");
    expect(source).toContain("release-url-password.sh");
    expect(source).toContain("release-migrator-url.py");
    expect(source).toContain("VERBOSITY=verbose");
    const denied = run({ STELL22_STATEMENT_RELEASE_EXECUTE: "", STELL22_STATEMENT_RELEASE_AUTHORIZATION: "" });
    expect(denied.out).toContain("RESULT=STOP_OWNER_GATE");
    expect(denied.out).toContain("MIGRATE_CALLS=0");
    const facts = harness({ facts: path.join(os.tmpdir(), "statement-facts.json") });
    const supplied = run(facts.env);
    expect(supplied.out).toContain("RESULT=STOP_LOCKED");
    expect(fs.readFileSync(facts.log, "utf8")).not.toContain("prisma migrate deploy");
  });

  it("refuses the wrong SHA, history, checksum, and SQLSTATE before migrate", () => {
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

    const denied = harness({ sqlstate: "" });
    const role = run(denied.env);
    expect(role.out).toContain("RESULT=STOP_APP_ROLE");
    expect(role.out).toContain("OLD_IMAGE_RESTART=NO");
    const deniedLog = fs.readFileSync(denied.log, "utf8");
    expect(deniedLog).not.toContain("prisma migrate deploy");
    expect(deniedLog).not.toContain("build app");
  });

  it("allows the running app before stop and refuses conflicting work", () => {
    const processConflict = harness({ processes: "sh scripts/backup-db.sh\n" });
    const conflicted = run(processConflict.env);
    expect(conflicted.out).toContain("RESULT=STOP_WRITER");
    expect(conflicted.out).toContain("OLD_IMAGE_RESTART=NO");
    const conflictLog = fs.readFileSync(processConflict.log, "utf8");
    expect(conflictLog).not.toContain("prisma migrate deploy");
    expect(lineIndex(processConflict.log, /^stop /)).toBe(-1);

    const writer = harness({
      sessionsAfter: "stell22|stell22-statement-inspect|client backend\nintruder|psql|client backend\n",
    });
    const intruder = run(writer.env);
    expect(intruder.out).toContain("RESULT=STOP_WRITER");
    expect(intruder.out).toContain("OLD_IMAGE_RESTART=YES");
    expect(fs.readFileSync(writer.log, "utf8")).not.toContain("prisma migrate deploy");
    expect(lineIndex(writer.log, /^start /)).toBeGreaterThan(lineIndex(writer.log, /^stop /));

    const named = harness({ database: "stell22", dbContainer: "stell22-db-prod", appContainer: "stell22-app" });
    expect(run(named.env).out).toContain("RESULT=STOP_LOCKED");
  }, 30000);

  it("returns the previous image only when the schema and image id are unchanged", () => {
    const backup = harness({ backupFail: true });
    const restored = run(backup.env);
    expect(restored.out).toContain("RESULT=STOP_BACKUP");
    expect(restored.out).toContain("OLD_IMAGE_RESTART=YES");
    expect(restored.out).toContain("MIGRATE_CALLS=0");
    expect(lineIndex(backup.log, /^start /)).toBeGreaterThan(lineIndex(backup.log, /^stop /));
    expect(fs.readFileSync(backup.log, "utf8")).not.toContain("prisma migrate deploy");

    const drifted = harness({ backupFail: true, historyDrift: "1" });
    const unsafe = run(drifted.env);
    expect(unsafe.out).toContain("RESULT=STOP_BACKUP");
    expect(unsafe.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(lineIndex(drifted.log, /^start /)).toBe(-1);

    const shifted = harness({ backupFail: true, imageShift: "1" });
    const unknown = run(shifted.env);
    expect(unknown.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(lineIndex(shifted.log, /^start /)).toBe(-1);
  }, 30000);

  it("builds the new image before stop and migrates that image once", () => {
    const spec = harness({ healthFails: "1" });
    const result = run(spec.env);
    expect(result.status).toBe(0);
    expect(result.out).toContain("RESULT=RELEASE_APPLIED");
    expect(result.out).toContain("MIGRATE_CALLS=1");
    expect(result.out).toContain("STATEMENT_ROWS_UNCHANGED=YES");
    expect(result.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(result.out).toContain("FREEZE_PASS=NO");
    expect(result.out).toContain("PRODUCTION_AUTHORIZED=NO");
    expect(result.out).toContain("FUTURE_PRIVILEGED_WRITES_PROVEN_IMPOSSIBLE=NO");
    expect(result.out).toContain("DATABASE_RESTORE=NO");
    const log = fs.readFileSync(spec.log, "utf8");
    expect(log.match(/prisma migrate deploy/g)).toHaveLength(1);
    const buildAt = lineIndex(spec.log, /build app$/);
    const sumAt = lineIndex(spec.log, /sha256sum/);
    const stopAt = lineIndex(spec.log, /^stop /);
    const migrateAt = lineIndex(spec.log, /prisma migrate deploy/);
    const upAt = lineIndex(spec.log, /up -d/);
    expect(buildAt).toBeGreaterThan(-1);
    expect(sumAt).toBeGreaterThan(buildAt);
    expect(stopAt).toBeGreaterThan(sumAt);
    expect(migrateAt).toBeGreaterThan(stopAt);
    expect(upAt).toBeGreaterThan(migrateAt);
    const migrateLine = lines(spec.log)[migrateAt] ?? "";
    expect(migrateLine).toContain(builtImage);
    expect(migrateLine).not.toContain(legacyImage);
    expect(result.out).not.toContain("FORWARD_RECOVERY");
  }, 30000);

  it("does not retry or return the old image after an uncertain migration", () => {
    const failed = harness({ migrateExit: "1" });
    const failure = run(failed.env);
    expect(failure.status).not.toBe(0);
    expect(failure.out).toContain("RESULT=FORWARD_RECOVERY");
    expect(failure.out).toContain("RETRY_MIGRATION=NO");
    expect(failure.out).toContain("SCHEMA_RESTORE=NO");
    expect(failure.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(failure.out).toContain("MIGRATE_CALLS=1");
    expect(fs.readFileSync(failed.log, "utf8").match(/prisma migrate deploy/g)).toHaveLength(1);
    expect(lineIndex(failed.log, /up -d/)).toBe(-1);
    expect(lineIndex(failed.log, /^start /)).toBe(-1);

    const sticky = harness({ sticky: "1" });
    const unverified = run(sticky.env);
    expect(unverified.out).toContain("RESULT=FORWARD_RECOVERY");
    expect(unverified.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(unverified.out).toContain("MIGRATE_CALLS=1");
    expect(lineIndex(sticky.log, /up -d/)).toBe(-1);
    expect(lineIndex(sticky.log, /^start /)).toBe(-1);
  }, 30000);
});
