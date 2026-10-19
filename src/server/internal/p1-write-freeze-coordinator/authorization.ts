import { MAX_APPROVAL_WINDOW_MS, type TestOwnedApproval } from "@/server/internal/p1-write-freeze-coordinator/contract";

export type ApprovalExpectation = {
  kind: TestOwnedApproval["kind"];
  invocationId: string;
  databaseName: string;
  containerId: string;
  daemonId: string;
  digest: string;
  now: Date;
};

export type ApprovalDecision =
  | { ok: true; consume: true }
  | { ok: false; code: string; consume: false };

export function evaluateApproval(
  approval: TestOwnedApproval,
  expected: ApprovalExpectation,
  consumed: readonly string[],
): ApprovalDecision {
  if (!approval || approval.scope !== "TEST_OWNED" || hasOwnerSignature(approval)) {
    return refuse("FORGED_OWNER");
  }
  if (approval.kind !== expected.kind) return refuse("KIND");
  if (
    approval.invocationId !== expected.invocationId ||
    approval.databaseName !== expected.databaseName ||
    approval.containerId !== expected.containerId ||
    approval.daemonId !== expected.daemonId
  ) {
    return refuse("IDENTITY");
  }
  if (approval.digest !== expected.digest) return refuse("DIGEST");
  if (!/^[0-9a-f]{32}$/.test(approval.nonce)) return refuse("MALFORMED");
  const notBefore = Date.parse(approval.notBefore);
  const notAfter = Date.parse(approval.notAfter);
  if (!Number.isFinite(notBefore) || !Number.isFinite(notAfter) || notAfter <= notBefore) return refuse("MALFORMED");
  if (notAfter - notBefore > MAX_APPROVAL_WINDOW_MS) return refuse("WINDOW");
  if (expected.now.getTime() < notBefore) return refuse("NOT_YET");
  if (expected.now.getTime() > notAfter) return refuse("EXPIRED");
  if (consumed.includes(approval.nonce)) return refuse("REPLAY");
  return { ok: true, consume: true };
}

function refuse(code: string): ApprovalDecision {
  return { ok: false, code, consume: false };
}

function hasOwnerSignature(approval: TestOwnedApproval): boolean {
  return Object.prototype.hasOwnProperty.call(approval, "ownerSignature") || Object.keys(approval).includes("production");
}
