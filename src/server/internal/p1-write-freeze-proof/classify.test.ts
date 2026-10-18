import { describe, expect, it } from "vitest";
import { classifyFreeze, type FreezeEvidence } from "@/server/internal/p1-write-freeze-proof/classify";

function evidence(overrides: Partial<FreezeEvidence> = {}): FreezeEvidence {
  return {
    catalogReadable: true,
    breakGlassLogin: true,
    privilegeTransaction: "committed",
    grantsAreFreeze: true,
    applicationBackendsRemaining: 0,
    unexpectedSuperuserSession: false,
    operatorInterrupted: false,
    canary: "authenticated-write-denied",
    unfreezeGrantsCommitted: false,
    appStillNonSuperuser: true,
    ownershipStillMigrator: true,
    postUnfreezeWrite: false,
    ...overrides,
  };
}

describe("write-freeze proof classification", () => {
  it("does not repair any observation", () => {
    const states = [
      evidence(),
      evidence({ catalogReadable: false }),
      evidence({ privilegeTransaction: "rolled-back" }),
      evidence({ operatorInterrupted: true, applicationBackendsRemaining: 2 }),
      evidence({ canary: "write-succeeded" }),
      evidence({ canary: "authentication-failed" }),
      evidence({ unexpectedSuperuserSession: true }),
      evidence({ breakGlassLogin: false }),
      evidence({ grantsAreFreeze: "unknown" }),
      evidence({ applicationBackendsRemaining: "unknown" }),
      evidence({
        unfreezeGrantsCommitted: true,
        postUnfreezeWrite: true,
      }),
    ];
    for (const item of states) expect(classifyFreeze(item).repair).toBe("none");
  });

  it("classifies the required failure and success cases", () => {
    expect(classifyFreeze(evidence({ privilegeTransaction: "not-started" })).state).toBe("NORMAL");
    expect(classifyFreeze(evidence({ privilegeTransaction: "rolled-back" })).state).toBe("NORMAL");
    expect(classifyFreeze(evidence({ applicationBackendsRemaining: 1, canary: "not-run" })).state).toBe(
      "REVOKE_COMMITTED",
    );
    expect(classifyFreeze(evidence({ operatorInterrupted: true })).state).toBe("UNCERTAIN");
    expect(classifyFreeze(evidence({ catalogReadable: false })).state).toBe("UNCERTAIN");
    expect(classifyFreeze(evidence({ unexpectedSuperuserSession: true })).state).toBe("UNCERTAIN");
    expect(classifyFreeze(evidence({ breakGlassLogin: false })).state).toBe("UNCERTAIN");
    expect(classifyFreeze(evidence({ grantsAreFreeze: "unknown" })).state).toBe("UNCERTAIN");
    expect(classifyFreeze(evidence({ canary: "write-succeeded" })).state).toBe("UNCERTAIN");
    expect(classifyFreeze(evidence({ canary: "authentication-failed" })).state).toBe("UNCERTAIN");
    expect(classifyFreeze(evidence()).state).toBe("FROZEN_VERIFIED");
    expect(
      classifyFreeze(
        evidence({ unfreezeGrantsCommitted: true, postUnfreezeWrite: true, canary: "not-run" }),
      ).state,
    ).toBe("UNFREEZE_AUTHORIZED");
  });
});
