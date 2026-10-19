import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  CoordinatorRefusal,
  type Binding,
  type CoordinatorEvent,
  type CoordinatorState,
  type P1Status,
  type PrivilegePhase,
} from "@/server/internal/p1-write-freeze-coordinator/contract";
import { sameBinding } from "@/server/internal/p1-write-freeze-coordinator/identity";
import { isCoordinatorEvent, isCoordinatorState, transition } from "@/server/internal/p1-write-freeze-coordinator/machine";

export type JournalEntry = {
  generation: number;
  state: CoordinatorState;
  event: CoordinatorEvent | "OPEN" | "TORN_TAIL";
  privilegePhase: PrivilegePhase;
  logicalDigest: string | null;
  backupDigest: string | null;
  restoreDigest: string | null;
  p1Status: P1Status;
  postcheckPassed: boolean;
  consumedNonces: string[];
  binding: Binding;
  note: string;
};

const FAIL_CLOSED = new Set<CoordinatorState>(["BLOCKED", "UNCERTAIN", "MANUAL_RECOVERY_REQUIRED"]);
const PRIVILEGE_PHASES = new Set<PrivilegePhase>(["not-started", "rolled-back", "committed"]);
const P1_STATUSES = new Set<P1Status>(["not-started", "failed", "ambiguous", "committed"]);

export type Journal = {
  head(): JournalEntry;
  append(event: CoordinatorEvent, patch?: Partial<JournalEntry>): JournalEntry;
  refuse(code: string): never;
};

export type LockClassification =
  | { kind: "ABSENT" }
  | { kind: "LIVE"; pid: number }
  | { kind: "STALE_UNVERIFIED"; pid: number }
  | { kind: "AMBIGUOUS"; reason: string };

/**
 * A leftover journal.lock is never deleted here.
 * LOCK_HELD means the recorded pid is a different live process.
 * LOCK_STALE_UNVERIFIED means the recorded pid is not alive; that is not proof the lock is safe to remove.
 * LOCK_AMBIGUOUS means the lock bytes do not identify a pid. Manual removal requires the operator to archive
 * journal.lock, journal.ndjson, and journal.torn, confirm that pid is not a coordinator, and confirm that no
 * P1 apply is in progress. Removing the lock does not authorize another P1 apply from UNCERTAIN or
 * MANUAL_RECOVERY_REQUIRED. This is not a production recovery path.
 */
export function classifyJournalLock(directory: string): LockClassification {
  const lockPath = path.join(directory, "journal.lock");
  if (!fs.existsSync(lockPath)) return { kind: "ABSENT" };
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return { kind: "AMBIGUOUS", reason: "UNREADABLE" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "AMBIGUOUS", reason: "MALFORMED" };
  }
  const pid = parsed !== null && typeof parsed === "object" && "pid" in parsed ? parsed.pid : undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return { kind: "AMBIGUOUS", reason: "PID" };
  if (pid === process.pid) return { kind: "AMBIGUOUS", reason: "PID_REUSE" };
  return pidAlive(pid) ? { kind: "LIVE", pid } : { kind: "STALE_UNVERIFIED", pid };
}

export function openJournal(directory: string, binding: Binding, options: { recover?: boolean } = {}): Journal {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "journal.ndjson");
  const recover = options.recover !== false;
  let entries = recover ? recoverJournal(directory, file, binding) : readOnlyEntries(file, binding);
  return {
    head() {
      return entries[entries.length - 1] ?? initial(binding);
    },
    append(event, patch = {}) {
      const current = entries[entries.length - 1] ?? initial(binding);
      const step = transition(current.state, event);
      if (!step.ok) throw new CoordinatorRefusal("INVALID_TRANSITION");
      const next: JournalEntry = {
        ...current,
        ...patch,
        generation: current.generation + 1,
        state: step.state,
        event,
        binding,
        consumedNonces: patch.consumedNonces ?? current.consumedNonces,
      };
      writeLine(file, next);
      entries = [...entries, next];
      return next;
    },
    refuse(code: string): never {
      throw new CoordinatorRefusal(code);
    },
  };
}

export function withJournalLock<T>(directory: string, fn: () => T): T {
  const found = classifyJournalLock(directory);
  if (found.kind === "LIVE") throw new CoordinatorRefusal("LOCK_HELD");
  if (found.kind === "STALE_UNVERIFIED") throw new CoordinatorRefusal("LOCK_STALE_UNVERIFIED");
  if (found.kind === "AMBIGUOUS") throw new CoordinatorRefusal("LOCK_AMBIGUOUS");
  const lockPath = path.join(directory, "journal.lock");
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (isExists(error)) throw new CoordinatorRefusal("LOCK_HELD");
    throw error;
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid }));
    fs.fsyncSync(fd);
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

function recoverJournal(directory: string, file: string, binding: Binding): JournalEntry[] {
  if (!fs.existsSync(file)) {
    if (markerPresent(directory)) throw new CoordinatorRefusal("JOURNAL_TORN");
    return [];
  }
  let raw = fs.readFileSync(file, "utf8");
  if (raw.length === 0) {
    if (markerPresent(directory)) throw new CoordinatorRefusal("JOURNAL_TORN");
    return [];
  }
  if (!raw.endsWith("\n")) {
    const splitAt = raw.lastIndexOf("\n") + 1;
    preserveTorn(directory, raw.slice(splitAt));
    writeMarker(directory);
    if (splitAt === 0) throw new CoordinatorRefusal("JOURNAL_TORN");
    truncateFile(file, splitAt);
    raw = raw.slice(0, splitAt);
  }
  const entries = parseComplete(raw, binding);
  const head = entries[entries.length - 1];
  if (head === undefined) return entries;
  if (markerPresent(directory) && !FAIL_CLOSED.has(head.state)) {
    const recovered = failClosed(head);
    writeLine(file, recovered);
    entries.push(recovered);
  }
  if (markerPresent(directory) && entries[entries.length - 1] !== undefined && FAIL_CLOSED.has(entries[entries.length - 1].state)) {
    fs.rmSync(markerPath(directory), { force: true });
  }
  return entries;
}

