import { Prisma, type RailType, type Sort } from "@prisma/client";
import { D } from "@/lib/cost";
import { isNoPrisadkaDetail, isReady, requiredPrisadki } from "@/lib/detail-stock";
import { canonicalLengthDecimal } from "@/server/internal/blank-length";
import {
  planInventoryPhysicalEffects,
  type InventoryPhysicalEffect,
  type InventoryPhysicalPlanInput,
} from "@/server/internal/inventory-physical-effects";

export const STALE_SNAPSHOT =
  "После начала инвентаризации остаток изменился. Инвентаризацию необходимо обновить/создать заново.";
export const ALREADY_CONDUCTED = "Инвентаризация уже проведена";
export const INVENTORY_BOUNDARY =
  "Нельзя изменить/удалить: после этой операции проведена инвентаризация по затронутому остатку.";
export const DRAFT_ALREADY_EXISTS = "Черновик инвентаризации уже существует";
export const LEGACY_INVENTORY_DRAFT_RECREATE = "LEGACY_INVENTORY_DRAFT_RECREATE";

/**
 * BD-16.2: violation of partial UNIQUE Inventory_status_draft_key.
 * PostgreSQL 17 / Prisma 6: meta = { modelName: "Inventory", target: ["status"] }.
 */
export function isDraftUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== "P2002") return false;
  const meta = err.meta as { modelName?: unknown; target?: unknown } | undefined;
  if (meta?.modelName !== "Inventory") return false;
  return Array.isArray(meta.target) && meta.target.includes("status");
}

export type InventoryRef = {
  refType: "PRODUCT" | "DETAIL" | "NOMENCLATURE" | "BLANK";
  refId: string;
};

export type BlankSpec = {
  materialId: string;
  lengthM: Prisma.Decimal | number | string;
  detailType: RailType;
  sort: Sort;
};

export type PrisadkaReverseLine = {
  detailId: string | null;
  prisadkaTorcevaya: boolean;
  sourceIsBlank: boolean;
  sourceTorcevayaDone: boolean;
  sourcePloskostDone: boolean;
  blankLengthM: Prisma.Decimal | number | null;
  blankType: RailType | null;
  blankSort: Sort | null;
  blankMaterialId: string | null;
};

export type UpakovkaDetailLine = {
  detailId: string | null;
  sourceIsBlank: boolean;
  blankLengthM: Prisma.Decimal | number | null;
  blankType: RailType | null;
  blankSort: Sort | null;
  blankMaterialId: string | null;
};

export type PreparedUpakovkaDetail = {
  detailId: string;
  quantity: number;
  materialId: string;
  lengthM: Prisma.Decimal;
  detailType: RailType;
  sort: Sort;
  prisadkaTorcevaya: boolean;
  prisadkaPloskost: boolean;
};

export type PreparedUpakovkaApply = {
  productId: string;
  details: PreparedUpakovkaDetail[];
  fasteners: { nomenclatureId: string; quantity: number }[];
  packagingId: string | null;
  extras: { nomenclatureId: string }[];
};

function toDec(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

export function blankSpecSortKey(spec: BlankSpec): string {
  return `${spec.materialId}|${toDec(spec.lengthM).toFixed(4)}|${spec.detailType}|${spec.sort}`;
}

export function uniqueSortedBlankSpecs(specs: Iterable<BlankSpec>): BlankSpec[] {
  const byKey = new Map<string, BlankSpec>();
  for (const spec of specs) {
    const key = blankSpecSortKey(spec);
    if (!byKey.has(key)) byKey.set(key, spec);
  }
  return [...byKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, spec]) => spec);
}

