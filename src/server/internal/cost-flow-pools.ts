/**
 * Package 3 shared monetary pool helpers.
 * Active-mode only. Race-safe: createMany(skipDuplicates) → FOR UPDATE → assert.
 * Lock order inside this module: BlankStock → DetailStock → NomenclatureStock → ProductStock.
 */
import { Prisma } from "@prisma/client";
import { D, type Num } from "@/lib/cost";
import {
  isMonetaryPoolInitialized,
  q6,
  wacConsume,
  wacReceive,
  type WacState,
} from "@/lib/cost-foundation";
import {
  COST_FLOW_POOL_UNINITIALIZED,
  COST_FLOW_VERSION_MISMATCH,
  ensureAndLockActiveBlankPools,
  lockExistingActiveBlankPools,
} from "@/server/internal/cost-flow-raw";
import { type BlankSpec } from "@/server/internal/inventory-integrity";

export const COST_FLOW_DETAIL_POOL_UNINITIALIZED =
  "Денежный учёт включён, но складской пул деталей не инициализирован. Операция заблокирована.";
export const COST_FLOW_NOM_POOL_UNINITIALIZED =
  "Денежный учёт включён, но складской пул номенклатуры не инициализирован. Операция заблокирована.";
export const COST_FLOW_PRODUCT_POOL_UNINITIALIZED =
  "Денежный учёт включён, но складской пул изделий не инициализирован. Операция заблокирована.";
export const COST_FLOW_EMPTY_SURPLUS_VALUATION =
  "Для излишка на пустом остатке требуется ручная оценка стоимости.";
export const COST_FLOW_QTY_ONLY_WRITER =
  "Денежный учёт включён: операция со складом без движения стоимости заблокирована.";

export function money6(value: { toFixed: (digits: number) => string } | string | number): Prisma.Decimal {
  return new Prisma.Decimal(
    typeof value === "object" && "toFixed" in value ? value.toFixed(6) : q6(value).toFixed(6),
  );
}

export function moneyZero(): Prisma.Decimal {
  return new Prisma.Decimal("0");
}

export type DetailStockSpec = {
  detailId: string;
  torcevayaDone: boolean;
  ploskostDone: boolean;
};

export function detailStockSortKey(spec: DetailStockSpec): string {
  return `${spec.detailId}|${spec.torcevayaDone ? "1" : "0"}|${spec.ploskostDone ? "1" : "0"}`;
}

export function uniqueSortedDetailStockSpecs(specs: Iterable<DetailStockSpec>): DetailStockSpec[] {
  const byKey = new Map<string, DetailStockSpec>();
  for (const spec of specs) byKey.set(detailStockSortKey(spec), spec);
  return [...byKey.values()].sort((a, b) => detailStockSortKey(a).localeCompare(detailStockSortKey(b)));
}

/** Create missing initialized DetailStock rows without locking. Caller locks in canonical order after. */
export async function createMissingActiveDetailPoolRows(
  tx: Prisma.TransactionClient,
  specs: Iterable<DetailStockSpec>,
): Promise<void> {
  const unique = uniqueSortedDetailStockSpecs(specs);
  if (unique.length === 0) return;
  await tx.detailStock.createMany({
    data: unique.map((spec) => ({
      detailId: spec.detailId,
      torcevayaDone: spec.torcevayaDone,
      ploskostDone: spec.ploskostDone,
      quantity: 0,
      materialValue: moneyZero(),
      laborValue: moneyZero(),
      totalValue: moneyZero(),
      costVersion: 1,
    })),
    skipDuplicates: true,
  });
}

function uniqueSortedIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export type TwoComponentPool = {
  id: string;
  quantity: number;
  costVersion: number;
  materialValue: Prisma.Decimal | null;
  laborValue: Prisma.Decimal | null;
  totalValue: Prisma.Decimal | null;
};

export type NomPool = {
  id: string;
  quantity: number;
  costVersion: number;
  nomenclatureValue: Prisma.Decimal | null;
  totalValue: Prisma.Decimal | null;
};

export type ProductPool = {
  id: string;
  quantity: number;
  costVersion: number;
  materialValue: Prisma.Decimal | null;
  laborValue: Prisma.Decimal | null;
  nomenclatureValue: Prisma.Decimal | null;
  totalValue: Prisma.Decimal | null;
};

