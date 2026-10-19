import { describe, expect, it } from "vitest";
import { evaluateApproval } from "@/server/internal/p1-write-freeze-coordinator/authorization";
import type { TestOwnedApproval } from "@/server/internal/p1-write-freeze-coordinator/contract";

const now = new Date("2026-10-19T00:01:00.000Z");

function approval(patch: Partial<TestOwnedApproval> = {}): TestOwnedApproval {
  return {
    scope: "TEST_OWNED",
    kind: "P1_APPLY",
    invocationId: "inv",
    nonce: "a".repeat(32),
    notBefore: "2026-10-19T00:00:00.000Z",
    notAfter: "2026-10-19T00:15:00.000Z",
    databaseName: "p1wc_abcdef12",
    containerId: "c".repeat(64),
    daemonId: "daemon",
    digest: "digest",
    ...patch,
  };
}

const expected = {
  kind: "P1_APPLY" as const,
  invocationId: "inv",
  databaseName: "p1wc_abcdef12",
  containerId: "c".repeat(64),
  daemonId: "daemon",
  digest: "digest",
  now,
};

describe("test-owned approvals", () => {
  it("accepts one in-window approval and rejects replay, expiry, and a longer window", () => {
    expect(evaluateApproval(approval(), expected, []).ok).toBe(true);
    expect(code(evaluateApproval(approval(), expected, ["a".repeat(32)]))).toBe("REPLAY");
    expect(code(evaluateApproval(approval({ notAfter: "2026-10-19T00:00:30.000Z" }), expected, []))).toBe("EXPIRED");
    expect(code(evaluateApproval(approval({ notAfter: "2026-10-19T00:16:00.000Z" }), expected, []))).toBe("WINDOW");
    expect(evaluateApproval(approval({ notAfter: "2026-10-19T00:00:30.000Z" }), expected, []).consume).toBe(false);
  });

  it("rejects a forged owner signature and a production scope", () => {
    const forged = approval() as TestOwnedApproval & { ownerSignature: string };
    forged.ownerSignature = "forged";
    expect(code(evaluateApproval(forged, expected, []))).toBe("FORGED_OWNER");
    expect(code(evaluateApproval({ ...approval(), scope: "PRODUCTION" as "TEST_OWNED" }, expected, []))).toBe("FORGED_OWNER");
  });
});

function code(decision: { ok: boolean; code?: string }): string | undefined {
  return decision.code;
}
