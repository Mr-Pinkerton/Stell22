import { Prisma, type TorcovkaAckBand, type TorcovkaWasteReason } from "@prisma/client";
import { D, sectionAreaM2 } from "@/lib/cost";
import {
  COST_FLOW_UNINITIALIZED_VERSION,
  CostFoundationError,
  allocatePersistenceShares,
  allocateRailLotValues,
  consumeRailValue,
  q6,
  wacReceive,
} from "@/lib/cost-foundation";
import {
  assignCanonicalTorcovkaLineIds,
  torcovkaLinePieceEarning,
  torcovkaPieceLaborCost,
} from "@/lib/torcovka-cost";
import type { OperationRateSnapshotWrite } from "@/lib/payroll";
import {
  blankSpecSortKey,
  uniqueSortedBlankSpecs,
  type BlankSpec,
} from "@/server/internal/inventory-integrity";
import type { Sort } from "@/types/domain";

export const COST_FLOW_LOT_UNINITIALIZED =
  "Денежный учёт включён, но у пакета реек нет стоимости. Операция заблокирована.";
export const COST_FLOW_POOL_UNINITIALIZED =
  "Денежный учёт включён, но складской пул заготовок не инициализирован. Операция заблокирована.";
export const COST_FLOW_PRE_CUTOVER_REVERSE =
  "Операция создана до включения денежного учёта. Исправление через корректировку остатков.";
export const COST_FLOW_VERSION_MISMATCH =
  "Результат операции уже использован или склад изменён. Исправление через корректировку остатков.";
export const COST_FLOW_DRIVER_AFTER_CONSUMPTION =
  "Нельзя менять цены сортов, сечение и материал: стоимость сырья уже ушла в производство.";
export const COST_FLOW_C_OLD_ZERO =
  "Нельзя переоценить партию с нулевой стоимостью при включённом денежном учёте.";
export const COST_FLOW_LOT_NULL_WRITEOFF =
  "Денежный учёт включён, но у остатка реек нет стоимости. Списание заблокировано.";
export const COST_FLOW_DELETE_BATCH = "Нельзя удалить партию при включённом денежном учёте.";

function money6(value: { toFixed: (digits: number) => string } | string | number): Prisma.Decimal {
  return new Prisma.Decimal(typeof value === "object" && "toFixed" in value ? value.toFixed(6) : q6(value).toFixed(6));
}

