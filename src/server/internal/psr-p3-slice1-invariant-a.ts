import { Prisma, type PrismaClient } from "@prisma/client";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
} from "@/server/internal/inventory-movement-identity";

export const SLICE1_CONTOURS = [
  "R05_CORRECTION",
  "BATCH_REMAINDER_WRITEOFF",
  "SIMPLE_PURCHASE_RECEIPT",
] as const;

export type Slice1Contour = (typeof SLICE1_CONTOURS)[number];

export type InvariantAStatus =
  | "MATCH_OBSERVED"
  | "MISMATCH"
  | "GATE_UNKNOWN"
  | "SOURCE_UNAVAILABLE"
  | "NOT_EVALUABLE"
  | "INVALID_SOURCE";

export type Slice1CausationKind = "PRODUCTION_OPERATION_MUTATION" | "BATCH" | "SIMPLE_PURCHASE";

export type Slice1DifferenceCode =
  | "MISSING_EFFECT"
  | "UNEXPECTED_EFFECT"
  | "EFFECT_KEY"
  | "KIND"
  | "STOCK_DOMAIN"
  | "TARGET_SNAPSHOT"
  | "SIGN"
  | "QUANTITY";

export type Slice1Difference = {
  code: Slice1DifferenceCode;
  effectKey: string;
  expected: string | null;
  observed: string | null;
};

export type Slice1DiagnosticResult = {
  contour: Slice1Contour;
  causationKind: Slice1CausationKind;
  causationId: string;
  invariantA: InvariantAStatus;
  invariantB: "NOT_EVALUABLE";
  expectedEffectCount: number;
  observedShadowMovementCount: number;
  differences: Slice1Difference[];
  reason: string;
};

export class Slice1DiagnosticExecutionError extends Error {
  readonly dbError: unknown;

  constructor(message: string, dbError?: unknown) {
    super(message);
    this.name = "Slice1DiagnosticExecutionError";
    this.dbError = dbError;
  }
}

export type R05RetainedSource = {
  id: string;
  requestId: string;
  operationId: string;
  adminUserId: string;
  railLotId: string;
  batchId: string;
  expectedOldRailsTaken: number;
  newRailsTaken: number;
  deltaReturned: number;
  reason: string;
};

export type WriteOffRetainedSource = {
  id: string;
  batchId: string;
  totalQuantity: number;
  effectSnapshot: unknown;
};

export type SimplePurchaseCreationRetained = {
  id: string;
  requestId: string;
  simplePurchaseId: string;
  requestSnapshot: unknown;
};

export type SimplePurchaseRetainedSource = {
  id: string;
  nomenclatureId: string;
  quantity: number;
  creationCommand: SimplePurchaseCreationRetained | null;
};

export type ObservedShadowMovement = {
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
  kind: "ADJUSTMENT" | "RECEIPT";
  stockDomain: "RAIL_LOT" | "NOMENCLATURE";
  quantityDelta: number;
  railLotId: string | null;
  nomenclatureId: string | null;
  targetSnapshot: Record<string, unknown>;
};

type SourceVerdict =
  | { status: "INVALID_SOURCE" | "NOT_EVALUABLE"; reason: string }
  | { status: "READY"; effects: ExpectedEffect[] };

const WRITE_OFF_SNAPSHOT = "BATCH_REMAINDER_WRITEOFF";
const PURCHASE_SNAPSHOT = "SIMPLE_PURCHASE_CREATE";

export function slice1CausationKind(contour: Slice1Contour): Slice1CausationKind {
  if (contour === "R05_CORRECTION") return "PRODUCTION_OPERATION_MUTATION";
  if (contour === "BATCH_REMAINDER_WRITEOFF") return "BATCH";
  return "SIMPLE_PURCHASE";
}

export function slice1ObservedMovementWhere(contour: Slice1Contour, causationId: string) {
  return {
    authority: "SHADOW" as const,
    causationKind: slice1CausationKind(contour),
    causationId,
  };
}

function finished(
  input: {
    contour: Slice1Contour;
    causationId: string;
  },
  status: InvariantAStatus,
  expectedEffectCount: number,
  observedCount: number,
  differences: Slice1Difference[],
  reason: string,
): Slice1DiagnosticResult {
  return {
    contour: input.contour,
    causationKind: slice1CausationKind(input.contour),
    causationId: input.causationId,
    invariantA: status,
    invariantB: "NOT_EVALUABLE",
    expectedEffectCount,
    observedShadowMovementCount: observedCount,
    differences,
    reason,
  };
}

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim() === "";
}

function nonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function railEffect(
  role: "adjust" | "writeoff",
  railLotId: string,
  quantityDelta: number,
  qualifier?: string,
): ExpectedEffect {
  const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId });
  return {
    effectKey: effectKeyV1(role, canonical.targetHashV1, qualifier),
    kind: "ADJUSTMENT",
    stockDomain: "RAIL_LOT",
    quantityDelta,
    railLotId,
    nomenclatureId: null,
    targetSnapshot: canonical.targetSnapshot,
  };
}

function nomenclatureReceipt(nomenclatureId: string, quantity: number): ExpectedEffect {
  const canonical = canonicalizeMovementTarget({
    stockDomain: "NOMENCLATURE",
    nomenclatureId,
  });
  return {
    effectKey: effectKeyV1("receipt", canonical.targetHashV1),
    kind: "RECEIPT",
    stockDomain: "NOMENCLATURE",
    quantityDelta: quantity,
    railLotId: null,
    nomenclatureId,
    targetSnapshot: canonical.targetSnapshot,
  };
}

function deriveR05(source: R05RetainedSource, causationId: string): SourceVerdict {
  if (source.id !== causationId) {
    return { status: "INVALID_SOURCE", reason: "correction id does not match the requested causation" };
  }
  if (
    isBlank(source.requestId) ||
    isBlank(source.operationId) ||
    isBlank(source.adminUserId) ||
    isBlank(source.railLotId) ||
    isBlank(source.batchId) ||
    isBlank(source.reason)
  ) {
    return { status: "INVALID_SOURCE", reason: "correction is missing a required retained field" };
  }
  if (
    !isPositiveInt(source.expectedOldRailsTaken) ||
    !isPositiveInt(source.newRailsTaken) ||
    !isPositiveInt(source.deltaReturned) ||
    source.newRailsTaken >= source.expectedOldRailsTaken ||
    source.expectedOldRailsTaken - source.newRailsTaken !== source.deltaReturned
  ) {
    return { status: "INVALID_SOURCE", reason: "correction delta is not a consistent positive integer" };
  }
  return {
    status: "READY",
    effects: [railEffect("adjust", source.railLotId, source.deltaReturned, "rails-taken")],
  };
}

function deriveWriteOff(source: WriteOffRetainedSource, causationId: string): SourceVerdict {
  if (source.id !== causationId || isBlank(source.batchId)) {
    return { status: "INVALID_SOURCE", reason: "write-off identity is incomplete" };
  }
  if (!Number.isInteger(source.totalQuantity) || source.totalQuantity < 0) {
    return { status: "INVALID_SOURCE", reason: "write-off totalQuantity is not a non-negative integer" };
  }
  if (!isRecord(source.effectSnapshot)) {
    return { status: "INVALID_SOURCE", reason: "write-off effectSnapshot is malformed" };
  }
  const snapshot = source.effectSnapshot;
  if (snapshot.v !== 1) {
    return snapshot.v === undefined
      ? { status: "INVALID_SOURCE", reason: "write-off effectSnapshot has no version" }
      : { status: "NOT_EVALUABLE", reason: "write-off effectSnapshot version is not readable by this slice" };
  }
  if (snapshot.d !== WRITE_OFF_SNAPSHOT) {
    return snapshot.d === undefined
      ? { status: "INVALID_SOURCE", reason: "write-off effectSnapshot has no domain" }
      : { status: "NOT_EVALUABLE", reason: "write-off effectSnapshot domain is not readable by this slice" };
  }
  if (snapshot.batchId !== source.batchId || isBlank(snapshot.batchId)) {
    return { status: "INVALID_SOURCE", reason: "write-off effectSnapshot batchId is inconsistent" };
  }
  if (!Array.isArray(snapshot.effects)) {
    return { status: "INVALID_SOURCE", reason: "write-off effectSnapshot effects are malformed" };
  }
  const seen = new Set<string>();
  const effects: ExpectedEffect[] = [];
  let total = 0;
  for (const item of snapshot.effects) {
    if (!isRecord(item) || !nonBlankString(item.railLotId) || !isPositiveInt(item.quantityBefore)) {
      return { status: "INVALID_SOURCE", reason: "write-off effect is malformed" };
    }
    if (item.quantityDelta !== -item.quantityBefore) {
      return { status: "INVALID_SOURCE", reason: "write-off quantityDelta is not -quantityBefore" };
    }
    if (seen.has(item.railLotId)) {
      return { status: "INVALID_SOURCE", reason: "write-off snapshot repeats a canonical rail target" };
    }
    seen.add(item.railLotId);
    total += item.quantityBefore;
    effects.push(railEffect("writeoff", item.railLotId, -item.quantityBefore));
  }
  if (total !== source.totalQuantity) {
    return { status: "INVALID_SOURCE", reason: "write-off totalQuantity does not equal the retained effects" };
  }
  return { status: "READY", effects };
}