function uniqueRefs(refs: InventoryRef[]): InventoryRef[] {
  const seen = new Set<string>();
  const out: InventoryRef[] = [];
  for (const ref of refs) {
    const key = `${ref.refType}:${ref.refId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

function sortedUniqueIds(ids: Iterable<string | null | undefined>): string[] {
  return [...new Set([...ids].filter((id): id is string => Boolean(id)))].sort();
}

export type InventoryBlankLockLine = {
  refType: string;
  refId: string;
};

export type InventoryBlankLockBlankRow = {
  id: string;
  materialId: string;
  lengthM: Prisma.Decimal | number | string;
  detailType: RailType;
  sort: Sort;
};

export type InventoryBlankLockDetailRow = {
  id: string;
  materialId: string;
  lengthM: Prisma.Decimal | number | string;
  detailType: RailType;
  sort: Sort;
  prisadkaTorcevaya: boolean;
  prisadkaPloskost: boolean;
};

export type InventoryBlankLockResolution = {
  blankRows: InventoryBlankLockBlankRow[];
  details: InventoryBlankLockDetailRow[];
};

function canonicalizeInventoryBlankSpec(spec: BlankSpec): BlankSpec {
  return {
    materialId: spec.materialId,
    lengthM: canonicalLengthDecimal(spec.lengthM),
    detailType: spec.detailType,
    sort: spec.sort,
  };
}

/**
 * Global Inventory BlankStock lock plan: one canonical physical-tuple set,
 * independent of input line order. Direct BLANK ids resolve to
 * (materialId, lengthM, detailType, sort); no-prisadka DETAIL aliases of the
 * same tuple collapse into that set. Missing BLANK rows are omitted (they
 * have no physical tuple to lock). Prisadka DETAIL lines do not lock BlankStock.
 */
export function planInventoryBlankStockLockSpecs(
  lines: Iterable<InventoryBlankLockLine>,
  resolution: InventoryBlankLockResolution,
): BlankSpec[] {
  const blanksById = new Map(resolution.blankRows.map((row) => [row.id, row]));
  const detailsById = new Map(resolution.details.map((row) => [row.id, row]));
  const specs: BlankSpec[] = [];
  for (const line of lines) {
    if (line.refType === "BLANK") {
      const row = blanksById.get(line.refId);
      if (!row) continue;
      specs.push(
        canonicalizeInventoryBlankSpec({
          materialId: row.materialId,
          lengthM: row.lengthM,
          detailType: row.detailType,
          sort: row.sort,
        }),
      );
      continue;
    }
    if (line.refType !== "DETAIL") continue;
    const detail = detailsById.get(line.refId);
    if (!detail) throw new Error("Деталь не найдена");
    if (!isNoPrisadkaDetail(detail)) continue;
    specs.push(
      canonicalizeInventoryBlankSpec({
        materialId: detail.materialId,
        lengthM: detail.lengthM,
        detailType: detail.detailType,
        sort: detail.sort,
      }),
    );
  }
  return uniqueSortedBlankSpecs(specs);
}

export async function loadInventoryBlankLockResolution(
  tx: Prisma.TransactionClient,
  lines: Iterable<InventoryBlankLockLine>,
): Promise<InventoryBlankLockResolution> {
  const lineList = [...lines];
  const blankIds = sortedUniqueIds(
    lineList.filter((line) => line.refType === "BLANK").map((line) => line.refId),
  );
  const detailIds = sortedUniqueIds(
    lineList.filter((line) => line.refType === "DETAIL").map((line) => line.refId),
  );
  const [blankRows, details] = await Promise.all([
    blankIds.length > 0
      ? tx.blankStock.findMany({
          where: { id: { in: blankIds } },
          select: { id: true, materialId: true, lengthM: true, detailType: true, sort: true },
        })
      : Promise.resolve([]),
    detailIds.length > 0
      ? tx.detail.findMany({
          where: { id: { in: detailIds } },
          select: {
            id: true,
            materialId: true,
            lengthM: true,
            detailType: true,
            sort: true,
            prisadkaTorcevaya: true,
            prisadkaPloskost: true,
          },
        })
      : Promise.resolve([]),
  ]);
  return { blankRows, details };
}

export async function collectInventoryBlankLockSpecs(
  tx: Prisma.TransactionClient,
  lines: Iterable<InventoryBlankLockLine>,
): Promise<BlankSpec[]> {
  const lineList = [...lines];
  const resolution = await loadInventoryBlankLockResolution(tx, lineList);
  return planInventoryBlankStockLockSpecs(lineList, resolution);
}

export function inventoryDeviationSumDecimal(
  deviation: number,
  unitCost: number,
): Prisma.Decimal {
  return new Prisma.Decimal(D(deviation).times(D(unitCost)).toDecimalPlaces(2).toFixed(2));
}

export function prisadkaDestFlags(line: PrisadkaReverseLine): {
  destTorcev: boolean;
  destPlosk: boolean;
} {
  const kind: "torcev" | "plosk" = line.prisadkaTorcevaya ? "torcev" : "plosk";
  const destTorcev = line.sourceIsBlank
    ? kind === "torcev"
    : kind === "torcev"
      ? true
      : line.sourceTorcevayaDone;
  const destPlosk = line.sourceIsBlank
    ? kind === "plosk"
    : kind === "plosk"
      ? true
      : line.sourcePloskostDone;
  return { destTorcev, destPlosk };
}

export function prisadkaReverseCoveredRefs(
  detail: { id: string; prisadkaTorcevaya: boolean; prisadkaPloskost: boolean },
  line: PrisadkaReverseLine,
): { includeDetail: boolean; includeBlankSpec: boolean } {
  const { destTorcev, destPlosk } = prisadkaDestFlags(line);
  const destReady = isReady(detail, destTorcev, destPlosk);
  const sourceReady =
    !line.sourceIsBlank &&
    isReady(detail, line.sourceTorcevayaDone, line.sourcePloskostDone);
  return {
    includeDetail: destReady || sourceReady,
    includeBlankSpec: line.sourceIsBlank,
  };
}

export async function lockInventoryForUpdate(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<{ id: string; status: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>(
    Prisma.sql`SELECT id, status::text AS status FROM "Inventory" WHERE id = ${id} FOR UPDATE`,
  );
  return rows[0] ?? null;
}

export async function lockDetails(
  tx: Prisma.TransactionClient,
  ids: Iterable<string | null | undefined>,
): Promise<void> {
  const unique = sortedUniqueIds(ids);
  if (unique.length === 0) return;
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "Detail" WHERE id IN (${Prisma.join(unique)}) ORDER BY id FOR UPDATE`,
  );
}

