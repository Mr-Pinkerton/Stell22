import { Prisma, type RailType, type Sort } from "@prisma/client";
import { D, type Num } from "@/lib/cost";
import { canExactMonetaryReverse, q6 } from "@/lib/cost-foundation";
import { allocate, isReady, requiredPrisadki } from "@/lib/detail-stock";
import { ensureAndLockActiveBlankPools } from "@/server/internal/cost-flow-raw";
import {
  COST_FLOW_PRE_CUTOVER_REVERSE,
  COST_FLOW_VERSION_MISMATCH,
} from "@/server/internal/cost-flow-raw";
import { isCostFlowActive } from "@/server/internal/cost-flow-state";
import {
  COST_FLOW_EMPTY_SURPLUS_VALUATION,
  COST_FLOW_QTY_ONLY_WRITER,
  consumeNomPool,
  consumeProductPool,
  consumeTwoComponentPool,
  createMissingActiveDetailPoolRows,
  detailStockSortKey,
  ensureAndLockActiveDetailPools,
  ensureAndLockActiveNomPools,
  ensureAndLockActiveProductPools,
  lockExistingActiveBlanks,
  lockExistingActiveDetailPools,
  lockExistingActiveNomPools,
  lockExistingActiveProductPools,
  money6,
  receiveNomPool,
  receiveProductPool,
  receiveTwoComponentPool,
  removeExactProductReceipt,
  uniqueSortedDetailStockSpecs,
  type DetailStockSpec,
} from "@/server/internal/cost-flow-pools";
import {
  assertInventoryBoundary,
  blankSpecSortKey,
  blankSpecToInventoryRefs,
  collectPrisadkaRefs,
  lockDetails,
  prisadkaDestFlags,
  uniqueSortedBlankSpecs,
  type BlankSpec,
  type PreparedUpakovkaApply,
} from "@/server/internal/inventory-integrity";

export {
  COST_FLOW_DETAIL_POOL_UNINITIALIZED,
  COST_FLOW_EMPTY_SURPLUS_VALUATION,
  COST_FLOW_NOM_POOL_UNINITIALIZED,
  COST_FLOW_PRODUCT_POOL_UNINITIALIZED,
  COST_FLOW_QTY_ONLY_WRITER,
} from "@/server/internal/cost-flow-pools";

function snapshotDec(value: Prisma.Decimal | null | undefined): ReturnType<typeof D> {
  if (value == null) return D(0);
  return D(value.toString());
}

export function prisadkaLinePieceLabor(args: {
  quantity: number;
  torcevaya: boolean;
  ploskost: boolean;
  ratePrisadkaTorcevSnapshot: Prisma.Decimal | null;
  ratePrisadkaPlosktSnapshot: Prisma.Decimal | null;
}): ReturnType<typeof q6> {
  const rate = args.torcevaya
    ? snapshotDec(args.ratePrisadkaTorcevSnapshot)
    : args.ploskost
      ? snapshotDec(args.ratePrisadkaPlosktSnapshot)
      : D(0);
  return q6(D(args.quantity).times(rate));
}

export function upakovkaPieceLabor(args: {
  productQty: number;
  rateUpakovkaSnapshot: Prisma.Decimal | null;
}): ReturnType<typeof q6> {
  return q6(D(args.productQty).times(snapshotDec(args.rateUpakovkaSnapshot)));
}

export async function assertNoActiveQtyOnlyStockWrite(
  db: Prisma.TransactionClient | { setting: Prisma.TransactionClient["setting"] },
): Promise<void> {
  if (await isCostFlowActive(db as Prisma.TransactionClient)) {
    throw new Error(COST_FLOW_QTY_ONLY_WRITER);
  }
}

function destSpecOf(detailId: string, destTorcev: boolean, destPlosk: boolean): DetailStockSpec {
  return { detailId, torcevayaDone: destTorcev, ploskostDone: destPlosk };
}

function prisadkaDestFromPick(
  kind: "torcev" | "plosk",
  sourceIsBlank: boolean,
  sourceTorcevayaDone: boolean,
  sourcePloskostDone: boolean,
): { destTorcev: boolean; destPlosk: boolean } {
  return prisadkaDestFlags({
    detailId: "x",
    prisadkaTorcevaya: kind === "torcev",
    sourceIsBlank,
    sourceTorcevayaDone,
    sourcePloskostDone,
    blankLengthM: null,
    blankType: null,
    blankSort: null,
    blankMaterialId: null,
  });
}

type PlannedPrisadkaPortion = {
  take: number;
  sourceIsBlank: boolean;
  sourceTorcevayaDone: boolean;
  sourcePloskostDone: boolean;
  destTorcev: boolean;
  destPlosk: boolean;
};

async function planPrisadkaPortions(
  tx: Prisma.TransactionClient,
  detail: { id: string },
  kind: "torcev" | "plosk",
  quantity: number,
): Promise<PlannedPrisadkaPortion[]> {
  const portions: PlannedPrisadkaPortion[] = [];
  let left = quantity;
  const partials = await tx.detailStock.findMany({
    where: {
      detailId: detail.id,
      quantity: { gt: 0 },
      ...(kind === "torcev" ? { torcevayaDone: false } : { ploskostDone: false }),
    },
    orderBy: { id: "asc" },
  });
  for (const src of partials) {
    if (left <= 0) break;
    const take = Math.min(src.quantity, left);
    const dest = prisadkaDestFromPick(kind, false, src.torcevayaDone, src.ploskostDone);
    portions.push({
      take,
      sourceIsBlank: false,
      sourceTorcevayaDone: src.torcevayaDone,
      sourcePloskostDone: src.ploskostDone,
      destTorcev: dest.destTorcev,
      destPlosk: dest.destPlosk,
    });
    left -= take;
  }
  if (left > 0) {
    const dest = prisadkaDestFromPick(kind, true, false, false);
    portions.push({
      take: left,
      sourceIsBlank: true,
      sourceTorcevayaDone: false,
      sourcePloskostDone: false,
      destTorcev: dest.destTorcev,
      destPlosk: dest.destPlosk,
    });
  }
  return portions;
}

type PrisadkaJob = {
  detail: {
    id: string;
    materialId: string;
    lengthM: Prisma.Decimal;
    detailType: RailType;
    sort: Sort;
    prisadkaTorcevaya: boolean;
    prisadkaPloskost: boolean;
  };
  kind: "torcev" | "plosk";
  portions: PlannedPrisadkaPortion[];
};

function blankSpecOfDetail(detail: PrisadkaJob["detail"]): BlankSpec {
  return {
    materialId: detail.materialId,
    lengthM: detail.lengthM,
    detailType: detail.detailType,
    sort: detail.sort,
  };
}

const PRISADKA_OUTPUT_CONSUMED =
  "Нельзя изменить/удалить: деталь уже использована в упаковке или дальнейшей присадке";

/**
 * Lock the PRISADKA write-set in canonical order (BlankStock → DetailStock)
 * before sequential pick apply. Every logical BlankStock source spec is
 * ensure+locked so a missing pool becomes a zero-qty active-initialized
 * serialization anchor (no CostEvent, no invented value). Possible dest
 * buckets are ensured so a later pick can consume WIP produced by an earlier
 * pick in the same operation.
 */
async function lockActivePrisadkaWriteSet(
  tx: Prisma.TransactionClient,
  details: PrisadkaJob["detail"][],
): Promise<void> {
  await ensureAndLockActiveBlankPools(tx, uniqueSortedBlankSpecs(details.map(blankSpecOfDetail)));

  const destSpecs: DetailStockSpec[] = [];
  for (const detail of details) {
    const existing = await tx.detailStock.findMany({ where: { detailId: detail.id } });
    for (const row of existing) {
      destSpecs.push({
        detailId: detail.id,
        torcevayaDone: row.torcevayaDone,
        ploskostDone: row.ploskostDone,
      });
    }
    if (detail.prisadkaTorcevaya) destSpecs.push(destSpecOf(detail.id, true, false));
    if (detail.prisadkaPloskost) destSpecs.push(destSpecOf(detail.id, false, true));
    if (detail.prisadkaTorcevaya && detail.prisadkaPloskost) {
      destSpecs.push(destSpecOf(detail.id, true, true));
    }
  }
  await ensureAndLockActiveDetailPools(tx, destSpecs);
}