function derivePurchase(source: SimplePurchaseRetainedSource, causationId: string): SourceVerdict {
  if (source.id !== causationId) {
    return { status: "INVALID_SOURCE", reason: "purchase id does not match the requested causation" };
  }
  if (isBlank(source.nomenclatureId) || !isPositiveInt(source.quantity)) {
    return { status: "INVALID_SOURCE", reason: "purchase quantity or nomenclature is invalid" };
  }
  const command = source.creationCommand;
  if (command) {
    if (command.simplePurchaseId !== source.id) {
      return { status: "INVALID_SOURCE", reason: "creation command points at a different purchase" };
    }
    if (!isRecord(command.requestSnapshot)) {
      return { status: "INVALID_SOURCE", reason: "creation command requestSnapshot is malformed" };
    }
    const snapshot = command.requestSnapshot;
    if (snapshot.v !== 1 || snapshot.d !== PURCHASE_SNAPSHOT) {
      if (typeof snapshot.v === "number" && snapshot.v !== 1) {
        return { status: "NOT_EVALUABLE", reason: "creation command snapshot version is not readable by this slice" };
      }
      return { status: "INVALID_SOURCE", reason: "creation command requestSnapshot is malformed" };
    }
    if (snapshot.nomenclatureId !== source.nomenclatureId || snapshot.quantity !== source.quantity) {
      return {
        status: "INVALID_SOURCE",
        reason: "creation command requestSnapshot contradicts the retained purchase",
      };
    }
  }
  return {
    status: "READY",
    effects: [nomenclatureReceipt(source.nomenclatureId, source.quantity)],
  };
}

function deriveExpected(
  contour: Slice1Contour,
  causationId: string,
  source: R05RetainedSource | WriteOffRetainedSource | SimplePurchaseRetainedSource,
): SourceVerdict {
  if (contour === "R05_CORRECTION") return deriveR05(source as R05RetainedSource, causationId);
  if (contour === "BATCH_REMAINDER_WRITEOFF") {
    return deriveWriteOff(source as WriteOffRetainedSource, causationId);
  }
  return derivePurchase(source as SimplePurchaseRetainedSource, causationId);
}

function targetIdentity(row: {
  stockDomain: string;
  railLotId: string | null;
  nomenclatureId: string | null;
}): string {
  if (row.stockDomain === "RAIL_LOT") return `RAIL_LOT:${row.railLotId ?? ""}`;
  if (row.nomenclatureId != null || row.stockDomain === "NOMENCLATURE") {
    return `NOMENCLATURE:${row.nomenclatureId ?? ""}`;
  }
  return `${row.stockDomain}:unpaired`;
}

function belongsToCausation(
  row: ObservedShadowMovement,
  causationKind: Slice1CausationKind,
  causationId: string,
): boolean {
  return (
    row.authority === "SHADOW" &&
    row.causationKind === causationKind &&
    row.causationId === causationId
  );
}

function compareEffects(
  expected: ExpectedEffect[],
  observed: ObservedShadowMovement[],
  causationKind: Slice1CausationKind,
  causationId: string,
): Slice1Difference[] {
  const eligible: ObservedShadowMovement[] = [];
  const differences: Slice1Difference[] = [];
  for (const row of observed) {
    if (belongsToCausation(row, causationKind, causationId)) eligible.push(row);
    else {
      differences.push({
        code: "UNEXPECTED_EFFECT",
        effectKey: row.effectKey,
        expected: null,
        observed: row.railLotId ?? row.nomenclatureId ?? row.id,
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
        expected: effect.railLotId ?? effect.nomenclatureId,
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
      observed: row.railLotId ?? row.nomenclatureId ?? row.id,
    });
  }
  return differences.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    if (a.effectKey !== b.effectKey) return a.effectKey < b.effectKey ? -1 : 1;
    return (a.expected ?? "").localeCompare(b.expected ?? "");
  });
}