export async function lockProductIds(
  tx: Prisma.TransactionClient,
  ids: Iterable<string | null | undefined>,
): Promise<void> {
  const unique = sortedUniqueIds(ids);
  if (unique.length === 0) return;
  await tx.productStock.createMany({
    data: unique.map((productId) => ({ productId, quantity: 0 })),
    skipDuplicates: true,
  });
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "ProductStock" WHERE "productId" IN (${Prisma.join(unique)}) ORDER BY "productId" FOR UPDATE`,
  );
}

export async function lockNomenclatureIds(
  tx: Prisma.TransactionClient,
  ids: Iterable<string | null | undefined>,
): Promise<void> {
  const unique = sortedUniqueIds(ids);
  if (unique.length === 0) return;
  await tx.nomenclatureStock.createMany({
    data: unique.map((nomenclatureId) => ({ nomenclatureId, quantity: 0 })),
    skipDuplicates: true,
  });
  await tx.$queryRaw(
    Prisma.sql`SELECT id FROM "NomenclatureStock" WHERE "nomenclatureId" IN (${Prisma.join(unique)}) ORDER BY "nomenclatureId" FOR UPDATE`,
  );
}

export async function lockBlankSpecs(
  tx: Prisma.TransactionClient,
  specs: Iterable<BlankSpec>,
): Promise<void> {
  const unique = uniqueSortedBlankSpecs(specs);
  if (unique.length === 0) return;
  await tx.blankStock.createMany({
    data: unique.map((spec) => ({
      materialId: spec.materialId,
      lengthM: toDec(spec.lengthM),
      detailType: spec.detailType,
      sort: spec.sort,
      quantity: 0,
    })),
    skipDuplicates: true,
  });
  for (const spec of unique) {
    const row = await tx.blankStock.findUniqueOrThrow({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId: spec.materialId,
          lengthM: toDec(spec.lengthM),
          detailType: spec.detailType,
          sort: spec.sort,
        },
      },
      select: { id: true },
    });
    await tx.$queryRaw`SELECT id FROM "BlankStock" WHERE id = ${row.id} FOR UPDATE`;
  }
}

/**
 * Inventory stock lock order (inactive path):
 * 1. Detail catalog rows for DETAIL lines (ORDER BY id)
 * 2. One global BlankStock physical set (canonical spec order) via
 *    collectInventoryBlankLockSpecs → lockBlankSpecs. Creating a missing
 *    projection row with quantity 0 is lock representation, not a movement.
 * 3. NomenclatureStock ORDER BY nomenclatureId
 * 4. ProductStock ORDER BY productId
 *
 * BLANK does not lock catalog Detail aliases of the same spec.
 */
export async function lockInventoryStockRows(
  tx: Prisma.TransactionClient,
  lines: Array<{ refType: string; refId: string }>,
): Promise<void> {
  const detailIds = lines.filter((l) => l.refType === "DETAIL").map((l) => l.refId);
  await lockDetails(tx, detailIds);
  await lockBlankSpecs(tx, await collectInventoryBlankLockSpecs(tx, lines));
  await lockNomenclatureIds(
    tx,
    lines.filter((l) => l.refType === "NOMENCLATURE").map((l) => l.refId),
  );
  await lockProductIds(
    tx,
    lines.filter((l) => l.refType === "PRODUCT").map((l) => l.refId),
  );
}

export async function liveQtyForLine(
  tx: Prisma.TransactionClient,
  line: { refType: string; refId: string },
): Promise<number> {
  if (line.refType === "PRODUCT") {
    const row = await tx.productStock.findUnique({ where: { productId: line.refId } });
    return row?.quantity ?? 0;
  }
  if (line.refType === "NOMENCLATURE") {
    const row = await tx.nomenclatureStock.findUnique({
      where: { nomenclatureId: line.refId },
    });
    return row?.quantity ?? 0;
  }
  if (line.refType === "BLANK") {
    const row = await tx.blankStock.findUnique({ where: { id: line.refId } });
    return row?.quantity ?? 0;
  }
  const detail = await tx.detail.findUniqueOrThrow({ where: { id: line.refId } });
  if (isNoPrisadkaDetail(detail)) {
    const blank = await tx.blankStock.findUnique({
      where: {
        materialId_lengthM_detailType_sort: {
          materialId: detail.materialId,
          lengthM: detail.lengthM,
          detailType: detail.detailType,
          sort: detail.sort,
        },
      },
    });
    return blank?.quantity ?? 0;
  }
  const rows = await tx.detailStock.findMany({ where: { detailId: line.refId } });
  return rows
    .filter((r) => isReady(detail, r.torcevayaDone, r.ploskostDone))
    .reduce((sum, r) => sum + r.quantity, 0);
}

export async function assertLiveEqualsAccounted(
  tx: Prisma.TransactionClient,
  lines: Array<{ refType: string; refId: string; accountedQty: number }>,
): Promise<void> {
  for (const line of lines) {
    const live = await liveQtyForLine(tx, line);
    if (live !== line.accountedQty) throw new Error(STALE_SNAPSHOT);
  }
}

export async function blankSpecToInventoryRefs(
  tx: Prisma.TransactionClient,
  spec: BlankSpec,
): Promise<InventoryRef[]> {
  const refs: InventoryRef[] = [];
  const blank = await tx.blankStock.findUnique({
    where: {
      materialId_lengthM_detailType_sort: {
        materialId: spec.materialId,
        lengthM: toDec(spec.lengthM),
        detailType: spec.detailType,
        sort: spec.sort,
      },
    },
    select: { id: true },
  });
  if (blank) refs.push({ refType: "BLANK", refId: blank.id });
  const details = await tx.detail.findMany({
    where: {
      materialId: spec.materialId,
      lengthM: toDec(spec.lengthM),
      detailType: spec.detailType,
      sort: spec.sort,
      prisadkaTorcevaya: false,
      prisadkaPloskost: false,
    },
    select: { id: true },
  });
  for (const d of details) refs.push({ refType: "DETAIL", refId: d.id });
  return refs;
}

/** Pre-R06 DRAFT: DETAIL line pointing at a no-prisadka catalog Detail. Must recreate. */
export async function assertNotLegacyInventoryDraft(
  tx: Prisma.TransactionClient,
  lines: Array<{ refType: string; refId: string }>,
): Promise<void> {
  const detailIds = lines.filter((l) => l.refType === "DETAIL").map((l) => l.refId);
  if (detailIds.length === 0) return;
  const details = await tx.detail.findMany({ where: { id: { in: detailIds } } });
  const byId = new Map(details.map((d) => [d.id, d]));
  for (const id of detailIds) {
    const detail = byId.get(id);
    if (!detail) throw new Error("Деталь не найдена");
    if (isNoPrisadkaDetail(detail)) throw new Error(LEGACY_INVENTORY_DRAFT_RECREATE);
  }
}

export async function loadInventoryPhysicalPlanInput(
  tx: Prisma.TransactionClient,
  lines: Array<{
    id: string;
    refType: string;
    refId: string;
    accountedQty: number;
    actualQty: number;
  }>,
): Promise<InventoryPhysicalPlanInput> {
  const blankIds = lines.filter((l) => l.refType === "BLANK").map((l) => l.refId);
  const detailIds = lines.filter((l) => l.refType === "DETAIL").map((l) => l.refId);
  const productIds = lines.filter((l) => l.refType === "PRODUCT").map((l) => l.refId);
  const nomIds = lines.filter((l) => l.refType === "NOMENCLATURE").map((l) => l.refId);

  const [blanks, details, detailBuckets, products, noms] = await Promise.all([
    blankIds.length > 0
      ? tx.blankStock.findMany({ where: { id: { in: blankIds } } })
      : Promise.resolve([]),
    detailIds.length > 0 ? tx.detail.findMany({ where: { id: { in: detailIds } } }) : Promise.resolve([]),
    detailIds.length > 0
      ? tx.detailStock.findMany({ where: { detailId: { in: detailIds } } })
      : Promise.resolve([]),
    productIds.length > 0
      ? tx.productStock.findMany({ where: { productId: { in: productIds } } })
      : Promise.resolve([]),
    nomIds.length > 0
      ? tx.nomenclatureStock.findMany({ where: { nomenclatureId: { in: nomIds } } })
      : Promise.resolve([]),
  ]);

  const detailBucketsByDetailId = new Map<
    string,
    Array<{ torcevayaDone: boolean; ploskostDone: boolean; quantity: number }>
  >();
  for (const row of detailBuckets) {
    const list = detailBucketsByDetailId.get(row.detailId) ?? [];
    list.push({
      torcevayaDone: row.torcevayaDone,
      ploskostDone: row.ploskostDone,
      quantity: row.quantity,
    });
    detailBucketsByDetailId.set(row.detailId, list);
  }

  return {
    lines,
    blanksById: new Map(
      blanks.map((b) => [
        b.id,
        {
          id: b.id,
          materialId: b.materialId,
          lengthM: Number(b.lengthM),
          detailType: b.detailType,
          sort: b.sort,
          quantity: b.quantity,
        },
      ]),
    ),
    detailsById: new Map(
      details.map((d) => [
        d.id,
        {
          id: d.id,
          prisadkaTorcevaya: d.prisadkaTorcevaya,
          prisadkaPloskost: d.prisadkaPloskost,
        },
      ]),
    ),
    detailBucketsByDetailId,
    productQtyById: new Map(products.map((p) => [p.productId, p.quantity])),
    nomenclatureQtyById: new Map(noms.map((n) => [n.nomenclatureId, n.quantity])),
  };
}

export function deriveInventoryPhysicalEffects(
  input: InventoryPhysicalPlanInput,
): InventoryPhysicalEffect[] {
  return planInventoryPhysicalEffects(input);
}

export async function applyInactiveInventoryPhysicalEffects(
  tx: Prisma.TransactionClient,
  effects: InventoryPhysicalEffect[],
): Promise<void> {
  for (const e of effects) {
    if (e.stockDomain === "PRODUCT") {
      await tx.productStock.upsert({
        where: { productId: e.physicalTarget.productId },
        create: { productId: e.physicalTarget.productId, quantity: e.afterQty },
        update: { quantity: e.afterQty },
      });
      continue;
    }
    if (e.stockDomain === "NOMENCLATURE") {
      await tx.nomenclatureStock.upsert({
        where: { nomenclatureId: e.physicalTarget.nomenclatureId },
        create: { nomenclatureId: e.physicalTarget.nomenclatureId, quantity: e.afterQty },
        update: { quantity: e.afterQty },
      });
      continue;
    }
    if (e.stockDomain === "BLANK") {
      await tx.blankStock.upsert({
        where: {
          materialId_lengthM_detailType_sort: {
            materialId: e.physicalTarget.materialId,
            lengthM: e.physicalTarget.lengthM,
            detailType: e.physicalTarget.detailType,
            sort: e.physicalTarget.sort,
          },
        },
        create: {
          materialId: e.physicalTarget.materialId,
          lengthM: e.physicalTarget.lengthM,
          detailType: e.physicalTarget.detailType,
          sort: e.physicalTarget.sort,
          quantity: e.afterQty,
        },
        update: { quantity: e.afterQty },
      });
      continue;
    }
    await tx.detailStock.upsert({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: e.physicalTarget.detailId,
          torcevayaDone: e.physicalTarget.torcevayaDone,
          ploskostDone: e.physicalTarget.ploskostDone,
        },
      },
      create: {
        detailId: e.physicalTarget.detailId,
        torcevayaDone: e.physicalTarget.torcevayaDone,
        ploskostDone: e.physicalTarget.ploskostDone,
        quantity: e.afterQty,
      },
      update: { quantity: e.afterQty },
    });
  }
}

export async function assertInventoryBoundary(
  tx: Prisma.TransactionClient,
  occurredAt: Date,
  refs: InventoryRef[],
): Promise<void> {
  const unique = uniqueRefs(refs);
  if (unique.length === 0) return;
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT i.id
    FROM "Inventory" i
    JOIN "InventoryLine" l ON l."inventoryId" = i.id
    WHERE i.status = 'CONDUCTED'
      AND i.date > ${occurredAt}
      AND (${Prisma.join(
        unique.map((r) => Prisma.sql`(l."refType" = ${r.refType} AND l."refId" = ${r.refId})`),
        " OR ",
      )})
    LIMIT 1
  `);
  if (rows.length > 0) throw new Error(INVENTORY_BOUNDARY);
}