function assertTwoComponentInitialized(
  pool: TwoComponentPool,
  message: string,
): asserts pool is TwoComponentPool & {
  materialValue: Prisma.Decimal;
  laborValue: Prisma.Decimal;
  totalValue: Prisma.Decimal;
} {
  if (
    !isMonetaryPoolInitialized(pool.costVersion) ||
    pool.materialValue == null ||
    pool.laborValue == null ||
    pool.totalValue == null
  ) {
    throw new Error(message);
  }
}

function assertNomInitialized(
  pool: NomPool,
): asserts pool is NomPool & { nomenclatureValue: Prisma.Decimal; totalValue: Prisma.Decimal } {
  if (
    !isMonetaryPoolInitialized(pool.costVersion) ||
    pool.nomenclatureValue == null ||
    pool.totalValue == null
  ) {
    throw new Error(COST_FLOW_NOM_POOL_UNINITIALIZED);
  }
}

function assertProductInitialized(
  pool: ProductPool,
): asserts pool is ProductPool & {
  materialValue: Prisma.Decimal;
  laborValue: Prisma.Decimal;
  nomenclatureValue: Prisma.Decimal;
  totalValue: Prisma.Decimal;
} {
  if (
    !isMonetaryPoolInitialized(pool.costVersion) ||
    pool.materialValue == null ||
    pool.laborValue == null ||
    pool.nomenclatureValue == null ||
    pool.totalValue == null
  ) {
    throw new Error(COST_FLOW_PRODUCT_POOL_UNINITIALIZED);
  }
}

async function lockRow(tx: Prisma.TransactionClient, table: string, id: string): Promise<void> {
  if (table === "BlankStock") {
    await tx.$queryRaw`SELECT id FROM "BlankStock" WHERE id = ${id} FOR UPDATE`;
    return;
  }
  if (table === "DetailStock") {
    await tx.$queryRaw`SELECT id FROM "DetailStock" WHERE id = ${id} FOR UPDATE`;
    return;
  }
  if (table === "NomenclatureStock") {
    await tx.$queryRaw`SELECT id FROM "NomenclatureStock" WHERE id = ${id} FOR UPDATE`;
    return;
  }
  await tx.$queryRaw`SELECT id FROM "ProductStock" WHERE id = ${id} FOR UPDATE`;
}

export async function ensureAndLockActiveBlankPoolsForSpecs(
  tx: Prisma.TransactionClient,
  specs: Iterable<BlankSpec>,
): Promise<Map<string, string>> {
  return ensureAndLockActiveBlankPools(tx, specs);
}

export async function lockExistingActiveBlanks(
  tx: Prisma.TransactionClient,
  specs: Iterable<BlankSpec>,
): Promise<Map<string, string>> {
  return lockExistingActiveBlankPools(tx, specs);
}

export async function ensureAndLockActiveDetailPools(
  tx: Prisma.TransactionClient,
  specs: Iterable<DetailStockSpec>,
): Promise<Map<string, string>> {
  const unique = uniqueSortedDetailStockSpecs(specs);
  const byKey = new Map<string, string>();
  if (unique.length === 0) return byKey;
  await tx.detailStock.createMany({
    data: unique.map((spec) => ({
      detailId: spec.detailId,
      torcevayaDone: spec.torcevayaDone,
      ploskostDone: spec.ploskostDone,
      quantity: 0,
      materialValue: moneyZero(),
      laborValue: moneyZero(),
      totalValue: moneyZero(),
      costVersion: 1,
    })),
    skipDuplicates: true,
  });
  for (const spec of unique) {
    const found = await tx.detailStock.findUniqueOrThrow({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: spec.detailId,
          torcevayaDone: spec.torcevayaDone,
          ploskostDone: spec.ploskostDone,
        },
      },
    });
    await lockRow(tx, "DetailStock", found.id);
    const locked = await tx.detailStock.findUniqueOrThrow({ where: { id: found.id } });
    assertTwoComponentInitialized(locked, COST_FLOW_DETAIL_POOL_UNINITIALIZED);
    byKey.set(detailStockSortKey(spec), locked.id);
  }
  return byKey;
}

