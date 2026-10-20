/**
 * Disposable privileged-writer barrier contract.
 * There is no production mode and no owner signer.
 * APPLICATION_ROLE_ONLY is not upgraded by this package.
 */

export const BARRIER_TASK = "PSR-P3-P1-PRIVILEGED-WRITER-BARRIER-F01" as const;
export const BARRIER_SCOPE = "TEST_OWNED" as const;
export const FREEZE_COVERAGE_UNCHANGED = "APPLICATION_ROLE_ONLY" as const;
export const BARRIER_GATE_BLOCKED = "PRIVILEGED_WRITER_BARRIER_BLOCKED" as const;
export const BARRIER_GATE_VERIFIED = "PRIVILEGED_WRITER_BARRIER_VERIFIED" as const;
export const ARCHITECTURE_BLOCKED = "ARCHITECTURE_BLOCKED" as const;
export const STRONGEST_INCOMPLETE = "D_SUPERVISED_ADMISSION" as const;
export const ADMISSION_COVERAGE =
  "AUTHENTICATION_ADMISSION_EXCEPT_ADMITTED_SUPERUSER_AND_HOST_CONTROL" as const;

export const BARRIER_ROLE = "p1pb_barrier" as const;
export const DUMP_ROLE = "p1pb_dump" as const;
export const UNEXPECTED_ROLE = "p1pb_unexpected" as const;
export const FLASH_ROLE = "p1pb_flash" as const;

export const ACTORS = [
  "APPLICATION",
  "MIGRATOR",
  "BOOTSTRAP",
  "BREAK_GLASS",
  "OTHER_LOGIN",
  "HOST_ROOT",
] as const;

export type Actor = (typeof ACTORS)[number];

export type BarrierGate = typeof BARRIER_GATE_BLOCKED | typeof BARRIER_GATE_VERIFIED;

export type Preconditions = {
  newBootstrapTcpRejected: boolean;
  newBootstrapSocketRejected: boolean;
  newBreakGlassTcpRejected: boolean;
  newUnexpectedLoginRejected: boolean;
  uncontrolledExistingSessionBlocked: boolean;
  admittedSuperuserWritesBlocked: boolean;
  hostRootRewriteBlocked: boolean;
  admittedSuperuserHbaRewriteBlocked: boolean;
  transientWriteDetected: boolean;
  crashKeepsReject: boolean;
  ambiguousReleaseStaysClosed: boolean;
  startedAtStableAcrossRestart: boolean;
  hostSocketExclusivityProven: boolean;
  migratorLoginClosed: boolean;
  backupDoesNotUseSuperuser: boolean;
};

export const PRECONDITION_KEYS = [
  "newBootstrapTcpRejected",
  "newBootstrapSocketRejected",
  "newBreakGlassTcpRejected",
  "newUnexpectedLoginRejected",
  "uncontrolledExistingSessionBlocked",
  "admittedSuperuserWritesBlocked",
  "hostRootRewriteBlocked",
  "admittedSuperuserHbaRewriteBlocked",
  "transientWriteDetected",
  "crashKeepsReject",
  "ambiguousReleaseStaysClosed",
  "startedAtStableAcrossRestart",
  "hostSocketExclusivityProven",
  "migratorLoginClosed",
  "backupDoesNotUseSuperuser",
] as const satisfies readonly (keyof Preconditions)[];
