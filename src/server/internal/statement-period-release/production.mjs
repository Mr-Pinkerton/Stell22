/**
 * Classifies observations captured by scripts/statement-period-release.sh.
 * It does not accept a caller-supplied facts file as permission to mutate.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MIGRATION_SHA256,
  evaluateOfflineHistory,
  readMigrationInventory,
  verifyAppliedHistory,
} from "./decide.mjs";

export const INSPECTION_APP = "stell22-statement-inspect";
export const ENTRYPOINT = "./docker-entrypoint-app-only.sh";
export const MIGRATOR_ROLE = "stell22_migrator";

const COMMANDS = new Set([
  "history-preflight",
  "history-post",
  "roles",
  "image",
  "writers-before",
  "writers-after",
]);

function inventory() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  return readMigrationInventory(path.join(root, "prisma", "migrations"));
}

function parseHistoryText(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const [name, checksum, finished, rolledBack, steps] = line.split("|");
    if (!name || !checksum || !/^\d+$/.test(steps ?? "")) throw new Error("HISTORY_MALFORMED");
    rows.push({
      name,
      checksum,
      finished: finished === "t" || finished === "true" || finished === "1",
      rolledBack: rolledBack === "t" || rolledBack === "true" || rolledBack === "1",
      steps: Number(steps),
    });
  }
  return rows;
}

function parseLines(text) {
  const facts = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    facts[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return facts;
}

function yes(value) {
  return value === "t" || value === "true" || value === "1";
}

function no(value) {
  return value === "f" || value === "false" || value === "0";
}

export function classifyHistory(kind, text) {
  const rows = parseHistoryText(text);
  const image = inventory();
  if (kind === "history-post") return verifyAppliedHistory(image, rows).code;
  return evaluateOfflineHistory(image, rows).code;
}

export function classifyRoles(text) {
  const facts = parseLines(text);
  const version = facts.serverVersionNum ?? "";
  if (!/^\d+$/.test(version) || Number(version) < 170000 || Number(version) >= 180000) return "STOP_MIGRATOR";
  if (!yes(facts.migratorLogin) || !no(facts.migratorSuper) || !no(facts.appInsert)) return "STOP_MIGRATOR";
  return "ROLES_OBSERVED";
}

function imageId(value) {
  return /^sha256:[0-9a-f]{64}$/.test(value);
}

export function classifyImage(text) {
  const facts = parseLines(text);
  const entrypoint = facts.entrypoint ?? "";
  if (!entrypoint.includes(ENTRYPOINT) || entrypoint.includes("prisma migrate") || entrypoint.includes("migrate deploy")) {
    return "STOP_IMAGE";
  }
  if (facts.migrationSha256 !== MIGRATION_SHA256 || facts.composeUser !== "stell22_app" || facts.migrateOnStart !== "0") {
    return "STOP_IMAGE";
  }
  if (!imageId(facts.builtImageId) || !imageId(facts.legacyImageId) || facts.builtImageId === facts.legacyImageId) {
    return "STOP_IMAGE";
  }
  return "IMAGE_OBSERVED";
}

export function classifyWriters(text, phase) {
  const beforeStop = phase === "before";
  const [sessionPart, processPart] = String(text).split(/\r?\nPROCESSES\r?\n/);
  const sessions = String(sessionPart ?? "").replace(/^SESSIONS\r?\n/, "");
  for (const raw of sessions.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const [user, applicationName, backendType] = line.split("|");
    if (backendType !== "client backend") continue;
    const inspection = user === "stell22" && applicationName === INSPECTION_APP;
    const appSession = user === "stell22_app";
    if (beforeStop) {
      if (!inspection && !appSession) return "STOP_WRITER";
    } else if (!inspection) return "STOP_WRITER";
  }
  for (const raw of String(processPart ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.includes("statement-period-release.sh") || line.includes("production.mjs")) continue;
    if (/backup-db\.sh|pg_dump|fetch-statements|prisma migrate|scripts\/deploy\.sh|release-role-split\.sh|ci-prod-remote\.sh/.test(line)) {
      return "STOP_WRITER";
    }
  }
  return "WRITERS_CURRENTLY_CLEAR";
}

function printCode(code) {
  const ok = code === "OFFLINE_HISTORY_CONTRACT_MATCHED"
    || code === "POST_MIGRATION_VERIFIED"
    || code === "ROLES_OBSERVED"
    || code === "IMAGE_OBSERVED"
    || code === "WRITERS_CURRENTLY_CLEAR";
  process.stdout.write(`CODE=${code}\n`);
  if (!ok) process.exitCode = 1;
}

function main() {
  const command = process.argv[2] ?? "";
  if (command.endsWith(".json") || (process.env.STELL22_STATEMENT_FACTS ?? "") !== "") {
    process.stdout.write("RESULT=STOP_LOCKED\nPRODUCTION_AUTHORIZED=NO\nFREEZE_PASS=NO\n");
    process.exitCode = 1;
    return;
  }
  if (!COMMANDS.has(command)) {
    process.stdout.write("RESULT=STOP_LOCKED\nPRODUCTION_AUTHORIZED=NO\nFREEZE_PASS=NO\n");
    process.exitCode = 1;
    return;
  }
  const text = fs.readFileSync(0, "utf8");
  if (command === "history-preflight" || command === "history-post") printCode(classifyHistory(command, text));
  else if (command === "roles") printCode(classifyRoles(text));
  else if (command === "image") printCode(classifyImage(text));
  else if (command === "writers-before") printCode(classifyWriters(text, "before"));
  else printCode(classifyWriters(text, "after"));
}

if (process.argv[1] && process.argv[1].endsWith("production.mjs")) main();
