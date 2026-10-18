/**
 * Fixed migrator credential.
 * The file is not created here, and a caller path cannot replace the allowed path.
 * Linux production reads the opened descriptor. A platform that cannot prove
 * that read fails closed. The password is not logged.
 */

import fs from "node:fs";
import path from "node:path";
import { PROPOSED_MIGRATOR_ROLE } from "@/server/internal/p1-production-adapter/contract";
import { fileIdentity, sameFileIdentity } from "@/server/internal/p1-production-adapter/file-identity";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";

export type MigratorCredential = {
  role: typeof PROPOSED_MIGRATOR_ROLE;
  database: string;
  password: string;
};

export const MAX_MIGRATOR_CREDENTIAL_BYTES = 4096;

const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export type CredentialIo = {
  lstat(filePath: string): fs.Stats;
  open(filePath: string, flags: number): number;
  fstat(fd: number): fs.Stats;
  read(fd: number, maxBytes: number): Buffer;
  close(fd: number): void;
};

export function credentialModeAllowed(mode: number): boolean {
  return (mode & 0o077) === 0 && (mode & 0o400) !== 0;
}

export function readMigratorCredentialFile(input: {
  requestedPath: string;
  allowedPath: string;
  expectedDatabase: string;
  uid?: number;
  openFlags?: { readOnly: number; noFollow: number };
  io?: CredentialIo;
}): MigratorCredential {
  if (path.resolve(input.requestedPath) !== path.resolve(input.allowedPath)) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_PATH", "P1 migrator credential path is not the fixed path");
  }
  const linux = linuxCredentialRead(input.openFlags, input.uid);
  if (linux === null && input.io === undefined) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_UNSUPPORTED", "P1 migrator credential cannot be proved on this filesystem");
  }
  const uid = input.uid ?? linux?.uid;
  const flags = (input.openFlags?.readOnly ?? linux?.readOnly ?? 0) | (input.openFlags?.noFollow ?? linux?.noFollow ?? 0);
  if (input.openFlags === undefined && linux === null) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_UNSUPPORTED", "P1 migrator credential cannot be proved on this filesystem");
  }
  if ((input.openFlags?.noFollow ?? linux?.noFollow ?? 0) === 0) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_UNSUPPORTED", "P1 migrator credential open cannot refuse a symlink");
  }
  if (uid === undefined) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_UNSUPPORTED", "P1 migrator credential owner cannot be proved");
  }
  const io = input.io ?? nodeCredentialIo();
  const allowed = path.resolve(input.allowedPath);
  assertPrivatePath(allowed, io, uid);
  const before = io.lstat(allowed);
  assertCredentialFile(before, uid);
  const beforeId = fileIdentity(before);
  if (beforeId === null || before.size > MAX_MIGRATOR_CREDENTIAL_BYTES) {
    throw refusal(
      "STOP",
      before.size > MAX_MIGRATOR_CREDENTIAL_BYTES ? "MIGRATOR_CREDENTIAL_SIZE" : "MIGRATOR_CREDENTIAL_UNSUPPORTED",
      "P1 migrator credential identity is not provable",
    );
  }
  let fd: number | null = null;
  try {
    fd = io.open(allowed, flags);
    const opened = io.fstat(fd);
    const openedId = fileIdentity(opened);
    if (openedId === null || !sameFileIdentity(openedId, beforeId) || !credentialModeAllowed(opened.mode) || opened.uid !== uid) {
      throw refusal("STOP", "MIGRATOR_CREDENTIAL_RACE", "P1 migrator credential changed before it was read");
    }
    if (opened.size > MAX_MIGRATOR_CREDENTIAL_BYTES) {
      throw refusal("STOP", "MIGRATOR_CREDENTIAL_SIZE", "P1 migrator credential is too large");
    }
    const raw = io.read(fd, MAX_MIGRATOR_CREDENTIAL_BYTES);
    if (raw.length > MAX_MIGRATOR_CREDENTIAL_BYTES) {
      throw refusal("STOP", "MIGRATOR_CREDENTIAL_SIZE", "P1 migrator credential is too large");
    }
    const settled = io.fstat(fd);
    const settledId = fileIdentity(settled);
    const pathAfter = io.lstat(allowed);
    const pathId = fileIdentity(pathAfter);
    if (
      settledId === null ||
      pathId === null ||
      pathAfter.isSymbolicLink() ||
      !sameFileIdentity(settledId, beforeId) ||
      !sameFileIdentity(pathId, beforeId)
    ) {
      throw refusal("STOP", "MIGRATOR_CREDENTIAL_RACE", "P1 migrator credential changed while it was read");
    }
    return parseMigratorCredential(raw.toString("utf8"), input.expectedDatabase);
  } catch (error) {
    if (isRefusal(error)) throw error;
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_INVALID", "P1 migrator credential could not be read");
  } finally {
    if (fd !== null) io.close(fd);
  }
}

