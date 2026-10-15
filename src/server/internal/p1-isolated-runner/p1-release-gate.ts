import { createHash } from "node:crypto";
import {
  EXPECTED_HISTORICAL_MIGRATION_COUNT,
  FORBIDDEN_CONTAINER_IDENTIFIERS,
  FORBIDDEN_DATABASE_NAMES,
  HISTORICAL_APPLICATION_COMMIT,
  P1_GIT_BLOB,
  P1_MIGRATION_NAME,
  P1_MIGRATION_PATH,
  P1_SHA256,
} from "@/server/internal/p1-isolated-runner/contract";
import { classifyP1State, type PrismaMigrationRow } from "@/server/internal/p1-isolated-runner/classify";
import { PINNED_MIGRATION_FILES } from "@/server/internal/p1-isolated-runner/inventory";
import type { GitBlobSource } from "@/server/internal/p1-isolated-runner/migration-set";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";
import type { P1SchemaEvidence } from "@/server/internal/p1-isolated-runner/schema-contract";

/**
 * P1-only release gate.
 * An image id is an immutable runtime identity. It is not a Git SHA.
 * A caller string such as RESTORE_VERIFIED is not recovery evidence.
 * Production container names, the production database, and the production
 * compose network stay unauthorized in this package.
 */

export const IMAGE_GIT_SHA = "UNVERIFIED" as const;
export const ONE_SHOT_IMAGE = "stell22-p1-oneshot:node22" as const;
export const ONE_SHOT_BASE_IMAGE = "node:22-bookworm-slim" as const;
export const PRODUCTION_NETWORK_NAME = "stell22_default" as const;

