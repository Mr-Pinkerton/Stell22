/**
 * Cost-flow foundation — PURE MATH ONLY.
 *
 * Decimal only. No Prisma. No JS `number` as money SoT.
 * Writers call these only when `production_cost_flow` is active.
 */
import { Decimal } from "decimal.js";
import { D, type Num } from "@/lib/cost";

export const COST_FLOW_UNINITIALIZED_VERSION = 0;

/** Persistence scale of Decimal(18,6) money fields. Quantize only at output boundary. */
export const COST_VALUE_SCALE = 6;

export function q6(value: Num): Decimal {
  return D(value).toDecimalPlaces(COST_VALUE_SCALE, Decimal.ROUND_HALF_UP);
}

export class CostFoundationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "CostFoundationError";
  }
}

export type CostComponents = {
  material: Decimal;
  labor: Decimal;
  nomenclature: Decimal;
};

export type WacState = CostComponents & {
  qty: Decimal;
  totalValue: Decimal;
};

export type WacInput = {
  qty: Num;
  material: Num;
  labor: Num;
  nomenclature: Num;
};

function fail(code: string, message: string): never {
  throw new CostFoundationError(code, message);
}

export type PersistenceShareItem = {
  id: string;
  shareBase: Num;
};

/**
 * Persistence-safe split of `total` by positive shareBase.
 * Residual → largest positive shareBase (tie-break: largest stable id).
 * Zero-share items always receive 0. Signed totals are allowed (late ΔC).
 * Mapping does not depend on input array order.
 */
export function allocatePersistenceShares(args: {
  total: Num;
  items: PersistenceShareItem[];
}): { id: string; value: Decimal }[] {
  const C = D(args.total);
  if (args.items.length === 0) fail("ZERO_SHARE", "no items to allocate");

  const rows = args.items.map((item) => {
    const shareBase = D(item.shareBase);
    if (shareBase.isNeg()) fail("NEGATIVE", `shareBase for ${item.id} must be >= 0`);
    return { id: item.id, shareBase, persistedValue: D(0) };
  });

  const shareDenom = rows.reduce((acc, row) => acc.plus(row.shareBase), D(0));
  if (shareDenom.isZero()) {
    if (!C.isZero()) fail("ZERO_SHARE", "no positive-share item to receive allocation");
    return rows
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((row) => ({ id: row.id, value: D(0) }));
  }

  for (const row of rows) {
    const share = row.shareBase.div(shareDenom);
    row.persistedValue = q6(C.times(share));
  }

  const persistedSum = rows.reduce((acc, row) => acc.plus(row.persistedValue), D(0));
  const residual = C.minus(persistedSum);

  let receiver = rows.find((row) => row.shareBase.gt(0));
  if (!receiver) fail("ZERO_SHARE", "no positive-share item to receive persistence residual");
  for (const row of rows) {
    if (!row.shareBase.gt(0)) continue;
    if (
      row.shareBase.gt(receiver.shareBase) ||
      (row.shareBase.equals(receiver.shareBase) && row.id > receiver.id)
    ) {
      receiver = row;
    }
  }

  receiver.persistedValue = receiver.persistedValue.plus(residual);

  const total = rows.reduce((acc, row) => acc.plus(row.persistedValue), D(0));
  if (!total.equals(C)) {
    fail("CONSERVATION", "Σ allocated values must equal total at persistence scale");
  }

  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows.map((row) => ({ id: row.id, value: row.persistedValue }));
}

/**
 * Consume N rails from an identified RailLot remainingValue.
 * Last-rail take is the exact stored residual. Non-last: q6(share), remainder
 * is stored remaining minus consumed (not independently rounded).
 */
export function consumeRailValue(args: {
  remainingQuantity: number;
  remainingValue: Num;
  railsTaken: number;
}): { consumedRawValue: Decimal; newRemainingValue: Decimal; newRemainingQuantity: number } {
  const remainingQuantity = args.remainingQuantity;
  const railsTaken = args.railsTaken;
  const remainingValue = D(args.remainingValue);
  if (!Number.isInteger(remainingQuantity) || remainingQuantity <= 0) {
    fail("INVALID_CONSUME", "remainingQuantity must be an integer > 0");
  }
  if (!Number.isInteger(railsTaken) || railsTaken <= 0) {
    fail("INVALID_CONSUME", "railsTaken must be an integer > 0");
  }
  if (railsTaken > remainingQuantity) fail("OVERDRAW", "railsTaken exceeds remainingQuantity");
  if (remainingValue.isNeg()) fail("NEGATIVE", "remainingValue must be >= 0");

  if (railsTaken === remainingQuantity) {
    return {
      consumedRawValue: remainingValue,
      newRemainingValue: D(0),
      newRemainingQuantity: 0,
    };
  }

  const consumedRawValue = q6(remainingValue.times(railsTaken).div(remainingQuantity));
  const newRemainingValue = remainingValue.minus(consumedRawValue);
  if (newRemainingValue.isNeg()) fail("NEGATIVE", "newRemainingValue must be >= 0");
  if (!consumedRawValue.plus(newRemainingValue).equals(remainingValue)) {
    fail("CONSERVATION", "consumed + remaining must equal previous remainingValue");
  }
  return {
    consumedRawValue,
    newRemainingValue,
    newRemainingQuantity: remainingQuantity - railsTaken,
  };
}

