import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCoordinator } from "@/server/internal/p1-write-freeze-coordinator/coordinator";
import { openJournal } from "@/server/internal/p1-write-freeze-coordinator/journal";
import {
  archiveCrashLock,
  authorizeCrash,
  crashBinding,
  crashDirectory,
  frozenPort,
  killCrashChild,
  pinnedSql,
  recordedCrashEvents,
  spawnCrashChild,
  waitForCrashSignal,
  COORDINATOR_ROLES,
} from "@/server/internal/p1-write-freeze-coordinator/p1-intent-crash-harness";
import {
  createOwnedCrashContainer,
  execOwned,
  realCrashWorld,
  releaseOwned,
  type OwnedCrash,
} from "@/server/internal/p1-write-freeze-coordinator/owned-crash-container";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";

describe.skipIf(!LIVE)("owned disposable P1 process death", () => {
  it("does not append P1_COMMITTED or retry after a killed process commits disposable SQL", () => {
    const world = realCrashWorld();
    let owned: OwnedCrash | undefined;
    try {
      owned = createOwnedCrashContainer(world);
      let ready = false;
      for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
        const probe = execOwned(world, owned, ["pg_isready", "-U", "stell22", "-d", "stell22"]);
        ready = probe.status === 0;
        if (!ready) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
      expect(ready).toBe(true);
      const dir = crashDirectory();
      authorizeCrash(dir);
      const ownedFile = path.join(dir, "owned.json");
      fs.writeFileSync(ownedFile, JSON.stringify(owned));
      const { child, signal } = spawnCrashChild("after-sql", dir, ownedFile);
      waitForCrashSignal(signal);
      killCrashChild(child);
      const count = execOwned(world, owned, ["psql", "-U", "stell22", "-d", "stell22", "-At", "-c", "SELECT count(*) FROM p1wc_crash_witness;"]);
      expect(count.stdout.trim()).toBe("1");
      expect(recordedCrashEvents(dir)).toContain("P1_SPAWN_INTENT");
      expect(recordedCrashEvents(dir)).not.toContain("P1_COMMITTED");
      archiveCrashLock(dir);
      expect(openJournal(dir, crashBinding()).head().state).toBe("MANUAL_RECOVERY_REQUIRED");
      const calls = { count: 0 };
      const blocked = createCoordinator({
        directory: dir,
        binding: crashBinding(),
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
      expect(blocked.rejectDestructiveRestore().code).toBe("DESTRUCTIVE_RESTORE_FORBIDDEN");
      const still = execOwned(world, owned, ["psql", "-U", "stell22", "-d", "stell22", "-At", "-c", "SELECT count(*) FROM p1wc_crash_witness;"]);
      expect(still.stdout.trim()).toBe("1");
    } finally {
      if (owned !== undefined) {
        const report = releaseOwned(realCrashWorld(), owned);
        expect(report.preserved).toEqual([]);
        expect(report.failures).toEqual([]);
      }
    }
  }, 240_000);
});
