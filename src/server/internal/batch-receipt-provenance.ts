/**
 * Forward-only Batch receipt provenance.
 * Built from the RailLot rows inserted by this command.
 * Not derived from InventoryMovement, causationSnapshot, or write-off records.
 */

export const BATCH_RECEIPT_PROVENANCE_DOMAIN = "BATCH_RECEIPT_PROVENANCE";

export const BATCH_RECEIPT_PROVENANCE_INVALID = "BATCH_RECEIPT_PROVENANCE_INVALID";

export interface BatchReceiptProvenanceLot {
  id: string;
  batchId: string;
  quantity: number;
}

export interface BatchReceiptProvenancePair {
  railLotId: string;
  quantity: number;
}

export interface BatchReceiptProvenanceV1 {
  v: 1;
  d: typeof BATCH_RECEIPT_PROVENANCE_DOMAIN;
  commandId: string;
  batchId: string;
  pairs: BatchReceiptProvenancePair[];
}

function invalid(): never {
  throw new Error(BATCH_RECEIPT_PROVENANCE_INVALID);
}

function requireNonBlank(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) invalid();
}

function requireOriginalQuantity(value: number): void {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    invalid();
  }
}

export function buildBatchReceiptProvenance(input: {
  commandId: string;
  batchId: string;
  lots: readonly BatchReceiptProvenanceLot[];
}): BatchReceiptProvenanceV1 {
  requireNonBlank(input.commandId);
  requireNonBlank(input.batchId);
  const seen = new Set<string>();
  const pairs: BatchReceiptProvenancePair[] = [];
  for (const lot of input.lots) {
    requireNonBlank(lot.id);
    requireNonBlank(lot.batchId);
    if (lot.batchId !== input.batchId) invalid();
    requireOriginalQuantity(lot.quantity);
    if (seen.has(lot.id)) invalid();
    seen.add(lot.id);
    pairs.push({ railLotId: lot.id, quantity: lot.quantity });
  }
  pairs.sort((a, b) => a.railLotId.localeCompare(b.railLotId));
  return {
    v: 1,
    d: BATCH_RECEIPT_PROVENANCE_DOMAIN,
    commandId: input.commandId,
    batchId: input.batchId,
    pairs,
  };
}
