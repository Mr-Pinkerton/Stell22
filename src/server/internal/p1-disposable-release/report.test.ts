import { describe, expect, it } from "vitest";
import {
  failureNextAction,
  publishRehearsalReport,
  rehearsalReport,
} from "@/server/internal/p1-disposable-release/report";

describe("disposable release report", () => {
  it("keeps the production release no-go and does not claim schema rollback", () => {
    const report = rehearsalReport({
      runId: "abcdef01",
      databaseName: "p1as_abcdef01",
      stages: [],
      failure: null,
    });
    expect(report.mode).toBe("DISPOSABLE_RELEASE_REHEARSAL");
    expect(report.scope).toBe("TEST_OWNED");
    expect(report.productionRelease).toBe("NO-GO");
    expect(report.freezePass).toBe("FORBIDDEN");
    expect(report.unauthorizedWritersExcluded).toBe("NOT_VERIFIED");
    expect(report.productionWriterExclusionProven).toBe(false);
    expect(report.databaseRollbackPerformed).toBe(false);
    expect(report.applicationRollbackRollsBackSchema).toBe(false);
    expect(report.automaticRetry).toBe(false);
  });

  it("names the failed stage and a next action that does not restore over a migrated database", () => {
    expect(failureNextAction("A", "PRODUCTION_DATABASE_REFUSED")).toMatch(/Do not apply P1/);
    expect(failureNextAction("E", "RESTORE_VERIFICATION_FAILED")).toMatch(
      /Do not restore an archive over the source/,
    );
    expect(failureNextAction("G", "MIGRATION_UNCERTAIN")).toMatch(/Do not retry/);
    expect(failureNextAction("G", "MIGRATION_UNCERTAIN")).toMatch(
      /would not roll back the database schema/,
    );
    expect(failureNextAction("C", "FAILED_MIGRATION")).toMatch(/Do not apply P1/);
    expect(failureNextAction("B", "ROLE_PRIVILEGE_REFUSED")).toMatch(/Stop before P1/);
  });

  it("keeps an earlier migration failure when cleanup also fails", () => {
    const published = publishRehearsalReport(
      rehearsalReport({
        runId: "abcdef01",
        databaseName: "p1as_abcdef01",
        stages: [{ id: "G", result: "FAIL" }],
        failure: { stage: "G", code: "MIGRATION_UNCERTAIN" },
      }),
      {
        removed: [],
        preserved: [{ resource: "p1as-db-abcdef01", reason: "INTENTIONAL_PRESERVATION" }],
        failures: [{ resource: "p1as-app-abcdef01", reason: "REMOVAL_FAILED" }],
        status: "COMPLETE",
      },
    );
    expect(published.failure?.code).toBe("MIGRATION_UNCERTAIN");
    expect(published.commandResult).toBe("REHEARSAL_FAILED");
    expect(published.cleanup.status).toBe("FAILED");
    expect(published.stages.find((stage) => stage.id === "G")?.result).toBe("FAIL");
  });

  it("does not report a failed cleanup as a successful rehearsal", () => {
    const published = publishRehearsalReport(
      rehearsalReport({
        runId: "abcdef01",
        databaseName: "p1as_abcdef01",
        stages: [{ id: "K", result: "PASS" }],
        failure: null,
      }),
      {
        removed: [],
        preserved: [],
        failures: [{ resource: "p1as-db-abcdef01", reason: "REMOVAL_FAILED" }],
        status: "COMPLETE",
      },
    );
    expect(published.failure).toBeNull();
    expect(published.commandResult).toBe("CLEANUP_FAILED");
    expect(published.stages.find((stage) => stage.id === "L")?.result).toBe("FAIL");
  });
});
