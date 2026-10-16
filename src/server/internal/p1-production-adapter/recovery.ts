import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { EXPECTED_HISTORICAL_MIGRATION_COUNT } from "@/server/internal/p1-isolated-runner/contract";
import {
  bindRecovery,
  logicalSchemaFingerprint,
  migrationHistoryFingerprint,
  sha256Bytes,
  type CatalogProbe,
  type LogicalColumn,
  type LogicalConstraint,
} from "@/server/internal/p1-isolated-runner/p1-release-gate";
import { refusal, RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";
import { SHA256, testRestoreName } from "@/server/internal/p1-production-adapter/contract";
import { canonicalJson, sha256Text, type ContainerFact } from "@/server/internal/p1-production-adapter/identity";

/**
 * A release backup is created for this attempt.
 * An older archive is not accepted just because it exists.
 * RESTORE_VERIFIED is not evidence.
 */

export type TableAggregate = {
  table: string;
  rowCount: number;
};

export type RecoverySnapshot = {
  migrations: readonly {
    name: string;
    checksum: string;
    finished: boolean;
    rolledBack: boolean;
    steps: number;
  }[];
  columns: readonly LogicalColumn[];
  constraints: readonly LogicalConstraint[];
  aggregates: readonly TableAggregate[];
  invalidIndexCount: number;
  notValidConstraintCount: number;
  publicTableCount: number;
  successfulMigrationCount: number;
  failedMigrationCount: number;
  userRowCount: number;
};

export type ReleaseBackupWitness = {
  kind: "RELEASE_BACKUP";
  createdForRelease: true;
  creator: "p1-production-adapter";
  attemptId: string;
  archiveSha256: string;
  archiveByteLength: number;
  sourceContainerId: string;
  sourceImageId: string;
  sourceStartedAt: string;
  databaseName: string;
  roleName: string;
};

export type BackupIo = {
  writeNew(filePath: string, bytes: Buffer | string): void;
  read(filePath: string): Buffer;
};

export function publishReleaseBackup(
  directory: string,
  archive: Buffer,
  source: {
    attemptId: string;
    container: ContainerFact;
    databaseName: string;
    roleName: string;
  },
  io: BackupIo = fsBackupIo(),
): ReleaseBackupWitness {
  if (archive.length < 8) {
    throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "Backup archive is empty");
  }
  const archiveSha256 = sha256Bytes(archive);
  const witness: ReleaseBackupWitness = {
    kind: "RELEASE_BACKUP",
    createdForRelease: true,
    creator: "p1-production-adapter",
    attemptId: source.attemptId,
    archiveSha256,
    archiveByteLength: archive.length,
    sourceContainerId: source.container.id,
    sourceImageId: source.container.imageId,
    sourceStartedAt: source.container.startedAt,
    databaseName: source.databaseName,
    roleName: source.roleName,
  };
  const checksumPath = path.join(directory, "backup.sql.gz.sha256");
  const archivePath = path.join(directory, "backup.sql.gz");
  const witnessPath = path.join(directory, "backup.witness.json");
  io.writeNew(checksumPath, `${archiveSha256}\n`);
  io.writeNew(archivePath, archive);
  const reread = sha256Bytes(io.read(archivePath));
  if (reread !== archiveSha256) {
    throw refusal("STOP", "CHECKSUM_DRIFT", "Archive bytes changed after the checksum was written");
  }
  io.writeNew(witnessPath, `${canonicalJson(witness)}\n`);
  return witness;
}