export async function lockExistingActiveDetailPools(
  tx: Prisma.TransactionClient,
  specs: Iterable<DetailStockSpec>,
): Promise<Map<string, string>> {
  const unique = uniqueSortedDetailStockSpecs(specs);
  const byKey = new Map<string, string>();
  for (const spec of unique) {
    const found = await tx.detailStock.findUnique({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: spec.detailId,
          torcevayaDone: spec.torcevayaDone,
          ploskostDone: spec.ploskostDone,
        },
      },
    });
    if (!found) throw new Error(COST_FLOW_VERSION_MISMATCH);
    await lockRow(tx, "DetailStock", found.id);
    const locked = await tx.detailStock.findUniqueOrThrow({ where: { id: found.id } });
    assertTwoComponentInitialized(locked, COST_FLOW_DETAIL_POOL_UNINITIALIZED);
    byKey.set(detailStockSortKey(spec), locked.id);
  }
  return byKey;
}

export async function ensureAndLockActiveNomPools(
  tx: Prisma.TransactionClient,
  nomenclatureIds: Iterable<string>,
): Promise<Map<string, string>> {
  const unique = uniqueSortedIds(nomenclatureIds);
  const byId = new Map<string, string>();
  if (unique.length === 0) return byId;
  await tx.nomenclatureStock.createMany({
    data: unique.map((nomenclatureId) => ({
      nomenclatureId,
      quantity: 0,
      nomenclatureValue: moneyZero(),
      totalValue: moneyZero(),
      costVersion: 1,
    })),
    skipDuplicates: true,
  });
  for (const nomenclatureId of unique) {
    const found = await tx.nomenclatureStock.findUniqueOrThrow({
      where: { nomenclatureId },
    });
    await lockRow(tx, "NomenclatureStock", found.id);
    const locked = await tx.nomenclatureStock.findUniqueOrThrow({ where: { id: found.id } });
    assertNomInitialized(locked);
    byId.set(nomenclatureId, locked.id);
  }
  return byId;
}

export async function lockExistingActiveNomPools(
  tx: Prisma.TransactionClient,
  nomenclatureIds: Iterable<string>,
): Promise<Map<string, string>> {
  const unique = uniqueSortedIds(nomenclatureIds);
  const byId = new Map<string, string>();
  for (const nomenclatureId of unique) {
    const found = await tx.nomenclatureStock.findUnique({ where: { nomenclatureId } });
    if (!found) throw new Error(COST_FLOW_VERSION_MISMATCH);
    await lockRow(tx, "NomenclatureStock", found.id);
    const locked = await tx.nomenclatureStock.findUniqueOrThrow({ where: { id: found.id } });
    assertNomInitialized(locked);
    byId.set(nomenclatureId, locked.id);
  }
  return byId;
}

export async function ensureAndLockActiveProductPools(
  tx: Prisma.TransactionClient,
  productIds: Iterable<string>,
): Promise<Map<string, string>> {
  const unique = uniqueSortedIds(productIds);
  const byId = new Map<string, string>();
  if (unique.length === 0) return byId;
  await tx.productStock.createMany({
    data: unique.map((productId) => ({
      productId,
      quantity: 0,
      materialValue: moneyZero(),
      laborValue: moneyZero(),
      nomenclatureValue: moneyZero(),
      totalValue: moneyZero(),
      costVersion: 1,
    })),
    skipDuplicates: true,
  });
  for (const productId of unique) {
    const found = await tx.productStock.findUniqueOrThrow({ where: { productId } });
    await lockRow(tx, "ProductStock", found.id);
    const locked = await tx.productStock.findUniqueOrThrow({ where: { id: found.id } });
    assertProductInitialized(locked);
    byId.set(productId, locked.id);
  }
  return byId;
}

export async function lockExistingActiveProductPools(
  tx: Prisma.TransactionClient,
  productIds: Iterable<string>,
): Promise<Map<string, string>> {
  const unique = uniqueSortedIds(productIds);
  const byId = new Map<string, string>();
  for (const productId of unique) {
    const found = await tx.productStock.findUnique({ where: { productId } });
    if (!found) throw new Error(COST_FLOW_VERSION_MISMATCH);
    await lockRow(tx, "ProductStock", found.id);
    const locked = await tx.productStock.findUniqueOrThrow({ where: { id: found.id } });
    assertProductInitialized(locked);
    byId.set(productId, locked.id);
  }
  return byId;
}

