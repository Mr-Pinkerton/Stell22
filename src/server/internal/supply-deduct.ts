import { Prisma } from "@prisma/client";
import { computeSupplyDeduction } from "@/lib/supply-stock";
import { PRODUCTION_COST_FLOW_KEY, parseProductionCostFlowValue } from "@/server/internal/cost-flow-state";
import { COST_FLOW_QTY_ONLY_WRITER } from "@/server/internal/cost-flow-pools";
import {
  evaluateOzonSupplyCancellation,
  isOzonCancelledInThisSync,
  nextSupplyAccountingLifecycle,
} from "@/server/internal/supply-accounting-cycle";
import {
  deriveSupplyProductStockTargets,
  incomingSupplyKeys,
  resolveSupplyProductBinding,
  shippedSupplyAccountingKeys,
  sortSuppliesForUpsert,
  supplyKeyId,
  unionSupplyAccountingKeys,
  uniqueSortedProductIds,
  uniqueSortedSupplyKeys,
  type IncomingSupply,
  type SupplyKey,
} from "@/server/internal/supply-lock-plan";

export {
  compareSupplyKeys,
  resolveSupplyProductBinding,
  uniqueSortedSupplyKeys,
  type SupplyKey,
} from "@/server/internal/supply-lock-plan";

export type SupplyDb = {
  $queryRaw: Prisma.TransactionClient["$queryRaw"];
  supply: Prisma.TransactionClient["supply"];
  productStock: Prisma.TransactionClient["productStock"];
};

export const SUPPLY_CANCEL_PRODUCT_BINDING_REQUIRED = "SUPPLY_CANCEL_PRODUCT_BINDING_REQUIRED";

export async function lockSuppliesInOrder(db: SupplyDb, keys: Iterable<SupplyKey>): Promise<void> {
  for (const key of uniqueSortedSupplyKeys(keys)) {
    await db.$queryRaw(Prisma.sql`
      SELECT id FROM "Supply"
      WHERE marketplace = ${key.marketplace}
        AND "externalId" = ${key.externalId}
        AND sku = ${key.sku}
      FOR UPDATE
    `);
  }
}

export function isRetryableSyncDeadlock(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; meta?: { code?: string }; message?: string };
  if (e.code === "P2034") return true;
  if (e.meta?.code === "40P01") return true;
  return typeof e.message === "string" && /deadlock detected/i.test(e.message);
}

export async function retryOnceOnSyncDeadlock<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isRetryableSyncDeadlock(err)) return await run();
    throw err;
  }
}

export async function readSupplyCostFlowActive(db: SupplyDb): Promise<boolean> {
  const settingRows = await db.$queryRaw<Array<{ value: unknown }>>`
    SELECT value FROM "Setting" WHERE key = ${PRODUCTION_COST_FLOW_KEY}
  `;
  if (!settingRows[0]) return false;
  return parseProductionCostFlowValue(settingRows[0].value).active;
}

async function resolveCostFlowActive(db: SupplyDb, captured?: boolean): Promise<boolean> {
  if (typeof captured === "boolean") return captured;
  return readSupplyCostFlowActive(db);
}

/**
 * INACTIVE: quantity-0 placeholders then FOR UPDATE by productId ASC.
 * ACTIVE: lock existing rows only — never mint uninitialized monetary pools.
 */
