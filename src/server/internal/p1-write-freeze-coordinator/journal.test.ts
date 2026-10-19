import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createCoordinator } from "@/server/internal/p1-write-freeze-coordinator/coordinator";
import { COORDINATOR_ROLES, CoordinatorRefusal, type Binding } from "@/server/internal/p1-write-freeze-coordinator/contract";
import { classifyJournalLock, openJournal, withJournalLock, type JournalEntry } from "@/server/internal/p1-write-freeze-coordinator/journal";

function binding(patch: Partial<Binding> = {}): Binding {
  return {
    scope: "TEST_OWNED",
    invocationId: "12345678-1234-4234-8234-123456789abc",
    endpoint: "npipe:////./pipe/docker_engine",
    daemonId: "daemon-a",
    containerId: "a".repeat(64),
    imageId: `sha256:${"b".repeat(64)}`,
    startedAt: "2026-10-19T00:00:00.000000000Z",
    databaseName: "p1wc_abcdef12",
    databaseOid: "16384",
    systemIdentifier: "7400000000000000000",
    serverVersionNum: "170005",
    applicationPid: 4242,
    ...patch,
  };
}

function directory(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "stell22-p1wc-journal-"));
}

function tear(dir: string): void {
  fs.appendFileSync(path.join(dir, "journal.ndjson"), "{\"torn\":");
}

function lines(dir: string): JournalEntry[] {
  const raw = fs.readFileSync(path.join(dir, "journal.ndjson"), "utf8");
  expect(raw.endsWith("\n")).toBe(true);
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JournalEntry);
}

function refusal(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof CoordinatorRefusal) return error.code;
    throw error;
  }
  return "";
}

