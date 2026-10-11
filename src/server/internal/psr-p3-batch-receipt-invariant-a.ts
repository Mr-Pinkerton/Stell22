import { Prisma, type PrismaClient } from "@prisma/client";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
} from "@/server/internal/inventory-movement-identity";

export const BATCH_RECEIPT_CONTOUR = "BATCH_RECEIPT" as const;

export const BATCH_RECEIPT_PROVENANCE_DOMAIN = "BATCH_RECEIPT_PROVENANCE";

export type BatchReceiptInvariantAStatus =
  | "MATCH_OBSERVED"
  | "MISMATCH"
  | "GATE_UNKNOWN"
  | "SOURCE_UNAVAILABLE"
  | "NOT_EVALUABLE"
  | "INVALID_SOURCE";

export type BatchReceiptDifferenceCode =
  | "MISSING_EFFECT"
  | "UNEXPECTED_EFFECT"
  | "EFFECT_KEY"
  | "KIND"
  | "STOCK_DOMAIN"
  | "TARGET_SNAPSHOT"
  | "SIGN"
  | "QUANTITY";

export type BatchReceiptDifference = {
  code: BatchReceiptDifferenceCode;
  effectKey: string;
  expected: string | null;
  observed: string | null;
};

export type BatchReceiptDiagnosticResult = {
  contour: typeof BATCH_RECEIPT_CONTOUR;
  causationKind: "BATCH";
  causationId: string;
  invariantA: BatchReceiptInvariantAStatus;
  invariantB: "NOT_EVALUABLE";
  expectedEffectCount: number;
  observedShadowMovementCount: number;
  differences: BatchReceiptDifference[];
  reason: string;
};

export class BatchReceiptDiagnosticExecutionError extends Error {
  readonly dbError: unknown;

  constructor(message: string, dbError?: unknown) {
    super(message);
    this.name = "BatchReceiptDiagnosticExecutionError";
    this.dbError = dbError;
  }
}

export type BatchReceiptRetainedSource = {
  id: string;
  batchId: string;
  receiptProvenanceSnapshot: unknown;
};

export type BatchReceiptObservedMovement = {
  id: string;
  kind: string;
  stockDomain: string;
  quantityDelta: number;
  effectKey: string;
  authority: string;
  causationKind: string;
  causationId: string;
  railLotId: string | null;
  nomenclatureId: string | null;
  targetSnapshot: unknown;
};

type ExpectedEffect = {
  effectKey: string;
  kind: "RECEIPT";
  stockDomain: "RAIL_LOT";
  quantityDelta: number;
  railLotId: string;
  targetSnapshot: Record<string, unknown>;
};

type SourceVerdict =
  | { status: "INVALID_SOURCE" | "NOT_EVALUABLE"; reason: string }
  | { status: "READY"; effects: ExpectedEffect[] };

function finished(
  causationId: string,
  status: BatchReceiptInvariantAStatus,
  expectedEffectCount: number,
  observedCount: number,
  differences: BatchReceiptDifference[],
  reason: string,
): BatchReceiptDiagnosticResult {
  return {
    contour: BATCH_RECEIPT_CONTOUR,
    causationKind: "BATCH",
    causationId,
    invariantA: status,
    invariantB: "NOT_EVALUABLE",
    expectedEffectCount,
    observedShadowMovementCount: observedCount,
    differences,
    reason,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function receiptEffect(railLotId: string, quantity: number): ExpectedEffect {
  const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId });
  return {
    effectKey: effectKeyV1("receipt", canonical.targetHashV1),
    kind: "RECEIPT",
    stockDomain: "RAIL_LOT",
    quantityDelta: quantity,
    railLotId,
    targetSnapshot: canonical.targetSnapshot,
  };
}

function invalid(reason: string): SourceVerdict {
  return { status: "INVALID_SOURCE", reason };
}

