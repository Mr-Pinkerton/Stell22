import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
} from "@/server/internal/inventory-movement-identity";
import {
  evaluateBatchReceiptInvariantA,
  readBatchReceiptInvariantA,
  BatchReceiptDiagnosticExecutionError,
  type BatchReceiptDiagnosticResult,
  type BatchReceiptObservedMovement,
  type BatchReceiptRetainedSource,
} from "@/server/internal/psr-p3-batch-receipt-invariant-a";

function expectInvariantB(result: BatchReceiptDiagnosticResult) {
  expect(result.invariantB).toBe("NOT_EVALUABLE");
  expect(result.contour).toBe("BATCH_RECEIPT");
  expect(result.causationKind).toBe("BATCH");
}

function receiptKey(railLotId: string) {
  const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId });
  return {
    effectKey: effectKeyV1("receipt", canonical.targetHashV1),
    targetSnapshot: canonical.targetSnapshot,
  };
}

function pair(railLotId: string, quantity: number) {
  return { railLotId, quantity };
}

function source(
  snapshot: unknown,
  overrides: Partial<BatchReceiptRetainedSource> = {},
): BatchReceiptRetainedSource {
  return {
    id: "cmd-1",
    batchId: "batch-1",
    receiptProvenanceSnapshot: snapshot,
    ...overrides,
  };
}

function provenance(
  pairs: Array<{ railLotId: string; quantity: number }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    v: 1,
    d: "BATCH_RECEIPT_PROVENANCE",
    commandId: "cmd-1",
    batchId: "batch-1",
    pairs,
    ...overrides,
  };
}

function observed(input: {
  id?: string;
  kind?: string;
  stockDomain?: string;
  quantityDelta: number;
  effectKey: string;
  causationId?: string;
  railLotId?: string | null;
  targetSnapshot: unknown;
  authority?: string;
  causationKind?: string;
}): BatchReceiptObservedMovement {
  return {
    id: input.id ?? `mv-${input.effectKey}`,
    kind: input.kind ?? "RECEIPT",
    stockDomain: input.stockDomain ?? "RAIL_LOT",
    quantityDelta: input.quantityDelta,
    effectKey: input.effectKey,
    authority: input.authority ?? "SHADOW",
    causationKind: input.causationKind ?? "BATCH",
    causationId: input.causationId ?? "cmd-1",
    railLotId: input.railLotId ?? null,
    nomenclatureId: null,
    targetSnapshot: input.targetSnapshot,
  };
}

function matching(railLotId: string, quantity: number, id?: string) {
  const key = receiptKey(railLotId);
  return observed({
    id,
    quantityDelta: quantity,
    effectKey: key.effectKey,
    railLotId,
    targetSnapshot: key.targetSnapshot,
  });
}