export function parseMigratorCredential(raw: string, expectedDatabase: string): MigratorCredential {
  if (raw.trim().length === 0) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_INVALID", "P1 migrator credential is empty");
  }
  if (Buffer.byteLength(raw) > MAX_MIGRATOR_CREDENTIAL_BYTES) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_SIZE", "P1 migrator credential is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_INVALID", "P1 migrator credential is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_INVALID", "P1 migrator credential is not a record");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "database,kind,password,role") {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_INVALID", "P1 migrator credential has an unexpected shape");
  }
  if (record.kind !== "P1_MIGRATOR_CREDENTIAL") {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_MISMATCH", "P1 migrator credential kind is not the migrator binding");
  }
  if (record.role !== PROPOSED_MIGRATOR_ROLE || !ROLE_NAME.test(String(record.role))) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_MISMATCH", "P1 migrator credential is not bound to the migrator role");
  }
  if (typeof record.database !== "string" || record.database !== expectedDatabase || !ROLE_NAME.test(record.database)) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_MISMATCH", "P1 migrator credential is not bound to this database");
  }
  if (typeof record.password !== "string" || record.password.length < 16 || /[\r\n\0]/.test(record.password)) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_INVALID", "P1 migrator credential is not usable");
  }
  return { role: PROPOSED_MIGRATOR_ROLE, database: record.database, password: record.password };
}

function linuxCredentialRead(
  injected: { readOnly: number; noFollow: number } | undefined,
  injectedUid: number | undefined,
): { uid: number; readOnly: number; noFollow: number } | null {
  if (injected !== undefined || injectedUid !== undefined) return null;
  if (process.platform !== "linux" || process.getuid === undefined) return null;
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  if (noFollow === 0) return null;
  return { uid: process.getuid(), readOnly: fs.constants.O_RDONLY, noFollow };
}

function nodeCredentialIo(): CredentialIo {
  return {
    lstat: (filePath) => fs.lstatSync(filePath),
    open: (filePath, flags) => fs.openSync(filePath, flags),
    fstat: (fd) => fs.fstatSync(fd),
    read: (fd, maxBytes) => {
      const opened = fs.fstatSync(fd);
      if (opened.size > maxBytes) {
        throw refusal("STOP", "MIGRATOR_CREDENTIAL_SIZE", "P1 migrator credential is too large");
      }
      return fs.readFileSync(fd);
    },
    close: (fd) => fs.closeSync(fd),
  };
}

function assertPrivatePath(filePath: string, io: CredentialIo, uid: number): void {
  const parts: string[] = [];
  let current = path.resolve(filePath);
  while (current !== path.dirname(current)) {
    parts.unshift(current);
    current = path.dirname(current);
  }
  parts.unshift(current);
  for (const component of parts) {
    let stat: fs.Stats;
    try {
      stat = io.lstat(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && component === filePath) {
        throw refusal("STOP", "MIGRATOR_CREDENTIAL_MISSING", "P1 migrator credential is not provisioned");
      }
      throw refusal("STOP", "MIGRATOR_CREDENTIAL_PATH", "P1 migrator credential path could not be inspected");
    }
    if (stat.isSymbolicLink()) {
      throw refusal("STOP", "MIGRATOR_CREDENTIAL_PATH", "P1 migrator credential path contains a symlink");
    }
    if (component !== filePath) {
      const parent = path.dirname(filePath);
      const immediate = component === parent;
      if (!stat.isDirectory() || (stat.mode & 0o002) !== 0 || (immediate && (stat.uid !== uid || (stat.mode & 0o020) !== 0))) {
        throw refusal("STOP", "MIGRATOR_CREDENTIAL_PERMISSIONS", "P1 migrator credential directory is not private");
      }
    }
  }
}

function assertCredentialFile(stat: fs.Stats, uid: number): void {
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_PATH", "P1 migrator credential is not a regular file");
  }
  if (!credentialModeAllowed(stat.mode) || stat.uid !== uid) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_PERMISSIONS", "P1 migrator credential permissions are too open");
  }
}

function isRefusal(error: unknown): boolean {
  return error instanceof Error && error.name === "RunnerRefusal";
}