export function verifyReleaseRecovery(input: {
  witness: unknown;
  archive: Buffer;
  live: RecoverySnapshot;
  restored: RecoverySnapshot;
  restoreExitCode: number;
  attemptId: string;
  source: ContainerFact;
  databaseName: string;
  roleName: string;
}): { archiveSha256: string; recoverySha256: string } {
  const witness = parseWitness(input.witness);
  if (witness.attemptId !== input.attemptId) {
    throw refusal("STOP", "HISTORICAL_BACKUP_NOT_SUFFICIENT", "Backup witness is not for this attempt");
  }
  if (
    witness.sourceContainerId !== input.source.id ||
    witness.sourceImageId !== input.source.imageId ||
    witness.sourceStartedAt !== input.source.startedAt ||
    witness.databaseName !== input.databaseName ||
    witness.roleName !== input.roleName
  ) {
    throw refusal("STOP", "HISTORICAL_BACKUP_NOT_SUFFICIENT", "Backup witness is not bound to this database");
  }
  if (input.archive.length !== witness.archiveByteLength || input.archive.length < 8) {
    throw refusal("STOP", "BACKUP_INCOMPLETE", "Backup archive is incomplete");
  }
  const actual = sha256Bytes(input.archive);
  if (actual !== witness.archiveSha256 || !SHA256.test(actual)) {
    throw refusal("STOP", "CHECKSUM_DRIFT", "Archive bytes do not match the creation-time checksum");
  }
  assertHealthySnapshot(input.live, "source");
  assertHealthySnapshot(input.restored, "restored");
  const liveCatalog = toCatalog(input.live);
  const restoredCatalog = toCatalog(input.restored);
  bindRecovery(
    { attemptId: input.attemptId, archiveSha256: actual },
    input.archive,
    liveCatalog,
    { ...restoredCatalog, exitCode: input.restoreExitCode },
    input.attemptId,
  );
  if (aggregateFingerprint(input.live.aggregates) !== aggregateFingerprint(input.restored.aggregates)) {
    throw refusal("STOP", "RESTORE_MISMATCH", "Restored business aggregates do not match the source");
  }
  if (
    input.live.invalidIndexCount !== 0 ||
    input.live.notValidConstraintCount !== 0 ||
    input.restored.invalidIndexCount !== 0 ||
    input.restored.notValidConstraintCount !== 0
  ) {
    throw refusal("STOP", "CORRUPTED_DATA", "Source or restored catalog has invalid objects");
  }
  return { archiveSha256: actual, recoverySha256: recoveryDigest(input.attemptId, actual, input.live) };
}

export function assertIndependentRestore(source: ContainerFact, restore: ContainerFact, attemptId: string): void {
  if (restore.id === source.id || restore.name === source.name) {
    throw refusal("STOP", "RESTORE_TARGET_IS_SOURCE", "Restore target is the source database container");
  }
  if (
    restore.name === "stell22-db-prod" ||
    restore.name === "stell22-app" ||
    restore.name === "stell22-caddy"
  ) {
    throw refusal("STOP", "RESTORE_TARGET_IS_PRODUCTION", "Restore target is a production container");
  }
  if (restore.name !== testRestoreName(attemptId)) {
    throw refusal("STOP", "RESTORE_TARGET_UNOWNED", "Restore target is not an attempt-owned disposable database");
  }
}

export function recheckArchiveSha(archive: Buffer, expected: string): void {
  if (sha256Bytes(archive) !== expected) {
    throw refusal("STOP", "CHECKSUM_DRIFT", "Archive checksum changed before apply");
  }
}

