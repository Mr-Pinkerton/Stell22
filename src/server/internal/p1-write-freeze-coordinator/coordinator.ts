import { createHash } from "node:crypto";
import { P1_SHA256 } from "@/server/internal/p1-isolated-runner/contract";
import { evaluateApproval } from "@/server/internal/p1-write-freeze-coordinator/authorization";
import {
  CoordinatorFault,
  CoordinatorRefusal,
  type BackupPort,
  type Binding,
  type CatalogPort,
  type CoordinatorEvent,
  type RestrictionReport,
  type Roles,
  type StepResult,
  type TestOwnedApproval,
} from "@/server/internal/p1-write-freeze-coordinator/contract";
import { assertBinding, sameBinding } from "@/server/internal/p1-write-freeze-coordinator/identity";
import { openJournal, withJournalLock, type Journal, type JournalEntry } from "@/server/internal/p1-write-freeze-coordinator/journal";
import { transition } from "@/server/internal/p1-write-freeze-coordinator/machine";
import { classifyInventory } from "@/server/internal/p1-write-freeze-coordinator/writers";

const WRITE_PROBES: Array<keyof RestrictionReport> = [
  "setRoleInsert",
  "loginInsert",
  "loginUpdate",
  "loginDelete",
  "loginTruncate",
  "loginNextval",
  "loginSetval",
  "loginCreate",
  "loginSetRole",
  "securityDefiner",
];

export type Coordinator = {
  requestFreeze(approval: TestOwnedApproval): StepResult;
  freeze(): StepResult;
  backupAndRestore(): StepResult;
  acceptP1(approval: TestOwnedApproval): StepResult;
  applyPinnedP1(sql: string): StepResult;
  postcheck(): StepResult;
  unfreeze(approval: TestOwnedApproval): StepResult;
  reread(): StepResult;
  rejectDestructiveRestore(): StepResult;
  head(): JournalEntry;
};