function deriveProvenance(
  source: BatchReceiptRetainedSource,
  causationId: string,
): SourceVerdict {
  if (source.id !== causationId) {
    return invalid("command id does not match the requested causation");
  }
  if (source.receiptProvenanceSnapshot == null) {
    return {
      status: "NOT_EVALUABLE",
      reason: "receipt provenance is absent",
    };
  }
  const snapshot = source.receiptProvenanceSnapshot;
  if (!isRecord(snapshot)) {
    return invalid("receipt provenance is not a JSON object");
  }
  if (typeof snapshot.v !== "number" || !Number.isFinite(snapshot.v)) {
    return invalid("receipt provenance version is malformed");
  }
  if (snapshot.v !== 1) {
    return {
      status: "NOT_EVALUABLE",
      reason: "receipt provenance version is not readable by this checker",
    };
  }
  if (!nonBlank(snapshot.d)) {
    return invalid("receipt provenance domain is malformed");
  }
  if (snapshot.d !== BATCH_RECEIPT_PROVENANCE_DOMAIN) {
    return {
      status: "NOT_EVALUABLE",
      reason: "receipt provenance domain is not readable by this checker",
    };
  }
  if (!nonBlank(snapshot.commandId) || snapshot.commandId !== source.id) {
    return invalid("receipt provenance commandId does not match the command");
  }
  if (!nonBlank(snapshot.batchId) || snapshot.batchId !== source.batchId) {
    return invalid("receipt provenance batchId does not match the command");
  }
  if (!Array.isArray(snapshot.pairs)) {
    return invalid("receipt provenance pairs are malformed");
  }

  const seen = new Set<string>();
  const effects: ExpectedEffect[] = [];
  let previousLotId: string | null = null;
  for (const item of snapshot.pairs) {
    if (!isRecord(item) || !nonBlank(item.railLotId)) {
      return invalid("receipt provenance pair is malformed");
    }
    const quantity = item.quantity;
    if (
      typeof quantity !== "number" ||
      !Number.isFinite(quantity) ||
      !Number.isInteger(quantity) ||
      quantity < 0
    ) {
      return invalid("receipt provenance quantity is not a non-negative integer");
    }
    if (seen.has(item.railLotId)) {
      return invalid("receipt provenance repeats a railLotId");
    }
    if (previousLotId !== null && previousLotId.localeCompare(item.railLotId) > 0) {
      return invalid("receipt provenance pairs are not in canonical railLotId order");
    }
    seen.add(item.railLotId);
    previousLotId = item.railLotId;
    if (quantity > 0) effects.push(receiptEffect(item.railLotId, quantity));
  }
  return { status: "READY", effects };
}

function targetIdentity(row: { stockDomain: string; railLotId: string | null }): string {
  if (row.stockDomain === "RAIL_LOT") return `RAIL_LOT:${row.railLotId ?? ""}`;
  return `${row.stockDomain}:unpaired`;
}

function belongsToCommand(row: BatchReceiptObservedMovement, causationId: string): boolean {
  return row.authority === "SHADOW" && row.causationKind === "BATCH" && row.causationId === causationId;
}

function compareEffects(
  expected: ExpectedEffect[],
  observed: BatchReceiptObservedMovement[],
  causationId: string,
): BatchReceiptDifference[] {
  const eligible: BatchReceiptObservedMovement[] = [];
  const differences: BatchReceiptDifference[] = [];
  for (const row of observed) {
    if (belongsToCommand(row, causationId)) eligible.push(row);
    else {
      differences.push({
        code: "UNEXPECTED_EFFECT",
        effectKey: row.effectKey,
        expected: null,
        observed: row.railLotId ?? row.id,
      });
    }
  }
  const used = new Set<string>();
  for (const effect of expected) {
    const identity = targetIdentity(effect);
    const match = eligible.find((row) => !used.has(row.id) && targetIdentity(row) === identity);
    if (!match) {
      differences.push({
        code: "MISSING_EFFECT",
        effectKey: effect.effectKey,
        expected: effect.railLotId,
        observed: null,
      });
      continue;
    }
    used.add(match.id);
    if (match.effectKey !== effect.effectKey) {
      differences.push({
        code: "EFFECT_KEY",
        effectKey: effect.effectKey,
        expected: effect.effectKey,
        observed: match.effectKey,
      });
    }
    if (match.kind !== effect.kind) {
      differences.push({
        code: "KIND",
        effectKey: effect.effectKey,
        expected: effect.kind,
        observed: match.kind,
      });
    }
    if (match.stockDomain !== effect.stockDomain) {
      differences.push({
        code: "STOCK_DOMAIN",
        effectKey: effect.effectKey,
        expected: effect.stockDomain,
        observed: match.stockDomain,
      });
    }
    if (stableJson(match.targetSnapshot) !== stableJson(effect.targetSnapshot)) {
      differences.push({
        code: "TARGET_SNAPSHOT",
        effectKey: effect.effectKey,
        expected: stableJson(effect.targetSnapshot),
        observed: stableJson(match.targetSnapshot),
      });
    }
    const expectedSign = Math.sign(effect.quantityDelta);
    const observedSign = Math.sign(match.quantityDelta);
    if (expectedSign !== observedSign) {
      differences.push({
        code: "SIGN",
        effectKey: effect.effectKey,
        expected: String(expectedSign),
        observed: String(observedSign),
      });
    }
    if (match.quantityDelta !== effect.quantityDelta) {
      differences.push({
        code: "QUANTITY",
        effectKey: effect.effectKey,
        expected: String(effect.quantityDelta),
        observed: String(match.quantityDelta),
      });
    }
  }
  for (const row of eligible) {
    if (used.has(row.id)) continue;
    differences.push({
      code: "UNEXPECTED_EFFECT",
      effectKey: row.effectKey,
      expected: null,
      observed: row.railLotId ?? row.id,
    });
  }
  return differences.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.effectKey !== b.effectKey) return a.effectKey < b.effectKey ? -1 : 1;
    if ((a.expected ?? "") !== (b.expected ?? "")) {
      return (a.expected ?? "").localeCompare(b.expected ?? "");
    }
    return (a.observed ?? "").localeCompare(b.observed ?? "");
  });
}

