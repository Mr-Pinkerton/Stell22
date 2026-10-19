/**
 * Disposable write-freeze coordinator contract.
 * There is no production mode, no production override, and no owner signer.
 */

export const COORDINATOR_SCOPE = "TEST_OWNED" as const;
export const COORDINATOR_LABEL = "stell22.p1.write-freeze-coordinator" as const;
export const IMAGE_REF = "postgres:17-alpine" as const;
export const FREEZE_COVERAGE = "APPLICATION_ROLE_ONLY" as const;
export const MAX_APPROVAL_WINDOW_MS = 15 * 60 * 1000;

export const APPLICATION_ROLE = "p1wc_app" as const;
export const MIGRATOR_ROLE = "p1wc_migrator" as const;
export const BREAK_GLASS_ROLE = "p1wc_breakglass" as const;
export const BOOTSTRAP_ROLE = "stell22" as const;

export const FORBIDDEN_RESOURCE_NAMES = ["stell22-db-prod", "stell22-app", "stell22-caddy"] as const;

export const COORDINATOR_STATES = [
  "NORMAL",
  "FREEZE_REQUESTED",
  "REVOKE_COMMITTED",
  "DRAINING",
  "FROZEN_VERIFIED",
  "BACKUP_IN_PROGRESS",
  "RESTORE_VERIFICATION",
  "AWAITING_OWNER_AUTHORIZATION",
  "P1_APPLY",
  "P1_INTENT_RECORDED",
  "P1_POSTCHECK",
  "UNFREEZE_AUTHORIZED",
  "BLOCKED",
  "UNCERTAIN",
  "MANUAL_RECOVERY_REQUIRED",
] as const;

export type CoordinatorState = (typeof COORDINATOR_STATES)[number];

export const COORDINATOR_EVENTS = [
  "REQUEST_FREEZE",
  "PRIVILEGE_COMMIT",
  "PRIVILEGE_ROLLBACK",
  "CRASH_BEFORE_COMMIT",
  "BEGIN_DRAIN",
  "CRASH_BEFORE_DRAIN",
  "VERIFY_OK",
  "VERIFY_FAILED",
  "PRIVILEGED_WRITER",
  "UNEXPECTED_SUPERUSER",
  "BEGIN_BACKUP",
  "BACKUP_OK",
  "BACKUP_FAILED",
  "RESTORE_OK",
  "RESTORE_FAILED",
  "P1_AUTHORIZED",
  "APPROVAL_EXPIRED",
  "APPROVAL_MISSING",
  "P1_SPAWN_INTENT",
  "DURABLE_INTENT_INTERRUPTED",
  "P1_COMMITTED",
  "P1_FAILED",
  "P1_AMBIGUOUS",
  "POSTCHECK_OK",
  "POSTCHECK_FAILED",
  "UNFREEZE_AUTHORIZED",
  "UNFREEZE_GRANTS_COMMITTED",
  "UNFREEZE_UNCERTAIN",
  "CRASH",
  "IDENTITY_UNREADABLE",
  "REREAD_FROZEN",
  "BLOCK",
  "TIMEOUT",
] as const;

export type CoordinatorEvent = (typeof COORDINATOR_EVENTS)[number];

export type PrivilegePhase = "not-started" | "rolled-back" | "committed";
export type P1Status = "not-started" | "intent" | "failed" | "ambiguous" | "committed";
export type ApprovalKind = "FREEZE_REQUEST" | "P1_APPLY" | "UNFREEZE";

export type Binding = {
  scope: typeof COORDINATOR_SCOPE;
  invocationId: string;
  endpoint: string;
  daemonId: string;
  containerId: string;
  imageId: string;
  startedAt: string;
  databaseName: string;
  databaseOid: string;
  systemIdentifier: string;
  serverVersionNum: string;
  applicationPid: number;
};

export type Roles = {
  bootstrap: typeof BOOTSTRAP_ROLE;
  breakglass: typeof BREAK_GLASS_ROLE;
  migrator: typeof MIGRATOR_ROLE;
  application: typeof APPLICATION_ROLE;
};

export const COORDINATOR_ROLES: Roles = {
  bootstrap: BOOTSTRAP_ROLE,
  breakglass: BREAK_GLASS_ROLE,
  migrator: MIGRATOR_ROLE,
  application: APPLICATION_ROLE,
};

export type Probe = { ok: boolean; sqlstate: string | null };

export type RestrictionReport = {
  setRoleInsert: Probe;
  loginSelect: Probe;
  loginInsert: Probe;
  loginUpdate: Probe;
  loginDelete: Probe;
  loginTruncate: Probe;
  loginNextval: Probe;
  loginSetval: Probe;
  loginCreate: Probe;
  loginSetRole: Probe;
  securityDefiner: Probe;
};

export type WriterRow = {
  name: string;
  superuser: boolean;
  createdb: boolean;
  createrole: boolean;
  replication: boolean;
  bypassrls: boolean;
  canlogin: boolean;
  inherit: boolean;
  memberships: string[];
  setRoles: string[];
  databaseCreate: boolean;
  schemaCreate: boolean;
  databaseOwner: boolean;
  tableWrite: boolean;
  columnWrite: boolean;
  sequenceMutation: boolean;
  securityDefinerExecute: boolean;
  sessions: number;
  transactions: number;
};

export type ActivityRow = { pid: number; user: string; inTransaction: boolean };

export type CatalogPort = {
  readIdentity(): Binding;
  administrator(): { ok: true; user: string } | { ok: false; sqlstate: string | null };
  inventory(): WriterRow[];
  commitFreeze(): { ok: true } | { ok: false; sqlstate: string | null; rolledBack: boolean };
  activity(): ActivityRow[];
  terminate(pids: readonly number[]): { terminated: number[]; remaining: number[] };
  restrictions(): RestrictionReport;
  logicalDigest(): string;
  grantsAreFreeze(): boolean | "unknown";
  unfreezePreconditions(): UnfreezeFacts | "unknown";
  commitUnfreeze(): { ok: true } | { ok: false; sqlstate: string | null };
  ordinaryWrite(): Probe;
  applyP1(sql: string): { outcome: "committed" | "failed" | "ambiguous"; sqlstate: string | null };
  p1Visible(): boolean | "unknown";
  applicationAlive(): boolean;
  containerUnchanged(): boolean;
  checkpoint(point: CoordinatorFault["point"]): void;
};

export type UnfreezeFacts = {
  databaseOwner: string;
  applicationRole: string;
  applicationSuperuser: boolean;
  applicationCreate: boolean;
  migratorSuperuser: boolean;
  migratorCreate: boolean;
  containerId: string;
  startedAt: string;
};

export type BackupPort = {
  dump(sourceDatabase: string): { ok: true; digest: string } | { ok: false; reason: string };
  restore(sourceDatabase: string, digest: string): { ok: true; digest: string } | { ok: false; reason: string };
};

export type TestOwnedApproval = {
  scope: typeof COORDINATOR_SCOPE;
  kind: ApprovalKind;
  invocationId: string;
  nonce: string;
  notBefore: string;
  notAfter: string;
  databaseName: string;
  containerId: string;
  daemonId: string;
  digest: string;
};

export class CoordinatorFault extends Error {
  constructor(readonly point: "before-commit" | "after-commit" | "during-drain" | "after-verified" | "after-p1-commit") {
    super(point);
    this.name = "CoordinatorFault";
  }
}

export class CoordinatorRefusal extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CoordinatorRefusal";
  }
}

export type StepResult = {
  ok: boolean;
  state: CoordinatorState;
  code: string | null;
  sqlstate: string | null;
};
