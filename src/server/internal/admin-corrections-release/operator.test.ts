import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AUTHORIZATION_PHRASE, MIGRATION_NAME, MIGRATION_SHA256, REJECTED_AUTHORIZATION_PHRASE, compareHistory, readMigrationInventory } from "./decide.mjs";

const SCRIPT = "scripts/admin-corrections-release.sh";
const SHA = `${"ab".repeat(16)}${"cd".repeat(4)}`;
const directories: string[] = [];

function absentSchema() {
  return [
    "batchPackageEdit=false",
    "productionOperationCancellation=false",
    "cancelledAtPresent=false",
    "indexProductionOperationCancelledAt=false",
    "indexBatchRequest=false",
    "indexBatchBatchRecorded=false",
    "indexCancelRequest=false",
    "indexCancelOperation=false",
    "indexCancelOperationRecorded=false",
    "sentinelProductionOperation=0",
    "sentinelInventoryMovement=0",
    "",
  ].join("\n");
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    COMSPEC: process.env.COMSPEC,
    PATHEXT: process.env.PATHEXT,
    NODE_ENV: process.env.NODE_ENV,
    ...extra,
  };
}

function run(extra: Record<string, string>) {
  const child = spawnSync("sh", [SCRIPT], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: baseEnv(extra),
    windowsHide: true,
  });
  return { status: child.status, out: `${child.stdout ?? ""}${child.stderr ?? ""}` };
}

function auth(extra: Record<string, string> = {}) {
  return {
    STELL22_ADMIN_CORRECTIONS_EXECUTE: "1",
    STELL22_ADMIN_CORRECTIONS_MAINTENANCE: "1",
    STELL22_ADMIN_CORRECTIONS_AUTHORIZATION: AUTHORIZATION_PHRASE,
    STELL22_ADMIN_CORRECTIONS_CI: "1",
    STELL22_ADMIN_CORRECTIONS_SHA: SHA,
    ...extra,
  };
}

function disposable(extra: Record<string, string> = {}) {
  return auth({
    STELL22_ADMIN_CORRECTIONS_DISPOSABLE: "1",
    STELL22_AC_PHASE: "fixture",
    STELL22_AC_DATABASE: "acrel_abcd1234",
    STELL22_AC_DB_CONTAINER: "acrel-db-abcd1234",
    STELL22_AC_APP_CONTAINER: "acrel-app-abcd1234",
    STELL22_AC_INSPECT_USER: "acrel_boot",
    STELL22_AC_ORIGIN_MAIN: SHA,
    STELL22_AC_HEAD: SHA,
    ...extra,
  });
}

function writeExecutable(file: string, body: string) {
  fs.writeFileSync(file, body.replace(/\r\n/g, "\n"));
  fs.chmodSync(file, 0o755);
}

