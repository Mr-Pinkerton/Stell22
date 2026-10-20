import { describe, expect, it } from "vitest";
import { PRECONDITION_KEYS, type Preconditions } from "@/server/internal/p1-privileged-writer-barrier/contract";
import {
  assessActors,
  failedPreconditions,
  judgeArchitectures,
  preconditionsFromFacts,
  privilegedWriterBarrierGate,
  type MeasuredFacts,
} from "@/server/internal/p1-privileged-writer-barrier/verdict";

function allowed(): Preconditions {
  return {
    newBootstrapTcpRejected: true,
    newBootstrapSocketRejected: true,
    newBreakGlassTcpRejected: true,
    newUnexpectedLoginRejected: true,
    uncontrolledExistingSessionBlocked: true,
    admittedSuperuserWritesBlocked: true,
    hostRootRewriteBlocked: true,
    admittedSuperuserHbaRewriteBlocked: true,
    transientWriteDetected: true,
    crashKeepsReject: true,
    ambiguousReleaseStaysClosed: true,
    startedAtStableAcrossRestart: true,
    hostSocketExclusivityProven: true,
    migratorLoginClosed: true,
    backupDoesNotUseSuperuser: true,
  };
}

function measured(): MeasuredFacts {
  return {
    appPlainInsertAfterRevoke: "42501",
    appInsertAfterMembershipRevoke: "42501",
    appSetRoleMigratorInsert: "committed",
    appExistingSessionAfterHba: "committed",
    bootstrapInsertAfterRevoke: "committed",
    breakGlassInsertAfterRevoke: "committed",
    migratorInsertAfterRevoke: "committed",
    openPrivilegedInsertTerminated: "absent",
    existingBootstrapInsertAfterHbaReload: "committed",
    newBootstrapTcp: "28000",
    newBootstrapSocket: "28000",
    newBreakGlassTcp: "28000",
    newMigratorTcp: "28000",
    newAppTcp: "28000",
    newUnexpectedTcp: "28000",
    siblingTcpAfterHba: "28000",
    siblingTcpBeforeHba: "ok",
    dockerPublishedPort: "",
    admittedBarrierInsert: "committed",
    barrierSetRoleMigratorDdl: "committed",
    migratorLoginWhenLineAdded: "committed",
    dumpRoleInsert: "42501",
    dumpCompleted: true,
    copyProgramReopenedBootstrap: true,
    rootRewriteReopenedBootstrap: true,
    appSuperuserWithoutHbaLine: "28000",
    appSuperuserWithHbaLine: "committed",
    flashRoleAbsentAfter: true,
    digestUnchangedAfterRevert: true,
    activityMissedFlashSession: true,
    overlappingSessionWasVisible: true,
    walInsertObserved: true,
    logSuppressedStatement: true,
    hbaSurvivesClientExit: true,
    ambiguousJournalBlocksWiden: true,
    startedAtChangedOnRestart: true,
    systemIdentifierStableOnRestart: true,
    hbaSurvivesRestart: true,
    bootstrapRejectedAfterRestart: true,
    hostSocketExclusivityProven: false,
  };
}

describe("privileged writer barrier gate", () => {
  it("verifies only when every precondition holds", () => {
    expect(privilegedWriterBarrierGate(allowed())).toBe("PRIVILEGED_WRITER_BARRIER_VERIFIED");
    for (const key of PRECONDITION_KEYS) {
      const missing = { ...allowed(), [key]: false };
      expect(privilegedWriterBarrierGate(missing)).toBe("PRIVILEGED_WRITER_BARRIER_BLOCKED");
      expect(failedPreconditions(missing)).toContain(key);
    }
  });

  it("does not upgrade application-role coverage from partial admission evidence", () => {
    const facts = measured();
    const gate = privilegedWriterBarrierGate(preconditionsFromFacts(facts));
    expect(gate).toBe("PRIVILEGED_WRITER_BARRIER_BLOCKED");
    const failed = failedPreconditions(preconditionsFromFacts(facts));
    expect(failed).toContain("admittedSuperuserWritesBlocked");
    expect(failed).toContain("hostRootRewriteBlocked");
    expect(failed).toContain("hostSocketExclusivityProven");
    expect(failed).toContain("uncontrolledExistingSessionBlocked");
    expect(failed).toContain("startedAtStableAcrossRestart");
    const architectures = judgeArchitectures(facts);
    expect(architectures.status).toBe("ARCHITECTURE_BLOCKED");
    expect(architectures.freezeCoverage).toBe("APPLICATION_ROLE_ONLY");
    expect(architectures.judgments.every((item) => item.sufficient === false)).toBe(true);
    const host = assessActors(facts).find((item) => item.actor === "HOST_ROOT");
    expect(host?.canWrite).toBe(true);
    expect(host?.canBePrevented).toBe(false);
  });
});
