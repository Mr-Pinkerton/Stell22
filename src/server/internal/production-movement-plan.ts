import type { Prisma } from "@prisma/client";
import { canonicalLengthFixed4 } from "@/server/internal/blank-length";
import {
  canonicalizeMovementTarget,
  compareEffectKey,
  effectKeyV1,
  type MovementEffect,
  type MovementTarget,
} from "@/server/internal/inventory-movement-identity";
import { prisadkaDestFlags } from "@/server/internal/inventory-integrity";
import type { RailType, Sort } from "@/types/domain";

export const PRODUCTION_BLANK_PROVENANCE_MISSING = "PRODUCTION_BLANK_PROVENANCE_MISSING";

function assertNever(value: never): never {
  throw new Error(`Unsupported production movement plan kind: ${JSON.stringify(value)}`);
}

function requireBlankProvenance(line: {
  blankMaterialId: string | null;
  blankLengthM: Prisma.Decimal | number | string | null;
  blankType: RailType | null;
  blankSort: Sort | null;
}): {
  materialId: string;
  lengthM: string;
  detailType: RailType;
  sort: Sort;
} {
  if (
    !line.blankMaterialId ||
    line.blankLengthM == null ||
    line.blankType == null ||
    line.blankSort == null
  ) {
    throw new Error(PRODUCTION_BLANK_PROVENANCE_MISSING);
  }
  return {
    materialId: line.blankMaterialId,
    lengthM: canonicalLengthFixed4(line.blankLengthM),
    detailType: line.blankType,
    sort: line.blankSort,
  };
}

function requireDetailId(detailId: string | null): string {
  if (!detailId) throw new Error(PRODUCTION_BLANK_PROVENANCE_MISSING);
  return detailId;
}

function blankTarget(spec: {
  materialId: string;
  lengthM: Prisma.Decimal | number | string;
  detailType: RailType;
  sort: Sort;
}): MovementTarget {
  return {
    stockDomain: "BLANK",
    materialId: spec.materialId,
    lengthM: canonicalLengthFixed4(spec.lengthM),
    detailType: spec.detailType,
    sort: spec.sort,
  };
}

function detailTarget(input: {
  detailId: string;
  torcevayaDone: boolean;
  ploskostDone: boolean;
}): MovementTarget {
  return {
    stockDomain: "DETAIL",
    detailId: input.detailId,
    torcevayaDone: input.torcevayaDone,
    ploskostDone: input.ploskostDone,
  };
}

function semanticKey(role: MovementEffect["role"], target: MovementTarget): string {
  return `${role}|${canonicalizeMovementTarget(target).targetKeyV1}`;
}

function effectSortKey(effect: MovementEffect): string {
  return effectKeyV1(effect.role, canonicalizeMovementTarget(effect.target).targetHashV1);
}

/**
 * Aggregate by semantic role + canonical physical target.
 * CONSUMPTION and PRODUCTION_OUTPUT are never netted against each other.
 * Result is input-order independent; gateway still owns INSERT order.
 */
export function aggregateProductionMovementEffects(
  effects: readonly MovementEffect[],
): MovementEffect[] {
  const grouped = new Map<string, MovementEffect>();
  for (const effect of effects) {
    if (effect.quantityDelta === 0) continue;
    const key = semanticKey(effect.role, effect.target);
    const existing = grouped.get(key);
    if (existing) {
      existing.quantityDelta += effect.quantityDelta;
      continue;
    }
    grouped.set(key, {
      ...effect,
      target: effect.target,
    });
  }
  return [...grouped.values()]
    .filter((effect) => effect.quantityDelta !== 0)
    .sort((a, b) => compareEffectKey(effectSortKey(a), effectSortKey(b)));
}

export type RetainedTorcovkaLine = {
  quantity: number;
  blankMaterialId: string | null;
  blankLengthM: Prisma.Decimal | number | string | null;
  blankType: RailType | null;
  blankSort: Sort | null;
};

export type RetainedTorcovkaOperation = {
  id: string;
  clientRequestId: string;
  batchId: string | null;
  railLotId: string | null;
  railsTaken: number | null;
  lines: readonly RetainedTorcovkaLine[];
};

export type RetainedPrisadkaLine = {
  quantity: number;
  detailId: string | null;
  sourceIsBlank: boolean;
  sourceTorcevayaDone: boolean;
  sourcePloskostDone: boolean;
  prisadkaTorcevaya: boolean;
  prisadkaPloskost: boolean;
  blankMaterialId: string | null;
  blankLengthM: Prisma.Decimal | number | string | null;
  blankType: RailType | null;
  blankSort: Sort | null;
};