function orderedPrisadkaPicks(
  picks: Array<{ detailId: string; kind: "torcev" | "plosk"; quantity: number }>,
): Array<{ detailId: string; kind: "torcev" | "plosk"; quantity: number }> {
  return picks.filter((p) => p.quantity > 0);
}

function prisadkaLineDestKey(line: {
  detailId: string | null;
  prisadkaTorcevaya: boolean;
  sourceIsBlank: boolean;
  sourceTorcevayaDone: boolean;
  sourcePloskostDone: boolean;
  blankLengthM: Prisma.Decimal | null;
  blankType: RailType | null;
  blankSort: Sort | null;
  blankMaterialId: string | null;
}): string | null {
  if (!line.detailId) return null;
  const dest = prisadkaDestFlags(line);
  return detailStockSortKey(destSpecOf(line.detailId, dest.destTorcev, dest.destPlosk));
}

function historicalPrisadkaDestVersions(
  lines: Array<{
    detailId: string | null;
    prisadkaTorcevaya: boolean;
    sourceIsBlank: boolean;
    sourceTorcevayaDone: boolean;
    sourcePloskostDone: boolean;
    blankLengthM: Prisma.Decimal | null;
    blankType: RailType | null;
    blankSort: Sort | null;
    blankMaterialId: string | null;
    outputCostVersion: number | null;
  }>,
): Map<string, number> {
  const versions = new Map<string, number>();
  for (const line of lines) {
    const key = prisadkaLineDestKey(line);
    if (!key || line.outputCostVersion == null) continue;
    const prev = versions.get(key);
    if (prev != null && prev !== line.outputCostVersion) throw new Error(COST_FLOW_VERSION_MISMATCH);
    versions.set(key, line.outputCostVersion);
  }
  return versions;
}

function plannedReverseDetailKeys(
  lines: Array<{
    detailId: string | null;
    prisadkaTorcevaya: boolean;
    sourceIsBlank: boolean;
    sourceTorcevayaDone: boolean;
    sourcePloskostDone: boolean;
    blankLengthM: Prisma.Decimal | null;
    blankType: RailType | null;
    blankSort: Sort | null;
    blankMaterialId: string | null;
  }>,
): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    const destKey = prisadkaLineDestKey(line);
    if (destKey) keys.add(destKey);
    if (!line.sourceIsBlank && line.detailId) {
      keys.add(
        detailStockSortKey({
          detailId: line.detailId,
          torcevayaDone: line.sourceTorcevayaDone,
          ploskostDone: line.sourcePloskostDone,
        }),
      );
    }
  }
  return keys;
}

async function assertRetainedDestVersionsUnchanged(
  tx: Prisma.TransactionClient,
  retained: Array<{
    detailId: string | null;
    prisadkaTorcevaya: boolean;
    sourceIsBlank: boolean;
    sourceTorcevayaDone: boolean;
    sourcePloskostDone: boolean;
    blankLengthM: Prisma.Decimal | null;
    blankType: RailType | null;
    blankSort: Sort | null;
    blankMaterialId: string | null;
    outputCostVersion: number | null;
  }>,
  keysAboutToTouch: Set<string>,
): Promise<void> {
  const historical = historicalPrisadkaDestVersions(retained);
  for (const line of retained) {
    const key = prisadkaLineDestKey(line);
    if (!key || !keysAboutToTouch.has(key)) continue;
    const dest = prisadkaDestFlags(line);
    const pool = await tx.detailStock.findUnique({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: line.detailId!,
          torcevayaDone: dest.destTorcev,
          ploskostDone: dest.destPlosk,
        },
      },
    });
    const expected = historical.get(key);
    if (pool == null || expected == null || pool.costVersion !== expected) {
      throw new Error(COST_FLOW_VERSION_MISMATCH);
    }
  }
}

/**
 * INITIAL SUBMIT: `outputCostVersion` is the destination pool version after all
 * internal mutations of this ProductionOperation transaction.
 *
 * CORRECTION: only lines whose destination key is in `touchedDestKeys` may
 * be updated, and only after pre-correction current pool.costVersion matched
 * the retained historical outputCostVersion. Untouched destinations keep
 * their historical outputCostVersion even if the live pool version is newer.
 */
async function assignFinalPrisadkaDestVersions(
  tx: Prisma.TransactionClient,
  operationId: string,
  touchedDestKeys: Set<string>,
): Promise<void> {
  if (touchedDestKeys.size === 0) return;
  const lines = await tx.operationDetailLine.findMany({ where: { operationId } });
  const versionByDest = new Map<string, number>();
  for (const line of lines) {
    const destKey = prisadkaLineDestKey(line);
    if (!destKey || !touchedDestKeys.has(destKey)) continue;
    let version = versionByDest.get(destKey);
    if (version == null) {
      const dest = prisadkaDestFlags(line);
      const pool = await tx.detailStock.findUniqueOrThrow({
        where: {
          detailId_torcevayaDone_ploskostDone: {
            detailId: line.detailId!,
            torcevayaDone: dest.destTorcev,
            ploskostDone: dest.destPlosk,
          },
        },
      });
      version = pool.costVersion;
      versionByDest.set(destKey, version);
    }
    if (line.outputCostVersion !== version) {
      await tx.operationDetailLine.update({
        where: { id: line.id },
        data: { outputCostVersion: version },
      });
    }
  }
}

async function recomputePrisadkaPieceLabor(
  tx: Prisma.TransactionClient,
  operationId: string,
): Promise<void> {
  const lines = await tx.operationDetailLine.findMany({ where: { operationId } });
  const pieceSum = lines.reduce((sum, l) => sum.plus(D((l.pieceLaborCost ?? 0).toString())), D(0));
  await tx.productionOperation.update({
    where: { id: operationId },
    data: { pieceLaborCost: money6(q6(pieceSum)) },
  });
}

/**
 * Apply picks in public-request order. Each pick is planned against live stock
 * after previous picks in this ProductionOperation have consumed/received, so
 * source routing matches inactive sequential `applyInactivePrisadkaPick`.
 *
 * `outputCostVersion` on a line whose destination is pool P is the FINAL
 * `costVersion` of P after internal mutations of P in this call (plus
 * `alreadyTouched` from the same correction). Untouched destinations are not rebased.
 */
