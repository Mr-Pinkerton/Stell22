/**
 * Classification only. An UNCERTAIN observation is not repaired here.
 * Row counts are not an input: an UPDATE can preserve them.
 */

export type FreezeEvidence = {
  catalogReadable: boolean;
  breakGlassLogin: boolean;
  privilegeTransaction: "not-started" | "rolled-back" | "committed";
  grantsAreFreeze: boolean | "unknown";
  applicationBackendsRemaining: number | "unknown";
  unexpectedSuperuserSession: boolean;
  operatorInterrupted: boolean;
  canary: "not-run" | "authenticated-write-denied" | "write-succeeded" | "authentication-failed";
  unfreezeGrantsCommitted: boolean;
  appStillNonSuperuser: boolean;
  ownershipStillMigrator: boolean;
  postUnfreezeWrite: boolean;
};

export type FreezeClass =
  | "NORMAL"
  | "REVOKE_COMMITTED"
  | "FROZEN_VERIFIED"
  | "UNFREEZE_AUTHORIZED"
  | "UNCERTAIN";

export type Classification = {
  state: FreezeClass;
  repair: "none";
};

export function classifyFreeze(evidence: FreezeEvidence): Classification {
  if (!evidence.catalogReadable) return uncertain();
  if (evidence.privilegeTransaction === "not-started") return { state: "NORMAL", repair: "none" };
  if (evidence.privilegeTransaction === "rolled-back") return { state: "NORMAL", repair: "none" };
  if (evidence.grantsAreFreeze === "unknown") return uncertain();
  if (!evidence.breakGlassLogin) return uncertain();
  if (evidence.operatorInterrupted) return uncertain();
  if (evidence.unexpectedSuperuserSession) return uncertain();
  if (evidence.canary === "write-succeeded" || evidence.canary === "authentication-failed") {
    return uncertain();
  }
  if (evidence.applicationBackendsRemaining === "unknown") return uncertain();
  if (
    evidence.unfreezeGrantsCommitted &&
    evidence.postUnfreezeWrite &&
    evidence.appStillNonSuperuser &&
    evidence.ownershipStillMigrator
  ) {
    return { state: "UNFREEZE_AUTHORIZED", repair: "none" };
  }
  if (evidence.applicationBackendsRemaining > 0 || evidence.canary === "not-run") {
    return { state: "REVOKE_COMMITTED", repair: "none" };
  }
  if (
    evidence.grantsAreFreeze === true &&
    evidence.applicationBackendsRemaining === 0 &&
    evidence.canary === "authenticated-write-denied" &&
    !evidence.unfreezeGrantsCommitted
  ) {
    return { state: "FROZEN_VERIFIED", repair: "none" };
  }
  return uncertain();
}

function uncertain(): Classification {
  return { state: "UNCERTAIN", repair: "none" };
}