/** Read-only inventory-history check. Does not create BlankStock rows. */
export async function assertTorcovkaBlankInventoryBoundary(
  tx: Prisma.TransactionClient,
  occurredAt: Date,
  specs: Iterable<BlankSpec>,
): Promise<void> {
  const unique = uniqueSortedBlankSpecs(specs);
  const refs: InventoryRef[] = [];
  for (const spec of unique) {
    refs.push(...(await blankSpecToInventoryRefs(tx, spec)));
  }
  await assertInventoryBoundary(tx, occurredAt, refs);
}

export async function collectPrisadkaRefs(
  tx: Prisma.TransactionClient,
  lines: PrisadkaReverseLine[],
): Promise<InventoryRef[]> {
  const refs: InventoryRef[] = [];
  for (const line of lines) {
    if (!line.detailId) continue;
    const detail = await tx.detail.findUniqueOrThrow({ where: { id: line.detailId } });
    const covered = prisadkaReverseCoveredRefs(detail, line);
    if (covered.includeDetail) {
      refs.push({ refType: "DETAIL", refId: line.detailId });
    }
    if (
      covered.includeBlankSpec &&
      line.blankMaterialId &&
      line.blankLengthM != null &&
      line.blankType &&
      line.blankSort
    ) {
      refs.push(
        ...(await blankSpecToInventoryRefs(tx, {
          materialId: line.blankMaterialId,
          lengthM: line.blankLengthM,
          detailType: line.blankType,
          sort: line.blankSort,
        })),
      );
    }
  }
  return refs;
}

