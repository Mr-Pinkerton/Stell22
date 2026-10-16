import zlib from "node:zlib";
import { sha256Bytes } from "@/server/internal/p1-isolated-runner/p1-release-gate";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";
import { PRODUCTION_NETWORK_NAME } from "@/server/internal/p1-production-adapter/contract";
import type { VolumeMount } from "@/server/internal/p1-production-adapter/docker-runtime";
import type { ContainerFact } from "@/server/internal/p1-production-adapter/identity";
import {
  assertIndependentRestore,
  verifyReleaseRecovery,
  type RecoverySnapshot,
  type ReleaseBackupWitness,
} from "@/server/internal/p1-production-adapter/recovery";

/**
 * Restore evidence is produced only by this controller.
 * A caller-supplied snapshot is not evidence.
 */

const trustedRestoreBrand = Symbol("trusted-restore");

export type RestoreContainerFact = ContainerFact & {
  mounts: readonly VolumeMount[];
};

export type TrustedRestoreEvidence = {
  attemptId: string;
  archiveSha256: string;
  restoreContainerId: string;
  restoreImageId: string;
  restoreExitCode: 0;
  recoverySha256: string;
};

export function isTrustedRestoreEvidence(value: unknown): value is TrustedRestoreEvidence {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<symbol, unknown>;
  return record[trustedRestoreBrand] === true && typeof (value as TrustedRestoreEvidence).recoverySha256 === "string";
}

export function executeTrustedRestore(input: {
  attemptId: string;
  archive: Buffer;
  source: ContainerFact;
  sourceMounts: readonly VolumeMount[];
  databaseName: string;
  roleName: string;
  live: RecoverySnapshot;
  claimed: ReleaseBackupWitness | null;
  inspectRestore: () => RestoreContainerFact;
  runRestore: (containerId: string, sql: Buffer) => number;
  readRestored: (containerId: string) => RecoverySnapshot;
}): TrustedRestoreEvidence {
  if (input.claimed === null) {
    throw refusal("STOP", "BACKUP_EVIDENCE_INVALID", "Recovery cannot mint a release witness");
  }
  if (input.archive.length < 8) {
    throw refusal("STOP", "BACKUP_INCOMPLETE", "Backup archive is incomplete");
  }
  const archiveSha256 = sha256Bytes(input.archive);
  if (input.claimed.archiveSha256 !== archiveSha256 || input.claimed.archiveByteLength !== input.archive.length) {
    throw refusal("STOP", "CHECKSUM_DRIFT", "Persisted backup checksum does not match the archive bytes");
  }
  if (
    input.claimed.attemptId !== input.attemptId ||
    input.claimed.sourceContainerId !== input.source.id ||
    input.claimed.sourceImageId !== input.source.imageId ||
    input.claimed.sourceStartedAt !== input.source.startedAt ||
    input.claimed.databaseName !== input.databaseName ||
    input.claimed.roleName !== input.roleName
  ) {
    throw refusal("STOP", "HISTORICAL_BACKUP_NOT_SUFFICIENT", "Persisted backup is not this source");
  }
  const restore = input.inspectRestore();
  assertIndependentRestore(input.source, restore, input.attemptId);
  assertRestoreIsolation(input.source, input.sourceMounts, restore);
  const exitCode = input.runRestore(restore.id, sqlBytes(input.archive));
  if (exitCode !== 0) {
    throw refusal("STOP", "RESTORE_FAILED", "Restore command did not exit 0");
  }
  const restored = input.readRestored(restore.id);
  const checked = verifyReleaseRecovery({
    witness: input.claimed,
    archive: input.archive,
    live: input.live,
    restored,
    restoreExitCode: exitCode,
    attemptId: input.attemptId,
    source: input.source,
    databaseName: input.databaseName,
    roleName: input.roleName,
  });
  const evidence = {
    attemptId: input.attemptId,
    archiveSha256: checked.archiveSha256,
    restoreContainerId: restore.id,
    restoreImageId: restore.imageId,
    restoreExitCode: 0 as const,
    recoverySha256: checked.recoverySha256,
  };
  Object.defineProperty(evidence, trustedRestoreBrand, { value: true });
  return evidence;
}

export function assertRestoreIsolation(
  source: ContainerFact,
  sourceMounts: readonly VolumeMount[],
  restore: RestoreContainerFact,
): void {
  if (restore.networks.length !== 1) {
    throw refusal("STOP", "RESTORE_NETWORK_NOT_ISOLATED", "Restore target is not on one isolated network");
  }
  const restoreNetwork = restore.networks[0]?.name ?? "";
  if (
    restoreNetwork === PRODUCTION_NETWORK_NAME ||
    source.networks.some((network) => network.name === restoreNetwork)
  ) {
    throw refusal("STOP", "RESTORE_NETWORK_NOT_ISOLATED", "Restore target shares a network with the source");
  }
  const shared = new Set(sourceMounts.flatMap((mount) => [mount.name, mount.source].filter((item): item is string => Boolean(item))));
  for (const mount of restore.mounts) {
    const label = [mount.type, mount.name, mount.source, mount.destination].filter(Boolean).join(" ");
    if (
      mount.type === "bind" ||
      /stell22/i.test(label) ||
      (mount.name !== null && shared.has(mount.name)) ||
      (mount.source !== null && shared.has(mount.source))
    ) {
      throw refusal("STOP", "RESTORE_VOLUME_SHARED", "Restore target shares a volume with production or the source");
    }
  }
}

function sqlBytes(archive: Buffer): Buffer {
  if (archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b) return zlib.gunzipSync(archive);
  return archive;
}