export function evaluateSlice1InvariantA(input: {
  contour: Slice1Contour;
  causationId: string;
  source: R05RetainedSource | WriteOffRetainedSource | SimplePurchaseRetainedSource | null;
  observed: ObservedShadowMovement[];
}): Slice1DiagnosticResult {
  const observedCount = input.observed.length;
  if (input.source === null) {
    return finished(
      input,
      "SOURCE_UNAVAILABLE",
      0,
      observedCount,
      [],
      "retained source is absent",
    );
  }
  const derived = deriveExpected(input.contour, input.causationId, input.source);
  if (derived.status !== "READY") {
    return finished(input, derived.status, 0, observedCount, [], derived.reason);
  }
  if (derived.effects.length > 0 && observedCount === 0) {
    return finished(
      input,
      "GATE_UNKNOWN",
      derived.effects.length,
      0,
      [],
      "expected effects are nonempty and no SHADOW movements were observed",
    );
  }
  const differences = compareEffects(
    derived.effects,
    input.observed,
    slice1CausationKind(input.contour),
    input.causationId,
  );
  if (differences.length === 0) {
    return finished(
      input,
      "MATCH_OBSERVED",
      derived.effects.length,
      observedCount,
      [],
      "expected and observed semantic effect sets are equal",
    );
  }
  return finished(
    input,
    "MISMATCH",
    derived.effects.length,
    observedCount,
    differences,
    "expected and observed semantic effect sets differ",
  );
}

function mapObserved(row: {
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
}): ObservedShadowMovement {
  return {
    id: row.id,
    kind: row.kind,
    stockDomain: row.stockDomain,
    quantityDelta: row.quantityDelta,
    effectKey: row.effectKey,
    authority: row.authority,
    causationKind: row.causationKind,
    causationId: row.causationId,
    railLotId: row.railLotId,
    nomenclatureId: row.nomenclatureId,
    targetSnapshot: row.targetSnapshot,
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

export async function readSlice1InvariantA(
  db: PrismaClient,
  input: { contour: Slice1Contour; causationId: string },
): Promise<Slice1DiagnosticResult> {
  try {
    return await db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('transaction_read_only', 'on', true)`;
        const where = slice1ObservedMovementWhere(input.contour, input.causationId);
        const movements = await tx.inventoryMovement.findMany({ where, select: observedSelect });
        if (input.contour === "R05_CORRECTION") {
          const row = await tx.productionOperationCorrection.findUnique({
            where: { id: input.causationId },
          });
          return evaluateSlice1InvariantA({
            contour: input.contour,
            causationId: input.causationId,
            source: row
              ? {
                  id: row.id,
                  requestId: row.requestId,
                  operationId: row.operationId,
                  adminUserId: row.adminUserId,
                  railLotId: row.railLotId,
                  batchId: row.batchId,
                  expectedOldRailsTaken: row.expectedOldRailsTaken,
                  newRailsTaken: row.newRailsTaken,
                  deltaReturned: row.deltaReturned,
                  reason: row.reason,
                }
              : null,
            observed: movements.map(mapObserved),
          });
        }
        if (input.contour === "BATCH_REMAINDER_WRITEOFF") {
          const row = await tx.batchRemainderWriteOff.findUnique({
            where: { id: input.causationId },
          });
          return evaluateSlice1InvariantA({
            contour: input.contour,
            causationId: input.causationId,
            source: row
              ? {
                  id: row.id,
                  batchId: row.batchId,
                  totalQuantity: row.totalQuantity,
                  effectSnapshot: row.effectSnapshot,
                }
              : null,
            observed: movements.map(mapObserved),
          });
        }
        const purchase = await tx.simplePurchase.findUnique({
          where: { id: input.causationId },
        });
        const command = purchase
          ? await tx.simplePurchaseCreationCommand.findUnique({
              where: { simplePurchaseId: purchase.id },
            })
          : null;
        return evaluateSlice1InvariantA({
          contour: input.contour,
          causationId: input.causationId,
          source: purchase
            ? {
                id: purchase.id,
                nomenclatureId: purchase.nomenclatureId,
                quantity: purchase.quantity,
                creationCommand: command
                  ? {
                      id: command.id,
                      requestId: command.requestId,
                      simplePurchaseId: command.simplePurchaseId,
                      requestSnapshot: command.requestSnapshot,
                    }
                  : null,
              }
            : null,
          observed: movements.map(mapObserved),
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  } catch (error) {
    if (error instanceof Slice1DiagnosticExecutionError) throw error;
    throw new Slice1DiagnosticExecutionError("Slice 1 diagnostic read failed", error);
  }
}
