import { describe, expect, it } from "vitest";
import { classifyEntrypoint, classifyPool } from "@/server/internal/p1-write-freeze-historical/classify";

const base = {
  beforeId: "a".repeat(64),
  afterId: "a".repeat(64),
  beforeStartedAt: "2026-10-18T09:00:00.000000000Z",
  afterStartedAt: "2026-10-18T09:00:00.000000000Z",
  running: true,
  exitCode: 0,
  healthStatus: 200,
};

describe("historical application outcomes", () => {
  it("keeps a healthy process distinct from a restart and an exit", () => {
    expect(classifyPool(base)).toBe("RECONNECTED");
    expect(classifyPool({ ...base, healthStatus: 503 })).toBe("DATABASE_CONNECTION_FAILURE");
    expect(classifyPool({ ...base, running: false, exitCode: 1, healthStatus: null })).toBe("APPLICATION_PROCESS_EXIT");
    expect(classifyPool({ ...base, afterStartedAt: "2026-10-18T09:05:00.000000000Z" })).toBe(
      "APPLICATION_CONTAINER_RESTART",
    );
  });

  it("proves startup from the Prisma log and health without inventing a migrate exit", () => {
    expect(
      classifyEntrypoint({
        migrateExit: "NOT_MEASURED",
        serverRunning: true,
        healthStatus: 200,
        noPendingLog: true,
      }),
    ).toBe("STARTUP_PROVEN");
    expect(
      classifyEntrypoint({
        migrateExit: 0,
        serverRunning: true,
        healthStatus: 200,
        noPendingLog: true,
      }),
    ).toBe("MIGRATE_MEASURED");
    expect(
      classifyEntrypoint({
        migrateExit: "NOT_MEASURED",
        serverRunning: true,
        healthStatus: 200,
        noPendingLog: false,
      }),
    ).toBe("FAIL");
    expect(
      classifyEntrypoint({
        migrateExit: 0,
        serverRunning: true,
        healthStatus: null,
        noPendingLog: true,
      }),
    ).toBe("FAIL");
    expect(classifyEntrypoint({ migrateExit: 1, serverRunning: true, healthStatus: 200, noPendingLog: true })).toBe(
      "FAIL",
    );
  });
});