export type TwoComponentReceipt = { qty: number; material: Num; labor: Num };

/**
 * WAC-receive into a two-component pool, then write absolute qty/money and
 * increment costVersion.
 *
 * Caller contract: this transaction must already hold the logical pool lock
 * (ensure+lock or lock-existing) before the read and absolute write. The helper
 * does not acquire that lock. A concurrent receipt without the lock can make
 * the computed remaining state stale.
 */
export async function receiveTwoComponentPool(
  tx: Prisma.TransactionClient,
  kind: "blank" | "detail",
  poolId: string,
  receipt: TwoComponentReceipt,
): Promise<number> {
  const pool =
    kind === "blank"
      ? await tx.blankStock.findUniqueOrThrow({ where: { id: poolId } })
      : await tx.detailStock.findUniqueOrThrow({ where: { id: poolId } });
  assertTwoComponentInitialized(
    pool,
    kind === "blank" ? COST_FLOW_POOL_UNINITIALIZED : COST_FLOW_DETAIL_POOL_UNINITIALIZED,
  );
  const next = wacReceive(
    { qty: pool.quantity, material: pool.materialValue, labor: pool.laborValue, nomenclature: 0 },
    { qty: receipt.qty, material: receipt.material, labor: receipt.labor, nomenclature: 0 },
  );
  const nextVersion = pool.costVersion + 1;
  const data = {
    quantity: pool.quantity + receipt.qty,
    materialValue: money6(next.material),
    laborValue: money6(next.labor),
    totalValue: money6(next.totalValue),
    costVersion: nextVersion,
  };
  if (kind === "blank") {
    await tx.blankStock.update({ where: { id: poolId }, data });
  } else {
    await tx.detailStock.update({ where: { id: poolId }, data });
  }
  return nextVersion;
}

/**
 * WAC-consume from a two-component pool, then write absolute remaining qty/money
 * and increment costVersion.
 *
 * Caller contract: this transaction must already hold the logical pool lock
 * (ensure+lock or lock-existing) before the read and absolute write. The helper
 * does not acquire that lock. A concurrent receipt between read and update can
 * make the computed remaining state stale.
 */
export async function consumeTwoComponentPool(
  tx: Prisma.TransactionClient,
  kind: "blank" | "detail",
  poolId: string,
  dq: number,
): Promise<{ taken: WacState; nextVersion: number }> {
  const pool =
    kind === "blank"
      ? await tx.blankStock.findUniqueOrThrow({ where: { id: poolId } })
      : await tx.detailStock.findUniqueOrThrow({ where: { id: poolId } });
  assertTwoComponentInitialized(
    pool,
    kind === "blank" ? COST_FLOW_POOL_UNINITIALIZED : COST_FLOW_DETAIL_POOL_UNINITIALIZED,
  );
  const { taken, remaining } = wacConsume(
    { qty: pool.quantity, material: pool.materialValue, labor: pool.laborValue, nomenclature: 0 },
    dq,
  );
  const nextVersion = pool.costVersion + 1;
  const data = {
    quantity: pool.quantity - dq,
    materialValue: money6(remaining.material),
    laborValue: money6(remaining.labor),
    totalValue: money6(remaining.totalValue),
    costVersion: nextVersion,
  };
  if (kind === "blank") {
    const updated = await tx.blankStock.updateMany({
      where: { id: poolId, quantity: { gte: dq } },
      data,
    });
    if (updated.count === 0) throw new Error("Недостаточно заготовок");
  } else {
    const updated = await tx.detailStock.updateMany({
      where: { id: poolId, quantity: { gte: dq } },
      data,
    });
    if (updated.count === 0) throw new Error("Недостаточно остатка деталей");
  }
  return { taken, nextVersion };
}