export async function applyActivePrisadkaPicks(
  tx: Prisma.TransactionClient,
  operationId: string,
  picks: Array<{ detailId: string; kind: "torcev" | "plosk"; quantity: number }>,
  options?: {
    retainedDestVersions?: Map<string, number>;
    alreadyTouched?: Set<string>;
  },
): Promise<Set<string>> {
  const touched = new Set(options?.alreadyTouched ?? []);
  const retained = options?.retainedDestVersions ?? new Map<string, number>();
  const ordered = orderedPrisadkaPicks(picks);
  if (ordered.length === 0) {
    await assignFinalPrisadkaDestVersions(tx, operationId, touched);
    await recomputePrisadkaPieceLabor(tx, operationId);
    return touched;
  }
  await lockDetails(tx, ordered.map((p) => p.detailId));
  const op = await tx.productionOperation.findUniqueOrThrow({ where: { id: operationId } });
  const details: PrisadkaJob["detail"][] = [];
  const seen = new Set<string>();
  for (const pick of ordered) {
    if (seen.has(pick.detailId)) continue;
    seen.add(pick.detailId);
    details.push(await tx.detail.findUniqueOrThrow({ where: { id: pick.detailId } }));
  }
  await lockActivePrisadkaWriteSet(tx, details);
  const detailById = new Map(details.map((d) => [d.id, d]));

  async function assertThenTouch(spec: DetailStockSpec): Promise<void> {
    const key = detailStockSortKey(spec);
    const expected = retained.get(key);
    if (expected != null && !touched.has(key)) {
      const pool = await tx.detailStock.findUnique({
        where: {
          detailId_torcevayaDone_ploskostDone: {
            detailId: spec.detailId,
            torcevayaDone: spec.torcevayaDone,
            ploskostDone: spec.ploskostDone,
          },
        },
      });
      if (pool == null || pool.costVersion !== expected) throw new Error(COST_FLOW_VERSION_MISMATCH);
    }
    touched.add(key);
  }

  for (const pick of ordered) {
    const detail = detailById.get(pick.detailId);
    if (!detail) throw new Error("Деталь не найдена");
    const portions = await planPrisadkaPortions(tx, detail, pick.kind, pick.quantity);
    const blankSpec = blankSpecOfDetail(detail);
    for (const portion of portions) {
      let takenMaterial = D(0);
      let takenLabor = D(0);
      if (portion.sourceIsBlank) {
        const blank = await tx.blankStock.findUnique({
          where: {
            materialId_lengthM_detailType_sort: {
              materialId: blankSpec.materialId,
              lengthM: blankSpec.lengthM,
              detailType: blankSpec.detailType,
              sort: blankSpec.sort,
            },
          },
        });
        if (!blank || blank.quantity < portion.take) {
          throw new Error("Недостаточно заготовок для присадки");
        }
        const consumed = await consumeTwoComponentPool(tx, "blank", blank.id, portion.take);
        takenMaterial = consumed.taken.material;
        takenLabor = consumed.taken.labor;
      } else {
        const srcSpec: DetailStockSpec = {
          detailId: detail.id,
          torcevayaDone: portion.sourceTorcevayaDone,
          ploskostDone: portion.sourcePloskostDone,
        };
        await assertThenTouch(srcSpec);
        const src = await tx.detailStock.findUnique({
          where: {
            detailId_torcevayaDone_ploskostDone: {
              detailId: detail.id,
              torcevayaDone: portion.sourceTorcevayaDone,
              ploskostDone: portion.sourcePloskostDone,
            },
          },
        });
        if (!src || src.quantity < portion.take) {
          throw new Error("Недостаточно остатка деталей для присадки");
        }
        const consumed = await consumeTwoComponentPool(tx, "detail", src.id, portion.take);
        takenMaterial = consumed.taken.material;
        takenLabor = consumed.taken.labor;
      }

      const piece = prisadkaLinePieceLabor({
        quantity: portion.take,
        torcevaya: pick.kind === "torcev",
        ploskost: pick.kind === "plosk",
        ratePrisadkaTorcevSnapshot: op.ratePrisadkaTorcevSnapshot,
        ratePrisadkaPlosktSnapshot: op.ratePrisadkaPlosktSnapshot,
      });
      const receiptMaterial = takenMaterial;
      const receiptLabor = takenLabor.plus(piece);
      const destSpec = destSpecOf(detail.id, portion.destTorcev, portion.destPlosk);
      await assertThenTouch(destSpec);
      const dest = await tx.detailStock.findUniqueOrThrow({
        where: {
          detailId_torcevayaDone_ploskostDone: {
            detailId: destSpec.detailId,
            torcevayaDone: destSpec.torcevayaDone,
            ploskostDone: destSpec.ploskostDone,
          },
        },
      });
      await receiveTwoComponentPool(tx, "detail", dest.id, {
        qty: portion.take,
        material: receiptMaterial,
        labor: receiptLabor,
      });

      await tx.operationDetailLine.create({
        data: {
          operationId,
          detailId: detail.id,
          quantity: portion.take,
          prisadkaTorcevaya: pick.kind === "torcev",
          prisadkaPloskost: pick.kind === "plosk",
          sourceIsBlank: portion.sourceIsBlank,
          sourceTorcevayaDone: portion.sourceTorcevayaDone,
          sourcePloskostDone: portion.sourcePloskostDone,
          blankLengthM: portion.sourceIsBlank ? detail.lengthM : null,
          blankType: portion.sourceIsBlank ? detail.detailType : null,
          blankSort: portion.sourceIsBlank ? detail.sort : null,
          blankMaterialId: portion.sourceIsBlank ? detail.materialId : null,
          inputMaterialValue: money6(takenMaterial),
          inputLaborValue: money6(takenLabor),
          receiptMaterialValue: money6(receiptMaterial),
          receiptLaborValue: money6(receiptLabor),
          pieceLaborCost: money6(piece),
        },
      });
    }
  }

  await assignFinalPrisadkaDestVersions(tx, operationId, touched);
  await recomputePrisadkaPieceLabor(tx, operationId);
  return touched;
}

export async function applyActivePrisadkaPick(
  tx: Prisma.TransactionClient,
  operationId: string,
  detailId: string,
  kind: "torcev" | "plosk",
  quantity: number,
): Promise<void> {
  await applyActivePrisadkaPicks(tx, operationId, [{ detailId, kind, quantity }]);
}

function assertPrisadkaLineSnapshots(line: {
  inputMaterialValue: Prisma.Decimal | null;
  inputLaborValue: Prisma.Decimal | null;
  receiptMaterialValue: Prisma.Decimal | null;
  receiptLaborValue: Prisma.Decimal | null;
  pieceLaborCost: Prisma.Decimal | null;
  outputCostVersion: number | null;
}): void {
  if (
    line.inputMaterialValue == null ||
    line.inputLaborValue == null ||
    line.receiptMaterialValue == null ||
    line.receiptLaborValue == null ||
    line.pieceLaborCost == null ||
    !canExactMonetaryReverse({ outputCostVersion: line.outputCostVersion })
  ) {
    throw new Error(COST_FLOW_PRE_CUTOVER_REVERSE);
  }
}

type PrisadkaLineRow = {
  id: string;
  detailId: string | null;
  quantity: number;
  prisadkaTorcevaya: boolean;
  sourceIsBlank: boolean;
  sourceTorcevayaDone: boolean;
  sourcePloskostDone: boolean;
  blankLengthM: Prisma.Decimal | null;
  blankType: RailType | null;
  blankSort: Sort | null;
  blankMaterialId: string | null;
  inputMaterialValue: Prisma.Decimal | null;
  inputLaborValue: Prisma.Decimal | null;
  receiptMaterialValue: Prisma.Decimal | null;
  receiptLaborValue: Prisma.Decimal | null;
  pieceLaborCost: Prisma.Decimal | null;
  outputCostVersion: number | null;
};