describe("evaluateBatchReceiptInvariantA", () => {
  it("returns SOURCE_UNAVAILABLE when the command is absent", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-missing",
      source: null,
      observed: [],
    });
    expect(result.invariantA).toBe("SOURCE_UNAVAILABLE");
    expect(result.expectedEffectCount).toBe(0);
    expectInvariantB(result);
  });

  it("returns NOT_EVALUABLE for SQL NULL and never MATCH_OBSERVED", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(null),
      observed: [],
    });
    expect(result.invariantA).toBe("NOT_EVALUABLE");
    expect(result.invariantA).not.toBe("MATCH_OBSERVED");
    expect(result.reason).toContain("absent");
    expectInvariantB(result);
  });

  it("does not treat a null provenance with a missing live lot as a proven zero", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(null),
      observed: [],
    });
    expect(result.invariantA).toBe("NOT_EVALUABLE");
    expect(result.expectedEffectCount).toBe(0);
  });

  it("matches one positive receipt", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 4)])),
      observed: [matching("lot-a", 4)],
    });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.expectedEffectCount).toBe(1);
    expect(result.observedShadowMovementCount).toBe(1);
    expect(result.differences).toEqual([]);
    expectInvariantB(result);
  });

  it("matches several positive receipts without using pair input order as identity", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 2), pair("lot-b", 5)])),
      observed: [matching("lot-b", 5, "mv-b"), matching("lot-a", 2, "mv-a")],
    });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.expectedEffectCount).toBe(2);
    expectInvariantB(result);
  });

  it("keeps an original zero pair and emits no receipt effect for it", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 0), pair("lot-b", 3)])),
      observed: [matching("lot-b", 3)],
    });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.expectedEffectCount).toBe(1);
    expectInvariantB(result);
  });

  it("treats an all-zero stored set and an empty observed set as a proven zero", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 0), pair("lot-b", 0)])),
      observed: [],
    });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.expectedEffectCount).toBe(0);
    expect(result.invariantA).not.toBe("GATE_UNKNOWN");
    expectInvariantB(result);
  });

  it("treats a valid empty pair list and an empty observed set as a proven zero", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([])),
      observed: [],
    });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.expectedEffectCount).toBe(0);
    expectInvariantB(result);
  });

  it("returns GATE_UNKNOWN for a nonempty expected set and zero movements", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 4)])),
      observed: [],
    });
    expect(result.invariantA).toBe("GATE_UNKNOWN");
    expect(result.invariantA).not.toBe("MISMATCH");
    expect(result.expectedEffectCount).toBe(1);
    expect(result.observedShadowMovementCount).toBe(0);
    expect(result.differences).toEqual([]);
    expectInvariantB(result);
  });

  it("returns INVALID_SOURCE for a duplicate railLotId and does not drop it", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 1), pair("lot-a", 2)])),
      observed: [matching("lot-a", 1), matching("lot-a", 2, "mv-2")],
    });
    expect(result.invariantA).toBe("INVALID_SOURCE");
    expect(result.expectedEffectCount).toBe(0);
    expect(result.invariantA).not.toBe("MATCH_OBSERVED");
  });

  it("returns INVALID_SOURCE when commandId or batchId is not bound to the row", () => {
    const wrongCommand = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 1)], { commandId: "cmd-other" })),
      observed: [matching("lot-a", 1)],
    });
    const wrongBatch = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 1)], { batchId: "batch-other" })),
      observed: [matching("lot-a", 1)],
    });
    expect(wrongCommand.invariantA).toBe("INVALID_SOURCE");
    expect(wrongBatch.invariantA).toBe("INVALID_SOURCE");
    expect(wrongCommand.invariantA).not.toBe("MATCH_OBSERVED");
    expect(wrongBatch.invariantA).not.toBe("MATCH_OBSERVED");
  });

  it("returns INVALID_SOURCE for a negative, fractional, or non-finite quantity", () => {
    for (const quantity of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = evaluateBatchReceiptInvariantA({
        causationId: "cmd-1",
        source: source(provenance([pair("lot-a", quantity)])),
        observed: [],
      });
      expect(result.invariantA).toBe("INVALID_SOURCE");
      expect(result.invariantA).not.toBe("GATE_UNKNOWN");
    }
  });

  it("returns INVALID_SOURCE for a malformed object and does not sort it into validity", () => {
    const cases = [
      provenance([pair("lot-b", 1), pair("lot-a", 2)]),
      { v: 1, d: "BATCH_RECEIPT_PROVENANCE", commandId: "cmd-1", batchId: "batch-1" },
      ["lot-a"],
      "not-an-object",
      { v: "1", d: "BATCH_RECEIPT_PROVENANCE", commandId: "cmd-1", batchId: "batch-1", pairs: [] },
    ];
    for (const snapshot of cases) {
      const result = evaluateBatchReceiptInvariantA({
        causationId: "cmd-1",
        source: source(snapshot),
        observed: [],
      });
      expect(result.invariantA).toBe("INVALID_SOURCE");
    }
  });

  it("leaves an unsupported numeric version unread instead of applying version-1 pair rules", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source({
        v: 2,
        d: "BATCH_RECEIPT_PROVENANCE",
        commandId: "cmd-1",
        batchId: "batch-1",
        pairs: [pair("lot-a", 1), pair("lot-a", 1)],
      }),
      observed: [],
    });
    expect(result.invariantA).toBe("NOT_EVALUABLE");
    expect(result.invariantA).not.toBe("INVALID_SOURCE");
    expect(result.invariantA).not.toBe("MATCH_OBSERVED");
  });

  it("leaves an unsupported domain unread", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([], { d: "OTHER_PROVENANCE" })),
      observed: [],
    });
    expect(result.invariantA).toBe("NOT_EVALUABLE");
    expect(result.invariantA).not.toBe("MATCH_OBSERVED");
  });

  it("reports an extra movement as MISMATCH and does not deduplicate it away", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 4)])),
      observed: [matching("lot-a", 4, "mv-a"), matching("lot-b", 1, "mv-b")],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.differences.map((item) => item.code)).toContain("UNEXPECTED_EFFECT");
    expect(result.observedShadowMovementCount).toBe(2);
  });

  it("reports an empty expected set with an observed movement as MISMATCH", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([])),
      observed: [matching("lot-a", 1)],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.invariantA).not.toBe("MATCH_OBSERVED");
    expect(result.invariantA).not.toBe("GATE_UNKNOWN");
  });

  it("reports a wrong target, kind, effectKey, sign, quantity, or snapshot as MISMATCH", () => {
    const key = receiptKey("lot-a");
    const cases: Array<{ row: BatchReceiptObservedMovement; code: string }> = [
      { row: matching("lot-other", 4), code: "MISSING_EFFECT" },
      {
        row: observed({
          quantityDelta: 4,
          effectKey: key.effectKey,
          railLotId: "lot-a",
          targetSnapshot: key.targetSnapshot,
          kind: "ADJUSTMENT",
        }),
        code: "KIND",
      },
      {
        row: observed({
          quantityDelta: 4,
          effectKey: "imfx1:receipt:not-the-canonical-hash",
          railLotId: "lot-a",
          targetSnapshot: key.targetSnapshot,
        }),
        code: "EFFECT_KEY",
      },
      {
        row: observed({
          quantityDelta: -4,
          effectKey: key.effectKey,
          railLotId: "lot-a",
          targetSnapshot: key.targetSnapshot,
        }),
        code: "SIGN",
      },
      {
        row: observed({
          quantityDelta: 9,
          effectKey: key.effectKey,
          railLotId: "lot-a",
          targetSnapshot: key.targetSnapshot,
        }),
        code: "QUANTITY",
      },
      {
        row: observed({
          quantityDelta: 4,
          effectKey: key.effectKey,
          railLotId: "lot-a",
          targetSnapshot: { v: 1, d: "RAIL_LOT", railLotId: "lot-other" },
        }),
        code: "TARGET_SNAPSHOT",
      },
      {
        row: observed({
          quantityDelta: 4,
          effectKey: "imfx1:receipt:other-domain",
          stockDomain: "NOMENCLATURE",
          railLotId: null,
          targetSnapshot: { v: 1, d: "NOMENCLATURE", nomenclatureId: "nom-1" },
        }),
        code: "UNEXPECTED_EFFECT",
      },
    ];
    for (const item of cases) {
      const result = evaluateBatchReceiptInvariantA({
        causationId: "cmd-1",
        source: source(provenance([pair("lot-a", 4)])),
        observed: [item.row],
      });
      expect(result.invariantA).toBe("MISMATCH");
      expect(result.differences.map((difference) => difference.code)).toContain(item.code);
    }
  });

  it("does not aggregate duplicate observed movements into one quantity", () => {
    const result = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 4)])),
      observed: [matching("lot-a", 2, "mv-1"), matching("lot-a", 2, "mv-2")],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.observedShadowMovementCount).toBe(2);
    expect(result.differences.map((item) => item.code)).toEqual(
      expect.arrayContaining(["QUANTITY", "UNEXPECTED_EFFECT"]),
    );
    expect(result.invariantA).not.toBe("MATCH_OBSERVED");
  });

  it("keeps Invariant B NOT_EVALUABLE for every completed status", () => {
    const results = [
      evaluateBatchReceiptInvariantA({
        causationId: "cmd-1",
        source: source(provenance([pair("lot-a", 4)])),
        observed: [matching("lot-a", 4)],
      }),
      evaluateBatchReceiptInvariantA({
        causationId: "missing",
        source: null,
        observed: [],
      }),
      evaluateBatchReceiptInvariantA({
        causationId: "cmd-1",
        source: source(null),
        observed: [],
      }),
      evaluateBatchReceiptInvariantA({
        causationId: "cmd-1",
        source: source(provenance([pair("lot-a", 4)])),
        observed: [],
      }),
      evaluateBatchReceiptInvariantA({
        causationId: "cmd-1",
        source: source(provenance([pair("lot-a", -1)])),
        observed: [],
      }),
      evaluateBatchReceiptInvariantA({
        causationId: "cmd-1",
        source: source(provenance([pair("lot-a", 4)])),
        observed: [matching("lot-b", 1)],
      }),
    ];
    expect(results.map((item) => item.invariantA)).toEqual([
      "MATCH_OBSERVED",
      "SOURCE_UNAVAILABLE",
      "NOT_EVALUABLE",
      "GATE_UNKNOWN",
      "INVALID_SOURCE",
      "MISMATCH",
    ]);
    expect(results.every((item) => item.invariantB === "NOT_EVALUABLE")).toBe(true);
  });

  it("sorts reported differences deterministically", () => {
    const key = receiptKey("lot-a");
    const forward = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 4), pair("lot-b", 2)])),
      observed: [
        matching("lot-b", 9, "mv-b"),
        observed({
          id: "mv-extra",
          quantityDelta: 1,
          effectKey: "imfx1:receipt:extra",
          railLotId: "lot-c",
          targetSnapshot: receiptKey("lot-c").targetSnapshot,
        }),
        observed({
          id: "mv-a",
          quantityDelta: 4,
          effectKey: "imfx1:receipt:wrong",
          railLotId: "lot-a",
          targetSnapshot: key.targetSnapshot,
        }),
      ],
    });
    const reverse = evaluateBatchReceiptInvariantA({
      causationId: "cmd-1",
      source: source(provenance([pair("lot-a", 4), pair("lot-b", 2)])),
      observed: [...forward.differences].length
        ? [
            observed({
              id: "mv-a",
              quantityDelta: 4,
              effectKey: "imfx1:receipt:wrong",
              railLotId: "lot-a",
              targetSnapshot: key.targetSnapshot,
            }),
            observed({
              id: "mv-extra",
              quantityDelta: 1,
              effectKey: "imfx1:receipt:extra",
              railLotId: "lot-c",
              targetSnapshot: receiptKey("lot-c").targetSnapshot,
            }),
            matching("lot-b", 9, "mv-b"),
          ]
        : [],
    });
    expect(forward.differences).toEqual(reverse.differences);
    const codes = forward.differences.map((item) => item.code);
    expect(codes).toEqual([...codes].sort());
  });
});