export function isMonetaryPoolInitialized(costVersion: number): boolean {
  return costVersion > COST_FLOW_UNINITIALIZED_VERSION;
}

/** Exact reverse is representable only when a post-cutover output version exists (> 0). */
export function canExactMonetaryReverse(args: { outputCostVersion: number | null }): boolean {
  return args.outputCostVersion != null && args.outputCostVersion > COST_FLOW_UNINITIALIZED_VERSION;
}

export function componentTotal(c: CostComponents | WacInput): Decimal {
  return D(c.material).plus(D(c.labor)).plus(D(c.nomenclature));
}

export function eventComponentsValid(args: CostComponents & { totalValue: Num }): boolean {
  return D(args.totalValue).equals(componentTotal(args));
}

function assertNonNegativeState(input: WacInput, label: string): void {
  const qty = D(input.qty);
  const material = D(input.material);
  const labor = D(input.labor);
  const nomenclature = D(input.nomenclature);
  if (qty.isNeg() || material.isNeg() || labor.isNeg() || nomenclature.isNeg()) {
    fail("NEGATIVE", `${label} has negative qty or component value`);
  }
  if (qty.isZero() && (!material.isZero() || !labor.isZero() || !nomenclature.isZero())) {
    fail("STOCK_002", `${label}: qty=0 requires all components=0`);
  }
}

function toState(input: WacInput): WacState {
  const qty = D(input.qty);
  const material = D(input.material);
  const labor = D(input.labor);
  const nomenclature = D(input.nomenclature);
  return {
    qty,
    material,
    labor,
    nomenclature,
    totalValue: material.plus(labor).plus(nomenclature),
  };
}

export function wacReceive(pool: WacInput, receipt: WacInput): WacState {
  assertNonNegativeState(pool, "pool");
  assertNonNegativeState(receipt, "receipt");
  const receiptQty = D(receipt.qty);
  if (receiptQty.lte(0)) {
    fail("INVALID_RECEIVE", "receipt qty must be > 0");
  }
  const current = toState(pool);
  const add = toState(receipt);
  const material = q6(current.material.plus(add.material));
  const labor = q6(current.labor.plus(add.labor));
  const nomenclature = q6(current.nomenclature.plus(add.nomenclature));
  return {
    qty: current.qty.plus(add.qty),
    material,
    labor,
    nomenclature,
    totalValue: material.plus(labor).plus(nomenclature),
  };
}

export function wacConsume(
  pool: WacInput,
  dq: Num,
): { taken: WacState; remaining: WacState } {
  assertNonNegativeState(pool, "pool");
  const current = toState(pool);
  const takeQty = D(dq);
  if (takeQty.lte(0)) {
    fail("INVALID_CONSUME", "dq must be > 0");
  }
  if (takeQty.gt(current.qty)) {
    fail("OVERDRAW", "dq exceeds pool qty");
  }

  if (takeQty.equals(current.qty)) {
    const empty: WacState = {
      qty: D(0),
      material: D(0),
      labor: D(0),
      nomenclature: D(0),
      totalValue: D(0),
    };
    return { taken: current, remaining: empty };
  }

  const fraction = takeQty.div(current.qty);
  const materialOut = q6(current.material.times(fraction));
  const laborOut = q6(current.labor.times(fraction));
  const nomenclatureOut = q6(current.nomenclature.times(fraction));
  const taken: WacState = {
    qty: takeQty,
    material: materialOut,
    labor: laborOut,
    nomenclature: nomenclatureOut,
    totalValue: materialOut.plus(laborOut).plus(nomenclatureOut),
  };
  const remainingMaterial = current.material.minus(materialOut);
  const remainingLabor = current.labor.minus(laborOut);
  const remainingNom = current.nomenclature.minus(nomenclatureOut);
  const remaining: WacState = {
    qty: current.qty.minus(takeQty),
    material: remainingMaterial,
    labor: remainingLabor,
    nomenclature: remainingNom,
    totalValue: remainingMaterial.plus(remainingLabor).plus(remainingNom),
  };
  return { taken, remaining };
}

