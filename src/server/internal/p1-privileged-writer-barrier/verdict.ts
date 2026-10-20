/**
 * Gate for a privileged writer barrier.
 * VERIFIED requires every precondition. A partial admission proof stays BLOCKED.
 * This does not change APPLICATION_ROLE_ONLY.
 */

import {
  ACTORS,
  ARCHITECTURE_BLOCKED,
  BARRIER_GATE_BLOCKED,
  BARRIER_GATE_VERIFIED,
  FREEZE_COVERAGE_UNCHANGED,
  PRECONDITION_KEYS,
  STRONGEST_INCOMPLETE,
  type Actor,
  type BarrierGate,
  type Preconditions,
} from "@/server/internal/p1-privileged-writer-barrier/contract";

export type SqlMark = "28000" | "42501" | "committed" | "denied" | "ok" | "other";

export type MeasuredFacts = {
  appPlainInsertAfterRevoke: SqlMark;
  appInsertAfterMembershipRevoke: SqlMark;
  appSetRoleMigratorInsert: SqlMark;
  appExistingSessionAfterHba: SqlMark;
  bootstrapInsertAfterRevoke: SqlMark;
  breakGlassInsertAfterRevoke: SqlMark;
  migratorInsertAfterRevoke: SqlMark;
  openPrivilegedInsertTerminated: "absent" | "present";
  existingBootstrapInsertAfterHbaReload: SqlMark;
  newBootstrapTcp: SqlMark;
  newBootstrapSocket: SqlMark;
  newBreakGlassTcp: SqlMark;
  newMigratorTcp: SqlMark;
  newAppTcp: SqlMark;
  newUnexpectedTcp: SqlMark;
  siblingTcpAfterHba: SqlMark;
  siblingTcpBeforeHba: SqlMark;
  dockerPublishedPort: string;
  admittedBarrierInsert: SqlMark;
  barrierSetRoleMigratorDdl: SqlMark;
  migratorLoginWhenLineAdded: SqlMark;
  dumpRoleInsert: SqlMark;
  dumpCompleted: boolean;
  copyProgramReopenedBootstrap: boolean;
  rootRewriteReopenedBootstrap: boolean;
  appSuperuserWithoutHbaLine: SqlMark;
  appSuperuserWithHbaLine: SqlMark;
  flashRoleAbsentAfter: boolean;
  digestUnchangedAfterRevert: boolean;
  activityMissedFlashSession: boolean;
  overlappingSessionWasVisible: boolean;
  walInsertObserved: boolean | "unavailable";
  logSuppressedStatement: boolean | "not-captured";
  hbaSurvivesClientExit: boolean;
  ambiguousJournalBlocksWiden: boolean;
  startedAtChangedOnRestart: boolean;
  systemIdentifierStableOnRestart: boolean;
  hbaSurvivesRestart: boolean;
  bootstrapRejectedAfterRestart: boolean;
  hostSocketExclusivityProven: boolean;
};

export type ActorAssessment = {
  actor: Actor;
  canWrite: boolean;
  canBePrevented: boolean;
  trustedControl: string;
  verification: string;
  unprovable: string;
};

export type ArchitectureJudgment = {
  id: "A_REVOKE_DRAIN" | "B_HBA_ADMISSION" | "C_HOST_EXCLUSIVE" | "D_SUPERVISED_ADMISSION";
  sufficient: boolean;
  reason: string;
};

export function privilegedWriterBarrierGate(preconditions: Preconditions): BarrierGate {
  for (const key of PRECONDITION_KEYS) {
    if (preconditions[key] !== true) return BARRIER_GATE_BLOCKED;
  }
  return BARRIER_GATE_VERIFIED;
}