async function reverseActivePrisadkaLines(
  tx: Prisma.TransactionClient,
  occurredAt: Date,
  lines: PrisadkaLineRow[],
): Promise<Set<string>> {
  const mutated = new Set<string>();
  if (lines.length === 0) return mutated;
  for (const line of lines) assertPrisadkaLineSnapshots(line);
  await lockDetails(tx, lines.map((l) => l.detailId));

  type DetailNet = {
    spec: DetailStockSpec;
    destQty: number;
    destMaterial: ReturnType<typeof D>;
    destLabor: ReturnType<typeof D>;
    srcQty: number;
    srcMaterial: ReturnType<typeof D>;
    srcLabor: ReturnType<typeof D>;
    destVersion: number | null;
  };
  type BlankNet = {
    spec: BlankSpec;
    srcQty: number;
    srcMaterial: ReturnType<typeof D>;
    srcLabor: ReturnType<typeof D>;
  };
  const detailNets = new Map<string, DetailNet>();
  const blankNets = new Map<string, BlankNet>();

  function detailNet(spec: DetailStockSpec): DetailNet {
    const key = detailStockSortKey(spec);
    const cur = detailNets.get(key);
    if (cur) return cur;
    const created: DetailNet = {
      spec,
      destQty: 0,
      destMaterial: D(0),
      destLabor: D(0),
      srcQty: 0,
      srcMaterial: D(0),
      srcLabor: D(0),
      destVersion: null,
    };
    detailNets.set(key, created);
    return created;
  }

  const destSpecs: DetailStockSpec[] = [];
  const sourceDetails: DetailStockSpec[] = [];
  const sourceBlanks: BlankSpec[] = [];

  for (const line of lines) {
    if (!line.detailId) throw new Error("Строка присадки без детали");
    const dest = prisadkaDestFlags(line);
    const spec = destSpecOf(line.detailId, dest.destTorcev, dest.destPlosk);
    destSpecs.push(spec);
    const dNet = detailNet(spec);
    const version = line.outputCostVersion!;
    if (dNet.destVersion != null && dNet.destVersion !== version) throw new Error(COST_FLOW_VERSION_MISMATCH);
    dNet.destVersion = version;
    dNet.destQty += line.quantity;
    dNet.destMaterial = dNet.destMaterial.plus(D(line.receiptMaterialValue!.toString()));
    dNet.destLabor = dNet.destLabor.plus(D(line.receiptLaborValue!.toString()));
    if (line.sourceIsBlank) {
      if (!line.blankMaterialId || line.blankLengthM == null || !line.blankType || !line.blankSort) {
        throw new Error("Нет спецификации заготовки для возврата");
      }
      const specB: BlankSpec = {
        materialId: line.blankMaterialId,
        lengthM: line.blankLengthM,
        detailType: line.blankType,
        sort: line.blankSort,
      };
      sourceBlanks.push(specB);
      const bKey = blankSpecSortKey(specB);
      const bCur = blankNets.get(bKey) ?? {
        spec: specB,
        srcQty: 0,
        srcMaterial: D(0),
        srcLabor: D(0),
      };
      bCur.srcQty += line.quantity;
      bCur.srcMaterial = bCur.srcMaterial.plus(D(line.inputMaterialValue!.toString()));
      bCur.srcLabor = bCur.srcLabor.plus(D(line.inputLaborValue!.toString()));
      blankNets.set(bKey, bCur);
    } else {
      const srcSpec: DetailStockSpec = {
        detailId: line.detailId,
        torcevayaDone: line.sourceTorcevayaDone,
        ploskostDone: line.sourcePloskostDone,
      };
      sourceDetails.push(srcSpec);
      const sNet = detailNet(srcSpec);
      sNet.srcQty += line.quantity;
      sNet.srcMaterial = sNet.srcMaterial.plus(D(line.inputMaterialValue!.toString()));
      sNet.srcLabor = sNet.srcLabor.plus(D(line.inputLaborValue!.toString()));
    }
  }

  const refs = await collectPrisadkaRefs(tx, lines);

  const blankIds = await ensureAndLockActiveBlankPools(tx, uniqueSortedBlankSpecs(sourceBlanks));
  await createMissingActiveDetailPoolRows(tx, sourceDetails);
  const detailIds = await lockExistingActiveDetailPools(
    tx,
    uniqueSortedDetailStockSpecs([...destSpecs, ...sourceDetails]),
  );
  await assertInventoryBoundary(tx, occurredAt, refs);

  for (const net of [...detailNets.values()].sort((a, b) =>
    detailStockSortKey(a.spec).localeCompare(detailStockSortKey(b.spec)),
  )) {
    const poolId = detailIds.get(detailStockSortKey(net.spec));
    if (!poolId) throw new Error(COST_FLOW_VERSION_MISMATCH);
    const pool = await tx.detailStock.findUniqueOrThrow({ where: { id: poolId } });
    if (net.destVersion != null && pool.costVersion !== net.destVersion) {
      throw new Error(COST_FLOW_VERSION_MISMATCH);
    }
    const netRemoveQty = net.destQty - net.srcQty;
    if (netRemoveQty > 0 && pool.quantity < netRemoveQty) {
      throw new Error(PRISADKA_OUTPUT_CONSUMED);
    }
    const nextQty = pool.quantity - net.destQty + net.srcQty;
    const nextMaterial = D(pool.materialValue!.toString()).minus(net.destMaterial).plus(net.srcMaterial);
    const nextLabor = D(pool.laborValue!.toString()).minus(net.destLabor).plus(net.srcLabor);
    if (nextQty < 0 || nextMaterial.isNeg() || nextLabor.isNeg()) {
      throw new Error(COST_FLOW_VERSION_MISMATCH);
    }
    if (nextQty === 0 && (!nextMaterial.isZero() || !nextLabor.isZero())) {
      throw new Error(COST_FLOW_VERSION_MISMATCH);
    }
    if (
      nextQty === pool.quantity &&
      nextMaterial.equals(D(pool.materialValue!.toString())) &&
      nextLabor.equals(D(pool.laborValue!.toString()))
    ) {
      continue;
    }
    await tx.detailStock.update({
      where: { id: poolId },
      data: {
        quantity: nextQty,
        materialValue: money6(nextMaterial),
        laborValue: money6(nextLabor),
        totalValue: money6(nextMaterial.plus(nextLabor)),
        costVersion: pool.costVersion + 1,
      },
    });
    mutated.add(detailStockSortKey(net.spec));
  }

  for (const net of [...blankNets.values()].sort((a, b) =>
    blankSpecSortKey(a.spec).localeCompare(blankSpecSortKey(b.spec)),
  )) {
    const poolId = blankIds.get(blankSpecSortKey(net.spec));
    if (!poolId) throw new Error(COST_FLOW_VERSION_MISMATCH);
    await receiveTwoComponentPool(tx, "blank", poolId, {
      qty: net.srcQty,
      material: net.srcMaterial,
      labor: net.srcLabor,
    });
  }
  return mutated;
}

export async function reverseActivePrisadkaOperation(
  tx: Prisma.TransactionClient,
  op: { createdAt: Date; lines: PrisadkaLineRow[] },
): Promise<void> {
  await reverseActivePrisadkaLines(tx, op.createdAt, op.lines);
}

/**
 * Quantity-correct one PRISADKA line. Destination-sharing lines (same detailId +
 * dest flags) reverse together even when they mix torcev/plosk kinds, then
 * re-apply reconstructed logical picks in one `applyActivePrisadkaPicks`.
 *
 * Retained lines' outputCostVersion may change only when this correction
 * internally mutates that destination, after proving current pool.costVersion
 * still equals the historical outputCostVersion. Untouched destinations are
 * never rebased to a live pool version.
 *
 * The Detail entity serialization anchor is acquired before any retained
 * destination version read. Nested lockDetails in reverse/apply is reentrant
 * in the same transaction and must not invert canonical lock order.
 */