export function evaluateBatchReceiptInvariantA(input: {
  causationId: string;
  source: BatchReceiptRetainedSource | null;
  observed: BatchReceiptObservedMovement[];
}): BatchReceiptDiagnosticResult {
  const observed = input.observed.slice().sort((a, b) => a.id.localeCompare(b.id));
  const observedCount = observed.length;
  if (input.source === null) {
    return finished(
      input.causationId,
      "SOURCE_UNAVAILABLE",
      0,
      observedCount,
      [],
      "retained source is absent",
    );
  }
  const derived = deriveProvenance(input.source, input.causationId);
  if (derived.status !== "READY") {
    return finished(input.causationId, derived.status, 0, observedCount, [], derived.reason);
  }
  if (derived.effects.length > 0 && observedCount === 0) {
    return finished(
      input.causationId,
      "GATE_UNKNOWN",
      derived.effects.length,
      0,
      [],
      "expected effects are nonempty and no SHADOW movements were observed",
    );
  }
  const differences = compareEffects(derived.effects, observed, input.causationId);
  if (differences.length === 0) {
    return finished(
      input.causationId,
      "MATCH_OBSERVED",
      derived.effects.length,
      observedCount,
      [],
      "expected and observed semantic effect sets are equal",
    );
  }
  return finished(
    input.causationId,
    "MISMATCH",
    derived.effects.length,
    observedCount,
    differences,
    "expected and observed semantic effect sets differ",
  );
}

export function batchReceiptObservedMovementWhere(causationId: string) {
  return {
    authority: "SHADOW" as const,
    causationKind: "BATCH" as const,
    causationId,
  };
}

const observedSelect = {
  id: true,
  kind: true,
  stockDomain: true,
  quantityDelta: true,
  effectKey: true,
  authority: true,
  causationKind: true,
  causationId: true,
  railLotId: true,
  nomenclatureId: true,
  targetSnapshot: true,
} as const;

export async function readBatchReceiptInvariantA(
  db: PrismaClient,
  input: { causationId: string },
): Promise<BatchReceiptDiagnosticResult> {
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('transaction_read_only', 'on', true)`;
        const command = await tx.batchCreationCommand.findUnique({
          where: { id: input.causationId },
          select: { id: true, batchId: true, receiptProvenanceSnapshot: true },
        });
        const movements = await tx.inventoryMovement.findMany({
          where: batchReceiptObservedMovementWhere(input.causationId),
          select: observedSelect,
          orderBy: { id: "asc" },
        });
        return evaluateBatchReceiptInvariantA({
          causationId: input.causationId,
          source: command
            ? {
                id: command.id,
                batchId: command.batchId,
                receiptProvenanceSnapshot: command.receiptProvenanceSnapshot,
              }
            : null,
          observed: movements,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  } catch (error) {
    if (error instanceof BatchReceiptDiagnosticExecutionError) throw error;
    throw new BatchReceiptDiagnosticExecutionError(
      "Batch receipt diagnostic read failed",
      error,
    );
  }
}
