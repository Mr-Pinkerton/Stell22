import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBusinessDatabase, createCluster, destroyCluster, type Cluster } from "@/server/internal/p1-write-freeze-coordinator/cluster";
import { runDisposableProof } from "@/server/internal/p1-privileged-writer-barrier/live-proof";

const LIVE = process.env.P1_DISPOSABLE_LIVE === "1";
let cluster: Cluster | undefined;

describe.skipIf(!LIVE)("disposable PostgreSQL 17 privileged writer barrier", () => {
  beforeAll(() => {
    cluster = createCluster();
  }, 180_000);

  afterAll(() => {
    if (cluster) destroyCluster(cluster);
  }, 180_000);

  it("blocks new unlisted logins and still leaves the admitted superuser and host root able to write", () => {
    const database = createBusinessDatabase(cluster!);
    const report = runDisposableProof(cluster!, database);
    const summary = { gate: report.gate, failed: report.failed, identity: report.identity, facts: report.facts };
    console.log(`P1PB_SUMMARY ${JSON.stringify(summary)}`);
    fs.writeFileSync(path.join(os.tmpdir(), "p1pb-summary.json"), JSON.stringify(summary));
    expect(report.gate).toBe("PRIVILEGED_WRITER_BARRIER_BLOCKED");
    expect(report.architectures.status).toBe("ARCHITECTURE_BLOCKED");
    expect(report.architectures.freezeCoverage).toBe("APPLICATION_ROLE_ONLY");
    expect(report.facts.hostSocketExclusivityProven).toBe(false);
    expect(report.facts.admittedBarrierInsert).toBe("committed");
    expect(report.facts.rootRewriteReopenedBootstrap).toBe(true);
    expect(report.facts.copyProgramReopenedBootstrap).toBe(true);
    expect(report.facts.newBootstrapTcp).toBe("28000");
    expect(report.facts.newBootstrapSocket).toBe("28000");
    expect(report.facts.existingBootstrapInsertAfterHbaReload).toBe("committed");
    expect(report.facts.openPrivilegedInsertTerminated).toBe("absent");
    expect(report.facts.appPlainInsertAfterRevoke).toBe("committed");
    expect(report.facts.appInsertAfterMembershipRevoke).toBe("42501");
    expect(report.facts.dockerPublishedPort).toBe("");
    expect(report.identity.reconfirmAfterRestart).toContain("StartedAt");
    expect(report.failed).toContain("admittedSuperuserWritesBlocked");
    expect(report.failed).toContain("hostRootRewriteBlocked");
    expect(report.failed).toContain("hostSocketExclusivityProven");
  }, 300_000);
});
