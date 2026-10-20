import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createBusinessDatabase, createCluster, destroyCluster, type Cluster } from "@/server/internal/p1-write-freeze-coordinator/cluster";
import { runOfflineAdmissionProof } from "@/server/internal/p1-offline-writer-admission/live-proof";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
let cluster: Cluster | undefined;

describe.skipIf(!LIVE)("disposable offline writer admission", () => {
  beforeAll(() => {
    cluster = createCluster();
  }, 180_000);

  afterAll(() => {
    if (cluster) destroyCluster(cluster);
  }, 180_000);

  it("rejects synthetic HTTP writes and still lets an earlier transaction commit", async () => {
    const database = createBusinessDatabase(cluster!);
    const report = await runOfflineAdmissionProof(cluster!, database, path.resolve(process.cwd()));
    const summary = {
      gate: report.verdict.gate,
      freezePassAllowed: report.verdict.freezePassAllowed,
      productionRelease: report.verdict.productionRelease,
      identity: report.identity,
      facts: report.facts,
      counts: report.counts,
      cleanup: report.cleanup,
      daemonRestartBlocker: report.daemonRestartBlocker,
      startupBlocker: report.startupBlocker,
      proven: report.verdict.proven,
      notProven: report.verdict.notProven,
      reasons: report.verdict.reasons,
    };
    console.log(`P1OWA_SUMMARY ${JSON.stringify(summary)}`);
    expect(report.verdict.gate).toBe("FREEZE_PASS_FORBIDDEN");
    expect(report.verdict.freezePassAllowed).toBe(false);
    expect(report.verdict.productionRelease).toBe("NO-GO");
    expect(report.verdict.p1Applied).toBe(false);
    expect(report.facts.httpDirectBefore).toBe("committed");
    expect(report.facts.httpProxyBefore).toBe("committed");
    expect(report.facts.httpDirectDuring).toBe("rejected-all");
    expect(report.facts.httpProxyDuring).toBe("rejected-all");
    expect(report.facts.continuityBreaks).toBe(0);
    expect(report.facts.blindCommitAfterDeclaration).toBe("committed");
    expect(report.facts.cooperativeRecheck).toBe("absent");
    expect(report.facts.terminatedBeforeCommit).toBe("absent");
    expect(report.facts.pastCheckCommitted).toBe(true);
    expect(report.facts.scheduledRecheckCommitted).toBe(false);
    expect(report.facts.newAppSqlAfterHttpFreeze).toBe("committed");
    expect(report.verdict.proven.some((line) => line.includes("pg_stat_activity"))).toBe(true);
    expect(report.facts.directAcceptedWhileProxyClosed).toBe(true);
    expect(report.facts.serverActionsCovered).toBe(false);
    expect(report.facts.physicalDisconnectTested).toBe(false);
    expect(report.facts.daemonRestart).toBe("not-tested");
    expect(report.facts.prismaMigrationsRelation).toBe("absent");
    expect(report.facts.appOnlyIsProductionPath).toBe(false);
    expect(report.facts.operatorBootstrapInsert).toBe("committed");
    expect(report.facts.appCannotUpdateAdmission).toBe(false);
    expect(report.facts.restartLoopWritesWhileOpen).toBe(true);
    expect(report.facts.restartLoopWritesWhileClosed).toBe(false);
    expect(report.facts.explicitStopStayedDown).toBe(true);
    expect(report.facts.crashRestartedByPolicy).toBe(true);
    expect(report.facts.crashWithClosedFileWrote).toBe(false);
    expect(report.facts.crashWithOpenFileWroteAgain).toBe(true);
    expect(report.facts.engineKillRestarted).toBe(false);
    expect(report.facts.operatorStartAfterStopWrote).toBe(true);
    expect(report.identity.publishedPostgresPorts).toBe("");
    expect(report.identity.database).toMatch(/^p1wc_[0-9a-f]{8}$/);
    expect(report.cleanup.container).toBe("removed");
    expect(report.cleanup.volume).toBe("removed");
    expect(report.cleanup.containerGone).toBe(true);
    expect(report.cleanup.foreignRunningAtEnd).toBeGreaterThan(0);
    expect(report.daemonRestartBlocker).toContain("NOT TESTED");
    expect(report.startupBlocker).toContain("prisma migrate deploy");
  }, 360_000);
});