export async function preparePrisadkaReverse(
  tx: Prisma.TransactionClient,
  occurredAt: Date,
  lines: PrisadkaReverseLine[],
): Promise<void> {
  await lockDetails(tx, lines.map((l) => l.detailId));
  const blanks: BlankSpec[] = [];
  for (const line of lines) {
    if (
      line.sourceIsBlank &&
      line.blankMaterialId &&
      line.blankLengthM != null &&
      line.blankType &&
      line.blankSort
    ) {
      blanks.push({
        materialId: line.blankMaterialId,
        lengthM: line.blankLengthM,
        detailType: line.blankType,
        sort: line.blankSort,
      });
    }
  }
  await lockBlankSpecs(tx, blanks);
  await assertInventoryBoundary(tx, occurredAt, await collectPrisadkaRefs(tx, lines));
}

async function collectUpakovkaRefs(
  tx: Prisma.TransactionClient,
  productId: string,
  detailLines: UpakovkaDetailLine[],
  nomenclatureLines: { nomenclatureId: string }[],
): Promise<InventoryRef[]> {
  const refs: InventoryRef[] = [{ refType: "PRODUCT", refId: productId }];
  for (const nl of nomenclatureLines) {
    refs.push({ refType: "NOMENCLATURE", refId: nl.nomenclatureId });
  }
  for (const line of detailLines) {
    if (line.sourceIsBlank) {
      if (
        line.blankMaterialId &&
        line.blankLengthM != null &&
        line.blankType &&
        line.blankSort
      ) {
        refs.push(
          ...(await blankSpecToInventoryRefs(tx, {
            materialId: line.blankMaterialId,
            lengthM: line.blankLengthM,
            detailType: line.blankType,
            sort: line.blankSort,
          })),
        );
      }
      continue;
    }
    if (line.detailId) refs.push({ refType: "DETAIL", refId: line.detailId });
  }
  return refs;
}