export async function correctActivePrisadkaLine(args: {
  tx: Prisma.TransactionClient;
  op: { id: string; createdAt: Date; lines: PrisadkaLineRow[] };
  lineIndex: number;
  newQty: number;
}): Promise<void> {
  const { tx, op, lineIndex, newQty } = args;
  const line = op.lines[lineIndex];
  if (!line || !line.detailId) throw new Error("Строка присадки без детали");
  await lockDetails(tx, op.lines.map((l) => l.detailId));
  historicalPrisadkaDestVersions(op.lines);
  const dest = prisadkaDestFlags(line);
  const destKey = detailStockSortKey(destSpecOf(line.detailId, dest.destTorcev, dest.destPlosk));
  const group = op.lines.filter((l) => {
    if (!l.detailId) return false;
    const d = prisadkaDestFlags(l);
    return detailStockSortKey(destSpecOf(l.detailId, d.destTorcev, d.destPlosk)) === destKey;
  });
  const groupIds = new Set(group.map((l) => l.id));
  for (const g of group) {
    if (g.detailId !== line.detailId) throw new Error(COST_FLOW_VERSION_MISMATCH);
  }
  const retained = op.lines.filter((l) => !groupIds.has(l.id));
  await assertRetainedDestVersionsUnchanged(tx, retained, plannedReverseDetailKeys(group));
  const qtyByKind = new Map<"torcev" | "plosk", number>();
  for (const g of group) {
    const kind: "torcev" | "plosk" = g.prisadkaTorcevaya ? "torcev" : "plosk";
    const qty = g.id === line.id ? newQty : g.quantity;
    qtyByKind.set(kind, (qtyByKind.get(kind) ?? 0) + qty);
  }
  const picks = [...qtyByKind.entries()]
    .filter(([, quantity]) => quantity > 0)
    .map(([kind, quantity]) => ({ detailId: line.detailId!, kind, quantity }));
  const reverseTouched = await reverseActivePrisadkaLines(tx, op.createdAt, group);
  await tx.operationDetailLine.deleteMany({ where: { id: { in: [...groupIds] } } });
  await applyActivePrisadkaPicks(tx, op.id, picks, {
    retainedDestVersions: historicalPrisadkaDestVersions(retained),
    alreadyTouched: reverseTouched,
  });
}

export async function applyActiveSimplePurchaseReceipt(
  tx: Prisma.TransactionClient,
  nomenclatureId: string,
  quantity: number,
  unitPrice: Num,
): Promise<void> {
  const amount = q6(D(quantity).times(D(unitPrice)));
  const ids = await ensureAndLockActiveNomPools(tx, [nomenclatureId]);
  const poolId = ids.get(nomenclatureId);
  if (!poolId) throw new Error(COST_FLOW_VERSION_MISMATCH);
  await receiveNomPool(tx, poolId, quantity, amount);
}

export async function applyActiveUpakovkaPrepared(
  tx: Prisma.TransactionClient,
  operationId: string,
  quantity: number,
  prepared: PreparedUpakovkaApply,
): Promise<void> {
  const op = await tx.productionOperation.findUniqueOrThrow({ where: { id: operationId } });
  const neededByDetail = new Map<string, number>();
  const byId = new Map(prepared.details.map((d) => [d.detailId, d]));
  for (const pd of prepared.details) {
    if (pd.quantity <= 0) continue;
    neededByDetail.set(pd.detailId, (neededByDetail.get(pd.detailId) ?? 0) + pd.quantity * quantity);
  }
  const detailIds = [...neededByDetail.keys()].sort();
  await lockDetails(tx, detailIds);

  type WipTake = {
    detailId: string;
    take: number;
    sourceIsBlank: boolean;
    sourceTorcevayaDone: boolean;
    sourcePloskostDone: boolean;
    blankSpec: BlankSpec | null;
    sourceDetailSpec: DetailStockSpec | null;
  };
  const wipTakes: WipTake[] = [];
  const blankSpecs: BlankSpec[] = [];
  const sourceDetailSpecs: DetailStockSpec[] = [];

  for (const detailId of detailIds) {
    const needed = neededByDetail.get(detailId) ?? 0;
    if (needed <= 0) continue;
    const detail = byId.get(detailId);
    if (!detail) throw new Error("Деталь не найдена");
    const req = requiredPrisadki(detail);
    if (!req.torcev && !req.plosk) {
      const spec: BlankSpec = {
        materialId: detail.materialId,
        lengthM: detail.lengthM,
        detailType: detail.detailType,
        sort: detail.sort,
      };
      blankSpecs.push(spec);
      wipTakes.push({
        detailId,
        take: needed,
        sourceIsBlank: true,
        sourceTorcevayaDone: false,
        sourcePloskostDone: false,
        blankSpec: spec,
        sourceDetailSpec: null,
      });
      continue;
    }
    const rows = (
      await tx.detailStock.findMany({
        where: { detailId, quantity: { gt: 0 } },
        orderBy: { id: "asc" },
      })
    ).filter((r) => isReady(detail, r.torcevayaDone, r.ploskostDone));
    const takes = allocate(
      rows.map((r) => r.quantity),
      needed,
    );
    for (let i = 0; i < rows.length; i++) {
      const take = takes[i];
      if (take <= 0) continue;
      const spec: DetailStockSpec = {
        detailId,
        torcevayaDone: rows[i]!.torcevayaDone,
        ploskostDone: rows[i]!.ploskostDone,
      };
      sourceDetailSpecs.push(spec);
      wipTakes.push({
        detailId,
        take,
        sourceIsBlank: false,
        sourceTorcevayaDone: rows[i]!.torcevayaDone,
        sourcePloskostDone: rows[i]!.ploskostDone,
        blankSpec: null,
        sourceDetailSpec: spec,
      });
    }
  }

  const nomNeeds: { nomenclatureId: string; quantity: number; kind: "fastener" | "packaging" | "extra" }[] =
    [];
  for (const f of prepared.fasteners) {
    const needed = f.quantity * quantity;
    if (needed <= 0) continue;
    nomNeeds.push({ nomenclatureId: f.nomenclatureId, quantity: needed, kind: "fastener" });
  }
  if (prepared.packagingId) {
    nomNeeds.push({ nomenclatureId: prepared.packagingId, quantity, kind: "packaging" });
  }
  for (const ex of prepared.extras) {
    nomNeeds.push({ nomenclatureId: ex.nomenclatureId, quantity, kind: "extra" });
  }
  nomNeeds.sort((a, b) => a.nomenclatureId.localeCompare(b.nomenclatureId));

  const blankIds = await lockExistingActiveBlanks(tx, blankSpecs);
  const detailPoolIds = await lockExistingActiveDetailPools(tx, sourceDetailSpecs);
  const nomIds = await lockExistingActiveNomPools(
    tx,
    nomNeeds.map((n) => n.nomenclatureId),
  );
  const productIds = await ensureAndLockActiveProductPools(tx, [prepared.productId]);

  let wipMaterial = D(0);
  let wipLabor = D(0);
  for (const take of wipTakes) {
    let takenMaterial = D(0);
    let takenLabor = D(0);
    if (take.sourceIsBlank && take.blankSpec) {
      const poolId = blankIds.get(blankSpecSortKey(take.blankSpec));
      if (!poolId) throw new Error("Недостаточно заготовок для упаковки");
      const consumed = await consumeTwoComponentPool(tx, "blank", poolId, take.take);
      takenMaterial = consumed.taken.material;
      takenLabor = consumed.taken.labor;
    } else if (take.sourceDetailSpec) {
      const poolId = detailPoolIds.get(detailStockSortKey(take.sourceDetailSpec));
      if (!poolId) throw new Error("Недостаточно готовых деталей для упаковки");
      const consumed = await consumeTwoComponentPool(tx, "detail", poolId, take.take);
      takenMaterial = consumed.taken.material;
      takenLabor = consumed.taken.labor;
    }
    wipMaterial = wipMaterial.plus(takenMaterial);
    wipLabor = wipLabor.plus(takenLabor);
    await tx.operationDetailLine.create({
      data: {
        operationId,
        detailId: take.detailId,
        quantity: take.take,
        sourceIsBlank: take.sourceIsBlank,
        sourceTorcevayaDone: take.sourceTorcevayaDone,
        sourcePloskostDone: take.sourcePloskostDone,
        blankLengthM: take.blankSpec?.lengthM ?? null,
        blankType: take.blankSpec?.detailType ?? null,
        blankSort: take.blankSpec?.sort ?? null,
        blankMaterialId: take.blankSpec?.materialId ?? null,
        inputMaterialValue: money6(takenMaterial),
        inputLaborValue: money6(takenLabor),
      },
    });
  }

  let nomConsumed = D(0);
  for (const need of nomNeeds) {
    const poolId = nomIds.get(need.nomenclatureId);
    if (!poolId) {
      if (need.kind === "fastener") throw new Error("Недостаточно крепежа на складе");
      if (need.kind === "packaging") throw new Error("Недостаточно упаковки на складе");
      throw new Error("Недостаточно доп. комплектующих на складе");
    }
    try {
      const consumed = await consumeNomPool(tx, poolId, need.quantity);
      nomConsumed = nomConsumed.plus(consumed.taken.nomenclature);
      await tx.operationNomenclatureLine.create({
        data: {
          operationId,
          nomenclatureId: need.nomenclatureId,
          quantity: need.quantity,
          consumedNomenclatureValue: money6(consumed.taken.nomenclature),
        },
      });
    } catch (err) {
      if (err instanceof Error && err.message.includes("Недостаточно номенклатуры")) {
        if (need.kind === "fastener") throw new Error("Недостаточно крепежа на складе");
        if (need.kind === "packaging") throw new Error("Недостаточно упаковки на складе");
        throw new Error("Недостаточно доп. комплектующих на складе");
      }
      throw err;
    }
  }

  const packerPiece = upakovkaPieceLabor({
    productQty: quantity,
    rateUpakovkaSnapshot: op.rateUpakovkaSnapshot,
  });
  const receiptMaterial = wipMaterial;
  const receiptLabor = wipLabor.plus(packerPiece);
  const receiptNom = nomConsumed;
  const productPoolId = productIds.get(prepared.productId);
  if (!productPoolId) throw new Error(COST_FLOW_VERSION_MISMATCH);
  const outputVersion = await receiveProductPool(tx, productPoolId, {
    qty: quantity,
    material: receiptMaterial,
    labor: receiptLabor,
    nomenclature: receiptNom,
  });
  await tx.productionOperation.update({
    where: { id: operationId },
    data: {
      pieceLaborCost: money6(packerPiece),
      receiptMaterialValue: money6(receiptMaterial),
      receiptLaborValue: money6(receiptLabor),
      receiptNomenclatureValue: money6(receiptNom),
      outputCostVersion: outputVersion,
    },
  });
}