function fixture(options: {
  history?: string;
  privileges?: string;
  sessions?: string;
  schema?: string;
  schemaNow?: string;
  processesNow?: string;
  backupExit?: number;
  checksumOk?: string;
  buildExit?: string;
  migrateExit?: string;
  appExit?: string;
  post?: string;
  runtime?: string;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-fixture-"));
  directories.push(root);
  const unix = root.replace(/\\/g, "/");
  const facts = path.join(root, "facts");
  fs.mkdirSync(facts);
  const image = readMigrationInventory(path.join(process.cwd(), "prisma", "migrations"));
  const pending = image.filter((row) => row.name !== MIGRATION_NAME);
  const history = options.history ?? `${pending.map((row) => `${row.name}|${row.sha256}|true|false|1`).join("\n")}\n`;
  fs.writeFileSync(path.join(facts, "history.txt"), history);
  fs.writeFileSync(
    path.join(facts, "privileges.env"),
    options.privileges ??
      [
        "serverVersionNum=170011",
        "migratorLogin=true",
        "migratorSuper=false",
        "migratorCreate=true",
        "migratorOwnsAlteredTable=true",
        "migratorOperationTypeUsage=true",
        "appOperationTypeUsage=true",
        "appLogin=true",
        "appSuper=false",
        "defaultPrivileges=true",
      ].join("\n") + "\n",
  );
  fs.writeFileSync(path.join(facts, "sessions.txt"), options.sessions ?? "");
  fs.writeFileSync(path.join(facts, "schema.env"), options.schema ?? absentSchema());
  if (options.schemaNow) fs.writeFileSync(path.join(facts, "schema.now"), options.schemaNow);
  if (options.processesNow) fs.writeFileSync(path.join(facts, "processes.now"), options.processesNow);
  fs.writeFileSync(path.join(facts, "objects.env"), "sentinelProductionOperation=0\nsentinelInventoryMovement=0\n");
  fs.writeFileSync(path.join(facts, "runtime.env"), options.runtime ?? "old_image_app_only=1\n");
  fs.writeFileSync(
    path.join(facts, "image.env"),
    [
      "buildOk=1",
      'entrypoint=["./docker-entrypoint-app-only.sh"]',
      "imageHasMigrateOnStart=0",
      `migrationSha256=${MIGRATION_SHA256}`,
      "composeAppUser=stell22_app",
      `imageId=sha256:${"a".repeat(64)}`,
      `legacyImageId=sha256:${"b".repeat(64)}`,
      "",
    ].join("\n"),
  );
  const applied = compareHistory(image, image.map((row) => ({ name: row.name, checksum: row.sha256, finished: true, rolledBack: false, steps: 1 })));
  const post = options.post ??
    [
      ...Object.entries(applied).map(([key, value]) => `${key}=${value}`),
      "batchPackageEdit=1",
      "productionOperationCancellation=1",
      "cancelledAtNullable=1",
      "indexProductionOperationCancelledAt=1",
      "indexBatchRequest=1",
      "indexBatchBatchRecorded=1",
      "indexCancelRequest=1",
      "indexCancelOperation=1",
      "indexCancelOperationRecorded=1",
      "appTablePrivileges=1",
      "sentinelProductionOperation=0",
      "sentinelProductionOperationBefore=0",
      "sentinelInventoryMovement=0",
      "sentinelInventoryMovementBefore=0",
    ].join("\n") + "\n";
  fs.writeFileSync(path.join(facts, "post.env"), post);
  const log = `${unix}/docker.log`;
  writeExecutable(path.join(root, "docker"), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit 0\n`);
  writeExecutable(
    path.join(root, "backup"),
    `#!/bin/sh\n${options.backupExit ? "echo BACKUP FAILED\nexit 1" : "echo BACKUP SUCCESS\nexit 0"}\n`,
  );
  return {
    log,
    env: disposable({
      PATH: `${unix}:${process.env.PATH ?? ""}`,
      STELL22_AC_FACTS_DIR: facts.replace(/\\/g, "/"),
      STELL22_AC_BACKUP_BIN: `${unix}/backup`,
      STELL22_AC_BUILD_EXIT: options.buildExit ?? "0",
      STELL22_AC_MIGRATE_EXIT: options.migrateExit ?? "0",
      STELL22_AC_APP_EXIT: options.appExit ?? "0",
      STELL22_AC_CHECKSUM_OK: options.checksumOk ?? "1",
    }),
  };
}

describe("admin corrections release operator", () => {
  afterEach(() => {
    for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it("stops before any release when the owner phrase, CI, or SHA is missing", () => {
    expect(run({}).out).toContain("RESULT=STOP_OWNER_GATE");
    expect(run(auth({ STELL22_ADMIN_CORRECTIONS_AUTHORIZATION: REJECTED_AUTHORIZATION_PHRASE })).out).toContain("RESULT=STOP_OWNER_GATE");
    expect(run(auth({ STELL22_ADMIN_CORRECTIONS_RESTORE: "1" })).out).toContain("RESULT=STOP_NO_RESTORE");
    const wrong = run(disposable({ STELL22_AC_ORIGIN_MAIN: "a".repeat(40) }));
    expect(wrong.status).not.toBe(0);
    expect(wrong.out).toContain("RESULT=STOP_CHECKOUT");
    expect(wrong.out).not.toContain(AUTHORIZATION_PHRASE);
  }, 30_000);

  it("refuses production names and production fixture overrides", () => {
    const named = run(disposable({ STELL22_AC_PHASE: "migrate-only", STELL22_AC_DATABASE: "stell22", STELL22_AC_DB_CONTAINER: "stell22-db-prod" }));
    expect(named.out).toContain("RESULT=STOP_LOCKED");
    const override = run(auth({ STELL22_AC_FACTS_DIR: "/tmp/facts" }));
    expect(override.out).toContain("RESULT=STOP_LOCKED");
    expect(override.out).not.toContain("git fetch");
  }, 30_000);

  it("keeps the old image running when the target image build fails", () => {
    const spec = fixture({ buildExit: "1" });
    const result = run(spec.env);
    expect(result.out).toContain("RESULT=STOP_IMAGE");
    expect(result.out).toContain("APP_UNCHANGED=YES");
    expect(result.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(fs.existsSync(spec.log)).toBe(false);
  }, 30_000);

  it("restarts only the old container when backup fails before migration", () => {
    const spec = fixture({ backupExit: 1 });
    const result = run(spec.env);
    expect(result.out).toContain("RESULT=STOP_BACKUP");
    expect(result.out).toContain("OLD_IMAGE_RESTART=YES");
    expect(result.out).toContain("DATABASE_RESTORE=NO");
    const log = fs.readFileSync(spec.log, "utf8");
    expect(log).toContain("stop acrel-app-abcd1234");
    expect(log).toContain("start acrel-app-abcd1234");
    expect(log).not.toContain("up -d");
  }, 30_000);

  it("stops without retry or restore when the migration result is uncertain", () => {
    const spec = fixture({ migrateExit: "1" });
    const result = run(spec.env);
    expect(result.out).toContain("RESULT=STOP_MIGRATION_UNCERTAIN");
    expect(result.out).toContain("DATABASE_RESTORE=NO");
    expect(result.out).toContain("RETRY_MIGRATION=NO");
    expect(result.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(result.out).toContain("FORWARD_RECOVERY=YES");
    const log = fs.readFileSync(spec.log, "utf8");
    expect(log).not.toContain("start acrel-app-abcd1234");
    expect(log).not.toContain("up -d");
  }, 30_000);

  it("does not start the historical image after a failed post-migration gate or app start", () => {
    const badPost = fixture({ post: "historyFinished=46\npendingCount=1\n" });
    const post = run(badPost.env);
    expect(post.out).toContain("RESULT=STOP_POST_MIGRATE");
    expect(post.out).toContain("FORWARD_RECOVERY=YES");
    expect(fs.readFileSync(badPost.log, "utf8")).not.toContain("start acrel-app-abcd1234");
    const badApp = fixture({ appExit: "1" });
    const app = run(badApp.env);
    expect(app.out).toContain("RESULT=FORWARD_RECOVERY");
    expect(app.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(app.out).toContain("DATABASE_RESTORE=NO");
    expect(fs.readFileSync(badApp.log, "utf8")).toContain("up -d --no-deps app");
    expect(fs.readFileSync(badApp.log, "utf8")).not.toContain("start acrel-app-abcd1234");
  }, 30_000);

  it("refuses unexpected history, privileges, writers, and a second apply", () => {
    const image = readMigrationInventory(path.join(process.cwd(), "prisma", "migrations"));
    const withoutTwo = image.filter((row) => row.name !== MIGRATION_NAME && row.name !== image[0]?.name);
    const pending = run(fixture({ history: `${withoutTwo.map((row) => `${row.name}|${row.sha256}|true|false|1`).join("\n")}\n` }).env);
    expect(pending.out).toContain("RESULT=STOP_PENDING");
    expect(pending.out).toContain("APP_UNCHANGED=YES");
    const broken = image.filter((row) => row.name !== MIGRATION_NAME);
    const incomplete = run(fixture({ history: `${broken.map((row, index) => `${row.name}|${row.sha256}|${index === 0 ? "false" : "true"}|false|${index === 0 ? "0" : "1"}`).join("\n")}\n` }).env);
    expect(incomplete.out).toContain("RESULT=STOP_INCOMPLETE");
    const mismatch = run(fixture({ history: `${broken.map((row, index) => `${row.name}|${index === 0 ? "e".repeat(64) : row.sha256}|true|false|1`).join("\n")}\n` }).env);
    expect(mismatch.out).toContain("RESULT=STOP_CHECKSUM");
    const type = run(fixture({ privileges: "serverVersionNum=170011\nmigratorLogin=true\nmigratorSuper=false\nmigratorCreate=true\nmigratorOwnsAlteredTable=true\nmigratorOperationTypeUsage=false\nappOperationTypeUsage=false\nappLogin=true\nappSuper=false\ndefaultPrivileges=true\n" }).env);
    expect(type.out).toContain("RESULT=STOP_OPERATION_TYPE");
    const defaults = run(fixture({ privileges: "serverVersionNum=170011\nmigratorLogin=true\nmigratorSuper=false\nmigratorCreate=true\nmigratorOwnsAlteredTable=true\nmigratorOperationTypeUsage=true\nappOperationTypeUsage=true\nappLogin=true\nappSuper=false\ndefaultPrivileges=false\n" }).env);
    expect(defaults.out).toContain("RESULT=STOP_DEFAULT_PRIVILEGES");
    const writer = fixture({ sessions: "intruder|psql|client backend\n" });
    const writers = run(writer.env);
    expect(writers.out).toContain("RESULT=STOP_WRITER");
    expect(writers.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(fs.readFileSync(writer.log, "utf8")).not.toContain("up -d");
    const applied = `${image.map((row) => `${row.name}|${row.sha256}|true|false|1`).join("\n")}\n`;
    const repeat = run(fixture({ history: applied }).env);
    expect(repeat.out).toContain("RESULT=STOP_ALREADY_APPLIED");
    expect(repeat.out).toContain("APP_UNCHANGED=YES");
  }, 30_000);

  it("records a successful fixture release without restoring a database", () => {
    const spec = fixture({});
    const result = run(spec.env);
    expect(result.status).toBe(0);
    expect(result.out).toContain("RESULT=RELEASE_APPLIED");
    expect(result.out).toContain("MIGRATION_APPLY=MIGRATOR");
    expect(result.out).toContain("MIGRATE_LOGIN=stell22_migrator");
    expect(result.out).toContain("DATABASE_RESTORE=NO");
    expect(result.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(result.out).toContain("RETRY_MIGRATION=NO");
    const log = fs.readFileSync(spec.log, "utf8");
    expect(log).toContain("up -d --no-deps app");
    expect(log).not.toContain("start acrel-app-abcd1234");
  }, 30_000);

  it("verifies a fresh basename checksum from the repository root and rejects an older archive", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ac-backup-"));
    directories.push(directory);
    const root = directory.replace(/\\/g, "/");
    fs.mkdirSync(path.join(directory, "backups"));
    fs.writeFileSync(path.join(directory, "backups", "stell22_2020-01-01_00-00-00.sql.gz"), "old\n");
    fs.writeFileSync(path.join(directory, "backups", "stell22_2026-10-25_12-00-00.sql.gz"), "new\n");
    const summed = spawnSync("sh", ["-c", 'cd "$1" && sha256sum "$2" > "$2.sha256"', "sh", `${root}/backups`, "stell22_2026-10-25_12-00-00.sql.gz"], { encoding: "utf8" });
    expect(summed.status, summed.stderr).toBe(0);
    const oldPath = `${root}/backups/stell22_2020-01-01_00-00-00.sql.gz`;
    const newPath = `${root}/backups/stell22_2026-10-25_12-00-00.sql.gz`;
    fs.writeFileSync(path.join(directory, "before"), `${oldPath}\n`);
    fs.writeFileSync(path.join(directory, "success"), `[backup] BACKUP SUCCESS: ${newPath}\n`);
    const success = `${root}/success`;
    const before = `${root}/before`;
    const fresh = run(disposable({
      STELL22_AC_PHASE: "backup-gate",
      STELL22_AC_BACKUP_STDOUT: success,
      STELL22_AC_BACKUP_BEFORE: before,
    }));
    expect(fresh.status, fresh.out).toBe(0);
    expect(fresh.out).toContain("RESULT=BACKUP_OK");
    const checksum = fs.readFileSync(`${root}/backups/stell22_2026-10-25_12-00-00.sql.gz.sha256`, "utf8");
    expect(checksum.trim().split(/\s+/)[1]?.replace(/^\*/, "")).toBe("stell22_2026-10-25_12-00-00.sql.gz");
    const stale = spawnSync("sh", ["-c", `printf '[backup] BACKUP SUCCESS: %s\\n' "$1" > "$2/stale"`, "sh", oldPath, root], { encoding: "utf8" });
    expect(stale.status).toBe(0);
    const rejected = run(disposable({
      STELL22_AC_PHASE: "backup-gate",
      STELL22_AC_BACKUP_STDOUT: `${root}/stale`,
      STELL22_AC_BACKUP_BEFORE: before,
    }));
    expect(rejected.status, rejected.out).not.toBe(0);
    expect(rejected.out).toContain("RESULT=STOP_BACKUP");
  }, 30_000);

  it("stops when the session probe fails and does not treat that as a clear writer set", () => {
    const spec = fixture({});
    const result = run({ ...spec.env, STELL22_AC_SESSION_STATUS: "1" });
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain("RESULT=STOP_WRITER");
    expect(result.out).not.toContain("WRITERS_CLEAR");
    expect(result.out).not.toContain("RELEASE_APPLIED");
    expect(result.out).toContain("OLD_IMAGE_RESTART=NO");
  }, 30_000);

  it("stops without restarting when a database read or process check fails after the app stop", () => {
    const sql = run(fixture({}).env);
    const sqlFail = run({ ...fixture({}).env, STELL22_AC_SQL_FAIL: "after-stop" });
    expect(sql.status, sql.out).toBe(0);
    expect(sqlFail.status, sqlFail.out).not.toBe(0);
    expect(sqlFail.out).toContain("RESULT=STOP_HISTORY");
    expect(sqlFail.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(sqlFail.out).not.toContain("RELEASE_APPLIED");
    const processFail = run({ ...fixture({}).env, STELL22_AC_PS_FAIL: "after-stop" });
    expect(processFail.status, processFail.out).not.toBe(0);
    expect(processFail.out).toContain("RESULT=STOP_WRITER");
    expect(processFail.out).toContain("OLD_IMAGE_RESTART=NO");
  }, 30_000);

  it("does not restart the old image on a signal before migration", () => {
    const spec = fixture({});
    const result = run({ ...spec.env, STELL22_AC_SIGNAL_AT: "after-stop" });
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain("RESULT=STOP_SIGNAL");
    expect(result.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(result.out).toContain("DATABASE_RESTORE=NO");
    const log = fs.readFileSync(spec.log, "utf8");
    expect(log).toContain("stop acrel-app-abcd1234");
    expect(log).not.toContain("start acrel-app-abcd1234");
  }, 30_000);

  it("restarts the old image only after positive schema and history proofs", () => {
    const proved = fixture({ backupExit: 1 });
    const ok = run(proved.env);
    expect(ok.out).toContain("RESULT=STOP_BACKUP");
    expect(ok.out).toContain("OLD_IMAGE_RESTART=YES");
    expect(fs.readFileSync(proved.log, "utf8")).toContain("start acrel-app-abcd1234");
    const drifted = absentSchema().replace("batchPackageEdit=false", "batchPackageEdit=true");
    const bad = fixture({ backupExit: 1, schemaNow: drifted });
    const stopped = run(bad.env);
    expect(stopped.out).toContain("RESULT=STOP_BACKUP");
    expect(stopped.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(fs.readFileSync(bad.log, "utf8")).not.toContain("start acrel-app-abcd1234");
  }, 30_000);

  it("does not restart when recovery confirms a competing process", () => {
    for (const line of ["sh scripts/backup-db.sh", "node fetch-statements.js", "npx prisma migrate deploy", "sh scripts/release-role-split.sh"]) {
      const spec = fixture({ backupExit: 1, processesNow: `${line}\n` });
      const result = run(spec.env);
      expect(result.out, line).toContain("OLD_IMAGE_RESTART=NO");
      expect(result.out, line).not.toContain("RELEASE_APPLIED");
      expect(fs.readFileSync(spec.log, "utf8")).not.toContain("start acrel-app-abcd1234");
    }
    const clear = fixture({ backupExit: 1 });
    const restarted = run(clear.env);
    expect(restarted.out).toContain("RESULT=STOP_BACKUP");
    expect(restarted.out).toContain("OLD_IMAGE_RESTART=YES");
  }, 60_000);

  it("rejects an old archive addressed by a relative path and accepts a new absolute archive", () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), ".ac-r2-backup-"));
    directories.push(directory);
    const oldName = "stell22_2020-01-01_00-00-00.sql.gz";
    const newName = "stell22_2026-10-25_12-00-00.sql.gz";
    fs.writeFileSync(path.join(directory, oldName), "old\n");
    fs.writeFileSync(path.join(directory, newName), "new\n");
    const unix = directory.replace(/\\/g, "/");
    const relativeOld = `${path.relative(process.cwd(), directory).replace(/\\/g, "/")}/${oldName}`;
    const absoluteOld = path.resolve(directory, oldName).replace(/\\/g, "/");
    const absoluteNew = path.resolve(directory, newName).replace(/\\/g, "/");
    const summed = spawnSync("sh", ["-c", 'cd "$1" && sha256sum "$2" > "$2.sha256" && sha256sum "$3" > "$3.sha256"', "sh", unix, newName, oldName], { encoding: "utf8" });
    expect(summed.status, summed.stderr).toBe(0);
    fs.writeFileSync(path.join(directory, "before"), `${relativeOld}\n`);
    fs.writeFileSync(path.join(directory, "old-success"), `[backup] BACKUP SUCCESS: ${absoluteOld}\n`);
    fs.writeFileSync(path.join(directory, "new-success"), `[backup] BACKUP SUCCESS: ${absoluteNew}\n`);
    const rejected = run(disposable({
      STELL22_AC_PHASE: "backup-gate",
      STELL22_AC_BACKUP_STDOUT: `${unix}/old-success`,
      STELL22_AC_BACKUP_BEFORE: `${unix}/before`,
    }));
    expect(rejected.status, rejected.out).not.toBe(0);
    expect(rejected.out).toContain("RESULT=STOP_BACKUP");
    const accepted = run(disposable({
      STELL22_AC_PHASE: "backup-gate",
      STELL22_AC_BACKUP_STDOUT: `${unix}/new-success`,
      STELL22_AC_BACKUP_BEFORE: `${unix}/before`,
    }));
    expect(accepted.status, accepted.out).toBe(0);
    expect(accepted.out).toContain("RESULT=BACKUP_OK");
  }, 30_000);

  it("stops before checkout and app stop when the target schema is present or unreadable", () => {
    const checkoutRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ac-schema-gate-"));
    directories.push(checkoutRoot);
    const checkoutFor = (name: string) => `${checkoutRoot.replace(/\\/g, "/")}/${name}.log`;
    const table = fixture({ schema: absentSchema().replace("batchPackageEdit=false", "batchPackageEdit=true") });
    const tableLog = checkoutFor("table");
    const tableResult = run({ ...table.env, STELL22_AC_PHASE: "gated", STELL22_AC_CHECKOUT_LOG: tableLog, STELL22_AC_GATE_ONLY: "1" });
    expect(tableResult.out).toContain("RESULT=STOP_SCHEMA");
    expect(tableResult.out).toContain("APP_UNCHANGED=YES");
    expect(fs.existsSync(tableLog)).toBe(false);
    expect(fs.existsSync(table.log)).toBe(false);
    const column = fixture({ schema: absentSchema().replace("cancelledAtPresent=false", "cancelledAtPresent=true") });
    const columnLog = checkoutFor("column");
    const columnResult = run({ ...column.env, STELL22_AC_PHASE: "gated", STELL22_AC_CHECKOUT_LOG: columnLog, STELL22_AC_GATE_ONLY: "1" });
    expect(columnResult.out).toContain("RESULT=STOP_SCHEMA");
    expect(fs.existsSync(columnLog)).toBe(false);
    expect(fs.existsSync(column.log)).toBe(false);
    const probe = fixture({});
    const probeLog = checkoutFor("probe");
    const probeResult = run({ ...probe.env, STELL22_AC_PHASE: "gated", STELL22_AC_CHECKOUT_LOG: probeLog, STELL22_AC_GATE_ONLY: "1", STELL22_AC_SQL_FAIL: "preflight" });
    expect(probeResult.out).toContain("RESULT=STOP_SCHEMA");
    expect(probeResult.out).toContain("APP_UNCHANGED=YES");
    expect(fs.existsSync(probeLog)).toBe(false);
    expect(fs.existsSync(probe.log)).toBe(false);
  }, 30_000);

  it("does not restart the old image after a migration attempt", () => {
    const spec = fixture({});
    const result = run({ ...spec.env, STELL22_AC_FAIL_AFTER_MIGRATE: "1" });
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(result.out).toContain("FORWARD_RECOVERY=YES");
    expect(result.out).not.toContain("RELEASE_APPLIED");
    expect(fs.readFileSync(spec.log, "utf8")).not.toContain("start acrel-app-abcd1234");
  }, 30_000);

  it("leaves the checkout unchanged when preflight fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-checkout-"));
    directories.push(root);
    const log = `${root.replace(/\\/g, "/")}/checkout.log`;
    const spec = fixture({
      privileges: "serverVersionNum=170011\nmigratorLogin=true\nmigratorSuper=false\nmigratorCreate=true\nmigratorOwnsAlteredTable=true\nmigratorOperationTypeUsage=false\nappOperationTypeUsage=false\nappLogin=true\nappSuper=false\ndefaultPrivileges=true\n",
    });
    const result = run({
      ...spec.env,
      STELL22_AC_PHASE: "gated",
      STELL22_AC_CHECKOUT_LOG: log,
      STELL22_AC_GATE_ONLY: "1",
    });
    expect(result.out).toContain("RESULT=STOP_OPERATION_TYPE");
    expect(result.out).toContain("APP_UNCHANGED=YES");
    expect(fs.existsSync(log)).toBe(false);
  }, 30_000);

  it("redacts migrate.log when execution is interrupted", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ac-diag-"));
    directories.push(root);
    const diag = root.replace(/\\/g, "/");
    const secret = "super-secret-migrator-pass";
    fs.writeFileSync(path.join(root, "migrate.log"), `postgresql://stell22_migrator:${secret}@127.0.0.1/acrel_abcd1234\n`);
    const spec = fixture({});
    const result = run({
      ...spec.env,
      STELL22_AC_DIAG_DIR: diag,
      STELL22_AC_SIGNAL_AT: "during-migrate",
    });
    expect(result.status, result.out).not.toBe(0);
    expect(result.out).toContain("RESULT=STOP_SIGNAL");
    expect(result.out).toContain("OLD_IMAGE_RESTART=NO");
    expect(result.out).not.toContain(secret);
    const redacted = fs.readFileSync(path.join(root, "migrate.log"), "utf8");
    expect(redacted).toContain("postgresql://REDACTED");
    expect(redacted).not.toContain(secret);
  }, 30_000);

  it("does not wire restore, reset, or an automatic production deploy", () => {
    const operator = fs.readFileSync(SCRIPT, "utf8");
    const restart = operator.slice(operator.indexOf("# RESTART_OLD_IMAGE_BEGIN"), operator.indexOf("# RESTART_OLD_IMAGE_END"));
    expect(restart).toContain('docker start "$app_container"');
    expect(restart).not.toContain("compose");
    expect(operator).not.toContain("sh scripts/restore-db.sh");
    expect(operator).not.toContain("migrate reset");
    expect(operator).not.toContain("db push");
    expect(operator).not.toContain("prisma migrate resolve");
    expect(operator).not.toContain("unexpected_sessions || true");
    expect(operator).not.toContain('sha256sum -c "${newest}.sha256"');
    expect(operator.indexOf("if ! checkout_after_gate")).toBeGreaterThan(operator.indexOf("decide_ok preflight"));
    const workflow = fs.readFileSync(".github/workflows/release-admin-corrections.yml", "utf8");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/\n\s*push:/);
    expect(workflow).toContain("OWNER_AUTHORIZES_ADMIN_CORRECTIONS_01_RELEASE");
    expect(workflow).toContain("group: production-deploy");
    expect(workflow).toContain("environment: production");
    expect(workflow).not.toContain("prisma migrate deploy");
    expect(workflow).not.toContain('sh "$TMP_DIR/release-checkout.sh"');
    const deploy = fs.readFileSync(".github/workflows/deploy-production.yml", "utf8");
    expect(deploy).toContain("workflow_dispatch:");
    expect(deploy).not.toMatch(/\n\s*push:/);
    expect(deploy).toContain("OWNER_AUTHORIZES_ROLE_SPLIT_RELEASE");
    expect(deploy).not.toContain(MIGRATION_NAME);
    const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
    expect(ci).not.toContain("release-admin-corrections.yml");
  });
});
