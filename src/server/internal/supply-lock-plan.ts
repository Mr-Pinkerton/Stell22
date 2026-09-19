/**
 * PSR-P2 Supply writer prerequisite: request-level canonical lock plan.
 * Pure planning only. Does not write InventoryMovement.
 */
import { isOzonCancelledInThisSync, evaluateOzonSupplyCancellation } from "@/server/internal/supply-accounting-cycle";

export type SupplyKey = {
  marketplace: string;
  externalId: string;
  sku: string;
};

export type IncomingSupply = SupplyKey & {
  number: string | null;
  quantity: number;
  status: string;
  warehouseName: string | null;
  createdAt: Date;
  acceptedAt: Date | null;
};

export type LockedSupplyAccounting = SupplyKey & {
  productId: string | null;
  deductedQty: number;
  shortfallQty: number;
  stockAccountingOpen: boolean;
};

export function supplyKeyId(key: SupplyKey): string {
  return `${key.marketplace}\0${key.externalId}\0${key.sku}`;
}

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
    const id = supplyKeyId(key);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ marketplace: key.marketplace, externalId: key.externalId, sku: key.sku });
  }
  return out.sort(compareSupplyKeys);
}

export const SUPPLY_DUPLICATE_IDENTITY_CONFLICT = "SUPPLY_DUPLICATE_IDENTITY_CONFLICT";

function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}

export function sameSupplyIdentityPayload(a: IncomingSupply, b: IncomingSupply): boolean {
  return (
    a.marketplace === b.marketplace &&
    a.externalId === b.externalId &&
    a.sku === b.sku &&
    a.quantity === b.quantity &&
    a.status === b.status &&
    a.number === b.number &&
    a.warehouseName === b.warehouseName &&
    sameInstant(a.createdAt, b.createdAt) &&
    sameInstant(a.acceptedAt, b.acceptedAt)
  );
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

/**
 * Canonical incoming snapshot: identical duplicate identities collapse;
 * conflicting payloads fail closed. Result is input-order independent.
 */
export function sortSuppliesForUpsert<T extends IncomingSupply>(supplies: readonly T[]): T[] {
  const byKey = new Map<string, T>();
  for (const supply of supplies) {
    const id = supplyKeyId(supply);
    const existing = byKey.get(id);
    if (!existing) {
      byKey.set(id, supply);
      continue;
    }
    if (!sameSupplyIdentityPayload(existing, supply)) {
      throw new Error(SUPPLY_DUPLICATE_IDENTITY_CONFLICT);
    }
  }
  return [...byKey.values()].sort(compareSupplyKeys);
}

export function incomingSupplyKeys(supplies: readonly SupplyKey[]): SupplyKey[] {
  return uniqueSortedSupplyKeys(supplies);
}

export function shippedSupplyAccountingKeys(supplies: readonly (SupplyKey & { status: string })[]): SupplyKey[] {
  return uniqueSortedSupplyKeys(
    supplies
      .filter((supply) => supply.status === "SHIPPED" || supply.status === "ACCEPTED")
      .map((supply) => ({
        marketplace: supply.marketplace,
        externalId: supply.externalId,
        sku: supply.sku,
      })),
  );
}

export function unionSupplyAccountingKeys(input: {
  deductKeys: Iterable<SupplyKey>;
  cancelKeys: Iterable<SupplyKey>;
}): SupplyKey[] {
  return uniqueSortedSupplyKeys([...input.deductKeys, ...input.cancelKeys]);
}

export function uniqueSortedProductIds(ids: Iterable<string | null | undefined>): string[] {
  return [...new Set([...ids].filter((id): id is string => Boolean(id)))].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

export function deriveSupplyProductStockTargets(input: {
  lockedSupplies: readonly LockedSupplyAccounting[];
  liveProductIdByKey: ReadonlyMap<string, string | null>;
  deductKeys: readonly SupplyKey[];
  cancelKeys: readonly SupplyKey[];
  cancelledOzonExternalIds: ReadonlySet<string>;
}): string[] {
  const lockedByKey = new Map(input.lockedSupplies.map((row) => [supplyKeyId(row), row]));
  const productIds: string[] = [];

  for (const key of input.deductKeys) {
    if (isOzonCancelledInThisSync(key.marketplace, key.externalId, input.cancelledOzonExternalIds)) {
      continue;
    }
    const locked = lockedByKey.get(supplyKeyId(key));
    if (!locked) continue;
    const binding = resolveSupplyProductBinding({
      deductedQty: locked.deductedQty,
      shortfallQty: locked.shortfallQty,
      boundProductId: locked.productId,
      liveProductId: input.liveProductIdByKey.get(supplyKeyId(key)) ?? null,
    });
    if (binding.productId) productIds.push(binding.productId);
  }

  for (const key of input.cancelKeys) {
    const locked = lockedByKey.get(supplyKeyId(key));
    if (!locked) continue;
    const decision = evaluateOzonSupplyCancellation({
      stockAccountingOpen: locked.stockAccountingOpen,
      deductedQty: locked.deductedQty,
    });
    if (decision.action === "close" && decision.restoreQty > 0 && locked.productId) {
      productIds.push(locked.productId);
    }
  }

  return uniqueSortedProductIds(productIds);
}