const CONTAINER_ID = /^[0-9a-f]{64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const ATTEMPT_ID = /^[0-9a-f]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISOLATED_DB_NAME = /^p1disp_[0-9a-f]+$/;
const ISOLATED_DB_CONTAINER = /^stell22-p1-disposable-[0-9a-f-]{36}$/;
const ISOLATED_APP_CONTAINER = /^p1rel-app-[0-9a-f]{16}$/;

const PRODUCTION_NAMES = new Set<string>(FORBIDDEN_CONTAINER_IDENTIFIERS);

export type ContainerIdentity = {
  id: string;
  imageId: string;
  startedAt: string;
  running: boolean;
  name: string;
  entrypoint: readonly string[];
  command: readonly string[];
};

export type TopologyObservation = {
  attemptId: string;
  app: ContainerIdentity;
  db: ContainerIdentity;
  databaseName: string;
  roleName: string;
  networkName: string;
};

export type CatalogProbe = {
  migrationFingerprint: string;
  logicalSchemaFingerprint: string;
  publicTableCount: number;
  successfulMigrationCount: number;
  failedMigrationCount: number;
  userRowCount: number;
};

export type RestoredProbe = CatalogProbe & { exitCode: number };

export type RecoveryClaim = {
  attemptId: string;
  archiveSha256: string;
};

export function productionReleaseAuthorized(): false {
  return false;
}

export function assessWriterDeployPrerequisite(input: {
  history: readonly PrismaMigrationRow[];
  schema: P1SchemaEvidence;
}): { allow: boolean; code: string } {
  const result = classifyP1State(input);
  if (result.verdict === "ALREADY_APPLIED" && result.code === "P1_APPLIED") {
    return { allow: true, code: result.code };
  }
  return { allow: false, code: result.code };
}

export function verifyPinnedHistoricalPlusP1(source: GitBlobSource): {
  historicalCount: 45;
  p1Sha256: string;
  p1GitBlob: string;
} {
  const resolved = source.resolveCommit(HISTORICAL_APPLICATION_COMMIT);
  if (resolved.commit !== HISTORICAL_APPLICATION_COMMIT) {
    throw refusal("STOP", "PREFLIGHT_DRIFT", "Historical commit pin does not match");
  }
  const listed = source
    .listMigrationTree(HISTORICAL_APPLICATION_COMMIT)
    .filter((entry) => entry.path.endsWith("/migration.sql"));
  if (listed.length !== EXPECTED_HISTORICAL_MIGRATION_COUNT) {
    throw refusal("STOP", "PREFLIGHT_DRIFT", "Historical migration count is not 45");
  }
  if (listed.some((entry) => entry.path.includes(P1_MIGRATION_NAME))) {
    throw refusal("STOP", "PREFLIGHT_DRIFT", "Historical tree contains P1");
  }
  const pinnedHistorical = PINNED_MIGRATION_FILES.filter(
    (entry) => entry.path.endsWith("/migration.sql") && !entry.path.includes(P1_MIGRATION_NAME),
  );
  if (pinnedHistorical.length !== EXPECTED_HISTORICAL_MIGRATION_COUNT) {
    throw refusal("STOP", "PREFLIGHT_DRIFT", "Pinned historical migration count is not 45");
  }
  const blobs = new Map(listed.map((entry) => [entry.path, entry.gitBlob]));
  for (const entry of pinnedHistorical) {
    if (blobs.get(entry.path) !== entry.gitBlob) {
      throw refusal("STOP", "PREFLIGHT_DRIFT", "Historical migration blob does not match the pin");
    }
    const hash = createHash("sha256").update(source.readBlob(entry.gitBlob)).digest("hex");
    if (hash !== entry.sha256) {
      throw refusal("STOP", "PREFLIGHT_DRIFT", "Historical migration checksum does not match the pin");
    }
  }
  const p1 = PINNED_MIGRATION_FILES.find((entry) => entry.path === P1_MIGRATION_PATH);
  if (!p1 || p1.gitBlob !== P1_GIT_BLOB || p1.sha256 !== P1_SHA256) {
    throw refusal("STOP", "PREFLIGHT_DRIFT", "Pinned P1 identity does not match the contract");
  }
  const p1Hash = createHash("sha256").update(source.readBlob(P1_GIT_BLOB)).digest("hex");
  if (p1Hash !== P1_SHA256) {
    throw refusal("STOP", "PREFLIGHT_DRIFT", "P1 blob checksum does not match the pin");
  }
  return { historicalCount: 45, p1Sha256: P1_SHA256, p1GitBlob: P1_GIT_BLOB };
}

export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function migrationHistoryFingerprint(
  rows: readonly { name: string; checksum: string; finished: boolean; rolledBack: boolean; steps: number }[],
): string {
  const lines = rows
    .map(
      (row) =>
        `${row.name}|${row.checksum}|${row.finished ? "1" : "0"}|${row.rolledBack ? "1" : "0"}|${row.steps}`,
    )
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export type LogicalColumn = {
  schema: string;
  table: string;
  column: string;
  type: string;
  nullable: string;
  columnDefault: string | null;
  identity: string;
  generated: string;
  collation: string | null;
};

export type LogicalConstraint = {
  schema: string;
  table: string;
  name: string;
  type: string;
  validated: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
  definition: string;
};

/**
 * Recovery fingerprint. Parentheses stay in the definition because they
 * can change boolean meaning. Only whitespace outside quoted literals is
 * collapsed. OID and attnum are not part of the identity.
 */
export function logicalSchemaFingerprint(input: {
  columns: readonly LogicalColumn[];
  constraints: readonly LogicalConstraint[];
}): string {
  const columns = input.columns
    .map(
      (row) =>
        [
          row.schema,
          row.table,
          row.column,
          row.type,
          row.nullable,
          `default=${presentOrNull(row.columnDefault)}`,
          `identity=${presentOrNull(row.identity)}`,
          `generated=${presentOrNull(row.generated)}`,
          `collation=${presentOrNull(row.collation)}`,
        ].join("|"),
    )
    .sort();
  const constraints = input.constraints
    .map(
      (row) =>
        [
          row.schema,
          row.table,
          row.name,
          row.type,
          row.validated ? "validated" : "not-validated",
          row.deferrable ? "deferrable" : "not-deferrable",
          row.initiallyDeferred ? "initially-deferred" : "not-initially-deferred",
          normalizeConstraintDefinition(row.definition),
        ].join("|"),
    )
    .sort();
  return createHash("sha256").update(`${columns.join("\n")}\n--\n${constraints.join("\n")}`).digest("hex");
}

export function normalizeConstraintDefinition(definition: string): string {
  let out = "";
  let quoted = false;
  for (let index = 0; index < definition.length; index += 1) {
    const char = definition[index] ?? "";
    if (quoted) {
      out += char;
      if (char === "'" && definition[index + 1] === "'") {
        out += "'";
        index += 1;
        continue;
      }
      if (char === "'") quoted = false;
      continue;
    }
    if (char === "'") {
      quoted = true;
      out += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (!out.endsWith(" ")) out += " ";
      continue;
    }
    out += char;
  }
  return out.trim();
}

function presentOrNull(value: string | null): string {
  return value === null ? "\\N" : value;
}

export function authenticateTopology(
  declared: TopologyObservation,
  observed: TopologyObservation,
): void {
  assertIsolatedTopology(declared);
  if (!sameTopology(declared, observed)) {
    throw refusal("STOP", "RUNTIME_IDENTITY_MISMATCH", "Declared topology does not match the inspect");
  }
  if (!observed.app.running || !observed.db.running) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "App or database container is not running");
  }
}