export async function removeExactTwoComponentReceipt(
  tx: Prisma.TransactionClient,
  kind: "blank" | "detail",
  poolId: string,
  receipt: TwoComponentReceipt,
  expectedVersion: number,
): Promise<number> {
  const pool =
    kind === "blank"
      ? await tx.blankStock.findUniqueOrThrow({ where: { id: poolId } })
      : await tx.detailStock.findUniqueOrThrow({ where: { id: poolId } });
  assertTwoComponentInitialized(
    pool,
    kind === "blank" ? COST_FLOW_POOL_UNINITIALIZED : COST_FLOW_DETAIL_POOL_UNINITIALIZED,
  );
  if (pool.costVersion !== expectedVersion) throw new Error(COST_FLOW_VERSION_MISMATCH);
  if (pool.quantity < receipt.qty) throw new Error(COST_FLOW_VERSION_MISMATCH);
  const nextQty = pool.quantity - receipt.qty;
  const nextMaterial = D(pool.materialValue.toString()).minus(D(receipt.material.toString()));
  const nextLabor = D(pool.laborValue.toString()).minus(D(receipt.labor.toString()));
  if (nextQty < 0 || nextMaterial.isNeg() || nextLabor.isNeg()) {
    throw new Error(COST_FLOW_VERSION_MISMATCH);
  }
  if (nextQty === 0 && (!nextMaterial.isZero() || !nextLabor.isZero())) {
    throw new Error(COST_FLOW_VERSION_MISMATCH);
  }
  const nextVersion = pool.costVersion + 1;
  const data = {
    quantity: nextQty,
    materialValue: money6(nextMaterial),
    laborValue: money6(nextLabor),
    totalValue: money6(nextMaterial.plus(nextLabor)),
    costVersion: nextVersion,
  };
  if (kind === "blank") await tx.blankStock.update({ where: { id: poolId }, data });
  else await tx.detailStock.update({ where: { id: poolId }, data });
  return nextVersion;
}

export async function receiveNomPool(
  tx: Prisma.TransactionClient,
  poolId: string,
  qty: number,
  amount: Num,
): Promise<number> {
  const pool = await tx.nomenclatureStock.findUniqueOrThrow({ where: { id: poolId } });
  assertNomInitialized(pool);
  const next = wacReceive(
    { qty: pool.quantity, material: 0, labor: 0, nomenclature: pool.nomenclatureValue },
    { qty, material: 0, labor: 0, nomenclature: amount },
  );
  const nextVersion = pool.costVersion + 1;
  await tx.nomenclatureStock.update({
    where: { id: poolId },
    data: {
      quantity: pool.quantity + qty,
      nomenclatureValue: money6(next.nomenclature),
      totalValue: money6(next.totalValue),
      costVersion: nextVersion,
    },
  });
  return nextVersion;
}

export async function consumeNomPool(
  tx: Prisma.TransactionClient,
  poolId: string,
  dq: number,
): Promise<{ taken: WacState; nextVersion: number }> {
  const pool = await tx.nomenclatureStock.findUniqueOrThrow({ where: { id: poolId } });
  assertNomInitialized(pool);
  const { taken, remaining } = wacConsume(
    { qty: pool.quantity, material: 0, labor: 0, nomenclature: pool.nomenclatureValue },
    dq,
  );
  const nextVersion = pool.costVersion + 1;
  const updated = await tx.nomenclatureStock.updateMany({
    where: { id: poolId, quantity: { gte: dq } },
    data: {
      quantity: pool.quantity - dq,
      nomenclatureValue: money6(remaining.nomenclature),
      totalValue: money6(remaining.totalValue),
      costVersion: nextVersion,
    },
  });
  if (updated.count === 0) throw new Error("Недостаточно номенклатуры на складе");
  return { taken, nextVersion };
}

export async function receiveProductPool(
  tx: Prisma.TransactionClient,
  poolId: string,
  receipt: { qty: number; material: Num; labor: Num; nomenclature: Num },
): Promise<number> {
  const pool = await tx.productStock.findUniqueOrThrow({ where: { id: poolId } });
  assertProductInitialized(pool);
  const next = wacReceive(
    {
      qty: pool.quantity,
      material: pool.materialValue,
      labor: pool.laborValue,
      nomenclature: pool.nomenclatureValue,
    },
    receipt,
  );
  const nextVersion = pool.costVersion + 1;
  await tx.productStock.update({
    where: { id: poolId },
    data: {
      quantity: pool.quantity + receipt.qty,
      materialValue: money6(next.material),
      laborValue: money6(next.labor),
      nomenclatureValue: money6(next.nomenclature),
      totalValue: money6(next.totalValue),
      costVersion: nextVersion,
    },
  });
  return nextVersion;
}