export function preconditionsFromFacts(facts: MeasuredFacts): Preconditions {
  return {
    newBootstrapTcpRejected: facts.newBootstrapTcp === "28000",
    newBootstrapSocketRejected: facts.newBootstrapSocket === "28000",
    newBreakGlassTcpRejected: facts.newBreakGlassTcp === "28000",
    newUnexpectedLoginRejected: facts.newUnexpectedTcp === "28000",
    uncontrolledExistingSessionBlocked: facts.existingBootstrapInsertAfterHbaReload === "denied",
    admittedSuperuserWritesBlocked: facts.admittedBarrierInsert === "denied",
    hostRootRewriteBlocked: facts.rootRewriteReopenedBootstrap === false,
    admittedSuperuserHbaRewriteBlocked: facts.copyProgramReopenedBootstrap === false,
    transientWriteDetected:
      facts.walInsertObserved === true &&
      facts.digestUnchangedAfterRevert === true &&
      facts.activityMissedFlashSession === true,
    crashKeepsReject:
      facts.hbaSurvivesClientExit && facts.hbaSurvivesRestart && facts.bootstrapRejectedAfterRestart,
    ambiguousReleaseStaysClosed: facts.ambiguousJournalBlocksWiden,
    startedAtStableAcrossRestart: facts.startedAtChangedOnRestart === false,
    hostSocketExclusivityProven: facts.hostSocketExclusivityProven === true,
    migratorLoginClosed: facts.newMigratorTcp === "28000",
    backupDoesNotUseSuperuser: facts.dumpCompleted && facts.dumpRoleInsert === "42501",
  };
}

export function assessActors(facts: MeasuredFacts): ActorAssessment[] {
  const byActor: Record<Actor, ActorAssessment> = {
    APPLICATION: {
      actor: "APPLICATION",
      canWrite:
        facts.appSetRoleMigratorInsert === "committed" ||
        facts.appExistingSessionAfterHba === "committed" ||
        facts.appSuperuserWithHbaLine === "committed",
      canBePrevented: facts.newAppTcp === "28000" && facts.appInsertAfterMembershipRevoke === "42501",
      trustedControl:
        facts.appPlainInsertAfterRevoke === "committed"
          ? "Revoking table privileges left a plain insert committed while the application role inherited the owning migrator. Revoking that membership then denied a new insert. Default-reject pg_hba blocks a new login. An existing session and an allow-listed superuser attribute still write."
          : "Table REVOKE blocked a new plain insert. Default-reject pg_hba blocks a new login. An existing session and an allow-listed superuser attribute still write.",
      verification:
        "SQLSTATE 42501 on a new plain insert, SQLSTATE 28000 on a new login, and a committed insert when the same role is allow-listed after ALTER ROLE SUPERUSER.",
      unprovable: "Production pool sessions and host cron were not connected. This cluster is disposable.",
    },
    MIGRATOR: {
      actor: "MIGRATOR",
      canWrite:
        facts.migratorInsertAfterRevoke === "committed" ||
        facts.migratorLoginWhenLineAdded === "committed" ||
        facts.barrierSetRoleMigratorDdl === "committed",
      canBePrevented: facts.newMigratorTcp === "28000",
      trustedControl:
        "Default-reject pg_hba blocks a new migrator login. Ownership still writes when the login is allow-listed or when the admitted superuser uses SET ROLE.",
      verification: "Direct TCP SQLSTATE 28000 while the extra hba line is absent, and a committed insert after that line is added.",
      unprovable: "A production operator credential for stell22_migrator was not installed and was not tested.",
    },
    BOOTSTRAP: {
      actor: "BOOTSTRAP",
      canWrite:
        facts.bootstrapInsertAfterRevoke === "committed" || facts.existingBootstrapInsertAfterHbaReload === "committed",
      canBePrevented: facts.newBootstrapTcp === "28000" && facts.newBootstrapSocket === "28000",
      trustedControl:
        "REVOKE does not apply to this superuser. A loaded default-reject pg_hba blocks a new TCP login and a new Unix-socket login. An existing backend keeps writing until it is terminated, and that backend can rewrite pg_hba.",
      verification:
        "Committed insert after REVOKE, committed insert from the pre-existing backend after reload, SQLSTATE 28000 for a new TCP login and a new socket login.",
      unprovable: "Whether the production data directory was initialized with stell22 as the bootstrap superuser was not read.",
    },
    BREAK_GLASS: {
      actor: "BREAK_GLASS",
      canWrite: facts.breakGlassInsertAfterRevoke === "committed",
      canBePrevented: facts.newBreakGlassTcp === "28000",
      trustedControl:
        "A second superuser login is a writer. Default-reject pg_hba blocks a new connection. It does not remove SUPERUSER from a session that is already authenticated.",
      verification: "Committed insert before the hba change, SQLSTATE 28000 for a new TCP login after the change.",
      unprovable: "No production break-glass secret exists in this repository, so production custody was not tested.",
    },
    OTHER_LOGIN: {
      actor: "OTHER_LOGIN",
      canWrite: facts.newUnexpectedTcp === "committed" || facts.appSuperuserWithHbaLine === "committed",
      canBePrevented: facts.newUnexpectedTcp === "28000",
      trustedControl:
        "A new LOGIN role, including a superuser created during the barrier, cannot connect while the loaded hba has no allow line for it.",
      verification: "CREATE ROLE followed by TCP SQLSTATE 28000. A role created and dropped between catalog reads is absent from the second read.",
      unprovable: "Roles that exist only in a production cluster and are not in this disposable catalog were not listed.",
    },
    HOST_ROOT: {
      actor: "HOST_ROOT",
      canWrite: facts.rootRewriteReopenedBootstrap === true,
      canBePrevented: false,
      trustedControl:
        "No PostgreSQL privilege stops the Docker daemon holder. docker exec as root rewrote pg_hba and a new bootstrap login then committed an insert.",
      verification: "The rewritten trust file was read back, reload succeeded, and the bootstrap insert committed. The published port list was empty before that rewrite.",
      unprovable:
        "Exclusive possession of the Docker socket was not proven. No second OS principal was created. A daemon authorization plugin was not installed.",
    },
  };
  return ACTORS.map((actor) => byActor[actor]);
}