export function createCoordinator(options: {
  directory: string;
  binding: Binding;
  roles: Roles;
  port: CatalogPort;
  backup: BackupPort;
  clock: () => Date;
}): Coordinator {
  assertBinding(options.binding);
  const { directory, binding, roles, port, backup, clock } = options;

  function run(fn: (journal: Journal) => StepResult): StepResult {
    try {
      return withJournalLock(directory, () => {
        const journal = openJournal(directory, binding);
        try {
          assertLive(journal);
          return fn(journal);
        } catch (error) {
          if (error instanceof CoordinatorFault) return onFault(journal, error);
          if (error instanceof CoordinatorRefusal) return stopped(journal, error.code, null);
          return onUnknown(journal);
        }
      });
    } catch (error) {
      if (error instanceof CoordinatorRefusal && error.code === "LOCK_HELD") {
        return { ok: false, state: peekState(), code: "LOCK_HELD", sqlstate: null };
      }
      if (error instanceof CoordinatorRefusal) {
        return { ok: false, state: peekState(), code: error.code, sqlstate: null };
      }
      throw error;
    }
  }

  function peekState() {
    try {
      return openJournal(directory, binding).head().state;
    } catch {
      return "UNCERTAIN" as const;
    }
  }

  function assertLive(journal: Journal): void {
    let live: Binding;
    try {
      live = port.readIdentity();
    } catch {
      markUnreadable(journal);
      return;
    }
    if (!sameBinding(live, binding) || !port.applicationAlive() || !port.containerUnchanged()) {
      markUnreadable(journal);
    }
  }

  function markUnreadable(journal: Journal): never {
    const state = journal.head().state;
    if (state === "NORMAL" || transition(state, "IDENTITY_UNREADABLE").ok === false) {
      throw new CoordinatorRefusal(state === "NORMAL" ? "IDENTITY_MISMATCH" : "IDENTITY_UNREADABLE");
    }
    journal.append("IDENTITY_UNREADABLE", { note: "identity drifted" });
    throw new CoordinatorRefusal("IDENTITY_UNREADABLE");
  }

  function onFault(journal: Journal, fault: CoordinatorFault): StepResult {
    if (fault.point === "before-commit" && journal.head().state === "FREEZE_REQUESTED") {
      return moved(journal, "CRASH_BEFORE_COMMIT", { privilegePhase: "rolled-back", note: fault.point }, null);
    }
    if (fault.point === "after-commit" && journal.head().state === "FREEZE_REQUESTED") {
      journal.append("PRIVILEGE_COMMIT", { privilegePhase: "committed", note: fault.point });
      return moved(journal, "CRASH_BEFORE_DRAIN", { note: fault.point }, null);
    }
    if (fault.point === "during-drain") {
      if (journal.head().state === "REVOKE_COMMITTED") journal.append("BEGIN_DRAIN", { note: fault.point });
      if (transition(journal.head().state, "CRASH").ok) return moved(journal, "CRASH", { note: fault.point }, null);
      return onUnknown(journal);
    }
    if (fault.point === "after-verified" && journal.head().state === "FROZEN_VERIFIED") {
      return moved(journal, "CRASH", { note: fault.point }, null);
    }
    if (fault.point === "after-p1-commit" && journal.head().state === "P1_APPLY") {
      return moved(journal, "P1_AMBIGUOUS", { p1Status: "ambiguous", note: "committed work remains; do not restore" }, null);
    }
    return onUnknown(journal);
  }

  function onUnknown(journal: Journal): StepResult {
    const state = journal.head().state;
    if (state !== "NORMAL" && transition(state, "IDENTITY_UNREADABLE").ok) {
      return moved(journal, "IDENTITY_UNREADABLE", { note: "port failed" }, null);
    }
    return stopped(journal, "PORT_FAILED", null);
  }

  return {
    requestFreeze(approval) {
      return run((journal) => {
        if (journal.head().state !== "NORMAL") return stopped(journal, "INVALID_TRANSITION", null);
        const decision = evaluateApproval(approval, expectation("FREEZE_REQUEST", "freeze-request"), journal.head().consumedNonces);
        if (!decision.ok) return stopped(journal, decision.code, null);
        return moved(journal, "REQUEST_FREEZE", { consumedNonces: [...journal.head().consumedNonces, approval.nonce] }, null);
      });
    },
    freeze() {
      return run((journal) => {
        if (journal.head().state !== "FREEZE_REQUESTED") return stopped(journal, "INVALID_TRANSITION", null);
        const admin = port.administrator();
        if (!admin.ok || admin.user !== roles.breakglass) {
          return moved(journal, "BLOCK", { note: "MISSING_ADMINISTRATOR" }, admin.ok ? null : admin.sqlstate);
        }
        const before = classifyInventory(port.inventory(), roles, "before");
        if (!before.ok) return moved(journal, "BLOCK", { note: before.problems.join(",") }, null);
        const committed = port.commitFreeze();
        if (!committed.ok) {
          if (committed.rolledBack) {
            return moved(journal, "PRIVILEGE_ROLLBACK", { privilegePhase: "rolled-back" }, committed.sqlstate);
          }
          return moved(journal, "IDENTITY_UNREADABLE", { note: "privilege transaction uncertain" }, committed.sqlstate);
        }
        journal.append("PRIVILEGE_COMMIT", { privilegePhase: "committed" });
        journal.append("BEGIN_DRAIN");
        const activity = port.activity();
        if (activity.some((row) => row.user === roles.bootstrap || row.user === roles.breakglass)) {
          return moved(journal, "UNEXPECTED_SUPERUSER", { note: "superuser session retains write authority" }, null);
        }
        const victims = activity.filter((row) => row.user === roles.application).map((row) => row.pid);
        const drained = port.terminate(victims);
        if (drained.remaining.length > 0) return moved(journal, "VERIFY_FAILED", { note: "APP_SESSION" }, null);
        const after = classifyInventory(port.inventory(), roles, "after");
        if (!after.ok) {
          const event: CoordinatorEvent = after.problems.includes("PRIVILEGED_SESSION") ? "UNEXPECTED_SUPERUSER" : "VERIFY_FAILED";
          return moved(journal, event, { note: after.problems.join(",") }, null);
        }
        const grants = port.grantsAreFreeze();
        if (grants === "unknown") return moved(journal, "IDENTITY_UNREADABLE", { note: "grants unreadable" }, null);
        if (!grants) return moved(journal, "VERIFY_FAILED", { note: "GRANTS" }, null);
        const restrictions = port.restrictions();
        if (!frozenProbes(restrictions)) return moved(journal, "VERIFY_FAILED", { note: "CANARY" }, firstSqlState(restrictions));
        const digest = port.logicalDigest();
        const entry = moved(
          journal,
          "VERIFY_OK",
          {
            logicalDigest: digest,
            note: "APPLICATION_ROLE_ONLY; revoking application DML does not stop a superuser or the owning migrator",
          },
          null,
        );
        port.checkpoint("after-verified");
        return entry;
      });
    },
    backupAndRestore() {
      return run((journal) => {
        const head = journal.head();
        if (head.state !== "FROZEN_VERIFIED" || head.logicalDigest === null) return stopped(journal, "INVALID_TRANSITION", null);
        if (port.logicalDigest() !== head.logicalDigest) return moved(journal, "BLOCK", { note: "DIGEST" }, null);
        journal.append("BEGIN_BACKUP");
        const dumped = backup.dump(binding.databaseName);
        if (!dumped.ok) return moved(journal, "BACKUP_FAILED", { note: dumped.reason }, null);
        journal.append("BACKUP_OK", { backupDigest: dumped.digest });
        const restored = backup.restore(binding.databaseName, dumped.digest);
        if (!restored.ok || restored.digest !== head.logicalDigest || port.logicalDigest() !== head.logicalDigest) {
          return moved(journal, "RESTORE_FAILED", { note: restored.ok ? "DIGEST" : restored.reason }, null);
        }
        return moved(journal, "RESTORE_OK", { restoreDigest: restored.digest }, null);
      });
    },
    acceptP1(approval) {
      return run((journal) => authorize(journal, approval, "P1_APPLY", journal.head().backupDigest, "P1_AUTHORIZED"));
    },
    applyPinnedP1(sql) {
      return run((journal) => {
        if (journal.head().state !== "P1_APPLY") return stopped(journal, "INVALID_TRANSITION", null);
        if (createHash("sha256").update(sql).digest("hex") !== P1_SHA256) return stopped(journal, "P1_PIN_MISMATCH", null);
        const result = port.applyP1(sql);
        if (result.outcome === "committed") {
          port.checkpoint("after-p1-commit");
          return moved(journal, "P1_COMMITTED", { p1Status: "committed" }, result.sqlstate);
        }
        if (result.outcome === "ambiguous") {
          return moved(journal, "P1_AMBIGUOUS", { p1Status: "ambiguous", note: "do not restore" }, result.sqlstate);
        }
        return moved(journal, "P1_FAILED", { p1Status: "failed" }, result.sqlstate);
      });
    },
    postcheck() {
      return run((journal) => {
        const head = journal.head();
        if (head.state !== "P1_POSTCHECK") return stopped(journal, "INVALID_TRANSITION", null);
        const visible = port.p1Visible();
        const stillFrozen = frozenProbes(port.restrictions());
        if (head.p1Status !== "committed" || visible !== true || !stillFrozen || port.logicalDigest() !== head.logicalDigest) {
          return moved(journal, "POSTCHECK_FAILED", { postcheckPassed: false }, null);
        }
        return moved(journal, "POSTCHECK_OK", { postcheckPassed: true }, null);
      });
    },
    unfreeze(approval) {
      return run((journal) => {
        const head = journal.head();
        if (head.state !== "P1_POSTCHECK" || !head.postcheckPassed || head.p1Status === "ambiguous") {
          return stopped(journal, "UNFREEZE_PRECONDITION", null);
        }
        const decision = evaluateApproval(
          approval,
          expectation("UNFREEZE", head.logicalDigest ?? ""),
          head.consumedNonces,
        );
        if (!decision.ok) return stopped(journal, decision.code, null);
        const facts = port.unfreezePreconditions();
        if (facts === "unknown") return moved(journal, "BLOCK", { note: "UNFREEZE_UNKNOWN" }, null);
        if (
          facts.databaseOwner !== roles.migrator ||
          facts.applicationRole !== roles.application ||
          facts.applicationSuperuser ||
          facts.applicationCreate ||
          facts.migratorSuperuser ||
          !facts.migratorCreate ||
          facts.containerId !== binding.containerId ||
          facts.startedAt !== binding.startedAt
        ) {
          return stopped(journal, "UNFREEZE_PRECONDITION", null);
        }
        journal.append("UNFREEZE_AUTHORIZED", { consumedNonces: [...head.consumedNonces, approval.nonce] });
        const granted = port.commitUnfreeze();
        if (!granted.ok) return moved(journal, "UNFREEZE_UNCERTAIN", { note: "grant uncertain" }, granted.sqlstate);
        const write = port.ordinaryWrite();
        const restrictions = port.restrictions();
        if (!write.ok || restrictions.loginCreate.ok || restrictions.loginCreate.sqlstate !== "42501") {
          return moved(journal, "UNFREEZE_UNCERTAIN", { note: "post-grant probe failed" }, write.sqlstate);
        }
        return moved(journal, "UNFREEZE_GRANTS_COMMITTED", { privilegePhase: "not-started", note: "application DML restored; DDL remains revoked" }, null);
      });
    },
    reread() {
      return run((journal) => {
        if (journal.head().state !== "UNCERTAIN") return stopped(journal, "INVALID_TRANSITION", null);
        const grants = port.grantsAreFreeze();
        const after = classifyInventory(port.inventory(), roles, "after");
        if (grants !== true || !after.ok || !frozenProbes(port.restrictions())) {
          return stopped(journal, "REREAD_FAILED", null);
        }
        const digest = port.logicalDigest();
        if (journal.head().logicalDigest !== null && digest !== journal.head().logicalDigest) {
          return stopped(journal, "REREAD_FAILED", null);
        }
        return moved(
          journal,
          "REREAD_FROZEN",
          { logicalDigest: journal.head().logicalDigest ?? digest, note: "reread matched the application freeze" },
          null,
        );
      });
    },
    rejectDestructiveRestore() {
      return run((journal) => stopped(journal, "DESTRUCTIVE_RESTORE_FORBIDDEN", null));
    },
    head() {
      return withJournalLock(directory, () => openJournal(directory, binding).head());
    },
  };

  function authorize(
    journal: Journal,
    approval: TestOwnedApproval,
    kind: TestOwnedApproval["kind"],
    digest: string | null,
    event: CoordinatorEvent,
  ): StepResult {
    const head = journal.head();
    if (head.consumedNonces.includes(approval.nonce)) return stopped(journal, "REPLAY", null);
    if (kind === "P1_APPLY" && head.state !== "AWAITING_OWNER_AUTHORIZATION") return stopped(journal, "INVALID_TRANSITION", null);
    const decision = evaluateApproval(approval, expectation(kind, digest ?? ""), head.consumedNonces);
    if (!decision.ok) {
      if (decision.code === "EXPIRED" && head.state === "AWAITING_OWNER_AUTHORIZATION") {
        return moved(journal, "APPROVAL_EXPIRED", { note: "EXPIRED" }, null);
      }
      return stopped(journal, decision.code, null);
    }
    return moved(journal, event, { consumedNonces: [...head.consumedNonces, approval.nonce] }, null);
  }

  function expectation(kind: TestOwnedApproval["kind"], digest: string) {
    return {
      kind,
      invocationId: binding.invocationId,
      databaseName: binding.databaseName,
      containerId: binding.containerId,
      daemonId: binding.daemonId,
      digest,
      now: clock(),
    };
  }
}

function moved(journal: Journal, event: CoordinatorEvent, patch: Partial<JournalEntry>, sqlstate: string | null): StepResult {
  const entry = journal.append(event, patch);
  const failed = entry.state === "BLOCKED" || entry.state === "UNCERTAIN" || entry.state === "MANUAL_RECOVERY_REQUIRED";
  return { ok: !failed, state: entry.state, code: patch.note ?? null, sqlstate };
}

function stopped(journal: Journal, code: string, sqlstate: string | null): StepResult {
  return { ok: false, state: journal.head().state, code, sqlstate };
}

function frozenProbes(report: RestrictionReport): boolean {
  if (!report.loginSelect.ok) return false;
  return WRITE_PROBES.every((name) => report[name].ok === false && report[name].sqlstate === "42501");
}

function firstSqlState(report: RestrictionReport): string | null {
  for (const name of WRITE_PROBES) {
    if (report[name].sqlstate) return report[name].sqlstate;
  }
  return null;
}