describe("write-freeze journal recovery", () => {
  it("recovers a torn tail after FREEZE_REQUESTED, REVOKE_COMMITTED, and P1_APPLY", () => {
    const requested = directory();
    const requestedJournal = openJournal(requested, binding());
    requestedJournal.append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
    tear(requested);
    expect(openJournal(requested, binding()).head().state).toBe("UNCERTAIN");
    expect(fs.readFileSync(path.join(requested, "journal.torn"), "utf8").length).toBeGreaterThan(0);

    const revoked = directory();
    const revokedJournal = openJournal(revoked, binding());
    revokedJournal.append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
    revokedJournal.append("PRIVILEGE_COMMIT", { privilegePhase: "committed" });
    expect(revokedJournal.head().state).toBe("REVOKE_COMMITTED");
    tear(revoked);
    expect(openJournal(revoked, binding()).head()).toMatchObject({ state: "UNCERTAIN", p1Status: "not-started" });

    const applying = directory();
    const applyingJournal = openJournal(applying, binding());
    applyingJournal.append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
    applyingJournal.append("PRIVILEGE_COMMIT", { privilegePhase: "committed" });
    applyingJournal.append("BEGIN_DRAIN");
    applyingJournal.append("VERIFY_OK", { logicalDigest: "digest-1" });
    applyingJournal.append("BEGIN_BACKUP");
    applyingJournal.append("BACKUP_OK", { backupDigest: "digest-1" });
    applyingJournal.append("RESTORE_OK", { restoreDigest: "digest-1" });
    applyingJournal.append("P1_AUTHORIZED", { consumedNonces: ["1".repeat(32), "2".repeat(32)] });
    expect(applyingJournal.head().state).toBe("P1_APPLY");
    tear(applying);
    const recovered = openJournal(applying, binding());
    expect(recovered.head().state).toBe("MANUAL_RECOVERY_REQUIRED");
    expect(recovered.head().p1Status).toBe("ambiguous");
    expect(recovered.head().executionRisk).toBe(true);
    expect(refusal(() => recovered.append("P1_COMMITTED", { p1Status: "committed" }))).toBe("INVALID_TRANSITION");
    expect(recovered.head().state).toBe("MANUAL_RECOVERY_REQUIRED");
  });

  it("keeps an existing BLOCKED or UNCERTAIN record when the tail is torn", () => {
    const blocked = directory();
    const blockedJournal = openJournal(blocked, binding());
    blockedJournal.append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
    blockedJournal.append("BLOCK", { note: "MISSING_ADMINISTRATOR" });
    tear(blocked);
    expect(openJournal(blocked, binding()).head().state).toBe("BLOCKED");
    expect(lines(blocked).some((entry) => entry.event === "TORN_TAIL")).toBe(false);

    const uncertain = directory();
    const uncertainJournal = openJournal(uncertain, binding());
    uncertainJournal.append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
    uncertainJournal.append("IDENTITY_UNREADABLE", { note: "identity drifted" });
    tear(uncertain);
    expect(openJournal(uncertain, binding()).head().state).toBe("UNCERTAIN");
    expect(lines(uncertain).at(-1)?.event).toBe("IDENTITY_UNREADABLE");
  });

  it("reopens a recovered journal three times and completes a partial recovery write", () => {
    const dir = directory();
    const journal = openJournal(dir, binding());
    journal.append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
    tear(dir);
    const first = openJournal(dir, binding()).head();
    const second = openJournal(dir, binding()).head();
    const third = openJournal(dir, binding()).head();
    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(third.state).toBe("UNCERTAIN");
    expect(lines(dir).every((entry) => entry.state === "FREEZE_REQUESTED" || entry.state === "UNCERTAIN")).toBe(true);

    const interrupted = directory();
    openJournal(interrupted, binding()).append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
    fs.writeFileSync(path.join(interrupted, "journal.recovering"), "{\"required\":true}\n");
    expect(openJournal(interrupted, binding()).head().state).toBe("UNCERTAIN");
    expect(fs.existsSync(path.join(interrupted, "journal.recovering"))).toBe(false);
    expect(openJournal(interrupted, binding()).head().state).toBe("UNCERTAIN");
  });

  it("rejects a malformed record, a bad sequence, and a mismatched binding", () => {
    const malformed = directory();
    fs.writeFileSync(path.join(malformed, "journal.ndjson"), "{not-json}\n");
    expect(refusal(() => openJournal(malformed, binding()))).toBe("JOURNAL_MALFORMED");

    const tornOnly = directory();
    fs.writeFileSync(path.join(tornOnly, "journal.ndjson"), "{\"partial\"");
    expect(refusal(() => openJournal(tornOnly, binding()))).toBe("JOURNAL_TORN");
    expect(refusal(() => openJournal(tornOnly, binding()))).toBe("JOURNAL_TORN");
    expect(fs.readFileSync(path.join(tornOnly, "journal.ndjson"), "utf8")).toBe("{\"partial\"");

    const sequence = directory();
    const good = openJournal(sequence, binding());
    good.append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
    const forged = lines(sequence)[0];
    forged.generation = 9;
    fs.writeFileSync(path.join(sequence, "journal.ndjson"), `${JSON.stringify(forged)}\n`);
    expect(refusal(() => openJournal(sequence, binding()))).toBe("JOURNAL_SEQUENCE");

    const mismatched = directory();
    const entry = openJournal(directory(), binding()).append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
    entry.binding = binding({ databaseName: "p1wc_ffffffff" });
    fs.writeFileSync(path.join(mismatched, "journal.ndjson"), `${JSON.stringify(entry)}\n`);
    expect(refusal(() => openJournal(mismatched, binding()))).toBe("IDENTITY_MISMATCH");
  });

  it("does not unfreeze or apply P1 from uncertain journal evidence", () => {
    const dir = directory();
    const journal = openJournal(dir, binding());
    journal.append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
    tear(dir);
    openJournal(dir, binding());
    const coordinator = createCoordinator({
      directory: dir,
      binding: binding(),
      roles: COORDINATOR_ROLES,
      port: {
        readIdentity: () => binding(),
        administrator: () => ({ ok: true, user: "p1wc_breakglass" }),
        inventory: () => [],
        commitFreeze: () => ({ ok: true }),
        activity: () => [],
        terminate: () => ({ terminated: [], remaining: [] }),
        restrictions: () => {
          throw new Error("not used");
        },
        logicalDigest: () => "digest-1",
        grantsAreFreeze: () => true,
        unfreezePreconditions: () => "unknown",
        commitUnfreeze: () => ({ ok: true }),
        ordinaryWrite: () => ({ ok: true, sqlstate: null }),
        applyP1: () => ({ outcome: "committed", sqlstate: null }),
        p1Visible: () => false,
        applicationAlive: () => true,
        containerUnchanged: () => true,
        checkpoint: () => undefined,
      },
      backup: { dump: () => ({ ok: false, reason: "no" }), restore: () => ({ ok: false, reason: "no" }) },
      clock: () => new Date("2026-10-19T00:01:00.000Z"),
    });
    expect(coordinator.unfreeze({
      scope: "TEST_OWNED",
      kind: "UNFREEZE",
      invocationId: binding().invocationId,
      nonce: "3".repeat(32),
      notBefore: "2026-10-19T00:00:00.000Z",
      notAfter: "2026-10-19T00:15:00.000Z",
      databaseName: "p1wc_abcdef12",
      containerId: "a".repeat(64),
      daemonId: "daemon-a",
      digest: "digest-1",
    }).code).toBe("UNFREEZE_PRECONDITION");
    expect(coordinator.applyPinnedP1("select 1").code).toBe("INVALID_TRANSITION");
    expect(coordinator.head().state).toBe("UNCERTAIN");
  });

  it("reopens an interrupted P1 intent as manual recovery and does not treat it as not started", () => {
    const dir = directory();
    const journal = openJournal(dir, binding());
    journal.append("REQUEST_FREEZE", { consumedNonces: ["1".repeat(32)] });
    journal.append("PRIVILEGE_COMMIT", { privilegePhase: "committed" });
    journal.append("BEGIN_DRAIN");
    journal.append("VERIFY_OK", { logicalDigest: "digest-1" });
    journal.append("BEGIN_BACKUP");
    journal.append("BACKUP_OK", { backupDigest: "digest-1" });
    journal.append("RESTORE_OK", { restoreDigest: "digest-1" });
    journal.append("P1_AUTHORIZED", { consumedNonces: ["1".repeat(32), "2".repeat(32)] });
    journal.append("P1_SPAWN_INTENT", {
      p1Status: "intent",
      p1AttemptId: "attempt-1",
      p1Sha: "a".repeat(64),
      p1ApprovalNonce: "2".repeat(32),
    });
    tear(dir);
    const first = openJournal(dir, binding()).head();
    const second = openJournal(dir, binding()).head();
    const third = openJournal(dir, binding()).head();
    expect(first).toEqual(second);
    expect(second).toEqual(third);
    expect(third).toMatchObject({
      state: "MANUAL_RECOVERY_REQUIRED",
      p1Status: "ambiguous",
      p1AttemptId: "attempt-1",
      executionRisk: true,
    });
    expect(third.p1Status).not.toBe("not-started");
    expect(fs.readFileSync(path.join(dir, "journal.torn"), "utf8").length).toBeGreaterThan(0);
  });

  it("classifies a live, stale, and ambiguous lock without deleting it", () => {
    const live = directory();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", windowsHide: true });
    fs.writeFileSync(path.join(live, "journal.lock"), JSON.stringify({ pid: child.pid }));
    expect(classifyJournalLock(live)).toMatchObject({ kind: "LIVE", pid: child.pid });
    child.kill();
    expect(fs.existsSync(path.join(live, "journal.lock"))).toBe(true);

    const stale = directory();
    fs.writeFileSync(path.join(stale, "journal.lock"), JSON.stringify({ pid: 2_147_483_646 }));
    expect(classifyJournalLock(stale)).toEqual({ kind: "STALE_UNVERIFIED", pid: 2_147_483_646 });
    expect(refusal(() => withJournalLock(stale, () => undefined))).toBe("LOCK_STALE_UNVERIFIED");
    expect(fs.existsSync(path.join(stale, "journal.lock"))).toBe(true);

    const ambiguous = directory();
    fs.writeFileSync(path.join(ambiguous, "journal.lock"), "held");
    expect(classifyJournalLock(ambiguous)).toEqual({ kind: "AMBIGUOUS", reason: "MALFORMED" });
    expect(fs.existsSync(path.join(ambiguous, "journal.lock"))).toBe(true);

    const reused = directory();
    fs.writeFileSync(path.join(reused, "journal.lock"), JSON.stringify({ pid: process.pid }));
    expect(classifyJournalLock(reused)).toEqual({ kind: "AMBIGUOUS", reason: "PID_REUSE" });
  });
});