export async function reverseActiveUpakovkaOperation(
  tx: Prisma.TransactionClient,
  op: {
    createdAt: Date;
    productId: string | null;
    productQty: number | null;
    receiptMaterialValue: Prisma.Decimal | null;
    receiptLaborValue: Prisma.Decimal | null;
    receiptNomenclatureValue: Prisma.Decimal | null;
    outputCostVersion: number | null;
    pieceLaborCost: Prisma.Decimal | null;
    lines: Array<{
      detailId: string | null;
      quantity: number;
      sourceIsBlank: boolean;
      sourceTorcevayaDone: boolean;
      sourcePloskostDone: boolean;
      blankLengthM: Prisma.Decimal | null;
      blankType: RailType | null;
      blankSort: Sort | null;
      blankMaterialId: string | null;
      inputMaterialValue: Prisma.Decimal | null;
      inputLaborValue: Prisma.Decimal | null;
    }>;
    nomenclatureLines: Array<{
      nomenclatureId: string;
      quantity: number;
      consumedNomenclatureValue: Prisma.Decimal | null;
    }>;
  },
): Promise<void> {
  if (
    !op.productId ||
    op.productQty == null ||
    op.receiptMaterialValue == null ||
    op.receiptLaborValue == null ||
    op.receiptNomenclatureValue == null ||
    op.pieceLaborCost == null ||
    !canExactMonetaryReverse({ outputCostVersion: op.outputCostVersion })
  ) {
    throw new Error(COST_FLOW_PRE_CUTOVER_REVERSE);
  }
  for (const line of op.lines) {
    if (line.inputMaterialValue == null || line.inputLaborValue == null) {
      throw new Error(COST_FLOW_PRE_CUTOVER_REVERSE);
    }
  }
  for (const nl of op.nomenclatureLines) {
    if (nl.consumedNomenclatureValue == null) throw new Error(COST_FLOW_PRE_CUTOVER_REVERSE);
  }

  await lockDetails(tx, op.lines.map((l) => l.detailId));

  const blankSpecs: BlankSpec[] = [];
  const detailSpecs: DetailStockSpec[] = [];
  for (const l of op.lines) {
    if (l.sourceIsBlank) {
      if (!l.blankMaterialId || l.blankLengthM == null || !l.blankType || !l.blankSort) {
        throw new Error("Нет спецификации заготовки для возврата");
      }
      blankSpecs.push({
        materialId: l.blankMaterialId,
        lengthM: l.blankLengthM,
        detailType: l.blankType,
        sort: l.blankSort,
      });
    } else if (l.detailId) {
      detailSpecs.push({
        detailId: l.detailId,
        torcevayaDone: l.sourceTorcevayaDone,
        ploskostDone: l.sourcePloskostDone,
      });
    }
  }

  const blankIds = await ensureAndLockActiveBlankPools(tx, uniqueSortedBlankSpecs(blankSpecs));
  await createMissingActiveDetailPoolRows(tx, detailSpecs);
  const detailIds = await lockExistingActiveDetailPools(tx, uniqueSortedDetailStockSpecs(detailSpecs));
  const nomIds = await ensureAndLockActiveNomPools(
    tx,
    op.nomenclatureLines.map((n) => n.nomenclatureId),
  );
  const productIds = await lockExistingActiveProductPools(tx, [op.productId]);
  const productPoolId = productIds.get(op.productId);
  if (!productPoolId) throw new Error(COST_FLOW_VERSION_MISMATCH);

  const refs: Array<{ refType: "PRODUCT" | "DETAIL" | "NOMENCLATURE"; refId: string }> = [
    { refType: "PRODUCT", refId: op.productId },
  ];
  for (const nl of op.nomenclatureLines) refs.push({ refType: "NOMENCLATURE", refId: nl.nomenclatureId });
  for (const l of op.lines) {
    if (l.sourceIsBlank && l.blankMaterialId && l.blankLengthM != null && l.blankType && l.blankSort) {
      refs.push(
        ...(await blankSpecToInventoryRefs(tx, {
          materialId: l.blankMaterialId,
          lengthM: l.blankLengthM,
          detailType: l.blankType,
          sort: l.blankSort,
        })),
      );
    } else if (l.detailId) {
      refs.push({ refType: "DETAIL", refId: l.detailId });
    }
  }
  await assertInventoryBoundary(tx, op.createdAt, refs);

  const productPool = await tx.productStock.findUniqueOrThrow({ where: { id: productPoolId } });
  if (productPool.costVersion !== op.outputCostVersion) throw new Error(COST_FLOW_VERSION_MISMATCH);

  await removeExactProductReceipt(
    tx,
    productPoolId,
    {
      qty: op.productQty,
      material: op.receiptMaterialValue,
      labor: op.receiptLaborValue,
      nomenclature: op.receiptNomenclatureValue,
    },
    op.outputCostVersion!,
  );

  for (const l of op.lines) {
    if (l.sourceIsBlank) {
      const spec: BlankSpec = {
        materialId: l.blankMaterialId!,
        lengthM: l.blankLengthM!,
        detailType: l.blankType!,
        sort: l.blankSort!,
      };
      const poolId = blankIds.get(blankSpecSortKey(spec));
      if (!poolId) throw new Error(COST_FLOW_VERSION_MISMATCH);
      await receiveTwoComponentPool(tx, "blank", poolId, {
        qty: l.quantity,
        material: l.inputMaterialValue!,
        labor: l.inputLaborValue!,
      });
    } else {
      const spec: DetailStockSpec = {
        detailId: l.detailId!,
        torcevayaDone: l.sourceTorcevayaDone,
        ploskostDone: l.sourcePloskostDone,
      };
      const poolId = detailIds.get(detailStockSortKey(spec));
      if (!poolId) throw new Error(COST_FLOW_VERSION_MISMATCH);
      await receiveTwoComponentPool(tx, "detail", poolId, {
        qty: l.quantity,
        material: l.inputMaterialValue!,
        labor: l.inputLaborValue!,
      });
    }
  }
  for (const nl of op.nomenclatureLines) {
    const poolId = nomIds.get(nl.nomenclatureId);
    if (!poolId) throw new Error(COST_FLOW_VERSION_MISMATCH);
    await receiveNomPool(tx, poolId, nl.quantity, nl.consumedNomenclatureValue!);
  }
}

