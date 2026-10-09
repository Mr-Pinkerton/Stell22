import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
} from "@/server/internal/inventory-movement-identity";
import {
  evaluateSlice1InvariantA,
  readSlice1InvariantA,
  Slice1DiagnosticExecutionError,
  slice1ObservedMovementWhere,
  type ObservedShadowMovement,
  type R05RetainedSource,
  type SimplePurchaseRetainedSource,
  type Slice1DiagnosticResult,
  type WriteOffRetainedSource,
} from "@/server/internal/psr-p3-slice1-invariant-a";

function expectInvariantB(result: Slice1DiagnosticResult) {
  expect(result.invariantB).toBe("NOT_EVALUABLE");
}

function railEffect(role: "adjust" | "writeoff", railLotId: string, qualifier?: string) {
  const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId });
  return {
    effectKey: effectKeyV1(role, canonical.targetHashV1, qualifier),
    targetSnapshot: canonical.targetSnapshot,
  };
}

function nomenclatureEffect(nomenclatureId: string) {
  const canonical = canonicalizeMovementTarget({
    stockDomain: "NOMENCLATURE",
    nomenclatureId,
  });
  return {
    effectKey: effectKeyV1("receipt", canonical.targetHashV1),
    targetSnapshot: canonical.targetSnapshot,
  };
}

function observed(input: {
  id?: string;
  kind: string;
  stockDomain: string;
  quantityDelta: number;
  effectKey: string;
  causationKind: string;
  causationId: string;
  railLotId?: string | null;
  nomenclatureId?: string | null;
  targetSnapshot: unknown;
  authority?: "SHADOW" | "AUTHORITATIVE";
}): ObservedShadowMovement {
  return {
    id: input.id ?? `mv-${input.effectKey}`,
    kind: input.kind,
    stockDomain: input.stockDomain,
    quantityDelta: input.quantityDelta,
    effectKey: input.effectKey,
    authority: input.authority ?? "SHADOW",
    causationKind: input.causationKind,
    causationId: input.causationId,
    railLotId: input.railLotId ?? null,
    nomenclatureId: input.nomenclatureId ?? null,
    targetSnapshot: input.targetSnapshot,
  };
}

function r05(overrides: Partial<R05RetainedSource> = {}): R05RetainedSource {
  return {
    id: "corr-1",
    requestId: "req-r05",
    operationId: "op-1",
    adminUserId: "admin-1",
    railLotId: "lot-1",
    batchId: "batch-1",
    expectedOldRailsTaken: 10,
    newRailsTaken: 7,
    deltaReturned: 3,
    reason: "short",
    ...overrides,
  };
}

function writeOff(overrides: Partial<WriteOffRetainedSource> = {}): WriteOffRetainedSource {
  return {
    id: "wo-1",
    batchId: "batch-1",
    totalQuantity: 6,
    effectSnapshot: {
      v: 1,
      d: "BATCH_REMAINDER_WRITEOFF",
      batchId: "batch-1",
      effects: [
        { railLotId: "lot-b", quantityBefore: 2, quantityDelta: -2 },
        { railLotId: "lot-a", quantityBefore: 4, quantityDelta: -4 },
      ],
    },
    ...overrides,
  };
}

function purchase(
  overrides: Partial<SimplePurchaseRetainedSource> = {},
): SimplePurchaseRetainedSource {
  return {
    id: "sp-1",
    nomenclatureId: "nom-1",
    quantity: 5,
    creationCommand: null,
    ...overrides,
  };
}

describe("slice 1 observed query", () => {
  it("keeps SHADOW rows for the exact causation and drops other authorities and commands", () => {
    expect(slice1ObservedMovementWhere("R05_CORRECTION", "corr-1")).toEqual({
      authority: "SHADOW",
      causationKind: "PRODUCTION_OPERATION_MUTATION",
      causationId: "corr-1",
    });
    expect(slice1ObservedMovementWhere("BATCH_REMAINDER_WRITEOFF", "wo-1")).toEqual({
      authority: "SHADOW",
      causationKind: "BATCH",
      causationId: "wo-1",
    });
    expect(slice1ObservedMovementWhere("SIMPLE_PURCHASE_RECEIPT", "sp-1")).toEqual({
      authority: "SHADOW",
      causationKind: "SIMPLE_PURCHASE",
      causationId: "sp-1",
    });
  });
});