describe("readBatchReceiptInvariantA", () => {
  it("fails closed when the database read throws", async () => {
    const db = {
      $transaction: async () => {
        throw new Error("connection reset");
      },
    };
    await expect(
      readBatchReceiptInvariantA(db as never, { causationId: "cmd-1" }),
    ).rejects.toBeInstanceOf(BatchReceiptDiagnosticExecutionError);
  });

  it("does not write movements, persist a status, or read the SHADOW gate", () => {
    const sourceText = readFileSync(
      path.join(import.meta.dirname, "psr-p3-batch-receipt-invariant-a.ts"),
      "utf8",
    );
    expect(sourceText).not.toContain("appendShadowInventoryMovements");
    expect(sourceText).not.toContain("appendBatchCreateShadowMovements");
    expect(sourceText).not.toContain("setInventoryMovementShadowWriteGate");
    expect(sourceText).not.toContain("isInventoryMovementShadowWriteActiveForWriter");
    expect(sourceText).not.toContain("causationSnapshot");
    expect(sourceText).not.toContain("effectSnapshot");
    expect(sourceText).not.toContain("remainingQuantity");
    expect(sourceText).not.toContain("railLot.find");
    expect(sourceText).not.toContain("changeLog");
    expect(sourceText).not.toMatch(
      /inventoryMovement\s*\.\s*(createMany|create|updateMany|update|deleteMany|delete|upsert)\s*\(/,
    );
    expect(sourceText).not.toMatch(/INSERT\s+INTO\s+"InventoryMovement"/i);
    expect(sourceText).not.toMatch(/UPDATE\s+"InventoryMovement"/i);
    expect(sourceText).not.toMatch(/DELETE\s+FROM\s+"InventoryMovement"/i);
    expect(sourceText).toContain("RepeatableRead");
    expect(sourceText).toContain("transaction_read_only");
    expect(sourceText).toContain('invariantB: "NOT_EVALUABLE"');
    expect(sourceText).not.toContain('invariantB: "MATCH_OBSERVED"');
  });
});