export async function lockActiveInventoryWriteSet(
  tx: Prisma.TransactionClient,
  lines: Array<{ refType: string; refId: string; actualQty: number; accountedQty: number }>,
): Promise<void> {
  const detailIds = [...new Set(lines.filter((l) => l.refType === "DETAIL").map((l) => l.refId))].sort();
  await lockDetails(tx, detailIds);

  const blankSpecs: BlankSpec[] = [];
  const detailSpecs: DetailStockSpec[] = [];
  if (detailIds.length > 0) {
    const details = await tx.detail.findMany({ where: { id: { in: detailIds } } });
    const byId = new Map(details.map((d) => [d.id, d]));
    for (const id of detailIds) {
      const detail = byId.get(id);
      if (!detail) throw new Error("Деталь не найдена");
      if (!detail.prisadkaTorcevaya && !detail.prisadkaPloskost) {
        blankSpecs.push({
          materialId: detail.materialId,
          lengthM: detail.lengthM,
          detailType: detail.detailType,
          sort: detail.sort,
        });
        continue;
      }
      const rows = await tx.detailStock.findMany({ where: { detailId: id } });
      for (const row of rows) {
        detailSpecs.push({
          detailId: id,
          torcevayaDone: row.torcevayaDone,
          ploskostDone: row.ploskostDone,
        });
      }
      detailSpecs.push({
        detailId: id,
        torcevayaDone: detail.prisadkaTorcevaya,
        ploskostDone: detail.prisadkaPloskost,
      });
    }
  }

  await ensureAndLockActiveBlankPools(tx, uniqueSortedBlankSpecs(blankSpecs));
  await ensureAndLockActiveDetailPools(tx, uniqueSortedDetailStockSpecs(detailSpecs));
  await ensureAndLockActiveNomPools(
    tx,
    lines.filter((l) => l.refType === "NOMENCLATURE").map((l) => l.refId),
  );
  await ensureAndLockActiveProductPools(
    tx,
    lines.filter((l) => l.refType === "PRODUCT").map((l) => l.refId),
  );
}

export async function applyActiveInventoryConduct(
  tx: Prisma.TransactionClient,
  doc: {
    id: string;
    lines: Array<{
      id: string;
      refType: string;
      refId: string;
      actualQty: number;
      accountedQty: number;
    }>;
  },
): Promise<void> {
  for (const line of doc.lines) {
    const deviation = line.actualQty - line.accountedQty;
    if (line.refType === "PRODUCT") {
      await applyProductInventoryLine(tx, doc.id, line, deviation);
    } else if (line.refType === "NOMENCLATURE") {
      await applyNomInventoryLine(tx, doc.id, line, deviation);
    } else {
      const detail = await tx.detail.findUniqueOrThrow({ where: { id: line.refId } });
      if (!detail.prisadkaTorcevaya && !detail.prisadkaPloskost) {
        await applyBlankInventoryLine(tx, doc.id, line, detail, deviation);
      } else {
        await applyDetailInventoryLine(tx, doc.id, line, detail, deviation);
      }
    }
  }
}

async function writeInventoryEvent(
  tx: Prisma.TransactionClient,
  args: {
    type: "INVENTORY_LOSS" | "INVENTORY_GAIN";
    inventoryId: string;
    inventoryLineId: string;
    material: Num;
    labor: Num;
    nomenclature: Num;
    stockKind: string;
    stockId: string;
  },
): Promise<void> {
  const total = D(args.material).plus(D(args.labor)).plus(D(args.nomenclature));
  await tx.costEvent.create({
    data: {
      type: args.type,
      inventoryId: args.inventoryId,
      inventoryLineId: args.inventoryLineId,
      materialValue: money6(args.material),
      laborValue: money6(args.labor),
      nomenclatureValue: money6(args.nomenclature),
      totalValue: money6(total),
      stockKind: args.stockKind,
      stockId: args.stockId,
    },
  });
}

async function applyProductInventoryLine(
  tx: Prisma.TransactionClient,
  inventoryId: string,
  line: { id: string; refId: string; actualQty: number },
  deviation: number,
): Promise<void> {
  const existing = await tx.productStock.findUnique({ where: { productId: line.refId } });
  if (deviation === 0) {
    if (existing && (existing.costVersion === 0 || existing.totalValue == null)) {
      throw new Error("Денежный учёт включён, но складской пул изделий не инициализирован. Операция заблокирована.");
    }
    return;
  }
  if (!existing) {
    if (deviation < 0) throw new Error("Недостаточно изделий на складе");
    throw new Error(COST_FLOW_EMPTY_SURPLUS_VALUATION);
  }
  const poolId = existing.id;
  if (deviation < 0) {
    const consumed = await consumeProductPool(tx, poolId, -deviation);
    await writeInventoryEvent(tx, {
      type: "INVENTORY_LOSS",
      inventoryId,
      inventoryLineId: line.id,
      material: consumed.taken.material,
      labor: consumed.taken.labor,
      nomenclature: consumed.taken.nomenclature,
      stockKind: "ProductStock",
      stockId: poolId,
    });
    return;
  }
  const pool = await tx.productStock.findUniqueOrThrow({ where: { id: poolId } });
  if (pool.quantity <= 0) throw new Error(COST_FLOW_EMPTY_SURPLUS_VALUATION);
  const unitMat = D(pool.materialValue!.toString()).div(pool.quantity);
  const unitLab = D(pool.laborValue!.toString()).div(pool.quantity);
  const unitNom = D(pool.nomenclatureValue!.toString()).div(pool.quantity);
  await receiveProductPool(tx, poolId, {
    qty: deviation,
    material: q6(unitMat.times(deviation)),
    labor: q6(unitLab.times(deviation)),
    nomenclature: q6(unitNom.times(deviation)),
  });
  await writeInventoryEvent(tx, {
    type: "INVENTORY_GAIN",
    inventoryId,
    inventoryLineId: line.id,
    material: q6(unitMat.times(deviation)),
    labor: q6(unitLab.times(deviation)),
    nomenclature: q6(unitNom.times(deviation)),
    stockKind: "ProductStock",
    stockId: poolId,
  });
}

