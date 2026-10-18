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

  it("accepts an entrypoint only when migrate exited 0 and the server is running", () => {
    expect(classifyEntrypoint({ migrateExit: 0, serverRunning: true })).toBe("PASS");
    expect(classifyEntrypoint({ migrateExit: 1, serverRunning: false })).toBe("FAIL");
    expect(classifyEntrypoint({ migrateExit: 0, serverRunning: false })).toBe("FAIL");
  });
});