export function assertIsolatedTopology(topology: TopologyObservation): void {
  if (!productionReleaseAuthorized()) {
    const names = [topology.app.name, topology.db.name, topology.networkName, topology.databaseName];
    if (
      names.some((name) => PRODUCTION_NAMES.has(name) || name === PRODUCTION_NETWORK_NAME) ||
      FORBIDDEN_DATABASE_NAMES.some((name) => name === topology.databaseName.toLowerCase())
    ) {
      throw refusal(
        "STOP",
        "PRODUCTION_NOT_AUTHORIZED",
        "Production topology is not authorized for this release package",
      );
    }
  }
  if (!ATTEMPT_ID.test(topology.attemptId)) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Release attempt id is missing");
  }
  if (topology.networkName !== `p1rel-${topology.attemptId}`) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Release network is not bound to the attempt");
  }
  if (!ISOLATED_APP_CONTAINER.test(topology.app.name) || topology.app.name !== `p1rel-app-${topology.attemptId}`) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "App container is not the isolated copy");
  }
  if (!ISOLATED_DB_CONTAINER.test(topology.db.name)) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Database container is not an owned disposable");
  }
  if (topology.roleName !== "p1disp" || !ISOLATED_DB_NAME.test(topology.databaseName)) {
    throw refusal("STOP", "DATABASE_MISMATCH", "Database name or role is not the isolated target");
  }
  for (const container of [topology.app, topology.db]) {
    if (!CONTAINER_ID.test(container.id) || !IMAGE_ID.test(container.imageId)) {
      throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Container or image id is not a full digest");
    }
    if (!container.startedAt.startsWith("20")) {
      throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Container start time is missing");
    }
  }
  if (
    topology.app.entrypoint.some((item) => item.includes("docker-entrypoint.sh")) ||
    topology.app.command.some((item) => item.includes("docker-entrypoint.sh"))
  ) {
    throw refusal("STOP", "APP_ENTRYPOINT_FORBIDDEN", "The application command must not be docker-entrypoint.sh");
  }
  if (topology.app.id === topology.db.id) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "App and database container ids are not distinct");
  }
}

export function sameTopology(left: TopologyObservation, right: TopologyObservation): boolean {
  return JSON.stringify(normalizeTopology(left)) === JSON.stringify(normalizeTopology(right));
}

export function sameAppIdentity(left: ContainerIdentity, right: ContainerIdentity): boolean {
  return (
    left.id === right.id &&
    left.imageId === right.imageId &&
    left.startedAt === right.startedAt &&
    left.running === right.running &&
    left.name === right.name
  );
}

export function bindRecovery(claim: unknown, archive: Buffer, live: CatalogProbe, restored: RestoredProbe, attemptId: string): void {
  if (typeof claim === "string" || claim === null || typeof claim !== "object" || Array.isArray(claim)) {
    throw refusal("STOP", "RESTORE_WORD_REJECTED", "A recovery word is not a backup proof");
  }
  const record = claim as Record<string, unknown>;
  if (record.restoreDrill === "RESTORE_VERIFIED" && typeof record.archiveSha256 !== "string") {
    throw refusal("STOP", "RESTORE_WORD_REJECTED", "RESTORE_VERIFIED does not prove a backup");
  }
  if (typeof record.attemptId !== "string" || typeof record.archiveSha256 !== "string") {
    throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "Recovery claim is not bound to an archive");
  }
  if (record.attemptId !== attemptId || !SHA256.test(record.archiveSha256)) {
    throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "Recovery claim is not bound to this attempt");
  }
  if (archive.length < 1) {
    throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "Backup archive is empty");
  }
  const actual = sha256Bytes(archive);
  if (actual !== record.archiveSha256) {
    throw refusal("STOP", "CHECKSUM_DRIFT", "Archive bytes do not match the creation-time checksum");
  }
  if (restored.exitCode !== 0) {
    throw refusal("STOP", "RESTORE_FAILED", "Isolated restore did not exit 0");
  }
  if (
    live.successfulMigrationCount !== EXPECTED_HISTORICAL_MIGRATION_COUNT ||
    restored.successfulMigrationCount !== EXPECTED_HISTORICAL_MIGRATION_COUNT ||
    live.failedMigrationCount !== 0 ||
    restored.failedMigrationCount !== 0 ||
    live.publicTableCount < 1 ||
    live.publicTableCount !== restored.publicTableCount ||
    live.userRowCount !== restored.userRowCount ||
    live.migrationFingerprint !== restored.migrationFingerprint ||
    live.logicalSchemaFingerprint !== restored.logicalSchemaFingerprint
  ) {
    throw refusal("STOP", "RESTORE_MISMATCH", "Restored catalog does not match the source");
  }
}

function normalizeTopology(topology: TopologyObservation): TopologyObservation {
  return {
    ...topology,
    app: { ...topology.app, entrypoint: [...topology.app.entrypoint], command: [...topology.app.command] },
    db: { ...topology.db, entrypoint: [...topology.db.entrypoint], command: [...topology.db.command] },
  };
}