export function judgeArchitectures(facts: MeasuredFacts): {
  status: typeof ARCHITECTURE_BLOCKED;
  strongestIncomplete: typeof STRONGEST_INCOMPLETE;
  freezeCoverage: typeof FREEZE_COVERAGE_UNCHANGED;
  judgments: ArchitectureJudgment[];
} {
  return {
    status: ARCHITECTURE_BLOCKED,
    strongestIncomplete: STRONGEST_INCOMPLETE,
    freezeCoverage: FREEZE_COVERAGE_UNCHANGED,
    judgments: [
      {
        id: "A_REVOKE_DRAIN",
        sufficient: false,
        reason:
          facts.bootstrapInsertAfterRevoke === "committed"
            ? "REVOKE plus a later terminate does not bind the bootstrap superuser, the break-glass superuser, or the owning migrator."
            : "The revoke observation did not match the expected superuser bypass.",
      },
      {
        id: "B_HBA_ADMISSION",
        sufficient: false,
        reason:
          facts.rootRewriteReopenedBootstrap || facts.admittedBarrierInsert === "committed"
            ? "Default-reject authentication blocks new logins that are not allow-listed. The admitted superuser and a Docker root exec can still write and can replace the file."
            : "The hba observations did not show the expected remaining writers.",
      },
      {
        id: "C_HOST_EXCLUSIVE",
        sufficient: false,
        reason:
          facts.siblingTcpBeforeHba === "ok" || facts.hostSocketExclusivityProven === false
            ? "A second container on the same Docker network connected before the hba change. Host exclusivity was not proven, and it would not revoke an already-open database session."
            : "The network-sibling observation was missing.",
      },
      {
        id: "D_SUPERVISED_ADMISSION",
        sufficient: false,
        reason:
          "A single admitted superuser session plus default-reject hba is the strongest incomplete control. It still admits that superuser, and host root can remove the file. The gate stays blocked.",
      },
    ],
  };
}

export function failedPreconditions(preconditions: Preconditions): string[] {
  return PRECONDITION_KEYS.filter((key) => preconditions[key] !== true);
}
