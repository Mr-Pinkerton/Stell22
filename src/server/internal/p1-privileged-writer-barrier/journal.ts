/**
 * Test-owned admission journal.
 * A missing release stays closed. This file is not the Package E coordinator journal.
 */

import fs from "node:fs";

export type BarrierState = "OPEN" | "HELD" | "BLOCKED" | "AMBIGUOUS" | "RELEASED";

export type JournalEvent = "ACQUIRE" | "UNEXPECTED_SESSION" | "RELEASE";

export type JournalRecord = {
  event: JournalEvent;
  state: BarrierState;
  binding: string;
};

export function applyJournal(records: readonly JournalRecord[], event: JournalEvent, binding: string): JournalRecord[] {
  const head = records.length === 0 ? "OPEN" : records[records.length - 1].state;
  let state: BarrierState;
  if (records.length > 0 && records.some((record) => record.binding !== binding)) {
    state = "AMBIGUOUS";
  } else if (event === "ACQUIRE" && head === "OPEN") {
    state = "HELD";
  } else if (event === "UNEXPECTED_SESSION" && head === "HELD") {
    state = "BLOCKED";
  } else if (event === "RELEASE" && head === "HELD") {
    state = "RELEASED";
  } else {
    state = "BLOCKED";
  }
  return [...records, { event, state, binding }];
}

export function reopenJournal(records: readonly JournalRecord[], binding: string): { state: BarrierState; mayWiden: boolean } {
  if (records.length === 0) return { state: "OPEN", mayWiden: false };
  if (records.some((record) => record.binding !== binding)) return { state: "AMBIGUOUS", mayWiden: false };
  const head = records[records.length - 1].state;
  if (head === "RELEASED") return { state: "RELEASED", mayWiden: true };
  if (head === "HELD" || head === "BLOCKED" || head === "AMBIGUOUS") {
    return { state: head === "HELD" ? "AMBIGUOUS" : head, mayWiden: false };
  }
  return { state: "OPEN", mayWiden: false };
}

export function mayWidenHba(state: BarrierState): boolean {
  return state === "RELEASED";
}

export function writeJournal(file: string, records: readonly JournalRecord[]): void {
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  const payload = body.length === 0 ? "" : `${body}\n`;
  const fd = fs.openSync(file, "w");
  try {
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJournal(file: string): JournalRecord[] {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, "utf8");
  if (text.length === 0) return [];
  const records: JournalRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const parsed: unknown = JSON.parse(line);
    if (!isRecord(parsed)) throw new Error("JOURNAL_MALFORMED");
    records.push(parsed);
  }
  return records;
}

function isRecord(value: unknown): value is JournalRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.event === "ACQUIRE" || record.event === "UNEXPECTED_SESSION" || record.event === "RELEASE") &&
    (record.state === "OPEN" ||
      record.state === "HELD" ||
      record.state === "BLOCKED" ||
      record.state === "AMBIGUOUS" ||
      record.state === "RELEASED") &&
    typeof record.binding === "string"
  );
}