export async function prepareUpakovkaReverse(
  tx: Prisma.TransactionClient,
  occurredAt: Date,
  productId: string,
  detailLines: UpakovkaDetailLine[],
  nomenclatureLines: { nomenclatureId: string }[],
): Promise<void> {
  await lockDetails(tx, detailLines.map((l) => l.detailId));
  const blanks: BlankSpec[] = [];
  for (const line of detailLines) {
    if (
      line.sourceIsBlank &&
      line.blankMaterialId &&
      line.blankLengthM != null &&
      line.blankType &&
      line.blankSort
    ) {
      blanks.push({
        materialId: line.blankMaterialId,
        lengthM: line.blankLengthM,
        detailType: line.blankType,
        sort: line.blankSort,
      });
    }
  }
  await lockBlankSpecs(tx, blanks);
  await lockNomenclatureIds(
    tx,
    nomenclatureLines.map((l) => l.nomenclatureId),
  );
  await lockProductIds(tx, [productId]);
  await assertInventoryBoundary(
    tx,
    occurredAt,
    await collectUpakovkaRefs(tx, productId, detailLines, nomenclatureLines),
  );
}

export async function prepareTorcovkaBlankMutation(
  tx: Prisma.TransactionClient,
  occurredAt: Date,
  specs: Iterable<BlankSpec>,
): Promise<void> {
  const unique = uniqueSortedBlankSpecs(specs);
  await lockBlankSpecs(tx, unique);
  const refs: InventoryRef[] = [];
  for (const spec of unique) {
    refs.push(...(await blankSpecToInventoryRefs(tx, spec)));
  }
  await assertInventoryBoundary(tx, occurredAt, refs);
}

async function collectCurrentUpakovkaApplyRefs(
  tx: Prisma.TransactionClient,
  prepared: PreparedUpakovkaApply,
): Promise<InventoryRef[]> {
  const refs: InventoryRef[] = [{ refType: "PRODUCT", refId: prepared.productId }];
  for (const f of prepared.fasteners) {
    refs.push({ refType: "NOMENCLATURE", refId: f.nomenclatureId });
  }
  if (prepared.packagingId) {
    refs.push({ refType: "NOMENCLATURE", refId: prepared.packagingId });
  }
  for (const ex of prepared.extras) {
    refs.push({ refType: "NOMENCLATURE", refId: ex.nomenclatureId });
  }
  for (const row of prepared.details) {
    if (row.quantity <= 0) continue;
    const req = requiredPrisadki(row);
    if (!req.torcev && !req.plosk) {
      refs.push(
        ...(await blankSpecToInventoryRefs(tx, {
          materialId: row.materialId,
          lengthM: row.lengthM,
          detailType: row.detailType,
          sort: row.sort,
        })),
      );
    } else {
      refs.push({ refType: "DETAIL", refId: row.detailId });
    }
  }
  return refs;
}

