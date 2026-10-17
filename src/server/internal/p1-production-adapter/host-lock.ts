import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";
import { ATTEMPT_ID } from "@/server/internal/p1-production-adapter/contract";

export const OPERATOR_HOST_LOCK_FILE = "p1-operator.host.lock";
export const PRODUCTION_OPERATOR_HOST_LOCK = "/var/lib/stell22/p1-operator.host.lock";

const OWNER = /^[0-9a-f]{32}$/;
const COMMANDS = new Set(["verify-recovery", "apply"]);

export type OperatorHostCommand = "verify-recovery" | "apply";

export type OperatorHostLock = {
  owner: string;
  release: () => void;
};

type LockRecord = {
  kind: "P1_OPERATOR_HOST_LOCK";
  owner: string;
  attemptId: string;
  command: OperatorHostCommand;
};

/**
 * One exclusive lock for every production-operator attempt.
 * A leftover file is evidence. This function does not delete a lock it does not own.
 */
export function acquireOperatorHostLock(
  lockPath: string,
  claim: { attemptId: string; command: OperatorHostCommand },
): OperatorHostLock {
  if (!ATTEMPT_ID.test(claim.attemptId) || !COMMANDS.has(claim.command)) {
    throw refusal("STOP", "HOST_LOCK_UNAVAILABLE", "Host lock claim is not a verify-recovery or apply attempt");
  }
  const parent = path.dirname(lockPath);
  const parentKind = pathKind(parent);
  if (parentKind === "absent") {
    try {
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    } catch {
      throw refusal("STOP", "HOST_LOCK_UNAVAILABLE", "Host lock directory could not be created");
    }
  } else if (parentKind !== "directory") {
    throw refusal("STOP", "HOST_LOCK_UNAVAILABLE", "Host lock directory is not a real directory");
  }
  const existing = pathKind(lockPath);
  if (existing === "symlink" || existing === "directory" || existing === "other") {
    throw refusal("BLOCKED", "HOST_LOCK_UNCERTAIN", "Host lock path is not a regular lock file");
  }
  if (existing === "file") refuseExisting(lockPath);
  const owner = randomBytes(16).toString("hex");
  const body = `${JSON.stringify(record(owner, claim))}\n`;
  let handle: number;
  try {
    handle = fs.openSync(lockPath, "wx", 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const raced = pathKind(lockPath);
      if (raced !== "file") {
        throw refusal("BLOCKED", "HOST_LOCK_UNCERTAIN", "Host lock path is not a regular lock file");
      }
      refuseExisting(lockPath);
    }
    throw refusal("STOP", "HOST_LOCK_UNAVAILABLE", "Host lock could not be created");
  }
  try {
    fs.writeFileSync(handle, body, "utf8");
    fs.fsyncSync(handle);
  } catch {
    fs.closeSync(handle);
    throw refusal("STOP", "HOST_LOCK_UNAVAILABLE", "Host lock record could not be written");
  }
  let released = false;
  return {
    owner,
    release() {
      if (released) return;
      released = true;
      fs.closeSync(handle);
      const kind = pathKind(lockPath);
      if (kind !== "file") {
        throw refusal("BLOCKED", "HOST_LOCK_UNCERTAIN", "Host lock disappeared before release");
      }
      const current = readRecord(lockPath);
      if (current === null || current.owner !== owner) {
        throw refusal("STOP", "HOST_LOCK_OWNER_MISMATCH", "Host lock is not owned by this run");
      }
      fs.unlinkSync(lockPath);
    },
  };
}

export function operatorHostLockPath(scope: "PRODUCTION" | "TEST_OWNED", workRoot: string): string {
  if (scope === "PRODUCTION") return PRODUCTION_OPERATOR_HOST_LOCK;
  return path.join(workRoot, OPERATOR_HOST_LOCK_FILE);
}

function refuseExisting(lockPath: string): never {
  const current = readRecord(lockPath);
  if (current === null) {
    throw refusal("BLOCKED", "HOST_LOCK_UNCERTAIN", "Host lock contents are not a complete ownership record");
  }
  throw refusal("BLOCKED", "HOST_LOCK_HELD", "Another attempt holds the operator host lock");
}

function record(owner: string, claim: { attemptId: string; command: OperatorHostCommand }): LockRecord {
  return { kind: "P1_OPERATOR_HOST_LOCK", owner, attemptId: claim.attemptId, command: claim.command };
}

function readRecord(lockPath: string): LockRecord | null {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  if (value.kind !== "P1_OPERATOR_HOST_LOCK") return null;
  if (typeof value.owner !== "string" || !OWNER.test(value.owner)) return null;
  if (typeof value.attemptId !== "string" || !ATTEMPT_ID.test(value.attemptId)) return null;
  if (value.command !== "verify-recovery" && value.command !== "apply") return null;
  return { kind: "P1_OPERATOR_HOST_LOCK", owner: value.owner, attemptId: value.attemptId, command: value.command };
}

function pathKind(target: string): "absent" | "symlink" | "directory" | "file" | "other" {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw refusal("STOP", "HOST_LOCK_UNAVAILABLE", "Host lock path could not be classified");
  }
}
