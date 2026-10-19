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
import { isCoordinatorState, transition } from "@/server/internal/p1-write-freeze-coordinator/machine";

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

export type Journal = {
  head(): JournalEntry;
  append(event: CoordinatorEvent, patch?: Partial<JournalEntry>): JournalEntry;
  refuse(code: string): never;
};

export function openJournal(directory: string, binding: Binding): Journal {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "journal.ndjson");
  const loaded = readEntries(file);
  if (loaded.torn && loaded.entries.length === 0) throw new CoordinatorRefusal("JOURNAL_TORN");
  if (loaded.entries.some((entry) => !sameBinding(entry.binding, binding))) {
    throw new CoordinatorRefusal("IDENTITY_MISMATCH");
  }
  let entries = loaded.entries;
  if (loaded.torn && entries.length > 0) {
    const current = entries[entries.length - 1];
    if (current && !FAIL_CLOSED.has(current.state)) {
      entries = [...entries, failClosed(current, "TORN_TAIL")];
      fs.appendFileSync(file, `${JSON.stringify(entries[entries.length - 1])}\n`);
    }
  }
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
      const line = JSON.stringify(next);
      const fd = fs.openSync(file, "a");
      try {
        fs.writeSync(fd, `${line}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      entries = [...entries, next];
      return next;
    },
    refuse(code: string): never {
      throw new CoordinatorRefusal(code);
    },
  };
}

export function withJournalLock<T>(directory: string, fn: () => T): T {
  const lockPath = path.join(directory, "journal.lock");
  let fd: number;
  try {
    fd = fs.openSync(lockPath, "wx");
  } catch (error) {
    if (isExists(error)) throw new CoordinatorRefusal("LOCK_HELD");
    throw error;
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
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

function failClosed(current: JournalEntry, event: "TORN_TAIL"): JournalEntry {
  return {
    ...current,
    generation: current.generation + 1,
    state: "UNCERTAIN",
    event,
    note: "torn journal tail",
  };
}

function readEntries(file: string): { entries: JournalEntry[]; torn: boolean } {
  if (!fs.existsSync(file)) return { entries: [], torn: false };
  const raw = fs.readFileSync(file, "utf8");
  if (raw.length === 0) return { entries: [], torn: false };
  const torn = !raw.endsWith("\n");
  const complete = raw.split("\n").slice(0, -1);
  const entries: JournalEntry[] = [];
  for (const line of complete) {
    if (line.length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    entries.push(asEntry(parsed));
  }
  return { entries, torn };
}

function asEntry(value: unknown): JournalEntry {
  if (value === null || typeof value !== "object") throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  const row = value as Partial<JournalEntry>;
  if (row.state === undefined || !isCoordinatorState(row.state) || row.binding === undefined) {
    throw new CoordinatorRefusal("JOURNAL_MALFORMED");
  }
  return row as JournalEntry;
}

function isExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
