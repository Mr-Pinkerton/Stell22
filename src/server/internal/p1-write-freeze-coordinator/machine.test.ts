import { describe, expect, it } from "vitest";
import { transition } from "@/server/internal/p1-write-freeze-coordinator/machine";

describe("write-freeze coordinator state machine", () => {
  it("walks the authorized interval and returns to NORMAL only after unfreeze grants", () => {
    const path = [
      ["NORMAL", "REQUEST_FREEZE", "FREEZE_REQUESTED"],
      ["FREEZE_REQUESTED", "PRIVILEGE_COMMIT", "REVOKE_COMMITTED"],
      ["REVOKE_COMMITTED", "BEGIN_DRAIN", "DRAINING"],
      ["DRAINING", "VERIFY_OK", "FROZEN_VERIFIED"],
      ["FROZEN_VERIFIED", "BEGIN_BACKUP", "BACKUP_IN_PROGRESS"],
      ["BACKUP_IN_PROGRESS", "BACKUP_OK", "RESTORE_VERIFICATION"],
      ["RESTORE_VERIFICATION", "RESTORE_OK", "AWAITING_OWNER_AUTHORIZATION"],
      ["AWAITING_OWNER_AUTHORIZATION", "P1_AUTHORIZED", "P1_APPLY"],
      ["P1_APPLY", "P1_COMMITTED", "P1_POSTCHECK"],
      ["P1_POSTCHECK", "POSTCHECK_OK", "P1_POSTCHECK"],
      ["P1_POSTCHECK", "UNFREEZE_AUTHORIZED", "UNFREEZE_AUTHORIZED"],
      ["UNFREEZE_AUTHORIZED", "UNFREEZE_GRANTS_COMMITTED", "NORMAL"],
    ] as const;
    for (const [from, event, to] of path) {
      expect(transition(from, event)).toEqual({ ok: true, state: to });
    }
  });

  it("rejects an unfreeze from every state that has not been separately authorized", () => {
    const blocked = [
      "NORMAL",
      "FREEZE_REQUESTED",
      "REVOKE_COMMITTED",
      "DRAINING",
      "FROZEN_VERIFIED",
      "BACKUP_IN_PROGRESS",
      "RESTORE_VERIFICATION",
      "AWAITING_OWNER_AUTHORIZATION",
      "P1_APPLY",
      "P1_POSTCHECK",
      "BLOCKED",
      "UNCERTAIN",
      "MANUAL_RECOVERY_REQUIRED",
    ] as const;
    for (const state of blocked) {
      expect(transition(state, "UNFREEZE_GRANTS_COMMITTED").ok).toBe(false);
      expect(transition(state, "TIMEOUT").ok).toBe(false);
    }
  });

  it("keeps the freeze when backup, restore, approval, P1, or postcheck fails", () => {
    expect(transition("BACKUP_IN_PROGRESS", "BACKUP_FAILED")).toEqual({ ok: true, state: "BLOCKED" });
    expect(transition("RESTORE_VERIFICATION", "RESTORE_FAILED")).toEqual({ ok: true, state: "BLOCKED" });
    expect(transition("AWAITING_OWNER_AUTHORIZATION", "APPROVAL_EXPIRED")).toEqual({
      ok: true,
      state: "AWAITING_OWNER_AUTHORIZATION",
    });
    expect(transition("AWAITING_OWNER_AUTHORIZATION", "APPROVAL_MISSING")).toEqual({
      ok: true,
      state: "AWAITING_OWNER_AUTHORIZATION",
    });
    expect(transition("P1_APPLY", "P1_FAILED")).toEqual({ ok: true, state: "BLOCKED" });
    expect(transition("P1_APPLY", "P1_AMBIGUOUS")).toEqual({ ok: true, state: "MANUAL_RECOVERY_REQUIRED" });
    expect(transition("P1_POSTCHECK", "POSTCHECK_FAILED")).toEqual({ ok: true, state: "BLOCKED" });
  });

  it("fails closed on crash windows and does not skip to a verified freeze", () => {
    expect(transition("FREEZE_REQUESTED", "CRASH_BEFORE_COMMIT")).toEqual({ ok: true, state: "FREEZE_REQUESTED" });
    expect(transition("REVOKE_COMMITTED", "CRASH_BEFORE_DRAIN")).toEqual({ ok: true, state: "UNCERTAIN" });
    expect(transition("DRAINING", "CRASH")).toEqual({ ok: true, state: "UNCERTAIN" });
    expect(transition("FROZEN_VERIFIED", "CRASH")).toEqual({ ok: true, state: "FROZEN_VERIFIED" });
    expect(transition("FROZEN_VERIFIED", "IDENTITY_UNREADABLE")).toEqual({ ok: true, state: "UNCERTAIN" });
    expect(transition("DRAINING", "PRIVILEGED_WRITER")).toEqual({ ok: true, state: "BLOCKED" });
    expect(transition("DRAINING", "UNEXPECTED_SUPERUSER")).toEqual({ ok: true, state: "UNCERTAIN" });
    expect(transition("FROZEN_VERIFIED", "UNEXPECTED_SUPERUSER")).toEqual({ ok: true, state: "UNCERTAIN" });
    expect(transition("UNCERTAIN", "REREAD_FROZEN")).toEqual({ ok: true, state: "FROZEN_VERIFIED" });
    expect(transition("UNCERTAIN", "UNFREEZE_AUTHORIZED").ok).toBe(false);
    expect(transition("MANUAL_RECOVERY_REQUIRED", "REREAD_FROZEN").ok).toBe(false);
    expect(transition("BLOCKED", "UNFREEZE_AUTHORIZED").ok).toBe(false);
  });

  it("rejects repeated and out-of-order requests without changing state", () => {
    expect(transition("FROZEN_VERIFIED", "REQUEST_FREEZE")).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(transition("NORMAL", "UNFREEZE_AUTHORIZED")).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(transition("FREEZE_REQUESTED", "VERIFY_OK")).toEqual({ ok: false, code: "INVALID_TRANSITION" });
    expect(transition("P1_POSTCHECK", "BEGIN_BACKUP")).toEqual({ ok: false, code: "INVALID_TRANSITION" });
  });
});
