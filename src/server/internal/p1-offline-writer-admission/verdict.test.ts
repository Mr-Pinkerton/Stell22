import { describe, expect, it } from "vitest";
import { UNCOVERED_PRODUCTION_CHANNELS } from "@/server/internal/p1-offline-writer-admission/contract";
import { judgeOfflineAdmission, type OfflineFacts } from "@/server/internal/p1-offline-writer-admission/verdict";

function facts(overrides: Partial<OfflineFacts> = {}): OfflineFacts {
  return {
    httpDirectBefore: "committed",
    httpProxyBefore: "committed",
    httpDirectDuring: "rejected-all",
    httpProxyDuring: "rejected-all",
    directAcceptedWhileProxyClosed: true,
    continuitySamples: 8,
    continuityBreaks: 0,
    blindCommitAfterDeclaration: "committed",
    cooperativeRecheck: "absent",
    terminatedBeforeCommit: "absent",
    pastCheckCommitted: true,
    backgroundTicksAfterClose: 0,
    scheduledRecheckCommitted: false,
    maxAppSessionsDuringLatch: 0,
    newAppSqlAfterHttpFreeze: "committed",
    postHocActivitySawThatSession: false,
    raceCommits: 0,
    raceTrials: 4,
    restartLoopWritesWhileOpen: true,
    restartLoopWritesWhileClosed: false,
    explicitStopStayedDown: true,
    crashRestartedByPolicy: true,
    crashWithOpenFileWroteAgain: true,
    crashWithClosedFileWrote: false,
    engineKillRestarted: false,
    operatorStartAfterStopWrote: true,
    daemonRestart: "not-tested",
    operatorBootstrapInsert: "committed",
    appCannotUpdateAdmission: true,
    prismaMigrationsRelation: "absent",
    appOnlyIsProductionPath: false,
    serverActionsCovered: false,
    physicalDisconnectTested: false,
    ...overrides,
  };
}

describe("offline writer admission verdict", () => {
  it("forbids FREEZE PASS when a pre-existing transaction commits after the declaration", () => {
    const verdict = judgeOfflineAdmission(facts());
    expect(verdict.gate).toBe("FREEZE_PASS_FORBIDDEN");
    expect(verdict.freezePassAllowed).toBe(false);
    expect(verdict.productionRelease).toBe("NO-GO");
    expect(verdict.p1Applied).toBe(false);
    expect(verdict.reasons.some((reason) => reason.includes("committed after the declaration"))).toBe(true);
  });

  it("still refuses a production freeze when the blind transaction is absent", () => {
    const verdict = judgeOfflineAdmission(facts({ blindCommitAfterDeclaration: "absent", pastCheckCommitted: false, newAppSqlAfterHttpFreeze: "absent", crashWithOpenFileWroteAgain: false, operatorBootstrapInsert: "absent" }));
    expect(verdict.freezePassAllowed).toBe(false);
    expect(verdict.productionRelease).toBe("NO-GO");
    expect(verdict.reasons.some((reason) => reason.includes("Server Actions"))).toBe(true);
    expect(verdict.reasons.some((reason) => reason.includes("not a production freeze"))).toBe(true);
  });

  it("records either activity sample without allowing FREEZE PASS", () => {
    const seen = judgeOfflineAdmission(facts({ postHocActivitySawThatSession: true }));
    const missed = judgeOfflineAdmission(facts({ postHocActivitySawThatSession: false }));
    expect(seen.freezePassAllowed).toBe(false);
    expect(missed.freezePassAllowed).toBe(false);
    expect(seen.proven.some((line) => line.includes("pg_stat_activity"))).toBe(true);
    expect(missed.proven.some((line) => line.includes("pg_stat_activity"))).toBe(true);
  });
  it("keeps production writer channels uncovered", () => {
    const verdict = judgeOfflineAdmission(facts());
    for (const channel of UNCOVERED_PRODUCTION_CHANNELS) {
      expect(verdict.notProven).toContain(channel);
    }
    expect(verdict.notProven).toContain("host root and the bootstrap superuser");
  });
});