async function lockBlankRow(tx: Prisma.TransactionClient, id: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "BlankStock" WHERE id = ${id} FOR UPDATE`;
}

function lengthDec(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return new Prisma.Decimal(D(value.toString()).toFixed(4));
}

function moneyZero(): Prisma.Decimal {
  return new Prisma.Decimal("0");
}

export async function ensureAndLockActiveBlankPools(
  tx: Prisma.TransactionClient,
  specs: Iterable<BlankSpec>,
): Promise<Map<string, string>> {
  const unique = uniqueSortedBlankSpecs(specs);
  const byKey = new Map<string, string>();
  if (unique.length === 0) return byKey;
  await tx.blankStock.createMany({
    data: unique.map((spec) => ({
      materialId: spec.materialId,
      lengthM: lengthDec(spec.lengthM),
      detailType: spec.detailType,
      sort: spec.sort,
      quantity: 0,
      materialValue: moneyZero(),
      laborValue: moneyZero(),
      totalValue: moneyZero(),
      costVersion: 1,
    })),
    skipDuplicates: true,
  });
  for (const spec of unique) {
    const found = await tx.blankStock.findUniqueOrThrow({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId: spec.materialId,
          lengthM: lengthDec(spec.lengthM),
          detailType: spec.detailType,
          sort: spec.sort,
        },
      },
    });
    await lockBlankRow(tx, found.id);
    const locked = await tx.blankStock.findUniqueOrThrow({ where: { id: found.id } });
    assertPoolInitialized(locked);
    byKey.set(blankSpecSortKey(spec), locked.id);
  }
  return byKey;
}

async function lockExistingActiveBlankPools(
  tx: Prisma.TransactionClient,
  specs: Iterable<BlankSpec>,
): Promise<Map<string, string>> {
  const unique = uniqueSortedBlankSpecs(specs);
  const byKey = new Map<string, string>();
  for (const spec of unique) {
    const found = await tx.blankStock.findUnique({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId: spec.materialId,
          lengthM: lengthDec(spec.lengthM),
          detailType: spec.detailType,
          sort: spec.sort,
        },
      },
    });
    if (!found) throw new Error(COST_FLOW_VERSION_MISMATCH);
    await lockBlankRow(tx, found.id);
    const locked = await tx.blankStock.findUniqueOrThrow({ where: { id: found.id } });
    assertPoolInitialized(locked);
    byKey.set(blankSpecSortKey(spec), locked.id);
  }
  return byKey;
}

export function lotIsConsumed(lot: { quantity: number; remainingQuantity: number }): boolean {
  return lot.remainingQuantity < lot.quantity;
}

export function assertLotMonetaryInitialized(lot: {
  initialValue: Prisma.Decimal | null;
  remainingValue: Prisma.Decimal | null;
}): void {
  if (lot.initialValue == null || lot.remainingValue == null) {
    throw new Error(COST_FLOW_LOT_UNINITIALIZED);
  }
}

function assertPoolInitialized(pool: {
  costVersion: number;
  materialValue: Prisma.Decimal | null;
  laborValue: Prisma.Decimal | null;
  totalValue: Prisma.Decimal | null;
}): void {
  if (
    pool.costVersion <= COST_FLOW_UNINITIALIZED_VERSION ||
    pool.materialValue == null ||
    pool.laborValue == null ||
    pool.totalValue == null
  ) {
    throw new Error(COST_FLOW_POOL_UNINITIALIZED);
  }
}

type TorcovkaPick = { lengthM: number | string | Prisma.Decimal; sort: Sort; quantity: number };

function specOf(pick: TorcovkaPick, materialId: string, detailType: BlankSpec["detailType"]): BlankSpec {
  return {
    materialId,
    lengthM: pick.lengthM,
    detailType,
    sort: pick.sort,
  };
}

export async function applyActiveTorcovkaInTx(args: {
  tx: Prisma.TransactionClient;
  employeeId: string;
  clientRequestId: string;
  batchId: string;
  railLotId: string;
  railsTaken: number;
  picks: TorcovkaPick[];
  persist: {
    torcovkaSubmitAckBand: TorcovkaAckBand | null;
    torcovkaSubmitWasteReason: TorcovkaWasteReason | null;
    torcovkaSubmitWasteNote: string | null;
  };
  rateSnapshots: OperationRateSnapshotWrite;
  lot: {
    id: string;
    remainingQuantity: number;
    remainingValue: Prisma.Decimal | null;
    initialValue: Prisma.Decimal | null;
    railType: BlankSpec["detailType"];
  };
  materialId: string;
}): Promise<{ opId: string }> {
  const { tx, lot, picks, railsTaken, materialId } = args;
  assertLotMonetaryInitialized(lot);
  let consume;
  try {
    consume = consumeRailValue({
      remainingQuantity: lot.remainingQuantity,
      remainingValue: lot.remainingValue!,
      railsTaken,
    });
  } catch (err) {
    if (err instanceof CostFoundationError && err.code === "OVERDRAW") {
      throw new Error("Недостаточно реек в пакете");
    }
    throw err;
  }

  const snapshots = {
    rateTorcovkaSort1Snapshot: args.rateSnapshots.rateTorcovkaSort1Snapshot,
    rateTorcovkaSort2Snapshot: args.rateSnapshots.rateTorcovkaSort2Snapshot,
  };
  const pieceLaborCost = torcovkaPieceLaborCost(
    picks.map((p) => ({ quantity: p.quantity, sort: p.sort })),
    snapshots,
  );

  const allocPicks = picks.map((p) => ({
    materialId,
    lengthM: p.lengthM,
    detailType: lot.railType,
    sort: p.sort,
    quantity: p.quantity,
  }));
  const lineIds = assignCanonicalTorcovkaLineIds(allocPicks);
  const metres = picks.map((p) => D(p.lengthM).times(p.quantity));
  const materialAlloc = allocatePersistenceShares({
    total: consume.consumedRawValue,
    items: picks.map((p, i) => ({ id: lineIds[i]!, shareBase: metres[i]! })),
  });
  const laborExact = picks.map((p) => torcovkaLinePieceEarning({ quantity: p.quantity, sort: p.sort, snapshots }));
  const laborAlloc = allocatePersistenceShares({
    total: pieceLaborCost,
    items: picks.map((_, i) => ({ id: lineIds[i]!, shareBase: laborExact[i]! })),
  });
  const materialByLine = new Map(materialAlloc.map((r) => [r.id, r.value]));
  const laborByLine = new Map(laborAlloc.map((r) => [r.id, r.value]));

  const specs = uniqueSortedBlankSpecs(picks.map((p) => specOf(p, materialId, lot.railType)));
  const poolIds = await ensureAndLockActiveBlankPools(tx, specs);

  const dec = await tx.railLot.updateMany({
    where: { id: lot.id, remainingQuantity: { gte: railsTaken } },
    data: {
      remainingQuantity: consume.newRemainingQuantity,
      remainingValue: money6(consume.newRemainingValue),
    },
  });
  if (dec.count === 0) throw new Error("Недостаточно реек в пакете");

  const op = await tx.productionOperation.create({
    data: {
      type: "TORCOVKA",
      employeeId: args.employeeId,
      clientRequestId: args.clientRequestId,
      batchId: args.batchId,
      railLotId: args.railLotId,
      railsTaken,
      torcovkaSubmitAckBand: args.persist.torcovkaSubmitAckBand,
      torcovkaSubmitWasteReason: args.persist.torcovkaSubmitWasteReason,
      torcovkaSubmitWasteNote: args.persist.torcovkaSubmitWasteNote,
      workDate: new Date(),
      ...args.rateSnapshots,
      consumedRawValue: money6(consume.consumedRawValue),
      pieceLaborCost: money6(pieceLaborCost),
      lines: {
        create: picks.map((p, i) => ({
          quantity: p.quantity,
          blankLengthM: p.lengthM,
          blankType: lot.railType,
          blankSort: p.sort,
          blankMaterialId: materialId,
          receiptMaterialValue: money6(materialByLine.get(lineIds[i]!)!),
          receiptLaborValue: money6(laborByLine.get(lineIds[i]!)!),
          pieceLaborCost: money6(laborByLine.get(lineIds[i]!)!),
        })),
      },
    },
    include: { lines: { orderBy: { id: "asc" } } },
  });

  const createdLines = op.lines;
  if (createdLines.length !== picks.length) {
    throw new Error("Не удалось записать строки торцовки");
  }

  const receiptBySpec = new Map<string, { qty: number; material: ReturnType<typeof D>; labor: ReturnType<typeof D> }>();
  for (let i = 0; i < picks.length; i++) {
    const spec = specOf(picks[i]!, materialId, lot.railType);
    const key = blankSpecSortKey(spec);
    const cur = receiptBySpec.get(key) ?? { qty: 0, material: D(0), labor: D(0) };
    cur.qty += picks[i]!.quantity;
    cur.material = cur.material.plus(materialByLine.get(lineIds[i]!)!);
    cur.labor = cur.labor.plus(laborByLine.get(lineIds[i]!)!);
    receiptBySpec.set(key, cur);
  }

  const versionBySpec = new Map<string, number>();
  for (const spec of specs) {
    const key = blankSpecSortKey(spec);
    const receipt = receiptBySpec.get(key)!;
    const poolId = poolIds.get(key);
    if (!poolId) throw new Error(COST_FLOW_POOL_UNINITIALIZED);
    const pool = await tx.blankStock.findUniqueOrThrow({ where: { id: poolId } });
    assertPoolInitialized(pool);
    const next = wacReceive(
      {
        qty: pool.quantity,
        material: pool.materialValue!,
        labor: pool.laborValue!,
        nomenclature: 0,
      },
      {
        qty: receipt.qty,
        material: receipt.material,
        labor: receipt.labor,
        nomenclature: 0,
      },
    );
    const nextVersion = pool.costVersion + 1;
    await tx.blankStock.update({
      where: { id: pool.id },
      data: {
        quantity: pool.quantity + receipt.qty,
        materialValue: money6(next.material),
        laborValue: money6(next.labor),
        totalValue: money6(next.totalValue),
        costVersion: nextVersion,
      },
    });
    versionBySpec.set(key, nextVersion);
  }

  for (const line of createdLines) {
    const spec: BlankSpec = {
      materialId: line.blankMaterialId!,
      lengthM: line.blankLengthM!,
      detailType: line.blankType!,
      sort: line.blankSort!,
    };
    const version = versionBySpec.get(blankSpecSortKey(spec));
    if (version == null) throw new Error(COST_FLOW_POOL_UNINITIALIZED);
    await tx.operationDetailLine.update({
      where: { id: line.id },
      data: { outputCostVersion: version },
    });
  }

  return { opId: op.id };
}

export async function reverseActiveTorcovkaStockInTx(args: {
  tx: Prisma.TransactionClient;
  op: {
    id: string;
    batchId: string | null;
    railLotId: string | null;
    railsTaken: number | null;
    consumedRawValue: Prisma.Decimal | null;
    pieceLaborCost: Prisma.Decimal | null;
    lines: Array<{
      id: string;
      quantity: number;
      blankLengthM: Prisma.Decimal | null;
      blankType: BlankSpec["detailType"] | null;
      blankSort: Sort | null;
      blankMaterialId: string | null;
      receiptMaterialValue: Prisma.Decimal | null;
      receiptLaborValue: Prisma.Decimal | null;
      outputCostVersion: number | null;
    }>;
  };
}): Promise<void> {
  const { tx, op } = args;
  if (op.consumedRawValue == null || op.pieceLaborCost == null || op.railLotId == null || op.railsTaken == null) {
    throw new Error(COST_FLOW_PRE_CUTOVER_REVERSE);
  }
  for (const line of op.lines) {
    if (
      line.receiptMaterialValue == null ||
      line.receiptLaborValue == null ||
      line.outputCostVersion == null ||
      line.blankLengthM == null ||
      line.blankType == null ||
      line.blankSort == null ||
      line.blankMaterialId == null
    ) {
      throw new Error(COST_FLOW_PRE_CUTOVER_REVERSE);
    }
  }

  const specs = uniqueSortedBlankSpecs(
    op.lines.map((l) => ({
      materialId: l.blankMaterialId!,
      lengthM: l.blankLengthM!,
      detailType: l.blankType!,
      sort: l.blankSort!,
    })),
  );
  const poolIds = await lockExistingActiveBlankPools(tx, specs);

  const receiptBySpec = new Map<
    string,
    { qty: number; material: ReturnType<typeof D>; labor: ReturnType<typeof D>; version: number }
  >();
  for (const line of op.lines) {
    const spec: BlankSpec = {
      materialId: line.blankMaterialId!,
      lengthM: line.blankLengthM!,
      detailType: line.blankType!,
      sort: line.blankSort!,
    };
    const key = blankSpecSortKey(spec);
    const cur = receiptBySpec.get(key) ?? {
      qty: 0,
      material: D(0),
      labor: D(0),
      version: line.outputCostVersion!,
    };
    if (cur.version !== line.outputCostVersion) {
      throw new Error(COST_FLOW_VERSION_MISMATCH);
    }
    cur.qty += line.quantity;
    cur.material = cur.material.plus(D(line.receiptMaterialValue!.toString()));
    cur.labor = cur.labor.plus(D(line.receiptLaborValue!.toString()));
    receiptBySpec.set(key, cur);
  }

  for (const spec of specs) {
    const key = blankSpecSortKey(spec);
    const receipt = receiptBySpec.get(key)!;
    const poolId = poolIds.get(key);
    if (!poolId) throw new Error(COST_FLOW_VERSION_MISMATCH);
    const locked = await tx.blankStock.findUniqueOrThrow({ where: { id: poolId } });
    if (locked.costVersion !== receipt.version) throw new Error(COST_FLOW_VERSION_MISMATCH);
    assertPoolInitialized(locked);
    const nextQty = locked.quantity - receipt.qty;
    if (nextQty < 0) throw new Error(COST_FLOW_VERSION_MISMATCH);
    const nextMaterial = D(locked.materialValue!.toString()).minus(receipt.material);
    const nextLabor = D(locked.laborValue!.toString()).minus(receipt.labor);
    if (nextMaterial.isNeg() || nextLabor.isNeg()) throw new Error(COST_FLOW_VERSION_MISMATCH);
    const nextTotal = nextQty === 0 ? D(0) : nextMaterial.plus(nextLabor);
    await tx.blankStock.update({
      where: { id: locked.id },
      data: {
        quantity: nextQty,
        materialValue: money6(nextQty === 0 ? D(0) : nextMaterial),
        laborValue: money6(nextQty === 0 ? D(0) : nextLabor),
        totalValue: money6(nextTotal),
        costVersion: locked.costVersion + 1,
      },
    });
  }

  const rawLoss = D(op.consumedRawValue.toString());
  await tx.costEvent.create({
    data: {
      type: "TORCOVKA_ZERO_OUTPUT",
      batchId: op.batchId,
      materialValue: money6(rawLoss),
      laborValue: moneyZero(),
      nomenclatureValue: moneyZero(),
      totalValue: money6(rawLoss),
      note: `TORCOVKA deleted operation ${op.id}; raw material physically consumed`,
    },
  });
}

type ActiveTorcovkaLine = {
  id: string;
  quantity: number;
  blankLengthM: Prisma.Decimal | null;
  blankType: BlankSpec["detailType"] | null;
  blankSort: Sort | null;
  blankMaterialId: string | null;
  receiptMaterialValue: Prisma.Decimal | null;
  receiptLaborValue: Prisma.Decimal | null;
  pieceLaborCost: Prisma.Decimal | null;
  outputCostVersion: number | null;
};

function assertPostCutoverLines(lines: ActiveTorcovkaLine[]): void {
  for (const line of lines) {
    if (
      line.receiptMaterialValue == null ||
      line.receiptLaborValue == null ||
      line.pieceLaborCost == null ||
      line.outputCostVersion == null ||
      line.blankLengthM == null ||
      line.blankType == null ||
      line.blankSort == null ||
      line.blankMaterialId == null
    ) {
      throw new Error(COST_FLOW_PRE_CUTOVER_REVERSE);
    }
  }
}

function lineSpec(line: ActiveTorcovkaLine): BlankSpec {
  return {
    materialId: line.blankMaterialId!,
    lengthM: line.blankLengthM!,
    detailType: line.blankType!,
    sort: line.blankSort!,
  };
}

function allocPicksFromLines(lines: ActiveTorcovkaLine[]) {
  return lines.map((l) => ({
    materialId: l.blankMaterialId!,
    lengthM: l.blankLengthM!,
    detailType: l.blankType!,
    sort: l.blankSort!,
    quantity: l.quantity,
  }));
}

function poolStateOrEmpty(pool: {
  quantity: number;
  materialValue: Prisma.Decimal | null;
  laborValue: Prisma.Decimal | null;
}): { qty: number; material: ReturnType<typeof D>; labor: ReturnType<typeof D> } {
  return {
    qty: pool.quantity,
    material: D(pool.materialValue!.toString()),
    labor: D(pool.laborValue!.toString()),
  };
}

function applyExactPoolReplacement(
  current: { qty: number; material: ReturnType<typeof D>; labor: ReturnType<typeof D> },
  oldReceipt: { qty: number; material: ReturnType<typeof D>; labor: ReturnType<typeof D> },
  newReceipt: { qty: number; material: ReturnType<typeof D>; labor: ReturnType<typeof D> },
): { qty: number; material: ReturnType<typeof D>; labor: ReturnType<typeof D> } {
  const qty = current.qty - oldReceipt.qty + newReceipt.qty;
  const material = current.material.minus(oldReceipt.material).plus(newReceipt.material);
  const labor = current.labor.minus(oldReceipt.labor).plus(newReceipt.labor);
  if (qty < 0 || material.isNeg() || labor.isNeg()) {
    throw new Error(COST_FLOW_VERSION_MISMATCH);
  }
  if (qty === 0) {
    return { qty: 0, material: D(0), labor: D(0) };
  }
  return { qty, material, labor };
}

export async function correctActiveTorcovkaRailsTakenInTx(args: {
  tx: Prisma.TransactionClient;
  op: {
    id: string;
    railsTaken: number;
    consumedRawValue: Prisma.Decimal | null;
    pieceLaborCost: Prisma.Decimal | null;
    lines: ActiveTorcovkaLine[];
  };
  lot: {
    id: string;
    remainingQuantity: number;
    remainingValue: Prisma.Decimal | null;
    initialValue: Prisma.Decimal | null;
  };
  newRailsTaken: number;
}): Promise<void> {
  const { tx, op, lot, newRailsTaken } = args;
  if (op.consumedRawValue == null || op.pieceLaborCost == null) {
    throw new Error(COST_FLOW_PRE_CUTOVER_REVERSE);
  }
  assertPostCutoverLines(op.lines);
  assertLotMonetaryInitialized(lot);
  const Rold = op.railsTaken;
  const Dreturned = Rold - newRailsTaken;
  const Cold = D(op.consumedRawValue.toString());
  let split;
  try {
    split = consumeRailValue({
      remainingQuantity: Rold,
      remainingValue: Cold,
      railsTaken: newRailsTaken,
    });
  } catch (err) {
    if (err instanceof CostFoundationError && err.code === "OVERDRAW") {
      throw new Error("Недостаточно реек в пакете");
    }
    throw err;
  }
  const newConsumed = split.consumedRawValue;
  const returnedRaw = split.newRemainingValue;

  const specs = uniqueSortedBlankSpecs(op.lines.map(lineSpec));
  const poolIds = await lockExistingActiveBlankPools(tx, specs);

  for (const line of op.lines) {
    const key = blankSpecSortKey(lineSpec(line));
    const poolId = poolIds.get(key);
    if (!poolId) throw new Error(COST_FLOW_VERSION_MISMATCH);
    const locked = await tx.blankStock.findUniqueOrThrow({ where: { id: poolId } });
    if (locked.costVersion !== line.outputCostVersion) throw new Error(COST_FLOW_VERSION_MISMATCH);
  }

  const ids = assignCanonicalTorcovkaLineIds(allocPicksFromLines(op.lines));
  const metres = op.lines.map((l) => D(l.blankLengthM!).times(l.quantity));
  const materialAlloc = allocatePersistenceShares({
    total: newConsumed,
    items: op.lines.map((_, i) => ({ id: ids[i]!, shareBase: metres[i]! })),
  });
  const newMatByIndex = op.lines.map((_, i) => materialAlloc.find((r) => r.id === ids[i]!)!.value);

  const oldBySpec = new Map<string, { qty: number; material: ReturnType<typeof D>; labor: ReturnType<typeof D> }>();
  const newBySpec = new Map<string, { qty: number; material: ReturnType<typeof D>; labor: ReturnType<typeof D> }>();
  for (let i = 0; i < op.lines.length; i++) {
    const line = op.lines[i]!;
    const key = blankSpecSortKey(lineSpec(line));
    const old = oldBySpec.get(key) ?? { qty: 0, material: D(0), labor: D(0) };
    old.qty += line.quantity;
    old.material = old.material.plus(D(line.receiptMaterialValue!.toString()));
    old.labor = old.labor.plus(D(line.receiptLaborValue!.toString()));
    oldBySpec.set(key, old);
    const neu = newBySpec.get(key) ?? { qty: 0, material: D(0), labor: D(0) };
    neu.qty += line.quantity;
    neu.material = neu.material.plus(newMatByIndex[i]!);
    neu.labor = neu.labor.plus(D(line.receiptLaborValue!.toString()));
    newBySpec.set(key, neu);
  }

  const versionBySpec = new Map<string, number>();
  for (const spec of specs) {
    const key = blankSpecSortKey(spec);
    const pool = await tx.blankStock.findUniqueOrThrow({ where: { id: poolIds.get(key)! } });
    const next = applyExactPoolReplacement(
      poolStateOrEmpty(pool),
      oldBySpec.get(key)!,
      {
        qty: newBySpec.get(key)!.qty,
        material: newBySpec.get(key)!.material,
        labor: oldBySpec.get(key)!.labor,
      },
    );
    const nextVersion = pool.costVersion + 1;
    await tx.blankStock.update({
      where: { id: pool.id },
      data: {
        quantity: next.qty,
        materialValue: money6(next.material),
        laborValue: money6(next.labor),
        totalValue: money6(next.material.plus(next.labor)),
        costVersion: nextVersion,
      },
    });
    versionBySpec.set(key, nextVersion);
  }

  await tx.railLot.update({
    where: { id: lot.id },
    data: {
      remainingQuantity: { increment: Dreturned },
      remainingValue: money6(D(lot.remainingValue!.toString()).plus(returnedRaw)),
    },
  });
  await tx.productionOperation.update({
    where: { id: op.id },
    data: {
      railsTaken: newRailsTaken,
      consumedRawValue: money6(newConsumed),
    },
  });
  for (let i = 0; i < op.lines.length; i++) {
    const line = op.lines[i]!;
    const key = blankSpecSortKey(lineSpec(line));
    await tx.operationDetailLine.update({
      where: { id: line.id },
      data: {
        receiptMaterialValue: money6(newMatByIndex[i]!),
        receiptLaborValue: line.receiptLaborValue,
        pieceLaborCost: line.pieceLaborCost,
        outputCostVersion: versionBySpec.get(key)!,
      },
    });
  }
}

export async function correctActiveTorcovkaLineQuantityInTx(args: {
  tx: Prisma.TransactionClient;
  op: {
    id: string;
    railsTaken: number | null;
    consumedRawValue: Prisma.Decimal | null;
    pieceLaborCost: Prisma.Decimal | null;
    rateTorcovkaSort1Snapshot: Prisma.Decimal | null;
    rateTorcovkaSort2Snapshot: Prisma.Decimal | null;
    lines: ActiveTorcovkaLine[];
  };
  lineId: string;
  newQty: number;
}): Promise<void> {
  const { tx, op, lineId, newQty } = args;
  if (op.consumedRawValue == null || op.pieceLaborCost == null) {
    throw new Error(COST_FLOW_PRE_CUTOVER_REVERSE);
  }
  assertPostCutoverLines(op.lines);
  const snapshots = {
    rateTorcovkaSort1Snapshot: op.rateTorcovkaSort1Snapshot,
    rateTorcovkaSort2Snapshot: op.rateTorcovkaSort2Snapshot,
  };
  const nextLines = op.lines.map((l) => (l.id === lineId ? { ...l, quantity: newQty } : l));
  const specs = uniqueSortedBlankSpecs(nextLines.map(lineSpec));
  const poolIds = await lockExistingActiveBlankPools(tx, specs);

  for (const line of op.lines) {
    const key = blankSpecSortKey(lineSpec(line));
    const poolId = poolIds.get(key);
    if (!poolId) throw new Error(COST_FLOW_VERSION_MISMATCH);
    const locked = await tx.blankStock.findUniqueOrThrow({ where: { id: poolId } });
    if (locked.costVersion !== line.outputCostVersion) throw new Error(COST_FLOW_VERSION_MISMATCH);
  }

  const ids = assignCanonicalTorcovkaLineIds(allocPicksFromLines(nextLines));
  const metres = nextLines.map((l) => D(l.blankLengthM!).times(l.quantity));
  const materialAlloc = allocatePersistenceShares({
    total: D(op.consumedRawValue.toString()),
    items: nextLines.map((_, i) => ({ id: ids[i]!, shareBase: metres[i]! })),
  });
  const newMat = nextLines.map((_, i) => materialAlloc.find((r) => r.id === ids[i]!)!.value);
  const laborExact = nextLines.map((l) =>
    torcovkaLinePieceEarning({
      quantity: l.quantity,
      sort: l.blankSort!,
      snapshots,
    }),
  );
  const newPieceLabor = torcovkaPieceLaborCost(
    nextLines.map((l) => ({ quantity: l.quantity, sort: l.blankSort! })),
    snapshots,
  );
  const laborAlloc = allocatePersistenceShares({
    total: newPieceLabor,
    items: nextLines.map((_, i) => ({ id: ids[i]!, shareBase: laborExact[i]! })),
  });
  const newLab = nextLines.map((_, i) => laborAlloc.find((r) => r.id === ids[i]!)!.value);

  const oldBySpec = new Map<string, { qty: number; material: ReturnType<typeof D>; labor: ReturnType<typeof D> }>();
  const newBySpec = new Map<string, { qty: number; material: ReturnType<typeof D>; labor: ReturnType<typeof D> }>();
  for (const line of op.lines) {
    const key = blankSpecSortKey(lineSpec(line));
    const old = oldBySpec.get(key) ?? { qty: 0, material: D(0), labor: D(0) };
    old.qty += line.quantity;
    old.material = old.material.plus(D(line.receiptMaterialValue!.toString()));
    old.labor = old.labor.plus(D(line.receiptLaborValue!.toString()));
    oldBySpec.set(key, old);
  }
  for (let i = 0; i < nextLines.length; i++) {
    const line = nextLines[i]!;
    const key = blankSpecSortKey(lineSpec(line));
    const neu = newBySpec.get(key) ?? { qty: 0, material: D(0), labor: D(0) };
    neu.qty += line.quantity;
    neu.material = neu.material.plus(newMat[i]!);
    neu.labor = neu.labor.plus(newLab[i]!);
    newBySpec.set(key, neu);
  }

  const versionBySpec = new Map<string, number>();
  for (const spec of specs) {
    const key = blankSpecSortKey(spec);
    const pool = await tx.blankStock.findUniqueOrThrow({ where: { id: poolIds.get(key)! } });
    const next = applyExactPoolReplacement(poolStateOrEmpty(pool), oldBySpec.get(key)!, newBySpec.get(key)!);
    const nextVersion = pool.costVersion + 1;
    await tx.blankStock.update({
      where: { id: pool.id },
      data: {
        quantity: next.qty,
        materialValue: money6(next.material),
        laborValue: money6(next.labor),
        totalValue: money6(next.material.plus(next.labor)),
        costVersion: nextVersion,
      },
    });
    versionBySpec.set(key, nextVersion);
  }

  await tx.productionOperation.update({
    where: { id: op.id },
    data: { pieceLaborCost: money6(newPieceLabor) },
  });
  for (let i = 0; i < nextLines.length; i++) {
    const line = nextLines[i]!;
    const key = blankSpecSortKey(lineSpec(line));
    await tx.operationDetailLine.update({
      where: { id: line.id },
      data: {
        quantity: line.quantity,
        receiptMaterialValue: money6(newMat[i]!),
        receiptLaborValue: money6(newLab[i]!),
        pieceLaborCost: money6(newLab[i]!),
        outputCostVersion: versionBySpec.get(key)!,
      },
    });
  }
}

export function sectionFromBatch(batch: {
  sectionWidthMm: Prisma.Decimal | number;
  sectionHeightMm: Prisma.Decimal | number;
}): ReturnType<typeof D> {
  const w = typeof batch.sectionWidthMm === "number" ? batch.sectionWidthMm : batch.sectionWidthMm.toString();
  const h = typeof batch.sectionHeightMm === "number" ? batch.sectionHeightMm : batch.sectionHeightMm.toString();
  return sectionAreaM2(w, h);
}

export async function initializeCreatedRailLotsInTx(
  tx: Prisma.TransactionClient,
  batch: {
    totalCost: Prisma.Decimal;
    priceSort1: Prisma.Decimal;
    priceSort2: Prisma.Decimal;
    sectionWidthMm: Prisma.Decimal;
    sectionHeightMm: Prisma.Decimal;
    railLots: Array<{
      id: string;
      lengthM: Prisma.Decimal;
      quantity: number;
      sort: Sort;
    }>;
  },
): Promise<void> {
  const alloc = allocateRailLotValues({
    totalCost: batch.totalCost,
    priceSort1: batch.priceSort1,
    priceSort2: batch.priceSort2,
    sectionAreaM2: sectionFromBatch(batch),
    lots: batch.railLots.map((lot) => ({
      id: lot.id,
      lengthM: lot.lengthM,
      quantity: lot.quantity,
      sort: lot.sort,
    })),
  });
  for (const row of alloc) {
    await tx.railLot.update({
      where: { id: row.id },
      data: {
        initialValue: money6(row.initialValue),
        remainingValue: money6(row.initialValue),
      },
    });
  }
}

export async function reallocateUnconsumedRailLotValuesInTx(
  tx: Prisma.TransactionClient,
  batch: {
    totalCost: Prisma.Decimal;
    priceSort1: Prisma.Decimal;
    priceSort2: Prisma.Decimal;
    sectionWidthMm: Prisma.Decimal;
    sectionHeightMm: Prisma.Decimal;
  },
  lots: Array<{
    id: string;
    lengthM: Prisma.Decimal;
    quantity: number;
    remainingQuantity: number;
    sort: Sort;
    initialValue: Prisma.Decimal | null;
    remainingValue: Prisma.Decimal | null;
  }>,
): Promise<void> {
  if (lots.some(lotIsConsumed)) throw new Error(COST_FLOW_DRIVER_AFTER_CONSUMPTION);
  for (const lot of lots) assertLotMonetaryInitialized(lot);
  await initializeCreatedRailLotsInTx(tx, { ...batch, railLots: lots });
}

export async function applyActiveRawWriteoffInTx(
  tx: Prisma.TransactionClient,
  batchId: string,
  lots: Array<{ remainingValue: Prisma.Decimal | null }>,
): Promise<void> {
  for (const lot of lots) {
    if (lot.remainingValue == null) throw new Error(COST_FLOW_LOT_NULL_WRITEOFF);
  }
  const rawLoss = lots.reduce((sum, lot) => sum.plus(D(lot.remainingValue!.toString())), D(0));
  await tx.railLot.updateMany({
    where: { batchId },
    data: {
      remainingQuantity: 0,
      remainingValue: money6(D(0)),
    },
  });
  await tx.costEvent.create({
    data: {
      type: "RAW_WRITEOFF",
      batchId,
      materialValue: money6(rawLoss),
      laborValue: money6(D(0)),
      nomenclatureValue: money6(D(0)),
      totalValue: money6(rawLoss),
      note: "отход",
    },
  });
}