export type RetainedPrisadkaOperation = {
  id: string;
  clientRequestId: string;
  lines: readonly RetainedPrisadkaLine[];
};

export type RetainedUpakovkaDetailLine = {
  quantity: number;
  detailId: string | null;
  sourceIsBlank: boolean;
  sourceTorcevayaDone: boolean;
  sourcePloskostDone: boolean;
  blankMaterialId: string | null;
  blankLengthM: Prisma.Decimal | number | string | null;
  blankType: RailType | null;
  blankSort: Sort | null;
};

export type RetainedUpakovkaNomenclatureLine = {
  nomenclatureId: string;
  quantity: number;
};

export type RetainedUpakovkaOperation = {
  id: string;
  clientRequestId: string;
  productId: string | null;
  productQty: number | null;
  lines: readonly RetainedUpakovkaDetailLine[];
  nomenclatureLines: readonly RetainedUpakovkaNomenclatureLine[];
};

export type ProductionPlanInput =
  | { kind: "TORCOVKA"; operation: RetainedTorcovkaOperation }
  | { kind: "PRISADKA"; operation: RetainedPrisadkaOperation }
  | { kind: "UPAKOVKA"; operation: RetainedUpakovkaOperation };

export type ProductionCausationSnapshot = {
  v: 1;
  d: "PRODUCTION_OPERATION";
  operationId: string;
  operationType: "TORCOVKA" | "PRISADKA" | "UPAKOVKA";
  clientRequestId: string;
  [key: string]: unknown;
};

export type ProductionShadowPlan = {
  kind: "TORCOVKA" | "PRISADKA" | "UPAKOVKA";
  effects: MovementEffect[];
  causationSnapshot: ProductionCausationSnapshot;
};

function snapshotHeader(
  operation: { id: string; clientRequestId: string },
  operationType: "TORCOVKA" | "PRISADKA" | "UPAKOVKA",
): Pick<
  ProductionCausationSnapshot,
  "v" | "d" | "operationId" | "operationType" | "clientRequestId"
> {
  return {
    v: 1,
    d: "PRODUCTION_OPERATION",
    operationId: operation.id,
    operationType,
    clientRequestId: operation.clientRequestId,
  };
}

function consume(target: MovementTarget, quantity: number): MovementEffect {
  return { role: "consume", kind: "CONSUMPTION", quantityDelta: -quantity, target };
}

function output(target: MovementTarget, quantity: number): MovementEffect {
  return { role: "output", kind: "PRODUCTION_OUTPUT", quantityDelta: quantity, target };
}

function planTorcovka(operation: RetainedTorcovkaOperation): ProductionShadowPlan {
  if (!operation.batchId || !operation.railLotId || operation.railsTaken == null) {
    throw new Error(PRODUCTION_BLANK_PROVENANCE_MISSING);
  }
  const raw: MovementEffect[] = [
    consume({ stockDomain: "RAIL_LOT", railLotId: operation.railLotId }, operation.railsTaken),
  ];
  for (const line of operation.lines) {
    if (line.quantity === 0) continue;
    raw.push(output(blankTarget(requireBlankProvenance(line)), line.quantity));
  }
  const effects = aggregateProductionMovementEffects(raw);
  const outputs = effects
    .filter((effect) => effect.role === "output" && effect.target.stockDomain === "BLANK")
    .map((effect) => {
      const canonical = canonicalizeMovementTarget(effect.target);
      return {
        materialId: canonical.materialId,
        lengthM: canonical.lengthMFixed4,
        detailType: canonical.detailType,
        sort: canonical.sort,
        quantity: effect.quantityDelta,
      };
    });
  return {
    kind: "TORCOVKA",
    effects,
    causationSnapshot: {
      ...snapshotHeader(operation, "TORCOVKA"),
      batchId: operation.batchId,
      railLotId: operation.railLotId,
      railsTaken: operation.railsTaken,
      outputs,
    },
  };
}

function prisadkaSourceTarget(line: RetainedPrisadkaLine): MovementTarget {
  if (line.sourceIsBlank) return blankTarget(requireBlankProvenance(line));
  return detailTarget({
    detailId: requireDetailId(line.detailId),
    torcevayaDone: line.sourceTorcevayaDone,
    ploskostDone: line.sourcePloskostDone,
  });
}

function prisadkaDestTarget(line: RetainedPrisadkaLine): MovementTarget {
  const dest = prisadkaDestFlags({
    detailId: line.detailId,
    prisadkaTorcevaya: line.prisadkaTorcevaya,
    sourceIsBlank: line.sourceIsBlank,
    sourceTorcevayaDone: line.sourceTorcevayaDone,
    sourcePloskostDone: line.sourcePloskostDone,
    blankLengthM: null,
    blankType: line.blankType,
    blankSort: line.blankSort,
    blankMaterialId: line.blankMaterialId,
  });
  return detailTarget({
    detailId: requireDetailId(line.detailId),
    torcevayaDone: dest.destTorcev,
    ploskostDone: dest.destPlosk,
  });
}

