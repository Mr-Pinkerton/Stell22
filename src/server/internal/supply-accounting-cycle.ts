/**
 * PSR-P2 R-04: durable Supply stock-accounting cycle identity.
 * Does not write InventoryMovement. Dual-write remains NOT STARTED.
 */

export const SUPPLY_CAUSATION_KIND = "SUPPLY" as const;

export type SupplyMovementDirection = "CONSUME" | "RESTORE";

export function hasNewSupplyAccountingDelta(
  targetQty: number,
  deductedQty: number,
  shortfallQty: number,
): boolean {
  return targetQty > deductedQty + shortfallQty;
}

export function nextSupplyAccountingLifecycle(input: {
  targetQty: number;
  deductedQty: number;
  shortfallQty: number;
  stockAccountingGeneration: number;
  stockAccountingOpen: boolean;
}): { generation: number; open: boolean; accountingDelta: boolean } {
  if (!hasNewSupplyAccountingDelta(input.targetQty, input.deductedQty, input.shortfallQty)) {
    return {
      generation: input.stockAccountingGeneration,
      open: input.stockAccountingOpen,
      accountingDelta: false,
    };
  }
  if (!input.stockAccountingOpen) {
    return {
      generation: input.stockAccountingGeneration + 1,
      open: true,
      accountingDelta: true,
    };
  }
  return {
    generation: input.stockAccountingGeneration,
    open: true,
    accountingDelta: true,
  };
}

export type OzonSupplyCancelDecision =
  | { action: "noop" }
  | { action: "close"; restoreQty: number };

export function evaluateOzonSupplyCancellation(input: {
  stockAccountingOpen: boolean;
  deductedQty: number;
}): OzonSupplyCancelDecision {
  if (!input.stockAccountingOpen) return { action: "noop" };
  return { action: "close", restoreQty: Math.max(0, input.deductedQty) };
}

export function isOzonCancelledInThisSync(
  marketplace: string,
  externalId: string,
  cancelledOzonExternalIds: ReadonlySet<string>,
): boolean {
  return marketplace === "OZON" && cancelledOzonExternalIds.has(externalId);
}

/**
 * Historical / non-runtime causal facts only.
 * Canonical consume identity is `supply-shadow-write.ts` (`processedQtyAfter`).
 */
export function supplyConsumeCausalIdentity(input: {
  supplyId: string;
  stockAccountingGeneration: number;
  accountedQtyAfter: number;
}): {
  causationKind: typeof SUPPLY_CAUSATION_KIND;
  causationId: string;
  stockAccountingGeneration: number;
  accountedQtyAfter: number;
  direction: "CONSUME";
} {
  return {
    causationKind: SUPPLY_CAUSATION_KIND,
    causationId: input.supplyId,
    stockAccountingGeneration: input.stockAccountingGeneration,
    accountedQtyAfter: input.accountedQtyAfter,
    direction: "CONSUME",
  };
}

/**
 * Historical / non-runtime causal facts only.
 * Canonical restore identity is `supply-shadow-write.ts`.
 */
export function supplyRestoreCausalIdentity(input: {
  supplyId: string;
  stockAccountingGeneration: number;
}): {
  causationKind: typeof SUPPLY_CAUSATION_KIND;
  causationId: string;
  stockAccountingGeneration: number;
  direction: "RESTORE";
} {
  return {
    causationKind: SUPPLY_CAUSATION_KIND,
    causationId: input.supplyId,
    stockAccountingGeneration: input.stockAccountingGeneration,
    direction: "RESTORE",
  };
}
