import { Prisma } from "@prisma/client";
import {
  lockExistingActiveBlankPools,
} from "@/server/internal/cost-flow-raw";
import {
  lockExistingActiveDetailPools,
  lockExistingActiveNomPools,
  ensureAndLockActiveProductPools,
  uniqueSortedDetailStockSpecs,
  type DetailStockSpec,
} from "@/server/internal/cost-flow-pools";
import {
  lockBlankSpecs,
  lockDetails,
  lockNomenclatureIds,
  lockProductIds,
  uniqueSortedBlankSpecs,
  type BlankSpec,
  type PreparedUpakovkaApply,
} from "@/server/internal/inventory-integrity";

export type UpakovkaPreparedRow = {
  pick: { productId: string; quantity: number };
  prepared: PreparedUpakovkaApply;
};

export type UpakovkaPhysicalLockPlan = {
  detailIds: string[];
  blankSpecs: BlankSpec[];
  nomenclatureIds: string[];
  productIds: string[];
};

function sortedUniqueIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Request-level UPAKOVKA physical write-set. Independent of pick order.
 * Blank specs = no-prisadka BOM details. Detail masters = all BOM details.
 * Nomenclature = fasteners ∪ packaging ∪ extras. Products = output SKUs.
 */
export function planUpakovkaPhysicalLockSet(
  rows: readonly UpakovkaPreparedRow[],
): UpakovkaPhysicalLockPlan {
  const detailIds: string[] = [];
  const blanks: BlankSpec[] = [];
  const nomenclatureIds: string[] = [];
  const productIds: string[] = [];

  for (const row of rows) {
    productIds.push(row.pick.productId);
    for (const detail of row.prepared.details) {
      if (detail.quantity <= 0) continue;
      detailIds.push(detail.detailId);
      if (!detail.prisadkaTorcevaya && !detail.prisadkaPloskost) {
        blanks.push({
          materialId: detail.materialId,
          lengthM: detail.lengthM,
          detailType: detail.detailType,
          sort: detail.sort,
        });
      }
    }
    for (const fastener of row.prepared.fasteners) {
      if (fastener.quantity <= 0) continue;
      nomenclatureIds.push(fastener.nomenclatureId);
    }
    if (row.prepared.packagingId) nomenclatureIds.push(row.prepared.packagingId);
    for (const extra of row.prepared.extras) nomenclatureIds.push(extra.nomenclatureId);
  }

  return {
    detailIds: sortedUniqueIds(detailIds),
    blankSpecs: uniqueSortedBlankSpecs(blanks),
    nomenclatureIds: sortedUniqueIds(nomenclatureIds),
    productIds: sortedUniqueIds(productIds),
  };
}

export async function lockExistingDetailStockForDetails(
  tx: Prisma.TransactionClient,
  detailIds: Iterable<string>,
): Promise<void> {
  const unique = sortedUniqueIds(detailIds);
  if (unique.length === 0) return;
  await tx.$queryRaw(
    Prisma.sql`
      SELECT id FROM "DetailStock"
      WHERE "detailId" IN (${Prisma.join(unique)})
      ORDER BY "detailId", "torcevayaDone", "ploskostDone"
      FOR UPDATE
    `,
  );
}

async function lockActiveDetailStockSuperset(
  tx: Prisma.TransactionClient,
  detailIds: readonly string[],
): Promise<void> {
  if (detailIds.length === 0) return;
  const rows = await tx.detailStock.findMany({
    where: { detailId: { in: [...detailIds] }, quantity: { gt: 0 } },
    select: { detailId: true, torcevayaDone: true, ploskostDone: true },
  });
  const specs: DetailStockSpec[] = uniqueSortedDetailStockSpecs(
    rows.map((row) => ({
      detailId: row.detailId,
      torcevayaDone: row.torcevayaDone,
      ploskostDone: row.ploskostDone,
    })),
  );
  if (specs.length === 0) return;
  await lockExistingActiveDetailPools(tx, specs);
}

/**
 * One global UPAKOVKA lock order:
 * Detail masters → BlankStock → DetailStock sources → NomenclatureStock → ProductStock.
 *
 * INACTIVE may create quantity-0 projection rows (existing lock helpers).
 * ACTIVE uses existing initialized-pool helpers and does not mint quantity-only
 * uninitialized monetary rows.
 */
export async function lockUpakovkaPhysicalWriteSet(
  tx: Prisma.TransactionClient,
  plan: UpakovkaPhysicalLockPlan,
  options: { costFlowActive: boolean },
): Promise<void> {
  await lockDetails(tx, plan.detailIds);
  if (options.costFlowActive) {
    await lockExistingActiveBlankPools(tx, plan.blankSpecs);
    await lockActiveDetailStockSuperset(tx, plan.detailIds);
    await lockExistingActiveNomPools(tx, plan.nomenclatureIds);
    await ensureAndLockActiveProductPools(tx, plan.productIds);
    return;
  }
  await lockBlankSpecs(tx, plan.blankSpecs);
  await lockExistingDetailStockForDetails(tx, plan.detailIds);
  await lockNomenclatureIds(tx, plan.nomenclatureIds);
  await lockProductIds(tx, plan.productIds);
}
