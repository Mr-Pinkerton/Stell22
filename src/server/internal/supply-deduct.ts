import { Prisma } from "@prisma/client";
import { computeSupplyDeduction } from "@/lib/supply-stock";

export type SupplyDb = {
  $queryRaw: Prisma.TransactionClient["$queryRaw"];
  supply: Prisma.TransactionClient["supply"];
  productStock: Prisma.TransactionClient["productStock"];
};

export type SupplyKey = {
  marketplace: string;
  externalId: string;
  sku: string;
};

export function compareSupplyKeys(a: SupplyKey, b: SupplyKey): number {
  return (
    a.marketplace.localeCompare(b.marketplace) ||
    a.externalId.localeCompare(b.externalId) ||
    a.sku.localeCompare(b.sku)
  );
}

export function uniqueSortedSupplyKeys(keys: Iterable<SupplyKey>): SupplyKey[] {
  const seen = new Set<string>();
  const out: SupplyKey[] = [];
  for (const key of keys) {
    const id = `${key.marketplace}\0${key.externalId}\0${key.sku}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(key);
  }
  return out.sort(compareSupplyKeys);
}

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

async function lockProductStockQty(
  db: SupplyDb,
  productId: string,
): Promise<number | null> {
  const rows = await db.$queryRaw<Array<{ quantity: number | bigint }>>(Prisma.sql`
    SELECT id, quantity FROM "ProductStock" WHERE "productId" = ${productId} FOR UPDATE
  `);
  if (rows.length === 0) return null;
  return Number(rows[0].quantity);
}

export function resolveSupplyProductBinding(input: {
  deductedQty: number;
  shortfallQty: number;
  boundProductId: string | null;
  liveProductId: string | null;
}): { productId: string | null; rebind: boolean } {
  const accountingStarted = input.deductedQty + input.shortfallQty > 0;
  if (accountingStarted) {
    return { productId: input.boundProductId, rebind: false };
  }
  const live = input.liveProductId;
  if (live && live !== input.boundProductId) {
    return { productId: live, rebind: true };
  }
  return { productId: live ?? input.boundProductId, rebind: false };
}

export async function applySupplyDeduction(
  db: SupplyDb,
  input: SupplyKey & { targetQty: number; productId: string | null },
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

  const lockedQty = await lockProductStockQty(db, productId);
  const available = lockedQty ?? 0;
  const { toRemove, shortfall, newDeducted, newShort } = computeSupplyDeduction({
    targetQty: input.targetQty,
    alreadyDeducted,
    alreadyShort,
    available,
  });

  if (toRemove > 0) {
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
    data: { deductedQty: newDeducted, shortfallQty: newShort },
  });

  return { toRemove, shortfall };
}
