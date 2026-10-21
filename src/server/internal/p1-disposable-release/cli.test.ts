import { describe, expect, it } from "vitest";
import { runCli } from "@/server/internal/p1-disposable-release/cli";
import { rehearsalReport } from "@/server/internal/p1-disposable-release/report";
import type {
  RehearsalCleanup,
  RehearsalRun,
} from "@/server/internal/p1-disposable-release/rehearsal";

describe("disposable release command", () => {
  it("refuses every flag, including a production bypass, without starting a rehearsal", () => {
    let calls = 0;
    for (const argv of [
      ["--production"],
      ["--bypass"],
      ["--force"],
      ["--retry"],
      ["--database-url"],
      ["plan"],
    ]) {
      const lines: string[] = [];
      const code = runCli(argv, {
        log: (line) => lines.push(line),
        run: () => {
          calls += 1;
          throw new Error("rehearsal must not start");
        },
      });
      expect(code).toBe(2);
      expect(lines.join("\n")).toContain("MALFORMED_CLI");
    }
    expect(calls).toBe(0);
  });

  it("prints a successful cleanup and returns zero", () => {
    const lines: string[] = [];
    const code = runCli([], {
      log: (line) => lines.push(line),
      run: () => rehearsalOutcome(null),
      finish: () => cleanup({ removed: ["p1as-db-abcdef01"] }),
    });
    const printed = JSON.parse(lines[0]) as {
      commandResult: string;
      failure: unknown;
      cleanup: { status: string; removed: string[] };
    };
    expect(code).toBe(0);
    expect(printed.failure).toBeNull();
    expect(printed.commandResult).toBe("SUCCESS");
    expect(printed.cleanup.status).toBe("COMPLETE");
    expect(printed.cleanup.removed).toEqual(["p1as-db-abcdef01"]);
  });

  it("returns nonzero for a cleanup failure without hiding a migration failure", () => {
    const lines: string[] = [];
    const failedCleanup = runCli([], {
      log: (line) => lines.push(line),
      run: () => rehearsalOutcome(null),
      finish: () =>
        cleanup({
          failures: [{ resource: "p1as-db-abcdef01", reason: "REMOVAL_FAILED" }],
        }),
    });
    const printed = JSON.parse(lines[0]) as {
      commandResult: string;
      failure: null;
      cleanup: { status: string };
    };
    expect(failedCleanup).toBe(2);
    expect(printed.failure).toBeNull();
    expect(printed.commandResult).toBe("CLEANUP_FAILED");
    expect(printed.cleanup.status).toBe("FAILED");

    const hidden: string[] = [];
    const migration = runCli([], {
      log: (line) => hidden.push(line),
      run: () => rehearsalOutcome({ stage: "G", code: "MIGRATION_UNCERTAIN" }),
      finish: () =>
        cleanup({
          failures: [{ resource: "p1as-app-abcdef01", reason: "REMOVAL_FAILED" }],
          preserved: [{ resource: "p1as-db-abcdef01", reason: "INTENTIONAL_PRESERVATION" }],
        }),
    });
    const kept = JSON.parse(hidden[0]) as {
      commandResult: string;
      failure: { code: string };
      cleanup: { failures: unknown[] };
    };
    expect(migration).toBe(2);
    expect(kept.failure.code).toBe("MIGRATION_UNCERTAIN");
    expect(kept.commandResult).toBe("REHEARSAL_FAILED");
    expect(kept.cleanup.failures).toHaveLength(1);
  });
});

function rehearsalOutcome(failure: { stage: "G"; code: string } | null): RehearsalRun {
  return {
    report: rehearsalReport({
      runId: "abcdef01",
      databaseName: "p1as_abcdef01",
      stages: [{ id: "K", result: failure === null ? "PASS" : "NOT_RUN" }],
      failure,
    }),
    resources: {
      runId: "abcdef01",
      binding: null,
      database: null,
      application: null,
      volume: null,
      network: null,
      image: null,
      extraContainers: [],
      migrationRoot: null,
      preserveDatabase: false,
      sharedImage: false,
    },
  };
}

function cleanup(overrides: Partial<RehearsalCleanup> = {}): RehearsalCleanup {
  return {
    removed: [],
    preserved: [],
    failures: [],
    status: "COMPLETE",
    ...overrides,
  };
}
