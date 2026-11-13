/**
 * Disposable-only operator for one statement-period migration.
 * It does not contain a production mode.
 */
import { PERSISTENT_DATABASE_NAMES } from "../../../../scripts/disposable-migrate-guard.mjs";
import {
  MIGRATION_NAME,
  evaluateOfflineHistory,
  verifyAppliedHistory,
} from "./decide.mjs";

export const POSTGRES_IMAGE =
  "postgres:17-alpine@sha256:eee6c6e1b0894fa4fe0075eb054af9fd1cf39a35321c2d4110626cfe506411fb";
export const RESTORE_DATABASE = "stell22_pbr_dst";
export const MIGRATOR_ROLE = "stell22_migrator";

const RENAMED_DATABASE = /^p1as_[0-9a-f]{8}$/;
const CONTAINER_NAME = /^stell22-pbr-[a-z0-9]{12,32}$/;
const CONTAINER_ID = /^[0-9a-f]{64}$/;
const ANON_VOLUME = /^[0-9a-f]{64}$/;
const PRODUCTION_CONTAINERS = new Set(["stell22-db-prod", "stell22-app", "stell22-caddy", "stell22-db"]);
const PERSISTENT_DATABASES = new Set(PERSISTENT_DATABASE_NAMES);
const VOLUME_NAMES = new Set(["db-data", "caddy-data", "caddy-config"]);

function outcome(code, attempted) {
  return {
    ok: code === "DISPOSABLE_MIGRATION_VERIFIED",
    code,
    attempted,
    scope: "DISPOSABLE_ONLY",
    role: MIGRATOR_ROLE,
    migration: MIGRATION_NAME,
    retryMigration: "NO",
    schemaRestore: "NO",
    databaseRestore: "NO",
    productionAuthorized: false,
    freezePass: false,
    appMigrated: false,
  };
}

function databaseAllowed(name) {
  return name === RESTORE_DATABASE || RENAMED_DATABASE.test(name);
}

function sameImage(value) {
  return value === POSTGRES_IMAGE || value === `docker.io/library/${POSTGRES_IMAGE}`;
}

export function parseEvidence(text) {
  const fields = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return {
    run: fields.run ?? "",
    containerId: (fields.container_id ?? "").toLowerCase(),
    containerName: fields.container_name ?? "",
    networkName: fields.network_name ?? "",
    image: fields.image ?? "",
  };
}

export function parseHistoryText(text) {
  const rows = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const [name, checksum, finished, rolledBack, steps] = line.split("|");
    if (!name || !checksum || !/^\d+$/.test(steps ?? "")) {
      throw new Error("HISTORY_MALFORMED");
    }
    rows.push({
      name,
      checksum,
      finished: finished === "t" || finished === "true",
      rolledBack: rolledBack === "t" || rolledBack === "true",
      steps: Number(steps),
    });
  }
  return rows;
}

export function assessDisposableIdentity(input) {
  const database = String(input?.databaseName ?? "").toLowerCase();
  if (input?.productionContainersPresent === true) return { ok: false, code: "STOP_PRODUCTION_CONTAINER" };
  if (database === "stell22" || PERSISTENT_DATABASES.has(database)) return { ok: false, code: "STOP_PRODUCTION_DATABASE" };
  if (!databaseAllowed(database)) return { ok: false, code: "STOP_DATABASE" };

  const evidence = input?.evidence ?? {};
  const inspect = input?.inspect ?? {};
  const containerName = String(inspect.name ?? "");
  const evidenceName = String(evidence.containerName ?? "");
  const containerId = String(inspect.id ?? "").toLowerCase();
  const evidenceId = String(evidence.containerId ?? "").toLowerCase();
  if (
    !CONTAINER_NAME.test(containerName) ||
    containerName !== evidenceName ||
    PRODUCTION_CONTAINERS.has(containerName) ||
    !CONTAINER_ID.test(containerId) ||
    containerId !== evidenceId ||
    evidence.networkName !== "none" ||
    evidence.image !== POSTGRES_IMAGE ||
    evidence.run.length < 12
  ) {
    return { ok: false, code: "STOP_IDENTITY" };
  }
  if (inspect.networkMode !== "none") return { ok: false, code: "STOP_NETWORK" };
  if (inspect.publishedPorts !== false) return { ok: false, code: "STOP_PUBLISHED_PORT" };
  if (!sameImage(inspect.configImage) || inspect.imageId !== inspect.expectedImageId || !CONTAINER_ID.test(String(inspect.imageId ?? ""))) {
    return { ok: false, code: "STOP_IMAGE" };
  }
  if (inspect.label !== evidence.run || (inspect.composeProject ?? "") !== "") return { ok: false, code: "STOP_IDENTITY" };
  const mounts = Array.isArray(inspect.mounts) ? inspect.mounts : [];
  const dataTmpfs = mounts.some((mount) => mount?.type === "tmpfs" && mount?.destination === "/var/lib/postgresql/data");
  if (inspect.dataTmpfs !== true && !dataTmpfs) return { ok: false, code: "STOP_VOLUME" };
  for (const mount of mounts) {
    if (VOLUME_NAMES.has(mount?.name)) return { ok: false, code: "STOP_VOLUME" };
    if (mount?.type === "volume" && !ANON_VOLUME.test(String(mount?.name ?? ""))) return { ok: false, code: "STOP_VOLUME" };
    if (mount?.type !== "tmpfs" && mount?.type !== "volume") return { ok: false, code: "STOP_VOLUME" };
  }
  return { ok: true, code: "DISPOSABLE_IDENTITY" };
}

function postgres17(version) {
  return /^\d+$/.test(String(version)) && Number(version) >= 170000 && Number(version) < 180000;
}

export function runDisposableStatementMigration(input) {
  const identity = assessDisposableIdentity(input?.identity);
  if (!identity.ok) return outcome(identity.code, false);
  if (input?.attempted === true) return outcome("STOP_RETRY", true);

  let version;
  try {
    version = input.readServerVersion();
  } catch {
    return outcome("STOP_UNCERTAIN", false);
  }
  if (!postgres17(version)) return outcome("STOP_POSTGRES", false);

  let history;
  try {
    history = input.readHistory();
  } catch {
    return outcome("STOP_UNCERTAIN", false);
  }
  const preflight = evaluateOfflineHistory(input.inventory, history);
  if (!preflight.ok) return outcome(preflight.code, false);

  let role;
  try {
    role = input.confirmRole();
  } catch {
    return outcome("STOP_UNCERTAIN", false);
  }
  if (role !== MIGRATOR_ROLE) return outcome("STOP_MIGRATOR", false);

  let migrated;
  try {
    migrated = input.migrate({ role: MIGRATOR_ROLE, database: input.identity.databaseName });
  } catch {
    return outcome("STOP_UNCERTAIN", true);
  }
  if (!migrated || migrated.status !== 0) return outcome("STOP_UNCERTAIN", true);

  let after;
  try {
    after = input.readHistory();
  } catch {
    return outcome("STOP_UNCERTAIN", true);
  }
  const verified = verifyAppliedHistory(input.inventory, after);
  if (!verified.ok) return outcome("STOP_UNCERTAIN", true);
  return outcome("DISPOSABLE_MIGRATION_VERIFIED", true);
}