function snapshotTarget(target: MovementTarget): Record<string, unknown> {
  return canonicalizeMovementTarget(target).targetSnapshot as Record<string, unknown>;
}

function planPrisadka(operation: RetainedPrisadkaOperation): ProductionShadowPlan {
  const raw: MovementEffect[] = [];
  const portionMap = new Map<string, { source: MovementTarget; destination: MovementTarget; quantity: number }>();
  for (const line of operation.lines) {
    if (line.quantity === 0) continue;
    const source = prisadkaSourceTarget(line);
    const destination = prisadkaDestTarget(line);
    raw.push(consume(source, line.quantity));
    raw.push(output(destination, line.quantity));
    const portionKey = `${canonicalizeMovementTarget(source).targetKeyV1}|${canonicalizeMovementTarget(destination).targetKeyV1}`;
    const existing = portionMap.get(portionKey);
    if (existing) existing.quantity += line.quantity;
    else portionMap.set(portionKey, { source, destination, quantity: line.quantity });
  }
  const portions = [...portionMap.values()]
    .filter((row) => row.quantity !== 0)
    .sort((a, b) => {
      const aKey = `${canonicalizeMovementTarget(a.source).targetKeyV1}|${canonicalizeMovementTarget(a.destination).targetKeyV1}`;
      const bKey = `${canonicalizeMovementTarget(b.source).targetKeyV1}|${canonicalizeMovementTarget(b.destination).targetKeyV1}`;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    })
    .map((row) => ({
      source: snapshotTarget(row.source),
      destination: snapshotTarget(row.destination),
      quantity: row.quantity,
    }));
  return {
    kind: "PRISADKA",
    effects: aggregateProductionMovementEffects(raw),
    causationSnapshot: {
      ...snapshotHeader(operation, "PRISADKA"),
      portions,
    },
  };
}

function upakovkaSourceTarget(line: RetainedUpakovkaDetailLine): MovementTarget {
  if (line.sourceIsBlank) return blankTarget(requireBlankProvenance(line));
  return detailTarget({
    detailId: requireDetailId(line.detailId),
    torcevayaDone: line.sourceTorcevayaDone,
    ploskostDone: line.sourcePloskostDone,
  });
}

function planUpakovka(operation: RetainedUpakovkaOperation): ProductionShadowPlan {
  if (!operation.productId || operation.productQty == null) {
    throw new Error(PRODUCTION_BLANK_PROVENANCE_MISSING);
  }
  const raw: MovementEffect[] = [];
  for (const line of operation.lines) {
    if (line.quantity === 0) continue;
    raw.push(consume(upakovkaSourceTarget(line), line.quantity));
  }
  for (const line of operation.nomenclatureLines) {
    if (line.quantity === 0) continue;
    raw.push(
      consume({ stockDomain: "NOMENCLATURE", nomenclatureId: line.nomenclatureId }, line.quantity),
    );
  }
  if (operation.productQty !== 0) {
    raw.push(output({ stockDomain: "PRODUCT", productId: operation.productId }, operation.productQty));
  }
  const effects = aggregateProductionMovementEffects(raw);
  const details = effects
    .filter(
      (effect) =>
        effect.role === "consume" &&
        (effect.target.stockDomain === "BLANK" || effect.target.stockDomain === "DETAIL"),
    )
    .map((effect) => ({
      target: snapshotTarget(effect.target),
      quantity: -effect.quantityDelta,
    }));
  const nomenclature = effects
    .filter((effect) => effect.role === "consume" && effect.target.stockDomain === "NOMENCLATURE")
    .map((effect) => ({
      nomenclatureId: effect.target.stockDomain === "NOMENCLATURE" ? effect.target.nomenclatureId : "",
      quantity: -effect.quantityDelta,
    }));
  return {
    kind: "UPAKOVKA",
    effects,
    causationSnapshot: {
      ...snapshotHeader(operation, "UPAKOVKA"),
      productId: operation.productId,
      productQty: operation.productQty,
      details,
      nomenclature,
    },
  };
}

export function planProductionShadowMovements(input: ProductionPlanInput): ProductionShadowPlan {
  switch (input.kind) {
    case "TORCOVKA":
      return planTorcovka(input.operation);
    case "PRISADKA":
      return planPrisadka(input.operation);
    case "UPAKOVKA":
      return planUpakovka(input.operation);
    default:
      return assertNever(input);
  }
}