export async function consumeProductPool(
  tx: Prisma.TransactionClient,
  poolId: string,
  dq: number,
): Promise<{ taken: WacState; nextVersion: number }> {
  const pool = await tx.productStock.findUniqueOrThrow({ where: { id: poolId } });
  assertProductInitialized(pool);
  const { taken, remaining } = wacConsume(
    {
      qty: pool.quantity,
      material: pool.materialValue,
      labor: pool.laborValue,
      nomenclature: pool.nomenclatureValue,
    },
    dq,
  );
  const nextVersion = pool.costVersion + 1;
  const updated = await tx.productStock.updateMany({
    where: { id: poolId, quantity: { gte: dq } },
    data: {
      quantity: pool.quantity - dq,
      materialValue: money6(remaining.material),
      laborValue: money6(remaining.labor),
      nomenclatureValue: money6(remaining.nomenclature),
      totalValue: money6(remaining.totalValue),
      costVersion: nextVersion,
    },
  });
  if (updated.count === 0) throw new Error("Недостаточно изделий на складе");
  return { taken, nextVersion };
}

export async function removeExactProductReceipt(
  tx: Prisma.TransactionClient,
  poolId: string,
  receipt: { qty: number; material: Num; labor: Num; nomenclature: Num },
  expectedVersion: number,
): Promise<number> {
  const pool = await tx.productStock.findUniqueOrThrow({ where: { id: poolId } });
  assertProductInitialized(pool);
  if (pool.costVersion !== expectedVersion) throw new Error(COST_FLOW_VERSION_MISMATCH);
  if (pool.quantity < receipt.qty) throw new Error(COST_FLOW_VERSION_MISMATCH);
  const nextQty = pool.quantity - receipt.qty;
  const nextMaterial = D(pool.materialValue.toString()).minus(D(receipt.material.toString()));
  const nextLabor = D(pool.laborValue.toString()).minus(D(receipt.labor.toString()));
  const nextNom = D(pool.nomenclatureValue.toString()).minus(D(receipt.nomenclature.toString()));
  if (nextQty < 0 || nextMaterial.isNeg() || nextLabor.isNeg() || nextNom.isNeg()) {
    throw new Error(COST_FLOW_VERSION_MISMATCH);
  }
  if (nextQty === 0 && (!nextMaterial.isZero() || !nextLabor.isZero() || !nextNom.isZero())) {
    throw new Error(COST_FLOW_VERSION_MISMATCH);
  }
  const nextVersion = pool.costVersion + 1;
  await tx.productStock.update({
    where: { id: poolId },
    data: {
      quantity: nextQty,
      materialValue: money6(nextMaterial),
      laborValue: money6(nextLabor),
      nomenclatureValue: money6(nextNom),
      totalValue: money6(nextMaterial.plus(nextLabor).plus(nextNom)),
      costVersion: nextVersion,
    },
  });
  return nextVersion;
}

export async function removeExactNomReceipt(
  tx: Prisma.TransactionClient,
  poolId: string,
  qty: number,
  amount: Num,
): Promise<number> {
  const pool = await tx.nomenclatureStock.findUniqueOrThrow({ where: { id: poolId } });
  assertNomInitialized(pool);
  const nextQty = pool.quantity - qty;
  const nextNom = D(pool.nomenclatureValue.toString()).minus(D(amount.toString()));
  if (nextQty < 0 || nextNom.isNeg()) throw new Error(COST_FLOW_VERSION_MISMATCH);
  if (nextQty === 0 && !nextNom.isZero()) throw new Error(COST_FLOW_VERSION_MISMATCH);
  const nextVersion = pool.costVersion + 1;
  await tx.nomenclatureStock.update({
    where: { id: poolId },
    data: {
      quantity: nextQty,
      nomenclatureValue: money6(nextNom),
      totalValue: money6(nextNom),
      costVersion: nextVersion,
    },
  });
  return nextVersion;
}