export async function snapshotUpakovkaApply(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<PreparedUpakovkaApply> {
  const product = await tx.product.findUnique({
    where: { id: productId },
    include: { details: true, fasteners: true, extras: true },
  });
  if (!product) throw new Error("Изделие не найдено");
  const detailIds = product.details.filter((pd) => pd.quantity > 0).map((pd) => pd.detailId);
  const details =
    detailIds.length > 0 ? await tx.detail.findMany({ where: { id: { in: detailIds } } }) : [];
  const byId = new Map(details.map((d) => [d.id, d]));
  const preparedDetails: PreparedUpakovkaDetail[] = [];
  for (const pd of product.details) {
    if (pd.quantity <= 0) continue;
    const d = byId.get(pd.detailId);
    if (!d) throw new Error("Деталь не найдена");
    preparedDetails.push({
      detailId: pd.detailId,
      quantity: pd.quantity,
      materialId: d.materialId,
      lengthM: d.lengthM,
      detailType: d.detailType,
      sort: d.sort,
      prisadkaTorcevaya: d.prisadkaTorcevaya,
      prisadkaPloskost: d.prisadkaPloskost,
    });
  }
  return {
    productId,
    details: preparedDetails,
    fasteners: product.fasteners.map((f) => ({
      nomenclatureId: f.nomenclatureId,
      quantity: f.quantity,
    })),
    packagingId: product.packagingId,
    extras: product.extras.map((e) => ({ nomenclatureId: e.nomenclatureId })),
  };
}

/**
 * UPAKOVKA qty edit: snapshot CURRENT BOM once, lock union(old provenance,
 * snapshot refs) in canonical order, boundary on that union — before reverse
 * or re-apply. Caller must re-apply from the returned snapshot, not live BOM.
 */
export async function prepareUpakovkaEdit(
  tx: Prisma.TransactionClient,
  occurredAt: Date,
  productId: string,
  oldDetailLines: UpakovkaDetailLine[],
  oldNomenclatureLines: { nomenclatureId: string }[],
): Promise<PreparedUpakovkaApply> {
  const prepared = await snapshotUpakovkaApply(tx, productId);

  await lockDetails(tx, [
    ...prepared.details.map((d) => d.detailId),
    ...oldDetailLines.map((l) => l.detailId),
  ]);

  const blanks: BlankSpec[] = [];
  for (const line of oldDetailLines) {
    if (
      line.sourceIsBlank &&
      line.blankMaterialId &&
      line.blankLengthM != null &&
      line.blankType &&
      line.blankSort
    ) {
      blanks.push({
        materialId: line.blankMaterialId,
        lengthM: line.blankLengthM,
        detailType: line.blankType,
        sort: line.blankSort,
      });
    }
  }
  for (const row of prepared.details) {
    if (row.quantity <= 0) continue;
    if (!row.prisadkaTorcevaya && !row.prisadkaPloskost) {
      blanks.push({
        materialId: row.materialId,
        lengthM: row.lengthM,
        detailType: row.detailType,
        sort: row.sort,
      });
    }
  }
  await lockBlankSpecs(tx, blanks);

  const nomIds = [
    ...oldNomenclatureLines.map((l) => l.nomenclatureId),
    ...prepared.fasteners.map((f) => f.nomenclatureId),
    prepared.packagingId,
    ...prepared.extras.map((e) => e.nomenclatureId),
  ];
  await lockNomenclatureIds(tx, nomIds);
  await lockProductIds(tx, [productId]);

  const oldRefs = await collectUpakovkaRefs(tx, productId, oldDetailLines, oldNomenclatureLines);
  const currentRefs = await collectCurrentUpakovkaApplyRefs(tx, prepared);
  await assertInventoryBoundary(tx, occurredAt, [...oldRefs, ...currentRefs]);
  return prepared;
}

type SimBucket = {
  id: string | null;
  torcevayaDone: boolean;
  ploskostDone: boolean;
  quantity: number;
};

function findOrCreateBucket(
  buckets: SimBucket[],
  torcevayaDone: boolean,
  ploskostDone: boolean,
): SimBucket {
  const existing = buckets.find(
    (b) => b.torcevayaDone === torcevayaDone && b.ploskostDone === ploskostDone,
  );
  if (existing) return existing;
  const created: SimBucket = { id: null, torcevayaDone, ploskostDone, quantity: 0 };
  buckets.push(created);
  return created;
}

function logicalReversePrisadka(
  buckets: SimBucket[],
  blankQty: number,
  line: PrisadkaReverseLine & { quantity: number },
): number {
  const { destTorcev, destPlosk } = prisadkaDestFlags(line);
  findOrCreateBucket(buckets, destTorcev, destPlosk).quantity -= line.quantity;
  if (line.sourceIsBlank) return blankQty + line.quantity;
  findOrCreateBucket(buckets, line.sourceTorcevayaDone, line.sourcePloskostDone).quantity +=
    line.quantity;
  return blankQty;
}

function simulatePrisadkaApplySteps(
  kind: "torcev" | "plosk",
  quantity: number,
  buckets: SimBucket[],
): Array<{
  sourceIsBlank: boolean;
  sourceTorcevayaDone: boolean;
  sourcePloskostDone: boolean;
  destTorcev: boolean;
  destPlosk: boolean;
}> {
  const steps: Array<{
    sourceIsBlank: boolean;
    sourceTorcevayaDone: boolean;
    sourcePloskostDone: boolean;
    destTorcev: boolean;
    destPlosk: boolean;
  }> = [];
  let left = quantity;
  const partials = buckets
    .filter((b) => b.quantity > 0 && (kind === "torcev" ? !b.torcevayaDone : !b.ploskostDone))
    .sort((a, b) => {
      if (a.id == null && b.id == null) return 0;
      if (a.id == null) return 1;
      if (b.id == null) return -1;
      return a.id.localeCompare(b.id);
    });
  for (const src of partials) {
    if (left <= 0) break;
    const take = Math.min(src.quantity, left);
    if (take <= 0) continue;
    const destTorcev = kind === "torcev" ? true : src.torcevayaDone;
    const destPlosk = kind === "plosk" ? true : src.ploskostDone;
    steps.push({
      sourceIsBlank: false,
      sourceTorcevayaDone: src.torcevayaDone,
      sourcePloskostDone: src.ploskostDone,
      destTorcev,
      destPlosk,
    });
    src.quantity -= take;
    findOrCreateBucket(buckets, destTorcev, destPlosk).quantity += take;
    left -= take;
  }
  if (left > 0) {
    const destTorcev = kind === "torcev";
    const destPlosk = kind === "plosk";
    steps.push({
      sourceIsBlank: true,
      sourceTorcevayaDone: false,
      sourcePloskostDone: false,
      destTorcev,
      destPlosk,
    });
  }
  return steps;
}

function prisadkaApplyStepCovered(
  detail: { id: string; prisadkaTorcevaya: boolean; prisadkaPloskost: boolean },
  step: {
    sourceIsBlank: boolean;
    sourceTorcevayaDone: boolean;
    sourcePloskostDone: boolean;
    destTorcev: boolean;
    destPlosk: boolean;
  },
): { includeDetail: boolean; includeBlankSpec: boolean } {
  const destReady = isReady(detail, step.destTorcev, step.destPlosk);
  const sourceReady =
    !step.sourceIsBlank && isReady(detail, step.sourceTorcevayaDone, step.sourcePloskostDone);
  return {
    includeDetail: destReady || sourceReady,
    includeBlankSpec: step.sourceIsBlank,
  };
}

/**
 * PRISADKA qty edit: lock Detail (+ blank spec), dry-run reverse then apply
 * allocation, boundary on OLD reverse refs ∪ NEW apply refs, before writes.
 */
export async function preparePrisadkaEdit(
  tx: Prisma.TransactionClient,
  occurredAt: Date,
  line: PrisadkaReverseLine & { quantity: number },
  newQty: number,
): Promise<void> {
  if (!line.detailId) throw new Error("Строка присадки без детали");
  const detailId = line.detailId;
  await lockDetails(tx, [detailId]);
  const detail = await tx.detail.findUniqueOrThrow({ where: { id: detailId } });

  const blankSpec: BlankSpec = {
    materialId: detail.materialId,
    lengthM: detail.lengthM,
    detailType: detail.detailType,
    sort: detail.sort,
  };
  const blanks: BlankSpec[] = [blankSpec];
  if (
    line.sourceIsBlank &&
    line.blankMaterialId &&
    line.blankLengthM != null &&
    line.blankType &&
    line.blankSort
  ) {
    blanks.push({
      materialId: line.blankMaterialId,
      lengthM: line.blankLengthM,
      detailType: line.blankType,
      sort: line.blankSort,
    });
  }
  await lockBlankSpecs(tx, blanks);

  const rows = await tx.detailStock.findMany({
    where: { detailId },
    orderBy: { id: "asc" },
  });
  const buckets: SimBucket[] = rows.map((r) => ({
    id: r.id,
    torcevayaDone: r.torcevayaDone,
    ploskostDone: r.ploskostDone,
    quantity: r.quantity,
  }));
  const blankRow = await tx.blankStock.findUnique({
    where: {
      materialId_lengthM_detailType_sort: {
        materialId: detail.materialId,
        lengthM: detail.lengthM,
        detailType: detail.detailType,
        sort: detail.sort,
      },
    },
  });
  logicalReversePrisadka(buckets, blankRow?.quantity ?? 0, line);
  const kind: "torcev" | "plosk" = line.prisadkaTorcevaya ? "torcev" : "plosk";
  const applySteps = simulatePrisadkaApplySteps(kind, newQty, buckets);

  const refs = await collectPrisadkaRefs(tx, [line]);
  for (const step of applySteps) {
    const covered = prisadkaApplyStepCovered(detail, step);
    if (covered.includeDetail) refs.push({ refType: "DETAIL", refId: detailId });
    if (covered.includeBlankSpec) {
      refs.push(...(await blankSpecToInventoryRefs(tx, blankSpec)));
    }
  }
  await assertInventoryBoundary(tx, occurredAt, refs);
}
