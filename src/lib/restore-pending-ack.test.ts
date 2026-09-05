import { describe, expect, it } from "vitest";
import { restorePendingAck } from "./restore-pending-ack";
import type { TerminalDraftV1 } from "./terminal-draft-storage";

const lot = { id: "lot-1", lengthM: 2 };

function torcovka(over: {
  phase: "none" | "suspicious" | "approval" | "extreme";
  railsTaken?: number;
  producedQty?: number;
  lotId?: string | null;
  batchId?: string | null;
  approvalCode?: string;
}): TerminalDraftV1 {
  const producedQty = over.producedQty ?? 7;
  return {
    version: 1,
    employeeId: "emp-1",
    clientRequestId: "req-keep",
    createdAt: "2026-09-05T11:00:00.000Z",
    updatedAt: "2026-09-05T11:01:00.000Z",
    operationType: "TORCOVKA",
    payload: {
      batchId: over.batchId === undefined ? "batch-1" : over.batchId,
      lotId: over.lotId === undefined ? "lot-1" : over.lotId,
      railsTaken: over.railsTaken ?? 5,
      picks: [{ lengthM: 1, sort: "SORT1", quantity: producedQty }],
      activeSort: "SORT1",
      ackUi: {
        phase: over.phase === "extreme" ? "none" : over.phase,
        approvalCode: over.approvalCode ?? "",
      },
    },
  };
}

describe("restorePendingAck", () => {
  it("ignores non-TORCOVKA drafts", () => {
    expect(
      restorePendingAck({
        draft: {
          version: 1,
          employeeId: "emp-1",
          clientRequestId: "h",
          createdAt: "2026-09-05T11:00:00.000Z",
          updatedAt: "2026-09-05T11:00:00.000Z",
          operationType: "HOURS",
          payload: { hoursInput: "8" },
        },
        railLots: [lot],
      }),
    ).toBeNull();
  });

  it("ignores phase none", () => {
    expect(
      restorePendingAck({
        draft: torcovka({ phase: "none" }),
        railLots: [lot],
      }),
    ).toBeNull();
  });

  it("returns null when lot is missing", () => {
    expect(
      restorePendingAck({
        draft: torcovka({ phase: "suspicious" }),
        railLots: [],
      }),
    ).toBeNull();
  });

  it("returns null when current waste is NORMAL", () => {
    expect(
      restorePendingAck({
        draft: torcovka({ phase: "suspicious", producedQty: 9 }),
        railLots: [lot],
      }),
    ).toBeNull();
    expect(
      restorePendingAck({
        draft: torcovka({ phase: "approval", producedQty: 9 }),
        railLots: [lot],
      }),
    ).toBeNull();
  });

  it("restores current SUSPICIOUS and draft.clientRequestId", () => {
    const draft = torcovka({ phase: "suspicious", producedQty: 7 });
    const restored = restorePendingAck({ draft, railLots: [lot] });
    expect(restored?.status).toBe("ACK_REQUIRED");
    expect(restored?.band).toBe("SUSPICIOUS");
    expect(restored?.clientRequestId).toBe(draft.clientRequestId);
    expect(restored?.clientRequestId).toBe("req-keep");
    expect(restored?.wastePct).toBe("30.00");
    expect(restored?.railLotId).toBe("lot-1");
    expect(restored?.batchId).toBe("batch-1");
  });

  it("saved approval + current EXTREME restores APPROVAL_REQUIRED", () => {
    const draft = torcovka({ phase: "approval", producedQty: 2 });
    const restored = restorePendingAck({
      draft,
      railLots: [lot],
    });
    expect(restored?.status).toBe("APPROVAL_REQUIRED");
    expect(restored?.band).toBe("EXTREME");
    expect(restored?.clientRequestId).toBe(draft.clientRequestId);
    expect(restored?.clientRequestId).toBe("req-keep");
  });

  it("saved approval + current SUSPICIOUS restores SUSPICIOUS", () => {
    const restored = restorePendingAck({
      draft: torcovka({ phase: "approval", producedQty: 7 }),
      railLots: [lot],
    });
    expect(restored?.status).toBe("ACK_REQUIRED");
    expect(restored?.band).toBe("SUSPICIOUS");
    expect(restored?.clientRequestId).toBe("req-keep");
  });

  it("saved SUSPICIOUS + current EXTREME does not restore approval dialog", () => {
    const restored = restorePendingAck({
      draft: torcovka({ phase: "suspicious", producedQty: 2 }),
      railLots: [lot],
    });
    expect(restored).toBeNull();
  });

  it("legacy extreme parsed to none does not restore a dialog", () => {
    expect(
      restorePendingAck({
        draft: torcovka({ phase: "extreme", producedQty: 2 }),
        railLots: [lot],
      }),
    ).toBeNull();
  });
});
