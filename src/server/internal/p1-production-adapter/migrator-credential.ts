/**
 * Fixed migrator credential.
 * The file is not created here, and a caller path cannot replace the allowed path.
 * The password is returned to the one-shot planner. It is not logged.
 */

import fs from "node:fs";
import path from "node:path";
import { PROPOSED_MIGRATOR_ROLE } from "@/server/internal/p1-production-adapter/contract";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";

export type MigratorCredential = {
  role: typeof PROPOSED_MIGRATOR_ROLE;
  database: string;
  password: string;
};

export type CredentialStat = {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  mode: number;
};

const ROLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function credentialModeAllowed(mode: number): boolean {
  return (mode & 0o077) === 0 && (mode & 0o400) !== 0;
}

export function readMigratorCredentialFile(input: {
  requestedPath: string;
  allowedPath: string;
  expectedDatabase: string;
  readFile?: (filePath: string) => string;
  lstat?: (filePath: string) => CredentialStat;
}): MigratorCredential {
  if (path.resolve(input.requestedPath) !== path.resolve(input.allowedPath)) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_PATH", "P1 migrator credential path is not the fixed path");
  }
  const lstat = input.lstat ?? ((filePath: string) => fs.lstatSync(filePath));
  let stat: CredentialStat;
  try {
    stat = lstat(input.requestedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw refusal("STOP", "MIGRATOR_CREDENTIAL_MISSING", "P1 migrator credential is not provisioned");
    }
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_INVALID", "P1 migrator credential could not be read");
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_PATH", "P1 migrator credential is not a regular file");
  }
  if (process.platform !== "win32" && !credentialModeAllowed(stat.mode)) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_PERMISSIONS", "P1 migrator credential permissions are too open");
  }
  if (input.lstat && !credentialModeAllowed(stat.mode)) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_PERMISSIONS", "P1 migrator credential permissions are too open");
  }
  let raw = "";
  try {
    raw = (input.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8")))(input.requestedPath);
  } catch {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_INVALID", "P1 migrator credential could not be read");
  }
  return parseMigratorCredential(raw, input.expectedDatabase);
}

export function parseMigratorCredential(raw: string, expectedDatabase: string): MigratorCredential {
  if (raw.trim().length === 0) {
    throw refusal("STOP", "MIGRATOR_CREDENTIAL_INVALID", "P1 migrator credential is empty");
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
