/**
 * Offline history contract for one migration:
 * 20261105120000_statement_period_coverage.
 * A match is not permission to migrate, deploy, restart, or restore.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MIGRATION_NAME = "20261105120000_statement_period_coverage";
export const MIGRATION_SHA256 = "9625815128d45b4cf4397b6360ae5bf28ac4b3ef2033baefa4d85142f907c52e";
export const IMAGE_COUNT = 48;
export const APPLIED_BEFORE = 47;
export const APPLIED_AFTER = 48;
export const CONTRACT = "OFFLINE_HISTORY_ONLY";

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

function result(ok, code) {
  return {
    ok,
    code,
    contract: CONTRACT,
    migrationAuthorized: false,
    productionAuthorized: false,
    writerExclusionProven: false,
    freezePass: false,
    databaseRestore: "NO",
    retryMigration: "NO",
    deploy: "NO",
    restart: "NO",
    sql: "NO",
  };
}

function inspect(inventory, history) {
  if (!Array.isArray(inventory) || inventory.length !== IMAGE_COUNT) return "STOP_IMAGE_COUNT";
  const seenImage = new Set();
  for (const row of inventory) {
    if (!row || typeof row.name !== "string" || seenImage.has(row.name)) return "STOP_DUPLICATE";
    seenImage.add(row.name);
  }
  const target = inventory.find((row) => row.name === MIGRATION_NAME);
  if (!target || target.sha256 !== MIGRATION_SHA256) return "STOP_TARGET_CHECKSUM";
  if (!Array.isArray(history)) return "STOP_HISTORY_COUNT";

  const seen = new Set();
  let finished = 0;
  let incomplete = 0;
  let rolled = 0;
  let checksumMismatch = false;
  let extra = false;
  const imageByName = new Map(inventory.map((row) => [row.name, row.sha256]));
  for (const row of history) {
    if (!row || typeof row.name !== "string" || seen.has(row.name)) return "STOP_DUPLICATE";
    seen.add(row.name);
    if (row.rolledBack === true) rolled += 1;
    if (row.finished === true && row.rolledBack !== true && row.steps === 1) finished += 1;
    else incomplete += 1;
    const expected = imageByName.get(row.name);
    if (expected === undefined) extra = true;
    else if (expected !== row.checksum) checksumMismatch = true;
  }
  if (extra) return "STOP_EXTRA";
  if (rolled > 0) return "STOP_ROLLED_BACK";
  if (incomplete > 0) return "STOP_INCOMPLETE";
  if (checksumMismatch) return "STOP_CHECKSUM";

  const pending = inventory.filter((row) => !seen.has(row.name));
  return { finished, pending };
}

function classifyPreflight(found) {
  if (typeof found === "string") return found;
  const { finished, pending } = found;
  if (finished === APPLIED_AFTER && pending.length === 0) return "STOP_ALREADY_APPLIED";
  if (finished === 45 || finished === 46) return "STOP_HISTORY_COUNT";
  if (pending.length !== 1) return "STOP_PENDING";
  if (pending[0]?.name !== MIGRATION_NAME) return "STOP_PENDING_NAME";
  if (pending[0]?.sha256 !== MIGRATION_SHA256) return "STOP_TARGET_CHECKSUM";
  if (finished !== APPLIED_BEFORE) return "STOP_HISTORY_COUNT";
  return "OFFLINE_HISTORY_CONTRACT_MATCHED";
}

function classifyApplied(found) {
  if (typeof found === "string") return found;
  const { finished, pending } = found;
  if (finished === APPLIED_AFTER && pending.length === 0) return "POST_MIGRATION_VERIFIED";
  if (finished === APPLIED_BEFORE && pending.length === 1 && pending[0]?.name === MIGRATION_NAME) return "STOP_NOT_APPLIED";
  if (pending.length > 1) return "STOP_PENDING";
  if (pending.length === 1 && pending[0]?.name !== MIGRATION_NAME) return "STOP_PENDING_NAME";
  return "STOP_HISTORY_COUNT";
}

export function evaluateOfflineHistory(inventory, history) {
  const code = classifyPreflight(inspect(inventory, history));
  return result(code === "OFFLINE_HISTORY_CONTRACT_MATCHED", code);
}

export function verifyAppliedHistory(inventory, history) {
  const code = classifyApplied(inspect(inventory, history));
  return result(code === "POST_MIGRATION_VERIFIED", code);
}