export type RailLotAllocInput = {
  id: string;
  lengthM: Num;
  quantity: Num;
  sort: "SORT1" | "SORT2";
};

export type RailLotAllocRow = {
  id: string;
  volume: Decimal;
  weight: Decimal;
  initialValue: Decimal;
};

/**
 * Allocate Batch.totalCost onto purchased lots by P·V (volume fallback if ΣW=0).
 * Persistence residual is assigned to the deterministic largest-positive
 * economic-weight lot (shareBase = weight when ΣW>0, else volume; tie-break by
 * largest stable lot id). Zero-share lots never receive residual.
 * Mapping is independent of input array order.
 */
export function allocateRailLotValues(args: {
  totalCost: Num;
  priceSort1: Num;
  priceSort2: Num;
  sectionAreaM2: Num;
  lots: RailLotAllocInput[];
}): RailLotAllocRow[] {
  const C = D(args.totalCost);
  if (C.isNeg()) fail("NEGATIVE", "Batch.totalCost must be >= 0");
  if (D(args.priceSort1).isNeg() || D(args.priceSort2).isNeg()) {
    fail("NEGATIVE", "supplier prices must be >= 0");
  }
  if (D(args.sectionAreaM2).isNeg()) fail("NEGATIVE", "section area must be >= 0");
  if (args.lots.length === 0) {
    fail("ZERO_PURCHASED_VOLUME", "no lots to allocate");
  }

  const prepared = args.lots.map((lot) => {
    const qty = D(lot.quantity);
    const length = D(lot.lengthM);
    if (qty.isNeg() || length.isNeg()) fail("NEGATIVE", `lot ${lot.id} has negative length/qty`);
    const volume = length.times(qty).times(D(args.sectionAreaM2));
    const price = lot.sort === "SORT1" ? D(args.priceSort1) : D(args.priceSort2);
    const weight = price.times(volume);
    return { id: lot.id, volume, weight };
  });

  const sumVolume = prepared.reduce((acc, row) => acc.plus(row.volume), D(0));
  if (sumVolume.lte(0)) {
    fail("ZERO_PURCHASED_VOLUME", "total purchased volume is 0");
  }

  const sumWeight = prepared.reduce((acc, row) => acc.plus(row.weight), D(0));
  const useWeight = sumWeight.gt(0);

  const allocated = allocatePersistenceShares({
    total: C,
    items: prepared.map((row) => ({
      id: row.id,
      shareBase: useWeight ? row.weight : row.volume,
    })),
  });
  const byId = new Map(allocated.map((row) => [row.id, row.value]));
  const total = allocated.reduce((acc, row) => acc.plus(row.value), D(0));
  if (!total.equals(C)) {
    fail("CONSERVATION", "Σ initialValue must equal C at persistence scale");
  }
  if (allocated.some((row) => row.value.isNeg())) {
    fail("NEGATIVE", "residual receiver initialValue must be >= 0");
  }

  return prepared
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((row) => ({
      id: row.id,
      volume: row.volume,
      weight: row.weight,
      initialValue: byId.get(row.id)!,
    }));
}

export function remainingLotValue(args: {
  initialValue: Num;
  remainingQty: Num;
  originalQty: Num;
}): Decimal {
  const initial = D(args.initialValue);
  const remainingQty = D(args.remainingQty);
  const originalQty = D(args.originalQty);
  if (initial.isNeg() || remainingQty.isNeg() || originalQty.lte(0)) {
    fail("NEGATIVE", "remaining lot value inputs invalid");
  }
  if (remainingQty.gt(originalQty)) fail("OVERDRAW", "remainingQty > originalQty");
  if (remainingQty.equals(originalQty)) return q6(initial);
  if (remainingQty.equals(0)) return D(0);
  return q6(initial.times(remainingQty).div(originalQty));
}

export function bootstrapRawTransfer(args: {
  totalCost: Num;
  remainingRawValue: Num;
  knownOpeningRawLosses: Num;
}): Decimal {
  const C = D(args.totalCost);
  const remaining = D(args.remainingRawValue);
  const losses = D(args.knownOpeningRawLosses);
  if (C.isNeg() || remaining.isNeg() || losses.isNeg()) {
    fail("NEGATIVE", "bootstrap raw transfer inputs must be >= 0");
  }
  if (remaining.plus(losses).gt(C)) {
    fail("BOOTSTRAP_OVER_C", "remaining raw + known losses exceed C; refuse negative BOOTSTRAP_RAW_TRANSFER");
  }
  return q6(C.minus(remaining).minus(losses));
}