function readOnlyEntries(file: string, binding: Binding): JournalEntry[] {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  if (raw.length === 0) return [];
  const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
  if (complete.length === 0) return [];
  const entries = parseComplete(complete, binding);
  const head = entries[entries.length - 1];
  if ((!raw.endsWith("\n") || markerPresent(path.dirname(file))) && head !== undefined && !FAIL_CLOSED.has(head.state)) {
    return [...entries, failClosed(head)];
  }
  return entries;
}

function parseComplete(raw: string, binding: Binding): JournalEntry[] {
  const entries: JournalEntry[] = [];
  let previous = initial(binding);
  for (const line of raw.split("\n").slice(0, -1)) {
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CoordinatorRefusal("JOURNAL_MALFORMED");
    }
    const entry = asEntry(parsed, binding);
    if (!follows(previous, entry)) throw new CoordinatorRefusal("JOURNAL_SEQUENCE");
    entries.push(entry);
    previous = entry;
  }
  return entries;
}

function follows(previous: JournalEntry, entry: JournalEntry): boolean {
  if (entry.generation !== previous.generation + 1) return false;
  if (entry.event === "TORN_TAIL") {
    return (
      entry.state === "UNCERTAIN" &&
      previous.state !== "NORMAL" &&
      !FAIL_CLOSED.has(previous.state) &&
      entry.p1Status === previous.p1Status &&
      entry.postcheckPassed === previous.postcheckPassed &&
      entry.privilegePhase === previous.privilegePhase &&
      entry.logicalDigest === previous.logicalDigest &&
      sameNonces(entry.consumedNonces, previous.consumedNonces)
    );
  }
  if (entry.event === "OPEN") return false;
  const step = transition(previous.state, entry.event);
  return step.ok && step.state === entry.state;
}

function asEntry(value: unknown, binding: Binding): JournalEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  const row = value as Partial<JournalEntry>;
  if (typeof row.generation !== "number" || !Number.isInteger(row.generation) || row.generation < 1) {
    throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  }
  if (typeof row.state !== "string" || !isCoordinatorState(row.state)) throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  if (typeof row.event !== "string" || (row.event !== "TORN_TAIL" && !isCoordinatorEvent(row.event))) {
    throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  }
  if (row.privilegePhase === undefined || !PRIVILEGE_PHASES.has(row.privilegePhase)) throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  if (row.p1Status === undefined || !P1_STATUSES.has(row.p1Status)) throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  if (typeof row.postcheckPassed !== "boolean") throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  if (typeof row.note !== "string") throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  if (!nullableString(row.logicalDigest) || !nullableString(row.backupDigest) || !nullableString(row.restoreDigest)) {
    throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  }
  if (!Array.isArray(row.consumedNonces) || row.consumedNonces.some((nonce) => typeof nonce !== "string")) {
    throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  }
  if (row.binding === undefined || !sameBinding(row.binding, binding)) throw new CoordinatorRefusal("IDENTITY_MISMATCH");
  return row as JournalEntry;
}

function initial(binding: Binding): JournalEntry {
  return {
    generation: 0,
    state: "NORMAL",
    event: "OPEN",
    privilegePhase: "not-started",
    logicalDigest: null,
    backupDigest: null,
    restoreDigest: null,
    p1Status: "not-started",
    postcheckPassed: false,
    consumedNonces: [],
    binding,
    note: "",
  };
}

function failClosed(current: JournalEntry): JournalEntry {
  return {
    ...current,
    generation: current.generation + 1,
    state: "UNCERTAIN",
    event: "TORN_TAIL",
    note: "torn journal tail; missing bytes are not a completed transition",
  };
}

function writeLine(file: string, entry: JournalEntry): void {
  const fd = fs.openSync(file, "a");
  try {
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function truncateFile(file: string, length: number): void {
  const fd = fs.openSync(file, "r+");
  try {
    fs.ftruncateSync(fd, length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function preserveTorn(directory: string, torn: string): void {
  const file = path.join(directory, "journal.torn");
  const fd = fs.openSync(file, "a");
  try {
    const digest = createHash("sha256").update(torn).digest("hex");
    const body = `${digest} ${Buffer.byteLength(torn)}\n${Buffer.from(torn).toString("base64")}\n`;
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeMarker(directory: string): void {
  const file = markerPath(directory);
  if (fs.existsSync(file)) return;
  const fd = fs.openSync(file, "wx");
  try {
    fs.writeSync(fd, "{\"required\":true}\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function markerPresent(directory: string): boolean {
  return fs.existsSync(markerPath(directory));
}

function markerPath(directory: string): string {
  return path.join(directory, "journal.recovering");
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function sameNonces(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((nonce, index) => nonce === right[index]);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isPermission(error);
  }
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isPermission(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
}