export function aggregateFingerprint(rows: readonly TableAggregate[]): string {
  const lines = rows.map((row) => `${row.table}|${row.rowCount}`).sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function recoveryDigest(attemptId: string, archiveSha256: string, snapshot: RecoverySnapshot): string {
  return sha256Text(
    canonicalJson({
      attemptId,
      archiveSha256,
      migrationFingerprint: migrationHistoryFingerprint(snapshot.migrations),
      logicalSchemaFingerprint: logicalSchemaFingerprint(snapshot),
      aggregateFingerprint: aggregateFingerprint(snapshot.aggregates),
      invalidIndexCount: snapshot.invalidIndexCount,
      notValidConstraintCount: snapshot.notValidConstraintCount,
      successfulMigrationCount: snapshot.successfulMigrationCount,
      publicTableCount: snapshot.publicTableCount,
    }),
  );
}

function assertHealthySnapshot(snapshot: RecoverySnapshot, label: string): void {
  if (
    snapshot.successfulMigrationCount !== EXPECTED_HISTORICAL_MIGRATION_COUNT ||
    snapshot.failedMigrationCount !== 0 ||
    snapshot.publicTableCount < 1
  ) {
    throw refusal("STOP", "RESTORE_MISMATCH", `${label} catalog is not the pinned historical set`);
  }
}

function toCatalog(snapshot: RecoverySnapshot): CatalogProbe {
  return {
    migrationFingerprint: migrationHistoryFingerprint(snapshot.migrations),
    logicalSchemaFingerprint: logicalSchemaFingerprint(snapshot),
    publicTableCount: snapshot.publicTableCount,
    successfulMigrationCount: snapshot.successfulMigrationCount,
    failedMigrationCount: snapshot.failedMigrationCount,
    userRowCount: snapshot.userRowCount,
  };
}

export function loadPersistedReleaseBackup(
  directory: string,
  io: BackupIo = fsBackupIo(),
): { witness: ReleaseBackupWitness; archive: Buffer } {
  const checksumPath = path.join(directory, "backup.sql.gz.sha256");
  const archivePath = path.join(directory, "backup.sql.gz");
  const witnessPath = path.join(directory, "backup.witness.json");
  let checksumRaw: Buffer;
  let archive: Buffer;
  let witnessRaw: Buffer;
  try {
    checksumRaw = io.read(checksumPath);
    archive = io.read(archivePath);
    witnessRaw = io.read(witnessPath);
  } catch (error) {
    if (isRefusal(error)) throw error;
    throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "The persisted release backup for this attempt is missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(witnessRaw.toString("utf8")) as unknown;
  } catch {
    throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "The persisted release witness is not intact");
  }
  const witness = parseWitness(parsed);
  const recorded = checksumRaw.toString("utf8").trim().split(/\s+/)[0] ?? "";
  const actual = sha256Bytes(archive);
  if (
    recorded !== actual ||
    recorded !== witness.archiveSha256 ||
    archive.length !== witness.archiveByteLength ||
    !SHA256.test(recorded)
  ) {
    throw refusal("STOP", "CHECKSUM_DRIFT", "Persisted checksum, witness, and archive bytes do not match");
  }
  return { witness, archive };
}

export function readClaimedWitness(value: unknown): ReleaseBackupWitness {
  if (value === undefined || value === null) {
    throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "A missing recovery witness is not release-backup provenance");
  }
  return parseWitness(value);
}

function isRefusal(error: unknown): error is RunnerRefusal {
  return error instanceof RunnerRefusal;
}

function parseWitness(value: unknown): ReleaseBackupWitness {
  if (typeof value === "string" || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refusal("STOP", "RESTORE_WORD_REJECTED", "A recovery word is not a backup proof");
  }
  const record = value as Record<string, unknown>;
  if (record.restoreDrill === "RESTORE_VERIFIED" || record.witness === "RESTORE_VERIFIED") {
    throw refusal("STOP", "RESTORE_WORD_REJECTED", "RESTORE_VERIFIED does not prove a backup");
  }
  if (record.kind !== "RELEASE_BACKUP" || record.createdForRelease !== true) {
    throw refusal("STOP", "HISTORICAL_BACKUP_NOT_SUFFICIENT", "An earlier backup is not a release backup");
  }
  if (record.creator !== "p1-production-adapter") {
    throw refusal("STOP", "HISTORICAL_BACKUP_NOT_SUFFICIENT", "Backup witness was not created by this adapter");
  }
  if (
    typeof record.attemptId !== "string" ||
    typeof record.archiveSha256 !== "string" ||
    typeof record.archiveByteLength !== "number" ||
    typeof record.sourceContainerId !== "string" ||
    typeof record.sourceImageId !== "string" ||
    typeof record.sourceStartedAt !== "string" ||
    typeof record.databaseName !== "string" ||
    typeof record.roleName !== "string"
  ) {
    throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "Backup witness is incomplete");
  }
  return record as ReleaseBackupWitness;
}

function fsBackupIo(): BackupIo {
  return {
    writeNew(filePath, bytes) {
      const directory = path.dirname(filePath);
      if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryStat = fs.lstatSync(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "Release backup directory is not a real directory");
      }
      let handle: number;
      try {
        handle = fs.openSync(filePath, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw refusal("STOP", "BACKUP_ALREADY_EXISTS", "An existing release backup cannot be replaced");
        }
        throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "Release backup could not be created");
      }
      try {
        fs.writeFileSync(handle, bytes);
      } finally {
        fs.closeSync(handle);
      }
    },
    read(filePath) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("missing");
        }
        throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "Release backup path is not a regular file");
      }
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "Release backup path is not a regular file");
      }
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
      let handle: number;
      try {
        handle = fs.openSync(filePath, flags);
      } catch {
        throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "Release backup path is not a regular file");
      }
      try {
        return fs.readFileSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    },
  };
}
