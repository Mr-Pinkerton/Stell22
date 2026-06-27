import type { Batch, RailLot } from "@/types/domain";

export interface BatchStats {
  railCount: number;
  totalLengthM: number;
  volumeM3: number;
  packageCount: number;
}

export interface PurchaseBatchRow extends Batch {
  stats: BatchStats;
  /** Расхождение цен сортов и стоимости партии (сигнал в UI). */
  costMismatch?: boolean;
}

/** Площадь сечения рейки, м². */
export function sectionAreaM2(widthMm: number, heightMm: number): number {
  return (widthMm / 1000) * (heightMm / 1000);
}

/**
 * Количество реек: вручную или ряды × слои (если оба заданы).
 * Приоритет у рядов×слоёв, когда оба > 0.
 */
export function resolveRailQuantity(input: {
  quantity?: number | null;
  rows?: number | null;
  layers?: number | null;
}): number | null {
  const rows = input.rows ?? 0;
  const layers = input.layers ?? 0;
  if (rows > 0 && layers > 0) return rows * layers;

  const quantity = input.quantity ?? 0;
  if (quantity > 0) return quantity;

  return null;
}

export function computeBatchStats(batch: Batch, lots: RailLot[]): BatchStats {
  const batchLots = lots.filter((l) => l.batchId === batch.id);
  const area = sectionAreaM2(batch.sectionWidthMm, batch.sectionHeightMm);

  let railCount = 0;
  let totalLengthM = 0;
  let volumeM3 = 0;

  for (const lot of batchLots) {
    railCount += lot.quantity;
    totalLengthM += lot.quantity * lot.lengthM;
    volumeM3 += lot.quantity * area * lot.lengthM;
  }

  return {
    railCount,
    totalLengthM,
    volumeM3,
    packageCount: batchLots.filter((l) => l.isPackage).length,
  };
}

export function buildPurchaseRows(
  batches: Batch[],
  lots: RailLot[],
  costMismatchIds: Set<string> = new Set(),
): PurchaseBatchRow[] {
  return batches.map((batch) => ({
    ...batch,
    stats: computeBatchStats(batch, lots),
    costMismatch: costMismatchIds.has(batch.id),
  }));
}