export async function lockSupplyProductStockTargets(
  db: SupplyDb,
  productIds: Iterable<string | null | undefined>,
  options: { costFlowActive: boolean },
): Promise<void> {
  const unique = uniqueSortedProductIds(productIds);
  if (unique.length === 0) return;
  if (!options.costFlowActive) {
    await db.productStock.createMany({
      data: unique.map((productId) => ({ productId, quantity: 0 })),
      skipDuplicates: true,
    });
  }
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM "ProductStock" WHERE "productId" IN (${Prisma.join(unique)}) ORDER BY "productId" FOR UPDATE`,
  );
}

async function lockProductStockQty(db: SupplyDb, productId: string): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ quantity: number | bigint }>>(Prisma.sql`
    SELECT id, quantity FROM "ProductStock" WHERE "productId" = ${productId} FOR UPDATE
  `);
  if (rows.length === 0) return null;
  return Number(rows[0].quantity);
}

export async function applySupplyDeduction(
  db: SupplyDb,
  input: SupplyKey & { targetQty: number; productId: string | null; costFlowActive?: boolean },
): Promise<{ toRemove: number; shortfall: number }> {
  await lockSuppliesInOrder(db, [input]);
  const supply = await db.supply.findUnique({
    where: {
      marketplace_externalId_sku: {
        marketplace: input.marketplace,
        externalId: input.externalId,
        sku: input.sku,
      },
    },
  });
  if (!supply) {
    return { toRemove: 0, shortfall: 0 };
  }

  const binding = resolveSupplyProductBinding({
    deductedQty: supply.deductedQty,
    shortfallQty: supply.shortfallQty,
    boundProductId: supply.productId,
    liveProductId: input.productId,
  });
  const productId = binding.productId;
  if (binding.rebind) {
    await db.supply.update({
      where: { id: supply.id },
      data: { productId },
    });
  }
  const alreadyDeducted = supply.deductedQty;
  const alreadyShort = supply.shortfallQty;
  if (input.targetQty <= alreadyDeducted + alreadyShort || !productId) {
    return { toRemove: 0, shortfall: 0 };
  }

  const lifecycle = nextSupplyAccountingLifecycle({
    targetQty: input.targetQty,
    deductedQty: alreadyDeducted,
    shortfallQty: alreadyShort,
    stockAccountingGeneration: supply.stockAccountingGeneration,
    stockAccountingOpen: supply.stockAccountingOpen,
  });

  const lockedQty = await lockProductStockQty(db, productId);
  const available = lockedQty ?? 0;
  const { toRemove, shortfall, newDeducted, newShort } = computeSupplyDeduction({
    targetQty: input.targetQty,
    alreadyDeducted,
    alreadyShort,
    available,
  });

  if (toRemove > 0) {
    const costFlowActive = await resolveCostFlowActive(db, input.costFlowActive);
    if (costFlowActive) throw new Error(COST_FLOW_QTY_ONLY_WRITER);
    const updated = await db.productStock.updateMany({
      where: { productId, quantity: { gte: toRemove } },
      data: { quantity: { decrement: toRemove } },
    });
    if (updated.count === 0) {
      throw new Error(
        "ProductStock gte failed after FOR UPDATE; refusing available=0 shortfall fallback",
      );
    }
  }

  await db.supply.update({
    where: { id: supply.id },
    data: {
      deductedQty: newDeducted,
      shortfallQty: newShort,
      stockAccountingGeneration: lifecycle.generation,
      stockAccountingOpen: lifecycle.open,
    },
  });

  return { toRemove, shortfall };
}

export async function findOzonSupplyKeysByExternalIds(
  db: SupplyDb,
  externalIds: string[],
): Promise<SupplyKey[]> {
  if (externalIds.length === 0) return [];
  const rows = await db.supply.findMany({
    where: { marketplace: "OZON", externalId: { in: externalIds } },
    select: { marketplace: true, externalId: true, sku: true },
  });
  return uniqueSortedSupplyKeys(rows);
}

/**
 * Close an open Ozon stock-accounting cycle under the Supply row lock.
 * Restores ProductStock by deductedQty only. Generation is unchanged.
 */
export async function applyOzonSupplyCancellation(
  db: SupplyDb,
  key: SupplyKey,
  options?: { costFlowActive?: boolean },
): Promise<{ restored: number; closed: boolean; generation: number }> {
  await lockSuppliesInOrder(db, [key]);
  const supply = await db.supply.findUnique({
    where: {
      marketplace_externalId_sku: {
        marketplace: key.marketplace,
        externalId: key.externalId,
        sku: key.sku,
      },
    },
  });
  if (!supply) return { restored: 0, closed: false, generation: 0 };

  const decision = evaluateOzonSupplyCancellation({
    stockAccountingOpen: supply.stockAccountingOpen,
    deductedQty: supply.deductedQty,
  });
  if (decision.action === "noop") {
    return { restored: 0, closed: false, generation: supply.stockAccountingGeneration };
  }

  if (decision.restoreQty > 0 && !supply.productId) {
    throw new Error(SUPPLY_CANCEL_PRODUCT_BINDING_REQUIRED);
  }

  if (decision.restoreQty > 0 && supply.productId) {
    const costFlowActive = await resolveCostFlowActive(db, options?.costFlowActive);
    if (costFlowActive) throw new Error(COST_FLOW_QTY_ONLY_WRITER);
    await db.$queryRaw`
      SELECT id FROM "ProductStock" WHERE "productId" = ${supply.productId} FOR UPDATE
    `;
    await db.productStock.upsert({
      where: { productId: supply.productId },
      create: { productId: supply.productId, quantity: decision.restoreQty },
      update: { quantity: { increment: decision.restoreQty } },
    });
  }

  await db.supply.update({
    where: { id: supply.id },
    data: {
      deductedQty: 0,
      shortfallQty: 0,
      status: "PENDING",
      stockAccountingOpen: false,
    },
  });

  return {
    restored: decision.restoreQty,
    closed: true,
    generation: supply.stockAccountingGeneration,
  };
}

export type SupplySyncAccountingResult = {
  deductedTotal: number;
  shortfallTotal: number;
  restoredTotal: number;
  shortfalls: Array<{ marketplace: string; externalId: string; sku: string; shortfall: number }>;
  restores: Array<{
    externalId: string;
    sku: string;
    restored: number;
    generation: number;
    closed: true;
  }>;
};

/**
 * Conforming marketplace-sync Supply accounting: canonical upsert order,
 * full Supply lock set, then full ProductStock lock set, then physical apply.
 */
export async function runSupplySyncAccounting(
  tx: SupplyDb,
  input: {
    supplies: IncomingSupply[];
    ozonCancelledExternalIds: string[];
    productIdFor: (marketplace: string, sku: string) => string | null;
  },
): Promise<SupplySyncAccountingResult> {
  const cancelledOzonIds = new Set(input.ozonCancelledExternalIds);
  const incomingSorted = sortSuppliesForUpsert(input.supplies);
  const existingCancelKeys = await findOzonSupplyKeysByExternalIds(tx, input.ozonCancelledExternalIds);
  await lockSuppliesInOrder(tx, [...incomingSupplyKeys(incomingSorted), ...existingCancelKeys]);

  for (const supply of incomingSorted) {
    const productId = input.productIdFor(supply.marketplace, supply.sku);
    await tx.supply.upsert({
      where: {
        marketplace_externalId_sku: {
          marketplace: supply.marketplace,
          externalId: supply.externalId,
          sku: supply.sku,
        },
      },
      create: {
        marketplace: supply.marketplace,
        externalId: supply.externalId,
        number: supply.number,
        sku: supply.sku,
        productId,
        quantity: supply.quantity,
        status: supply.status,
        warehouseName: supply.warehouseName,
        createdAt: supply.createdAt,
        acceptedAt: supply.acceptedAt,
      },
      update: {
        quantity: supply.quantity,
        status: supply.status,
        acceptedAt: supply.acceptedAt,
        warehouseName: supply.warehouseName,
      },
    });
  }

  const cancelKeys = await findOzonSupplyKeysByExternalIds(tx, input.ozonCancelledExternalIds);
  const deductKeys = shippedSupplyAccountingKeys(incomingSorted);
  const accountingKeys = unionSupplyAccountingKeys({ deductKeys, cancelKeys });
  await lockSuppliesInOrder(tx, accountingKeys);

  const lockedSupplies =
    accountingKeys.length === 0
      ? []
      : await tx.supply.findMany({
          where: {
            OR: accountingKeys.map((key) => ({
              marketplace: key.marketplace,
              externalId: key.externalId,
              sku: key.sku,
            })),
          },
        });

  const liveProductIdByKey = new Map<string, string | null>();
  for (const supply of incomingSorted) {
    liveProductIdByKey.set(supplyKeyId(supply), input.productIdFor(supply.marketplace, supply.sku));
  }

  const costFlowActive = await readSupplyCostFlowActive(tx);
  const productIds = deriveSupplyProductStockTargets({
    lockedSupplies,
    liveProductIdByKey,
    deductKeys,
    cancelKeys,
    cancelledOzonExternalIds: cancelledOzonIds,
  });
  await lockSupplyProductStockTargets(tx, productIds, { costFlowActive });

  let deductedTotal = 0;
  let shortfallTotal = 0;
  let restoredTotal = 0;
  const shortfalls: SupplySyncAccountingResult["shortfalls"] = [];
  const restores: SupplySyncAccountingResult["restores"] = [];

  const incomingByKey = new Map(incomingSorted.map((supply) => [supplyKeyId(supply), supply]));
  for (const key of deductKeys) {
    if (isOzonCancelledInThisSync(key.marketplace, key.externalId, cancelledOzonIds)) continue;
    const incoming = incomingByKey.get(supplyKeyId(key));
    const shipped = incoming
      ? incoming.status === "SHIPPED" || incoming.status === "ACCEPTED"
      : false;
    const target = shipped && incoming ? incoming.quantity : 0;
    if (!(target > 0)) continue;
    const { toRemove, shortfall } = await applySupplyDeduction(tx, {
      marketplace: key.marketplace,
      externalId: key.externalId,
      sku: key.sku,
      targetQty: target,
      productId: input.productIdFor(key.marketplace, key.sku),
      costFlowActive,
    });
    deductedTotal += toRemove;
    if (shortfall > 0) {
      shortfallTotal += shortfall;
      shortfalls.push({
        marketplace: key.marketplace,
        externalId: key.externalId,
        sku: key.sku,
        shortfall,
      });
    }
  }

  for (const key of cancelKeys) {
    const result = await applyOzonSupplyCancellation(tx, key, { costFlowActive });
    if (result.closed) {
      restoredTotal += result.restored;
      restores.push({
        externalId: key.externalId,
        sku: key.sku,
        restored: result.restored,
        generation: result.generation,
        closed: true,
      });
    }
  }

  return { deductedTotal, shortfallTotal, restoredTotal, shortfalls, restores };
}
