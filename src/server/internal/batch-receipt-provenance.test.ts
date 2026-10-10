import { describe, expect, it } from "vitest";
import {
  BATCH_RECEIPT_PROVENANCE_INVALID,
  buildBatchReceiptProvenance,
} from "./batch-receipt-provenance";

const commandId = "cmd-1";
const batchId = "batch-1";

function lot(id: string, quantity: number, owner = batchId) {
  return { id, batchId: owner, quantity };
}

describe("buildBatchReceiptProvenance", () => {
  it("keeps one positive lot and the exact object shape", () => {
    const snapshot = buildBatchReceiptProvenance({
      commandId,
      batchId,
      lots: [lot("lot-a", 6)],
    });
    expect(snapshot).toEqual({
      v: 1,
      d: "BATCH_RECEIPT_PROVENANCE",
      commandId,
      batchId,
      pairs: [{ railLotId: "lot-a", quantity: 6 }],
    });
    expect(Object.keys(snapshot)).toEqual(["v", "d", "commandId", "batchId", "pairs"]);
    expect(Object.keys(snapshot.pairs[0] ?? {})).toEqual(["railLotId", "quantity"]);
  });

  it("sorts several lots by railLotId and ignores input order", () => {
    const lots = [lot("lot-c", 1), lot("lot-a", 2), lot("lot-b", 3)];
    const forward = buildBatchReceiptProvenance({ commandId, batchId, lots });
    const reverse = buildBatchReceiptProvenance({
      commandId,
      batchId,
      lots: [...lots].reverse(),
    });
    expect(forward.pairs.map((pair) => pair.railLotId)).toEqual(["lot-a", "lot-b", "lot-c"]);
    expect(reverse).toEqual(forward);
  });

  it("keeps two pairs when the specifications match and the lot ids differ", () => {
    const snapshot = buildBatchReceiptProvenance({
      commandId,
      batchId,
      lots: [lot("lot-b", 4), lot("lot-a", 4)],
    });
    expect(snapshot.pairs).toEqual([
      { railLotId: "lot-a", quantity: 4 },
      { railLotId: "lot-b", quantity: 4 },
    ]);
  });

  it("retains a zero quantity and does not treat it as an empty list", () => {
    const snapshot = buildBatchReceiptProvenance({
      commandId,
      batchId,
      lots: [lot("lot-z", 0), lot("lot-p", 2)],
    });
    expect(snapshot.pairs).toEqual([
      { railLotId: "lot-p", quantity: 2 },
      { railLotId: "lot-z", quantity: 0 },
    ]);
  });

  it.each([
    ["negative", -1],
    ["fraction", 1.5],
    ["nan", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
  ])("rejects %s quantity", (_label, quantity) => {
    expect(() =>
      buildBatchReceiptProvenance({
        commandId,
        batchId,
        lots: [lot("lot-a", quantity)],
      }),
    ).toThrow(BATCH_RECEIPT_PROVENANCE_INVALID);
  });

  it("rejects a blank id, a duplicate lot, and a lot from another batch", () => {
    expect(() =>
      buildBatchReceiptProvenance({ commandId: "  ", batchId, lots: [lot("lot-a", 1)] }),
    ).toThrow(BATCH_RECEIPT_PROVENANCE_INVALID);
    expect(() =>
      buildBatchReceiptProvenance({ commandId, batchId: "", lots: [lot("lot-a", 1)] }),
    ).toThrow(BATCH_RECEIPT_PROVENANCE_INVALID);
    expect(() =>
      buildBatchReceiptProvenance({ commandId, batchId, lots: [lot("  ", 1)] }),
    ).toThrow(BATCH_RECEIPT_PROVENANCE_INVALID);
    expect(() =>
      buildBatchReceiptProvenance({
        commandId,
        batchId,
        lots: [lot("lot-a", 1), lot("lot-a", 1)],
      }),
    ).toThrow(BATCH_RECEIPT_PROVENANCE_INVALID);
    expect(() =>
      buildBatchReceiptProvenance({
        commandId,
        batchId,
        lots: [lot("lot-a", 1, "other-batch")],
      }),
    ).toThrow(BATCH_RECEIPT_PROVENANCE_INVALID);
  });
});
