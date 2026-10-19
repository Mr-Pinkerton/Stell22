import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCoordinator } from "@/server/internal/p1-write-freeze-coordinator/coordinator";
import { classifyJournalLock, openJournal } from "@/server/internal/p1-write-freeze-coordinator/journal";
import {
  archiveCrashLock as archiveStaleLock,
  authorizeCrash as authorize,
  crashBinding as binding,
  crashDirectory as directory,
  frozenPort,
  killCrashChild as killAndWait,
  P1_SHA256,
  pinnedSql,
  recordedCrashEvents as recordedEvents,
  spawnCrashChild as spawnChild,
  waitForCrashSignal as waitFor,
  COORDINATOR_ROLES,
} from "@/server/internal/p1-write-freeze-coordinator/p1-intent-crash-harness";
import { execOwned, realCrashWorld, type OwnedCrash } from "@/server/internal/p1-write-freeze-coordinator/owned-crash-container";

const ROLE = process.env.P1WC_CRASH_ROLE ?? "";

function hold(signal: string): never {
  fs.writeFileSync(signal, "ready\n");
  const gate = new Int32Array(new SharedArrayBuffer(4));
  while (true) Atomics.wait(gate, 0, 0, 1000);
}

function runChild(): void {
  const dir = process.env.P1WC_CRASH_DIR ?? "";
  const mode = process.env.P1WC_CRASH_MODE ?? "";
  const signal = process.env.P1WC_CRASH_SIGNAL ?? "";
  const coordinator = createCoordinator({
    directory: dir,
    binding: binding(),
    roles: COORDINATOR_ROLES,
    port: frozenPort(() => {
      if (mode !== "after-sql") return { outcome: "committed", sqlstate: null };
      const owned = JSON.parse(fs.readFileSync(process.env.P1WC_CRASH_OWNED ?? "", "utf8")) as OwnedCrash;
      const committed = execOwned(realCrashWorld(), owned, [
        "psql",
        "-U",
        "stell22",
        "-d",
        "stell22",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "BEGIN; CREATE TABLE p1wc_crash_witness(id int primary key); INSERT INTO p1wc_crash_witness VALUES (1); COMMIT;",
      ]);
      if (committed.status !== 0) throw new Error(committed.stderr.slice(0, 400));
      fs.writeFileSync(signal, "committed\n");
      hold(signal);
    }),
    backup: { dump: () => ({ ok: false, reason: "no" }), restore: () => ({ ok: false, reason: "no" }) },
    clock: () => new Date("2026-10-19T00:01:00.000Z"),
    probes: {
      beforeIntentFsync() {
        if (mode === "before-intent") hold(signal);
      },
      afterIntentFsync() {
        if (mode === "after-intent") hold(signal);
        if (mode === "exit-after-intent") {
          fs.writeFileSync(signal, "worker-exit\n");
          process.exit(0);
        }
      },
    },
  });
  coordinator.applyPinnedP1(pinnedSql());
}

describe.skipIf(ROLE === "child")("P1 intent process death", () => {
  it("does not start SQL when the process dies before the intent fsync", () => {
    const dir = directory();
    authorize(dir);
    const { child, signal } = spawnChild("before-intent", dir);
    waitFor(signal);
    killAndWait(child);
    expect(recordedEvents(dir)).not.toContain("P1_SPAWN_INTENT");
    expect(classifyJournalLock(dir).kind).toBe("STALE_UNVERIFIED");
    const calls = { count: 0 };
    const blocked = createCoordinator({
      directory: dir,
      binding: binding(),
      roles: COORDINATOR_ROLES,
      port: frozenPort(() => {
        calls.count += 1;
        return { outcome: "committed", sqlstate: null };
      }),
      backup: { dump: () => ({ ok: false, reason: "no" }), restore: () => ({ ok: false, reason: "no" }) },
      clock: () => new Date("2026-10-19T00:01:00.000Z"),
    });
    expect(blocked.applyPinnedP1(pinnedSql()).code).toBe("LOCK_STALE_UNVERIFIED");
    expect(calls.count).toBe(0);
    archiveStaleLock(dir);
    expect(openJournal(dir, binding()).head().state).toBe("P1_APPLY");
    expect(blocked.rejectDestructiveRestore().code).toBe("DESTRUCTIVE_RESTORE_FORBIDDEN");
  }, 120_000);

  it("fails closed after a durable intent when the process dies before SQL", () => {
    const dir = directory();
    authorize(dir);
    const { child, signal } = spawnChild("after-intent", dir);
    waitFor(signal);
    killAndWait(child);
    expect(recordedEvents(dir)).toContain("P1_SPAWN_INTENT");
    expect(recordedEvents(dir)).not.toContain("P1_COMMITTED");
    archiveStaleLock(dir);
    const heads = [openJournal(dir, binding()).head(), openJournal(dir, binding()).head(), openJournal(dir, binding()).head()];
    expect(heads[0]).toEqual(heads[1]);
    expect(heads[1]).toEqual(heads[2]);
    expect(heads[2].state).toBe("MANUAL_RECOVERY_REQUIRED");
    expect(heads[2].p1Status).toBe("ambiguous");
    const calls = { count: 0 };
    const blocked = createCoordinator({
      directory: dir,
      binding: binding(),
      roles: COORDINATOR_ROLES,
      port: frozenPort(() => {
        calls.count += 1;
        return { outcome: "committed", sqlstate: null };
      }),
      backup: { dump: () => ({ ok: false, reason: "no" }), restore: () => ({ ok: false, reason: "no" }) },
      clock: () => new Date("2026-10-19T00:01:00.000Z"),
    });
    expect(blocked.applyPinnedP1(pinnedSql()).code).toBe("INVALID_TRANSITION");
    expect(calls.count).toBe(0);
    expect(blocked.unfreeze({
      scope: "TEST_OWNED",
      kind: "UNFREEZE",
      invocationId: binding().invocationId,
      nonce: "3".repeat(32),
      notBefore: "2026-10-19T00:00:00.000Z",
      notAfter: "2026-10-19T00:15:00.000Z",
      databaseName: binding().databaseName,
      containerId: binding().containerId,
      daemonId: binding().daemonId,
      digest: "digest-1",
    }).code).toBe("UNFREEZE_PRECONDITION");
    expect(blocked.rejectDestructiveRestore().code).toBe("DESTRUCTIVE_RESTORE_FORBIDDEN");
  }, 120_000);

  it("reopens after the child exits with a durable intent and no SQL call", () => {
    const dir = directory();
    authorize(dir);
    const { child, signal } = spawnChild("exit-after-intent", dir);
    waitFor(signal);
    killAndWait(child);
    if (fs.existsSync(path.join(dir, "journal.lock"))) archiveStaleLock(dir);
    const head = openJournal(dir, binding()).head();
    expect(head.state).toBe("MANUAL_RECOVERY_REQUIRED");
    expect(head.p1Sha).toBe(P1_SHA256);
    expect(recordedEvents(dir)).not.toContain("P1_COMMITTED");
  }, 120_000);
});

describe.skipIf(ROLE !== "child")("P1 intent crash child", () => {
  it("runs the injected crash point", () => {
    runChild();
  }, 120_000);
});
