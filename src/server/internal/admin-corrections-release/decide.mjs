/**
 * Fail-closed decisions for the ADMIN-CORRECTIONS-01 release.
 * This module does not open a database, restore a backup, or retry a migration.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const AUTHORIZATION_PHRASE = "OWNER_AUTHORIZES_ADMIN_CORRECTIONS_01_RELEASE";
export const REJECTED_AUTHORIZATION_PHRASE = "OWNER_AUTHORIZES_ROLE_SPLIT_RELEASE";
export const MIGRATION_NAME = "20261025120000_admin_corrections_batch_and_cancel";
export const MIGRATION_SHA256 = "d8d83b48d536bd42cb9f394958dc981003d43da5b5904bcecadd3899b179f834";
export const APPLIED_BEFORE = 46;
export const APPLIED_AFTER = 47;
export const IMAGE_COUNT = 47;
export const MIGRATE_LOGIN = "stell22_migrator";
export const APP_LOGIN = "stell22_app";
export const FORBIDDEN_MIGRATE_LOGINS = ["stell22", "stell22_app", "postgres"];
export const PRODUCTION_DATABASE = "stell22";
export const DISPOSABLE_DATABASE = /^acrel_[0-9a-f]{8}$/;
export const DISPOSABLE_DB_CONTAINER = /^acrel-db-[0-9a-f]{8}$/;
export const DISPOSABLE_APP_CONTAINER = /^acrel-app-[0-9a-f]{8}$/;
export const PRODUCTION_CONTAINERS = ["stell22-db-prod", "stell22-app", "stell22-caddy"];
export const ENTRYPOINT = "./docker-entrypoint-app-only.sh";

const SHA = /^[0-9a-f]{40}$/;
const SUM = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const SECRET_KEY = /password|secret|token|database_url|pwd|authorization_phrase/i;

export function migrationSha256(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const normalized = Buffer.alloc(buffer.length);
  let length = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index] ?? 0;
    if (byte === 13) {
      if (buffer[index + 1] !== 10) throw new Error("STANDALONE_CR");
      continue;
    }
    normalized[length] = byte;
    length += 1;
  }
  return createHash("sha256").update(normalized.subarray(0, length)).digest("hex");
}

export function readMigrationInventory(migrationsDirectory) {
  if (!fs.existsSync(migrationsDirectory) || !fs.statSync(migrationsDirectory).isDirectory()) {
    throw new Error("MIGRATION_DIRECTORY_MISSING");
  }
  const names = fs
    .readdirSync(migrationsDirectory)
    .filter((name) => fs.existsSync(path.join(migrationsDirectory, name, "migration.sql")))
    .sort();
  return names.map((name) => ({
    name,
    sha256: migrationSha256(fs.readFileSync(path.join(migrationsDirectory, name, "migration.sql"))),
  }));
}

export function parseFacts(text) {
  const facts = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new Error("FACT_MALFORMED");
    const key = line.slice(0, eq);
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error("FACT_MALFORMED");
    if (SECRET_KEY.test(key)) throw new Error("SECRET_FACT");
    facts[key] = line.slice(eq + 1);
  }
  return facts;
}

export function parseHistory(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const parts = line.split("|");
    if (parts.length !== 5) throw new Error("HISTORY_MALFORMED");
    const [name, checksum, finished, rolledBack, steps] = parts;
    if (!/^[0-9]{14}_[a-z0-9_]+$/.test(name ?? "") || !SUM.test(checksum ?? "")) {
      throw new Error("HISTORY_MALFORMED");
    }
    if (!/^\d+$/.test(steps ?? "")) throw new Error("HISTORY_MALFORMED");
    rows.push({
      name,
      checksum,
      finished: finished === "true" || finished === "1",
      rolledBack: rolledBack === "true" || rolledBack === "1",
      steps: Number(steps),
    });
  }
  return rows;
}

export function compareHistory(image, history) {
  const facts = {
    imageCount: String(image.length),
    historyCount: String(history.length),
    historyFinished: "0",
    historyIncomplete: "0",
    historyRolledBack: "0",
    duplicateHistory: "0",
    checksumMismatch: "0",
    extraHistory: "0",
    pendingCount: "0",
    pendingName: "",
    pendingSha256: "",
    targetPresent: "0",
    targetChecksum: "",
    targetSteps: "",
    targetFinished: "0",
  };
  const seen = new Set();
  let finished = 0;
  let incomplete = 0;
  let rolled = 0;
  const imageByName = new Map(image.map((migration) => [migration.name, migration.sha256]));
  for (const row of history) {
    if (seen.has(row.name)) facts.duplicateHistory = "1";
    seen.add(row.name);
    if (row.rolledBack) rolled += 1;
    if (!row.finished || row.rolledBack || row.steps !== 1) incomplete += 1;
    else finished += 1;
    const expected = imageByName.get(row.name);
    if (expected === undefined) facts.extraHistory = "1";
    else if (expected !== row.checksum) facts.checksumMismatch = "1";
  }
  const pending = image.filter((migration) => !seen.has(migration.name));
  facts.historyFinished = String(finished);
  facts.historyIncomplete = String(incomplete);
  facts.historyRolledBack = String(rolled);
  facts.pendingCount = String(pending.length);
  if (pending.length === 1) {
    facts.pendingName = pending[0]?.name ?? "";
    facts.pendingSha256 = pending[0]?.sha256 ?? "";
  }
  const target = history.find((row) => row.name === MIGRATION_NAME);
  if (target) {
    facts.targetPresent = "1";
    facts.targetChecksum = target.checksum;
    facts.targetSteps = String(target.steps);
    facts.targetFinished = target.finished && !target.rolledBack && target.steps === 1 ? "1" : "0";
  }
  return facts;
}

function yes(facts, key) {
  const value = facts[key];
  return value === "1" || value === "true";
}

function no(facts, key) {
  const value = facts[key];
  return value === "0" || value === "false";
}

function decision(ok, code, action) {
  return { ok, code, action, databaseRestore: "NO", retryMigration: "NO" };
}

function historyReady(facts, applied) {
  return (
    facts.imageCount === String(IMAGE_COUNT) &&
    facts.historyFinished === String(applied) &&
    facts.historyIncomplete === "0" &&
    facts.historyRolledBack === "0" &&
    facts.duplicateHistory === "0" &&
    facts.checksumMismatch === "0" &&
    facts.extraHistory === "0"
  );
}

function privilegesReady(facts) {
  return (
    yes(facts, "migratorLogin") &&
    no(facts, "migratorSuper") &&
    yes(facts, "migratorCreate") &&
    yes(facts, "migratorOwnsAlteredTable") &&
    yes(facts, "migratorOperationTypeUsage") &&
    yes(facts, "appOperationTypeUsage") &&
    yes(facts, "appLogin") &&
    no(facts, "appSuper") &&
    yes(facts, "defaultPrivileges") &&
    /^\d+$/.test(facts.serverVersionNum ?? "") &&
    Number(facts.serverVersionNum) >= 170000 &&
    Number(facts.serverVersionNum) < 180000
  );
}

function pendingIsTarget(facts) {
  return (
    facts.pendingCount === "1" &&
    facts.pendingName === MIGRATION_NAME &&
    facts.pendingSha256 === MIGRATION_SHA256 &&
    facts.targetPresent === "0"
  );
}

export function entrypointAdmitted(entrypoint) {
  return (
    typeof entrypoint === "string" &&
    entrypoint.includes(ENTRYPOINT) &&
    !entrypoint.includes("prisma migrate") &&
    !entrypoint.includes("migrate deploy")
  );
}

export function assertMigratorUrl(text, mode) {
  const line = String(text).trim();
  const prefix = "DATABASE_URL=";
  if (!line.startsWith(prefix) || line.slice(prefix.length).includes("\n")) {
    return decision(false, "STOP_MIGRATOR", "none");
  }
  let parsed;
  try {
    parsed = new URL(line.slice(prefix.length));
  } catch {
    return decision(false, "STOP_MIGRATOR", "none");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  const user = decodeURIComponent(parsed.username);
  if (FORBIDDEN_MIGRATE_LOGINS.includes(user) || user !== MIGRATE_LOGIN) {
    return decision(false, "STOP_MIGRATOR", "none");
  }
  if (parsed.hostname !== "127.0.0.1" || parsed.password.length < 24) {
    return decision(false, "STOP_MIGRATOR", "none");
  }
  if (mode === "production" && database !== PRODUCTION_DATABASE) {
    return decision(false, "STOP_MIGRATOR", "none");
  }
  if (mode === "disposable" && !DISPOSABLE_DATABASE.test(database)) {
    return decision(false, "STOP_MIGRATOR", "none");
  }
  if (mode !== "production" && mode !== "disposable") {
    return decision(false, "STOP_MIGRATOR", "none");
  }
  return decision(true, "MIGRATOR_URL_READY", "none");
}

export function disposableIdentityAllowed(facts) {
  if (!DISPOSABLE_DATABASE.test(facts.database ?? "")) return false;
  if (!DISPOSABLE_DB_CONTAINER.test(facts.dbContainer ?? "")) return false;
  if (facts.appContainer !== undefined && facts.appContainer !== "" && !DISPOSABLE_APP_CONTAINER.test(facts.appContainer)) {
    return false;
  }
  const joined = `${facts.database} ${facts.dbContainer} ${facts.appContainer ?? ""} ${facts.inspectUser ?? ""}`;
  if (PRODUCTION_CONTAINERS.some((name) => joined.includes(name))) return false;
  if (/\bstell22\b/.test(facts.database ?? "")) return false;
  if (!facts.inspectUser || facts.inspectUser.length < 3) return false;
  if (facts.inspectUser === MIGRATE_LOGIN || facts.inspectUser === APP_LOGIN || facts.inspectUser === "stell22") return false;
  return true;
}

export function recoveryAction(facts) {
  if (facts.stage === "before-stop") return "none";
  if (facts.stage === "signal") return "stop";
  if (yes(facts, "migrationAttempted") || facts.stage === "migration-uncertain" || facts.stage === "app-start-failed") {
    return "forward-recovery";
  }
  if (
    facts.stage === "after-stop" &&
    yes(facts, "historyUnchanged") &&
    yes(facts, "schemaUnchanged") &&
    yes(facts, "targetObjectsAbsent") &&
    yes(facts, "schemaCompared") &&
    yes(facts, "oldImageIdentity") &&
    yes(facts, "sessionClear") &&
    yes(facts, "processesClear") &&
    no(facts, "unexpectedWrites") &&
    no(facts, "migrationAttempted") &&
    yes(facts, "oldImageAppOnly")
  ) {
    return "restart-old";
  }
  if (facts.stage === "success") return "release";
  return "stop";
}

export function decide(event, facts) {
  if (event === "lock") {
    if ((facts.restore ?? "") !== "") return decision(false, "STOP_NO_RESTORE", "none");
    if (facts.authorization === REJECTED_AUTHORIZATION_PHRASE) return decision(false, "STOP_OWNER_GATE", "none");
    if (facts.execute !== "1" || facts.maintenance !== "1" || facts.authorization !== AUTHORIZATION_PHRASE) {
      return decision(false, "STOP_OWNER_GATE", "none");
    }
    if ((facts.ci ?? "") !== "1") return decision(false, "STOP_CHECKOUT", "none");
    return decision(true, "LOCK_OPEN", "none");
  }
  if (event === "remote-sha" || event === "sha") {
    if (!SHA.test(facts.sha ?? "") || facts.sha !== facts.originMain) {
      return decision(false, "STOP_CHECKOUT", "none");
    }
    if (event === "sha" && facts.sha !== facts.head) return decision(false, "STOP_CHECKOUT", "none");
    if ((facts.ci ?? "") !== "1") return decision(false, "STOP_CHECKOUT", "none");
    return decision(true, "SHA_APPROVED", "none");
  }
  if (event === "preflight") {
    if (!privilegesReady(facts)) {
      if (!yes(facts, "migratorOperationTypeUsage") || !yes(facts, "appOperationTypeUsage")) {
        return decision(false, "STOP_OPERATION_TYPE", "none");
      }
      if (!yes(facts, "defaultPrivileges")) return decision(false, "STOP_DEFAULT_PRIVILEGES", "none");
      if (!yes(facts, "migratorLogin") || yes(facts, "migratorSuper")) return decision(false, "STOP_MIGRATOR", "none");
      return decision(false, "STOP_PREFLIGHT", "none");
    }
    if (facts.historyIncomplete !== "0" || facts.historyRolledBack !== "0" || facts.duplicateHistory !== "0") {
      return decision(false, "STOP_INCOMPLETE", "none");
    }
    if (facts.checksumMismatch !== "0") return decision(false, "STOP_CHECKSUM", "none");
    if (historyReady(facts, APPLIED_AFTER) && facts.pendingCount === "0" && facts.targetFinished === "1" && facts.targetChecksum === MIGRATION_SHA256) {
      return decision(false, "STOP_ALREADY_APPLIED", "none");
    }
    if (!historyReady(facts, APPLIED_BEFORE) || !pendingIsTarget(facts)) {
      if (facts.pendingCount !== "1") return decision(false, "STOP_PENDING", "none");
      return decision(false, "STOP_PREFLIGHT", "none");
    }
    if (!yes(facts, "appHealthy") || !yes(facts, "dbHealthy") || !yes(facts, "caddyPresent") || !yes(facts, "dbVolumePresent")) {
      return decision(false, "STOP_HEALTH", "none");
    }
    if (!no(facts, "backupRunning") || !no(facts, "importRunning") || !no(facts, "migrateProcess") || !no(facts, "conflictingDeploy")) {
      return decision(false, "STOP_WRITER", "none");
    }
    if (!yes(facts, "protectedFilesOk") || !yes(facts, "runningImagePresent") || !entrypointAdmitted(facts.runningEntrypoint ?? "")) {
      return decision(false, "STOP_IMAGE", "none");
    }
    return decision(true, "PREFLIGHT_OK", "none");
  }
  if (event === "image") {
    if (!yes(facts, "buildOk")) return decision(false, "STOP_IMAGE", "none");
    if (!entrypointAdmitted(facts.entrypoint ?? "") || facts.imageHasMigrateOnStart !== "0") {
      return decision(false, "STOP_IMAGE", "none");
    }
    if (facts.migrationSha256 !== MIGRATION_SHA256 || facts.composeAppUser !== APP_LOGIN) {
      return decision(false, "STOP_IMAGE", "none");
    }
    if (!IMAGE_ID.test(facts.imageId ?? "") || !IMAGE_ID.test(facts.legacyImageId ?? "") || facts.imageId === facts.legacyImageId) {
      return decision(false, "STOP_IMAGE", "none");
    }
    return decision(true, "IMAGE_READY", "none");
  }
  if (event === "writers") {
    if (!yes(facts, "appStopped") || !yes(facts, "inspectionOnly") || !no(facts, "unexpectedSessions")) {
      return decision(false, "STOP_WRITER", "none");
    }
    if (!no(facts, "backupRunning") || !no(facts, "importRunning") || !no(facts, "migrateProcess") || !no(facts, "conflictingDeploy")) {
      return decision(false, "STOP_WRITER", "none");
    }
    return decision(true, "WRITERS_CLEAR", "none");
  }
  if (event === "backup") {
    if (!yes(facts, "backupOk") || !yes(facts, "checksumOk")) return decision(false, "STOP_BACKUP", "none");
    return decision(true, "BACKUP_OK", "none");
  }
  if (event === "premigrate") {
    if (facts.migrateLogin !== MIGRATE_LOGIN || !yes(facts, "migratorCredentialReady")) {
      return decision(false, "STOP_MIGRATOR", "none");
    }
    if (!yes(facts, "historyUnchanged") || !yes(facts, "schemaUnchanged")) {
      return decision(false, "STOP_HISTORY", "stop");
    }
    if (!historyReady(facts, APPLIED_BEFORE) || !pendingIsTarget(facts) || !privilegesReady(facts)) {
      return decision(false, "STOP_PREFLIGHT", "stop");
    }
    if (!no(facts, "unexpectedSessions") || !no(facts, "backupRunning") || !no(facts, "importRunning") || !no(facts, "migrateProcess")) {
      return decision(false, "STOP_WRITER", "stop");
    }
    return decision(true, "MIGRATE_READY", "none");
  }
  if (event === "postmigrate") {
    if (!historyReady(facts, APPLIED_AFTER) || facts.pendingCount !== "0") {
      return decision(false, "STOP_POST_MIGRATE", "forward-recovery");
    }
    if (facts.targetPresent !== "1" || facts.targetFinished !== "1" || facts.targetChecksum !== MIGRATION_SHA256 || facts.targetSteps !== "1") {
      return decision(false, "STOP_POST_MIGRATE", "forward-recovery");
    }
    const objects = [
      "batchPackageEdit",
      "productionOperationCancellation",
      "cancelledAtNullable",
      "indexProductionOperationCancelledAt",
      "indexBatchRequest",
      "indexBatchBatchRecorded",
      "indexCancelRequest",
      "indexCancelOperation",
      "indexCancelOperationRecorded",
      "appTablePrivileges",
    ];
    if (objects.some((key) => !yes(facts, key))) return decision(false, "STOP_POST_MIGRATE", "forward-recovery");
    if (facts.sentinelProductionOperation !== facts.sentinelProductionOperationBefore) {
      return decision(false, "STOP_POST_MIGRATE", "forward-recovery");
    }
    if (facts.sentinelInventoryMovement !== facts.sentinelInventoryMovementBefore) {
      return decision(false, "STOP_POST_MIGRATE", "forward-recovery");
    }
    return decision(true, "MIGRATION_VERIFIED", "none");
  }
  if (event === "recovery") {
    const action = recoveryAction(facts);
    if (action === "restart-old") return decision(true, "RESTART_OLD", action);
    if (action === "release") return decision(true, "RELEASE_APPLIED", action);
    if (action === "forward-recovery") return decision(false, "FORWARD_RECOVERY", action);
    if (action === "none") return decision(false, "APP_UNCHANGED", action);
    return decision(false, "STOP", action);
  }
  return decision(false, "STOP_PREFLIGHT", "stop");
}

function printDecision(result) {
  process.stdout.write(`OK=${result.ok ? "YES" : "NO"}\nCODE=${result.code}\nACTION=${result.action}\nDATABASE_RESTORE=${result.databaseRestore}\nRETRY_MIGRATION=${result.retryMigration}\n`);
}

function main() {
  const [event, file, mode] = process.argv.slice(2);
  if (event === "inventory") {
    const rows = readMigrationInventory(file ?? "");
    process.stdout.write(rows.map((row) => `${row.name} ${row.sha256}\n`).join(""));
    return;
  }
  if (event === "compare") {
    const image = fs
      .readFileSync(file ?? "", "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, sha256] = line.split(" ");
        if (!name || !SUM.test(sha256 ?? "")) throw new Error("INVENTORY_MALFORMED");
        return { name, sha256 };
      });
    const history = parseHistory(fs.readFileSync(mode ?? "", "utf8"));
    const facts = compareHistory(image, history);
    process.stdout.write(Object.entries(facts).map(([key, value]) => `${key}=${value}\n`).join(""));
    return;
  }
  if (event === "assert-url") {
    const result = assertMigratorUrl(fs.readFileSync(file ?? "", "utf8"), mode ?? "");
    printDecision(result);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (event === "identity") {
    const facts = parseFacts(fs.readFileSync(file ?? "", "utf8"));
    const allowed = disposableIdentityAllowed(facts);
    printDecision(decision(allowed, allowed ? "DISPOSABLE_IDENTITY" : "STOP_LOCKED", "none"));
    if (!allowed) process.exitCode = 1;
    return;
  }
  if (!event || !file) {
    process.stderr.write("RESULT=STOP_PREFLIGHT\n");
    process.exitCode = 1;
    return;
  }
  const facts = parseFacts(fs.readFileSync(file, "utf8"));
  const result = decide(event, facts);
  printDecision(result);
  if (!result.ok) process.exitCode = 1;
}

function invokedDirectly() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    if (import.meta.url === pathToFileURL(arg).href) return true;
  } catch {
    return false;
  }
  return false;
}

if (invokedDirectly()) main();