describe("R-05 invariant A", () => {
  const matched = railEffect("adjust", "lot-1", "rails-taken");

  function r05Observed(overrides: Partial<Parameters<typeof observed>[0]> = {}) {
    return observed({
      kind: "ADJUSTMENT",
      stockDomain: "RAIL_LOT",
      quantityDelta: 3,
      effectKey: matched.effectKey,
      causationKind: "PRODUCTION_OPERATION_MUTATION",
      causationId: "corr-1",
      railLotId: "lot-1",
      targetSnapshot: matched.targetSnapshot,
      ...overrides,
    });
  }

  it("matches one positive rails-taken adjustment", () => {
    const result = evaluateSlice1InvariantA({
      contour: "R05_CORRECTION",
      causationId: "corr-1",
      source: r05(),
      observed: [r05Observed()],
    });
    expectInvariantB(result);
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.expectedEffectCount).toBe(1);
    expect(result.observedShadowMovementCount).toBe(1);
    expect(result.differences).toEqual([]);
    expect(result.causationKind).toBe("PRODUCTION_OPERATION_MUTATION");
  });

  it("rejects the wrong sign even when the absolute quantity matches", () => {
    const result = evaluateSlice1InvariantA({
      contour: "R05_CORRECTION",
      causationId: "corr-1",
      source: r05(),
      observed: [r05Observed({ quantityDelta: -3 })],
    });
    expectInvariantB(result);
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.differences.map((item) => item.code)).toEqual(
      expect.arrayContaining(["SIGN", "QUANTITY"]),
    );
  });

  it("rejects the wrong quantity", () => {
    const result = evaluateSlice1InvariantA({
      contour: "R05_CORRECTION",
      causationId: "corr-1",
      source: r05(),
      observed: [r05Observed({ quantityDelta: 4 })],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.differences.map((item) => item.code)).toContain("QUANTITY");
    expect(result.differences.map((item) => item.code)).not.toContain("SIGN");
  });

  it("rejects the wrong rail lot", () => {
    const other = railEffect("adjust", "lot-2", "rails-taken");
    const result = evaluateSlice1InvariantA({
      contour: "R05_CORRECTION",
      causationId: "corr-1",
      source: r05(),
      observed: [
        r05Observed({
          effectKey: other.effectKey,
          railLotId: "lot-2",
          targetSnapshot: other.targetSnapshot,
        }),
      ],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.differences.map((item) => item.code)).toEqual(
      expect.arrayContaining(["MISSING_EFFECT", "UNEXPECTED_EFFECT"]),
    );
  });

  it("rejects a wrong effectKey when the quantity and target columns are right", () => {
    const result = evaluateSlice1InvariantA({
      contour: "R05_CORRECTION",
      causationId: "corr-1",
      source: r05(),
      observed: [r05Observed({ effectKey: `${matched.effectKey}-other` })],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.differences).toEqual([
      expect.objectContaining({ code: "EFFECT_KEY", expected: matched.effectKey }),
    ]);
  });

  it("does not call an empty observed set a mismatch", () => {
    const result = evaluateSlice1InvariantA({
      contour: "R05_CORRECTION",
      causationId: "corr-1",
      source: r05(),
      observed: [],
    });
    expectInvariantB(result);
    expect(result.invariantA).toBe("GATE_UNKNOWN");
    expect(result.expectedEffectCount).toBe(1);
    expect(result.observedShadowMovementCount).toBe(0);
    expect(result.differences).toEqual([]);
  });

  it("returns SOURCE_UNAVAILABLE when the correction row is absent", () => {
    const result = evaluateSlice1InvariantA({
      contour: "R05_CORRECTION",
      causationId: "corr-1",
      source: null,
      observed: [r05Observed()],
    });
    expect(result.invariantA).toBe("SOURCE_UNAVAILABLE");
    expect(result.invariantA).not.toBe("MATCH_OBSERVED");
    expect(result.expectedEffectCount).toBe(0);
  });

  it("returns INVALID_SOURCE for a non-positive or inconsistent delta", () => {
    expect(
      evaluateSlice1InvariantA({
        contour: "R05_CORRECTION",
        causationId: "corr-1",
        source: r05({ deltaReturned: 0 }),
        observed: [],
      }).invariantA,
    ).toBe("INVALID_SOURCE");
    expect(
      evaluateSlice1InvariantA({
        contour: "R05_CORRECTION",
        causationId: "corr-1",
        source: r05({ deltaReturned: 2 }),
        observed: [],
      }).invariantA,
    ).toBe("INVALID_SOURCE");
    expect(
      evaluateSlice1InvariantA({
        contour: "R05_CORRECTION",
        causationId: "corr-1",
        source: r05({ railLotId: "  " }),
        observed: [],
      }).invariantA,
    ).toBe("INVALID_SOURCE");
  });
});

describe("batch remainder write-off invariant A", () => {
  const lotA = railEffect("writeoff", "lot-a");
  const lotB = railEffect("writeoff", "lot-b");

  function writeOffObserved() {
    return [
      observed({
        kind: "ADJUSTMENT",
        stockDomain: "RAIL_LOT",
        quantityDelta: -2,
        effectKey: lotB.effectKey,
        causationKind: "BATCH",
        causationId: "wo-1",
        railLotId: "lot-b",
        targetSnapshot: lotB.targetSnapshot,
      }),
      observed({
        kind: "ADJUSTMENT",
        stockDomain: "RAIL_LOT",
        quantityDelta: -4,
        effectKey: lotA.effectKey,
        causationKind: "BATCH",
        causationId: "wo-1",
        railLotId: "lot-a",
        targetSnapshot: lotA.targetSnapshot,
      }),
    ];
  }

  it("matches every lot independently of array order", () => {
    const result = evaluateSlice1InvariantA({
      contour: "BATCH_REMAINDER_WRITEOFF",
      causationId: "wo-1",
      source: writeOff(),
      observed: writeOffObserved(),
    });
    expectInvariantB(result);
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.expectedEffectCount).toBe(2);
    expect(result.causationKind).toBe("BATCH");
    expect(result.causationId).toBe("wo-1");
  });

  it("does not treat an equal delta sum as a match when one lot is missing", () => {
    const result = evaluateSlice1InvariantA({
      contour: "BATCH_REMAINDER_WRITEOFF",
      causationId: "wo-1",
      source: writeOff(),
      observed: [writeOffObserved()[1]!],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.differences.map((item) => item.code)).toContain("MISSING_EFFECT");
    const deltas = [writeOffObserved()[1]!.quantityDelta];
    expect(deltas.reduce((sum, value) => sum + value, 0)).not.toBe(-6);
  });

  it("rejects an additional effect", () => {
    const extra = railEffect("writeoff", "lot-c");
    const result = evaluateSlice1InvariantA({
      contour: "BATCH_REMAINDER_WRITEOFF",
      causationId: "wo-1",
      source: writeOff(),
      observed: [
        ...writeOffObserved(),
        observed({
          kind: "ADJUSTMENT",
          stockDomain: "RAIL_LOT",
          quantityDelta: -1,
          effectKey: extra.effectKey,
          causationKind: "BATCH",
          causationId: "wo-1",
          railLotId: "lot-c",
          targetSnapshot: extra.targetSnapshot,
        }),
      ],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.differences.map((item) => item.code)).toContain("UNEXPECTED_EFFECT");
  });

  it("rejects the wrong target", () => {
    const other = railEffect("writeoff", "lot-z");
    const rows = writeOffObserved();
    rows[1] = observed({
      kind: "ADJUSTMENT",
      stockDomain: "RAIL_LOT",
      quantityDelta: -4,
      effectKey: other.effectKey,
      causationKind: "BATCH",
      causationId: "wo-1",
      railLotId: "lot-z",
      targetSnapshot: other.targetSnapshot,
    });
    const result = evaluateSlice1InvariantA({
      contour: "BATCH_REMAINDER_WRITEOFF",
      causationId: "wo-1",
      source: writeOff(),
      observed: rows,
    });
    expect(result.invariantA).toBe("MISMATCH");
  });

  it("rejects a duplicate canonical target in the retained snapshot", () => {
    const result = evaluateSlice1InvariantA({
      contour: "BATCH_REMAINDER_WRITEOFF",
      causationId: "wo-1",
      source: writeOff({
        totalQuantity: 3,
        effectSnapshot: {
          v: 1,
          d: "BATCH_REMAINDER_WRITEOFF",
          batchId: "batch-1",
          effects: [
            { railLotId: "lot-a", quantityBefore: 1, quantityDelta: -1 },
            { railLotId: "lot-a", quantityBefore: 2, quantityDelta: -2 },
          ],
        },
      }),
      observed: [],
    });
    expect(result.invariantA).toBe("INVALID_SOURCE");
  });

  it("rejects a totalQuantity that is not the sum of quantityBefore", () => {
    const result = evaluateSlice1InvariantA({
      contour: "BATCH_REMAINDER_WRITEOFF",
      causationId: "wo-1",
      source: writeOff({ totalQuantity: 5 }),
      observed: writeOffObserved(),
    });
    expect(result.invariantA).toBe("INVALID_SOURCE");
  });

  it("rejects a malformed snapshot", () => {
    const result = evaluateSlice1InvariantA({
      contour: "BATCH_REMAINDER_WRITEOFF",
      causationId: "wo-1",
      source: writeOff({ effectSnapshot: "not-json" }),
      observed: [],
    });
    expect(result.invariantA).toBe("INVALID_SOURCE");
  });

  it("returns GATE_UNKNOWN when a nonempty snapshot has no movements", () => {
    const result = evaluateSlice1InvariantA({
      contour: "BATCH_REMAINDER_WRITEOFF",
      causationId: "wo-1",
      source: writeOff(),
      observed: [],
    });
    expectInvariantB(result);
    expect(result.invariantA).toBe("GATE_UNKNOWN");
    expect(result.invariantA).not.toBe("MISMATCH");
  });

  it("returns SOURCE_UNAVAILABLE when the write-off command is absent", () => {
    const result = evaluateSlice1InvariantA({
      contour: "BATCH_REMAINDER_WRITEOFF",
      causationId: "wo-1",
      source: null,
      observed: [],
    });
    expect(result.invariantA).toBe("SOURCE_UNAVAILABLE");
  });

  it("returns NOT_EVALUABLE for a retained snapshot version this slice cannot read", () => {
    const result = evaluateSlice1InvariantA({
      contour: "BATCH_REMAINDER_WRITEOFF",
      causationId: "wo-1",
      source: writeOff({
        effectSnapshot: {
          v: 2,
          d: "BATCH_REMAINDER_WRITEOFF",
          batchId: "batch-1",
          effects: [{ railLotId: "lot-a", quantityBefore: 4, quantityDelta: -4 }],
        },
      }),
      observed: [],
    });
    expect(result.invariantA).toBe("NOT_EVALUABLE");
  });
});

describe("SimplePurchase invariant A", () => {
  const receipt = nomenclatureEffect("nom-1");

  function purchaseObserved(overrides: Partial<Parameters<typeof observed>[0]> = {}) {
    return observed({
      kind: "RECEIPT",
      stockDomain: "NOMENCLATURE",
      quantityDelta: 5,
      effectKey: receipt.effectKey,
      causationKind: "SIMPLE_PURCHASE",
      causationId: "sp-1",
      nomenclatureId: "nom-1",
      targetSnapshot: receipt.targetSnapshot,
      ...overrides,
    });
  }

  it("matches one positive nomenclature receipt", () => {
    const result = evaluateSlice1InvariantA({
      contour: "SIMPLE_PURCHASE_RECEIPT",
      causationId: "sp-1",
      source: purchase(),
      observed: [purchaseObserved()],
    });
    expectInvariantB(result);
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.causationKind).toBe("SIMPLE_PURCHASE");
    expect(result.causationId).toBe("sp-1");
    expect(result.expectedEffectCount).toBe(1);
  });

  it("rejects the wrong nomenclature", () => {
    const other = nomenclatureEffect("nom-2");
    const result = evaluateSlice1InvariantA({
      contour: "SIMPLE_PURCHASE_RECEIPT",
      causationId: "sp-1",
      source: purchase(),
      observed: [
        purchaseObserved({
          effectKey: other.effectKey,
          nomenclatureId: "nom-2",
          targetSnapshot: other.targetSnapshot,
        }),
      ],
    });
    expect(result.invariantA).toBe("MISMATCH");
  });

  it("rejects the wrong quantity", () => {
    const result = evaluateSlice1InvariantA({
      contour: "SIMPLE_PURCHASE_RECEIPT",
      causationId: "sp-1",
      source: purchase(),
      observed: [purchaseObserved({ quantityDelta: 9 })],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.differences.map((item) => item.code)).toContain("QUANTITY");
  });

  it("returns GATE_UNKNOWN when the receipt movement is absent", () => {
    const result = evaluateSlice1InvariantA({
      contour: "SIMPLE_PURCHASE_RECEIPT",
      causationId: "sp-1",
      source: purchase(),
      observed: [],
    });
    expect(result.invariantA).toBe("GATE_UNKNOWN");
  });

  it("returns SOURCE_UNAVAILABLE when the purchase is absent", () => {
    const result = evaluateSlice1InvariantA({
      contour: "SIMPLE_PURCHASE_RECEIPT",
      causationId: "sp-1",
      source: null,
      observed: [],
    });
    expect(result.invariantA).toBe("SOURCE_UNAVAILABLE");
  });

  it("returns INVALID_SOURCE for a non-positive quantity", () => {
    const result = evaluateSlice1InvariantA({
      contour: "SIMPLE_PURCHASE_RECEIPT",
      causationId: "sp-1",
      source: purchase({ quantity: 0 }),
      observed: [],
    });
    expect(result.invariantA).toBe("INVALID_SOURCE");
  });

  it("returns INVALID_SOURCE when the retained creation snapshot disagrees", () => {
    const result = evaluateSlice1InvariantA({
      contour: "SIMPLE_PURCHASE_RECEIPT",
      causationId: "sp-1",
      source: purchase({
        creationCommand: {
          id: "cmd-1",
          requestId: "req-1",
          simplePurchaseId: "sp-1",
          requestSnapshot: {
            v: 1,
            d: "SIMPLE_PURCHASE_CREATE",
            nomenclatureId: "nom-1",
            quantity: 9,
          },
        },
      }),
      observed: [purchaseObserved()],
    });
    expect(result.invariantA).toBe("INVALID_SOURCE");
  });

  it("keeps one expected effect when a matching creation command records the replay identity", () => {
    const result = evaluateSlice1InvariantA({
      contour: "SIMPLE_PURCHASE_RECEIPT",
      causationId: "sp-1",
      source: purchase({
        creationCommand: {
          id: "cmd-1",
          requestId: "req-replay",
          simplePurchaseId: "sp-1",
          requestSnapshot: {
            v: 1,
            d: "SIMPLE_PURCHASE_CREATE",
            nomenclatureId: "nom-1",
            quantity: 5,
          },
        },
      }),
      observed: [purchaseObserved()],
    });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.expectedEffectCount).toBe(1);
    expect(result.causationId).not.toBe("cmd-1");
  });

  it("does not require a historical creation command", () => {
    const result = evaluateSlice1InvariantA({
      contour: "SIMPLE_PURCHASE_RECEIPT",
      causationId: "sp-1",
      source: purchase({ creationCommand: null }),
      observed: [purchaseObserved()],
    });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
  });
});

describe("shared invariant A rules", () => {
  const matched = railEffect("adjust", "lot-1", "rails-taken");

  it("treats an extra causation in the compared set as a mismatch", () => {
    const result = evaluateSlice1InvariantA({
      contour: "R05_CORRECTION",
      causationId: "corr-1",
      source: r05(),
      observed: [
        observed({
          kind: "ADJUSTMENT",
          stockDomain: "RAIL_LOT",
          quantityDelta: 3,
          effectKey: matched.effectKey,
          causationKind: "PRODUCTION_OPERATION_MUTATION",
          causationId: "corr-1",
          railLotId: "lot-1",
          targetSnapshot: matched.targetSnapshot,
        }),
        observed({
          id: "other-command",
          kind: "ADJUSTMENT",
          stockDomain: "RAIL_LOT",
          quantityDelta: 3,
          effectKey: matched.effectKey,
          causationKind: "PRODUCTION_OPERATION_MUTATION",
          causationId: "corr-2",
          railLotId: "lot-1",
          targetSnapshot: matched.targetSnapshot,
        }),
      ],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.observedShadowMovementCount).toBe(2);
  });

  it("treats an AUTHORITATIVE row in the compared set as a mismatch", () => {
    const result = evaluateSlice1InvariantA({
      contour: "R05_CORRECTION",
      causationId: "corr-1",
      source: r05(),
      observed: [
        observed({
          kind: "ADJUSTMENT",
          stockDomain: "RAIL_LOT",
          quantityDelta: 3,
          effectKey: matched.effectKey,
          causationKind: "PRODUCTION_OPERATION_MUTATION",
          causationId: "corr-1",
          railLotId: "lot-1",
          targetSnapshot: matched.targetSnapshot,
          authority: "AUTHORITATIVE",
        }),
      ],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.invariantA).not.toBe("MATCH_OBSERVED");
  });

  it("rejects a targetSnapshot that does not name the same physical target", () => {
    const result = evaluateSlice1InvariantA({
      contour: "R05_CORRECTION",
      causationId: "corr-1",
      source: r05(),
      observed: [
        observed({
          kind: "ADJUSTMENT",
          stockDomain: "RAIL_LOT",
          quantityDelta: 3,
          effectKey: matched.effectKey,
          causationKind: "PRODUCTION_OPERATION_MUTATION",
          causationId: "corr-1",
          railLotId: "lot-1",
          targetSnapshot: { v: 1, d: "RAIL_LOT", railLotId: "lot-other" },
        }),
      ],
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.differences.map((item) => item.code)).toContain("TARGET_SNAPSHOT");
  });

  it("reports Invariant B as NOT_EVALUABLE for every completed status", () => {
    const cases = [
      evaluateSlice1InvariantA({
        contour: "R05_CORRECTION",
        causationId: "corr-1",
        source: r05(),
        observed: [
          observed({
            kind: "ADJUSTMENT",
            stockDomain: "RAIL_LOT",
            quantityDelta: 3,
            effectKey: matched.effectKey,
            causationKind: "PRODUCTION_OPERATION_MUTATION",
            causationId: "corr-1",
            railLotId: "lot-1",
            targetSnapshot: matched.targetSnapshot,
          }),
        ],
      }),
      evaluateSlice1InvariantA({
        contour: "R05_CORRECTION",
        causationId: "corr-1",
        source: null,
        observed: [],
      }),
      evaluateSlice1InvariantA({
        contour: "R05_CORRECTION",
        causationId: "corr-1",
        source: r05(),
        observed: [],
      }),
    ];
    expect(cases.map((item) => item.invariantB)).toEqual([
      "NOT_EVALUABLE",
      "NOT_EVALUABLE",
      "NOT_EVALUABLE",
    ]);
  });

  it("fails closed when the database read throws", async () => {
    const db = {
      $transaction: async () => {
        throw new Error("connection reset");
      },
    };
    await expect(
      readSlice1InvariantA(db as never, {
        contour: "R05_CORRECTION",
        causationId: "corr-1",
      }),
    ).rejects.toBeInstanceOf(Slice1DiagnosticExecutionError);
  });

  it("does not import movement writers or issue inventory mutations", () => {
    const source = readFileSync(
      path.join(import.meta.dirname, "psr-p3-slice1-invariant-a.ts"),
      "utf8",
    );
    expect(source).not.toContain("appendShadowInventoryMovements");
    expect(source).not.toContain("appendR05CorrectionShadowMovement");
    expect(source).not.toContain("appendBatchWriteOffShadowMovements");
    expect(source).not.toContain("appendSimplePurchaseShadowMovement");
    expect(source).not.toContain("setInventoryMovementShadowWriteGate");
    expect(source).not.toContain("r05CorrectionMovementEffect");
    expect(source).not.toContain("batchWriteOffMovementEffects");
    expect(source).not.toContain("simplePurchaseReceiptEffect");
    expect(source).not.toMatch(/inventoryMovement\s*\.\s*(createMany|create|updateMany|update|deleteMany|delete|upsert)\s*\(/);
    expect(source).not.toMatch(/INSERT\s+INTO\s+"InventoryMovement"/i);
    expect(source).not.toMatch(/UPDATE\s+"InventoryMovement"/i);
    expect(source).not.toMatch(/DELETE\s+FROM\s+"InventoryMovement"/i);
    expect(source).toContain("RepeatableRead");
    expect(source).toContain("transaction_read_only");
    expect(source).not.toContain("invariantB: \"MATCH_OBSERVED\"");
    expect(source).toContain('invariantB: "NOT_EVALUABLE"');
  });
});