async function applyNomInventoryLine(
  tx: Prisma.TransactionClient,
  inventoryId: string,
  line: { id: string; refId: string },
  deviation: number,
): Promise<void> {
  const existing = await tx.nomenclatureStock.findUnique({ where: { nomenclatureId: line.refId } });
  if (deviation === 0) {
    if (existing && (existing.costVersion === 0 || existing.totalValue == null)) {
      throw new Error("Денежный учёт включён, но складской пул номенклатуры не инициализирован. Операция заблокирована.");
    }
    return;
  }
  if (deviation < 0) {
    if (!existing) throw new Error("Недостаточно номенклатуры на складе");
    const consumed = await consumeNomPool(tx, existing.id, -deviation);
    await writeInventoryEvent(tx, {
      type: "INVENTORY_LOSS",
      inventoryId,
      inventoryLineId: line.id,
      material: 0,
      labor: 0,
      nomenclature: consumed.taken.nomenclature,
      stockKind: "NomenclatureStock",
      stockId: existing.id,
    });
    return;
  }
  if (existing && existing.quantity > 0) {
    const unit = D(existing.nomenclatureValue!.toString()).div(existing.quantity);
    const amount = q6(unit.times(deviation));
    await receiveNomPool(tx, existing.id, deviation, amount);
    await writeInventoryEvent(tx, {
      type: "INVENTORY_GAIN",
      inventoryId,
      inventoryLineId: line.id,
      material: 0,
      labor: 0,
      nomenclature: amount,
      stockKind: "NomenclatureStock",
      stockId: existing.id,
    });
    return;
  }
  if (existing && existing.costVersion === 0) {
    throw new Error("Денежный учёт включён, но складской пул номенклатуры не инициализирован. Операция заблокирована.");
  }
  const item = await tx.nomenclatureItem.findUniqueOrThrow({ where: { id: line.refId } });
  const amount = q6(D(deviation).times(D(item.unitPrice.toString())));
  if (!existing) throw new Error(COST_FLOW_EMPTY_SURPLUS_VALUATION);
  await receiveNomPool(tx, existing.id, deviation, amount);
  await writeInventoryEvent(tx, {
    type: "INVENTORY_GAIN",
    inventoryId,
    inventoryLineId: line.id,
    material: 0,
    labor: 0,
    nomenclature: amount,
    stockKind: "NomenclatureStock",
    stockId: existing.id,
  });
}

async function applyBlankInventoryLine(
  tx: Prisma.TransactionClient,
  inventoryId: string,
  line: { id: string },
  detail: { materialId: string; lengthM: Prisma.Decimal; detailType: RailType; sort: Sort },
  deviation: number,
): Promise<void> {
  const spec: BlankSpec = {
    materialId: detail.materialId,
    lengthM: detail.lengthM,
    detailType: detail.detailType,
    sort: detail.sort,
  };
  const existing = await tx.blankStock.findUnique({
    where: {
      materialId_lengthM_detailType_sort: {
        materialId: spec.materialId,
        lengthM: detail.lengthM,
        detailType: spec.detailType,
        sort: spec.sort,
      },
    },
  });
  if (deviation === 0) {
    if (existing && (existing.costVersion === 0 || existing.totalValue == null)) {
      throw new Error("Денежный учёт включён, но складской пул заготовок не инициализирован. Операция заблокирована.");
    }
    return;
  }
  if (!existing || (deviation > 0 && existing.quantity <= 0)) {
    if (deviation < 0) throw new Error("Недостаточно заготовок");
    throw new Error(COST_FLOW_EMPTY_SURPLUS_VALUATION);
  }
  const poolId = existing.id;
  if (deviation < 0) {
    const consumed = await consumeTwoComponentPool(tx, "blank", poolId, -deviation);
    await writeInventoryEvent(tx, {
      type: "INVENTORY_LOSS",
      inventoryId,
      inventoryLineId: line.id,
      material: consumed.taken.material,
      labor: consumed.taken.labor,
      nomenclature: 0,
      stockKind: "BlankStock",
      stockId: poolId,
    });
    return;
  }
  const pool = await tx.blankStock.findUniqueOrThrow({ where: { id: poolId } });
  const unitMat = D(pool.materialValue!.toString()).div(pool.quantity);
  const unitLab = D(pool.laborValue!.toString()).div(pool.quantity);
  const material = q6(unitMat.times(deviation));
  const labor = q6(unitLab.times(deviation));
  await receiveTwoComponentPool(tx, "blank", poolId, { qty: deviation, material, labor });
  await writeInventoryEvent(tx, {
    type: "INVENTORY_GAIN",
    inventoryId,
    inventoryLineId: line.id,
    material,
    labor,
    nomenclature: 0,
    stockKind: "BlankStock",
    stockId: poolId,
  });
}

async function applyDetailInventoryLine(
  tx: Prisma.TransactionClient,
  inventoryId: string,
  line: { id: string; refId: string; actualQty: number },
  detail: { prisadkaTorcevaya: boolean; prisadkaPloskost: boolean },
  deviation: number,
): Promise<void> {
  const existing = await tx.detailStock.findMany({
    where: { detailId: line.refId },
    orderBy: { id: "asc" },
  });
  const ready = existing.filter((r) => isReady(detail, r.torcevayaDone, r.ploskostDone));
  if (deviation === 0) {
    if (ready.some((r) => r.costVersion === 0 || r.totalValue == null)) {
      throw new Error("Денежный учёт включён, но складской пул деталей не инициализирован. Операция заблокирована.");
    }
    return;
  }
  if (ready.length === 0 && deviation > 0) throw new Error(COST_FLOW_EMPTY_SURPLUS_VALUATION);
  if (ready.length === 0) throw new Error("Недостаточно остатка деталей");
  if (ready.some((r) => r.costVersion === 0 || r.totalValue == null)) {
    throw new Error("Денежный учёт включён, но складской пул деталей не инициализирован. Операция заблокирована.");
  }

  const canonSpec: DetailStockSpec = {
    detailId: line.refId,
    torcevayaDone: detail.prisadkaTorcevaya,
    ploskostDone: detail.prisadkaPloskost,
  };
  const canonRow = await tx.detailStock.findUnique({
    where: {
      detailId_torcevayaDone_ploskostDone: {
        detailId: canonSpec.detailId,
        torcevayaDone: canonSpec.torcevayaDone,
        ploskostDone: canonSpec.ploskostDone,
      },
    },
  });
  if (!canonRow) throw new Error(COST_FLOW_VERSION_MISMATCH);
  const canonId = canonRow.id;

  for (const row of [...ready].sort((a, b) => a.id.localeCompare(b.id))) {
    if (row.id === canonId || row.quantity <= 0) continue;
    const consumed = await consumeTwoComponentPool(tx, "detail", row.id, row.quantity);
    await receiveTwoComponentPool(tx, "detail", canonId, {
      qty: row.quantity,
      material: consumed.taken.material,
      labor: consumed.taken.labor,
    });
  }

  const pool = await tx.detailStock.findUniqueOrThrow({ where: { id: canonId } });
  if (pool.costVersion === 0 || pool.totalValue == null || pool.materialValue == null || pool.laborValue == null) {
    throw new Error("Денежный учёт включён, но складской пул деталей не инициализирован. Операция заблокирована.");
  }

  let eventMat = D(0);
  let eventLab = D(0);
  let eventType: "INVENTORY_LOSS" | "INVENTORY_GAIN" | null = null;

  if (deviation < 0) {
    if (pool.quantity < -deviation) throw new Error("Недостаточно остатка деталей");
    const consumed = await consumeTwoComponentPool(tx, "detail", canonId, -deviation);
    eventMat = consumed.taken.material;
    eventLab = consumed.taken.labor;
    eventType = "INVENTORY_LOSS";
  } else {
    if (pool.quantity <= 0) throw new Error(COST_FLOW_EMPTY_SURPLUS_VALUATION);
    const unitMat = D(pool.materialValue.toString()).div(pool.quantity);
    const unitLab = D(pool.laborValue.toString()).div(pool.quantity);
    eventMat = q6(unitMat.times(deviation));
    eventLab = q6(unitLab.times(deviation));
    await receiveTwoComponentPool(tx, "detail", canonId, {
      qty: deviation,
      material: eventMat,
      labor: eventLab,
    });
    eventType = "INVENTORY_GAIN";
  }

  if (eventType) {
    await writeInventoryEvent(tx, {
      type: eventType,
      inventoryId,
      inventoryLineId: line.id,
      material: eventMat,
      labor: eventLab,
      nomenclature: 0,
      stockKind: "DetailStock",
      stockId: canonId,
    });
  }
}
