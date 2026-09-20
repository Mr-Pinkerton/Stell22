/** PSR-P2 Package 2: retained identity for A/B/C quantity edit. Not Package 3 writer. */

import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { D } from "@/lib/cost";
import type { OperationType, RailType, Sort } from "@/types/domain";
import {
  lockBlankSpecs,
  lockDetailStocks,
  lockDetails,
  lockNomenclatureIds,
  lockProductIds,
  type PreparedUpakovkaApply,
} from "@/server/internal/inventory-integrity";

export const STALE_QUANTITY_EDIT =
  "STALE_QUANTITY_EDIT: текущее состояние операции не совпадает с ожидаемым";

export const REQUEST_ID_REUSE =
  "REQUEST_ID_REUSE: ключ попытки уже использован для другой команды";

export const QUANTITY_EDIT_SHADOW_WRITER_NOT_READY =
  "QUANTITY_EDIT_SHADOW_WRITER_NOT_READY: правки количества A/B/C заблокированы, пока SHADOW активен без writer Package 3";

export const QUANTITY_EDIT_UPAKOVKA_COST_FLOW_NOT_READY =
  "QUANTITY_EDIT_UPAKOVKA_COST_FLOW_NOT_READY: ARCH-P1-001 OPEN — правка количества УПАКОВКИ при ACTIVE cost-flow запрещена";

export const QUANTITY_EDIT_HOURS_NOT_PHYSICAL =
  "HOURS quantity edit is outside ProductionOperationQuantityEdit";

export const PHYSICAL_QUANTITY_EDIT_REQUIRES_RETAINED_COMMAND =
  "PHYSICAL_QUANTITY_EDIT_REQUIRES_RETAINED_COMMAND: правка количества A/B/C только через editProductionOperationQuantity";

export const QUANTITY_EDIT_BEFORE_SNAPSHOT_INCOMPLETE =
  "QUANTITY_EDIT_BEFORE_SNAPSHOT_INCOMPLETE: before snapshot missing a locked physical target";

/**
 * Dedicated two-int advisory namespace for quantity-edit requestId serialization.
 * Distinct from R-05 `8325` and SHADOW coordination.
 * key2 = hashtext(requestId); collisions only extra-serialize.
 */
export const QEDIT_REQUEST_LOCK_NAMESPACE = 8326;

export const QEDIT_REQUEST_LOCK_TX_REQUIRED =
  "Quantity-edit request lock requires an open Prisma transaction client.";

export const QEDIT_STATE_FINGERPRINT_VERSION = "qedit-state-v1";

export type ProductionQuantityEditInput = {
  operationId: string;
  requestId: string;
  targetLineId?: string | null;
  expectedOldQuantity: number;
  newQuantity: number;
  expectedStateFingerprint: string;
};

export type QuantityEditCommandPayload = {
  operationId: string;
  adminUserId: string;
  targetLineId: string | null;
  expectedOldQuantity: number;
  newQuantity: number;
  expectedStateFingerprint: string;
};

export type QuantityEditRequestTarget =
  | { kind: "LINE"; lineId: string }
  | { kind: "OPERATION" };

export type QuantityEditRequestSnapshotV1 = {
  v: 1;
  operationId: string;
  target: QuantityEditRequestTarget;
  expectedOldQuantity: number;
  newQuantity: number;
  expectedStateFingerprint: string;
};

export type QuantityEditBlankTarget = {
  targetType: "BLANK";
  materialId: string;
  lengthM: string;
  detailType: RailType;
  sort: Sort;
  quantityDelta: number;
};

export type QuantityEditDetailTarget = {
  targetType: "DETAIL";
  detailId: string;
  torcevayaDone: boolean;
  ploskostDone: boolean;
  quantityDelta: number;
};

export type QuantityEditNomenclatureTarget = {
  targetType: "NOMENCLATURE";
  nomenclatureId: string;
  quantityDelta: number;
};

export type QuantityEditProductTarget = {
  targetType: "PRODUCT";
  productId: string;
  quantityDelta: number;
};

export type QuantityEditPhysicalAdjustment =
  | QuantityEditBlankTarget
  | QuantityEditDetailTarget
  | QuantityEditNomenclatureTarget
  | QuantityEditProductTarget;

export type QuantityEditEffectSnapshotV1 = {
  v: 1;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  physicalAdjustments: QuantityEditPhysicalAdjustment[];
};

export type QuantityEditResult = {
  quantityEditId: string | null;
  requestId: string;
  operationId: string;
  replayed: boolean;
  noop: boolean;
};

export type QuantityEditLine = {
  id: string;
  quantity: number;
  detailId: string | null;
  blankLengthM: Prisma.Decimal | string | number | null;
  blankType: RailType | null;
  blankSort: Sort | null;
  blankMaterialId: string | null;
  prisadkaTorcevaya: boolean;
  prisadkaPloskost: boolean;
  sourceIsBlank: boolean;
  sourceTorcevayaDone: boolean;
  sourcePloskostDone: boolean;
};

export type QuantityEditNomLine = {
  id: string;
  nomenclatureId: string;
  quantity: number;
};

export async function acquireQuantityEditRequestLock(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<void> {
  if (typeof (tx as { $transaction?: unknown }).$transaction === "function") {
    throw new Error(QEDIT_REQUEST_LOCK_TX_REQUIRED);
  }
  await tx.$queryRaw`
    SELECT 1 AS acquired
    FROM (
      SELECT pg_advisory_xact_lock(
        ${QEDIT_REQUEST_LOCK_NAMESPACE}::integer,
        hashtext(${requestId})
      )
    ) AS qedit_request_lock
  `;
}

export function assertQuantityEditIntegers(input: {
  expectedOldQuantity: number;
  newQuantity: number;
}): void {
  const { expectedOldQuantity, newQuantity } = input;
  if (!Number.isInteger(expectedOldQuantity) || expectedOldQuantity <= 0) {
    throw new Error("Ожидаемое количество должно быть целым и больше нуля");
  }
  if (!Number.isInteger(newQuantity) || newQuantity <= 0) {
    throw new Error("Количество должно быть положительным");
  }
}

export function normalizeTargetLineId(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function quantityEditPayloadMatches(
  stored: QuantityEditCommandPayload,
  incoming: QuantityEditCommandPayload,
): boolean {
  return (
    stored.operationId === incoming.operationId &&
    stored.adminUserId === incoming.adminUserId &&
    stored.targetLineId === incoming.targetLineId &&
    stored.expectedOldQuantity === incoming.expectedOldQuantity &&
    stored.newQuantity === incoming.newQuantity &&
    stored.expectedStateFingerprint === incoming.expectedStateFingerprint
  );
}

export function assertQuantityEditPayloadMatch(
  stored: QuantityEditCommandPayload,
  incoming: QuantityEditCommandPayload,
): void {
  if (!quantityEditPayloadMatches(stored, incoming)) {
    throw new Error(REQUEST_ID_REUSE);
  }
}

export function quantityEditResultFromRow(
  row: { id: string; requestId: string; operationId: string },
  replayed: boolean,
): QuantityEditResult {
  return {
    quantityEditId: row.id,
    requestId: row.requestId,
    operationId: row.operationId,
    replayed,
    noop: false,
  };
}

export function canonicalBlankLengthM(value: Prisma.Decimal | string | number): string {
  return D(value).toFixed(4);
}

function sha256Hex(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function quantityEditStateFingerprint(canonicalMaterial: string): string {
  return `${QEDIT_STATE_FINGERPRINT_VERSION}:${sha256Hex(canonicalMaterial)}`;
}

function requireBlankSpec(line: QuantityEditLine): {
  materialId: string;
  lengthM: string;
  detailType: RailType;
  sort: Sort;
} {
  if (
    line.blankLengthM == null ||
    line.blankType == null ||
    line.blankSort == null ||
    line.blankMaterialId == null
  ) {
    throw new Error("Строка торцовки без спецификации заготовки");
  }
  return {
    materialId: line.blankMaterialId,
    lengthM: canonicalBlankLengthM(line.blankLengthM),
    detailType: line.blankType,
    sort: line.blankSort,
  };
}

export function buildTorcovkaStateCanonical(input: {
  operationId: string;
  line: QuantityEditLine;
}): string {
  const spec = requireBlankSpec(input.line);
  return [
    QEDIT_STATE_FINGERPRINT_VERSION,
    "operationId",
    input.operationId,
    "operationType",
    "TORCOVKA",
    "lineId",
    input.line.id,
    "quantity",
    String(input.line.quantity),
    "blankMaterialId",
    spec.materialId,
    "blankLengthM",
    spec.lengthM,
    "blankType",
    spec.detailType,
    "blankSort",
    spec.sort,
  ].join("\n");
}

export function buildPrisadkaStateCanonical(input: {
  operationId: string;
  line: QuantityEditLine;
}): string {
  if (!input.line.detailId) throw new Error("Строка присадки без детали");
  return [
    QEDIT_STATE_FINGERPRINT_VERSION,
    "operationId",
    input.operationId,
    "operationType",
    "PRISADKA",
    "lineId",
    input.line.id,
    "quantity",
    String(input.line.quantity),
    "detailId",
    input.line.detailId,
    "blankMaterialId",
    input.line.blankMaterialId ?? "",
    "blankLengthM",
    input.line.blankLengthM == null ? "" : canonicalBlankLengthM(input.line.blankLengthM),
    "blankType",
    input.line.blankType ?? "",
    "blankSort",
    input.line.blankSort ?? "",
    "prisadkaTorcevaya",
    input.line.prisadkaTorcevaya ? "1" : "0",
    "prisadkaPloskost",
    input.line.prisadkaPloskost ? "1" : "0",
    "sourceIsBlank",
    input.line.sourceIsBlank ? "1" : "0",
    "sourceTorcevayaDone",
    input.line.sourceTorcevayaDone ? "1" : "0",
    "sourcePloskostDone",
    input.line.sourcePloskostDone ? "1" : "0",
  ].join("\n");
}

function sortLinesById<T extends { id: string }>(lines: T[]): T[] {
  return [...lines].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function serializeDetailLine(line: QuantityEditLine): string {
  return [
    "lineId",
    line.id,
    "quantity",
    String(line.quantity),
    "detailId",
    line.detailId ?? "",
    "blankMaterialId",
    line.blankMaterialId ?? "",
    "blankLengthM",
    line.blankLengthM == null ? "" : canonicalBlankLengthM(line.blankLengthM),
    "blankType",
    line.blankType ?? "",
    "blankSort",
    line.blankSort ?? "",
    "prisadkaTorcevaya",
    line.prisadkaTorcevaya ? "1" : "0",
    "prisadkaPloskost",
    line.prisadkaPloskost ? "1" : "0",
    "sourceIsBlank",
    line.sourceIsBlank ? "1" : "0",
    "sourceTorcevayaDone",
    line.sourceTorcevayaDone ? "1" : "0",
    "sourcePloskostDone",
    line.sourcePloskostDone ? "1" : "0",
  ].join("\n");
}

function serializeNomLine(line: QuantityEditNomLine): string {
  return ["lineId", line.id, "nomenclatureId", line.nomenclatureId, "quantity", String(line.quantity)].join(
    "\n",
  );
}

export function buildUpakovkaStateCanonical(input: {
  operationId: string;
  productId: string;
  productQty: number;
  lines: QuantityEditLine[];
  nomenclatureLines: QuantityEditNomLine[];
}): string {
  const details = sortLinesById(input.lines).map(serializeDetailLine);
  const noms = sortLinesById(input.nomenclatureLines).map(serializeNomLine);
  return [
    QEDIT_STATE_FINGERPRINT_VERSION,
    "operationId",
    input.operationId,
    "operationType",
    "UPAKOVKA",
    "productId",
    input.productId,
    "productQty",
    String(input.productQty),
    "detailLines",
    String(details.length),
    ...details,
    "nomenclatureLines",
    String(noms.length),
    ...noms,
  ].join("\n");
}

export function computeQuantityEditStateFingerprint(input: {
  operationId: string;
  operationType: OperationType;
  productId?: string | null;
  productQty?: number | null;
  line?: QuantityEditLine | null;
  lines?: QuantityEditLine[];
  nomenclatureLines?: QuantityEditNomLine[];
}): string {
  if (input.operationType === "TORCOVKA") {
    if (!input.line) throw new Error("Строка не найдена");
    return quantityEditStateFingerprint(buildTorcovkaStateCanonical({
      operationId: input.operationId,
      line: input.line,
    }));
  }
  if (input.operationType === "PRISADKA") {
    if (!input.line) throw new Error("Строка не найдена");
    return quantityEditStateFingerprint(buildPrisadkaStateCanonical({
      operationId: input.operationId,
      line: input.line,
    }));
  }
  if (input.operationType === "UPAKOVKA") {
    if (!input.productId) throw new Error("У операции не указано изделие");
    return quantityEditStateFingerprint(
      buildUpakovkaStateCanonical({
        operationId: input.operationId,
        productId: input.productId,
        productQty: input.productQty ?? 0,
        lines: input.lines ?? [],
        nomenclatureLines: input.nomenclatureLines ?? [],
      }),
    );
  }
  throw new Error(QUANTITY_EDIT_HOURS_NOT_PHYSICAL);
}

export function buildQuantityEditRequestSnapshot(input: {
  operationId: string;
  targetLineId: string | null;
  expectedOldQuantity: number;
  newQuantity: number;
  expectedStateFingerprint: string;
}): QuantityEditRequestSnapshotV1 {
  return {
    v: 1,
    operationId: input.operationId,
    target: input.targetLineId ? { kind: "LINE", lineId: input.targetLineId } : { kind: "OPERATION" },
    expectedOldQuantity: input.expectedOldQuantity,
    newQuantity: input.newQuantity,
    expectedStateFingerprint: input.expectedStateFingerprint,
  };
}

export function lineProvenanceSnapshot(line: QuantityEditLine): Record<string, unknown> {
  return {
    lineId: line.id,
    quantity: line.quantity,
    detailId: line.detailId,
    blankMaterialId: line.blankMaterialId,
    blankLengthM: line.blankLengthM == null ? null : canonicalBlankLengthM(line.blankLengthM),
    blankType: line.blankType,
    blankSort: line.blankSort,
    prisadkaTorcevaya: line.prisadkaTorcevaya,
    prisadkaPloskost: line.prisadkaPloskost,
    sourceIsBlank: line.sourceIsBlank,
    sourceTorcevayaDone: line.sourceTorcevayaDone,
    sourcePloskostDone: line.sourcePloskostDone,
  };
}

export function nomProvenanceSnapshot(line: QuantityEditNomLine): Record<string, unknown> {
  return {
    lineId: line.id,
    nomenclatureId: line.nomenclatureId,
    quantity: line.quantity,
  };
}

export function buildTorcovkaProvenance(line: QuantityEditLine): Record<string, unknown> {
  return lineProvenanceSnapshot(line);
}

export function buildPrisadkaBeforeProvenance(line: QuantityEditLine): Record<string, unknown> {
  return lineProvenanceSnapshot(line);
}

export function buildPrisadkaAfterProvenance(lines: QuantityEditLine[]): Record<string, unknown> {
  return {
    lines: sortLinesById(lines).map(lineProvenanceSnapshot),
  };
}

export function buildUpakovkaProvenance(input: {
  productId: string;
  productQty: number;
  lines: QuantityEditLine[];
  nomenclatureLines: QuantityEditNomLine[];
}): Record<string, unknown> {
  return {
    productId: input.productId,
    productQty: input.productQty,
    detailLines: sortLinesById(input.lines).map(lineProvenanceSnapshot),
    nomenclatureLines: sortLinesById(input.nomenclatureLines).map(nomProvenanceSnapshot),
  };
}

export type PhysicalKey =
  | { targetType: "BLANK"; materialId: string; lengthM: string; detailType: RailType; sort: Sort }
  | { targetType: "DETAIL"; detailId: string; torcevayaDone: boolean; ploskostDone: boolean }
  | { targetType: "NOMENCLATURE"; nomenclatureId: string }
  | { targetType: "PRODUCT"; productId: string };

function physicalTargetKey(key: PhysicalKey): string {
  if (key.targetType === "BLANK") {
    return `BLANK|${key.materialId}|${key.lengthM}|${key.detailType}|${key.sort}`;
  }
  if (key.targetType === "DETAIL") {
    return `DETAIL|${key.detailId}|${key.torcevayaDone ? "1" : "0"}|${key.ploskostDone ? "1" : "0"}`;
  }
  if (key.targetType === "NOMENCLATURE") {
    return `NOMENCLATURE|${key.nomenclatureId}`;
  }
  return `PRODUCT|${key.productId}`;
}

function collectLinePhysicalKeys(line: QuantityEditLine, keys: Map<string, PhysicalKey>): void {
  if (line.detailId) {
    const dest: PhysicalKey = {
      targetType: "DETAIL",
      detailId: line.detailId,
      torcevayaDone: line.prisadkaTorcevaya,
      ploskostDone: line.prisadkaPloskost,
    };
    keys.set(physicalTargetKey(dest), dest);
    if (!line.sourceIsBlank) {
      const src: PhysicalKey = {
        targetType: "DETAIL",
        detailId: line.detailId,
        torcevayaDone: line.sourceTorcevayaDone,
        ploskostDone: line.sourcePloskostDone,
      };
      keys.set(physicalTargetKey(src), src);
    }
  }
  if (line.blankMaterialId && line.blankLengthM != null && line.blankType && line.blankSort) {
    const blank: PhysicalKey = {
      targetType: "BLANK",
      materialId: line.blankMaterialId,
      lengthM: canonicalBlankLengthM(line.blankLengthM),
      detailType: line.blankType,
      sort: line.blankSort,
    };
    keys.set(physicalTargetKey(blank), blank);
  }
}

export function collectPhysicalKeys(input: {
  productId?: string | null;
  lines: QuantityEditLine[];
  nomenclatureLines: QuantityEditNomLine[];
}): PhysicalKey[] {
  const keys = new Map<string, PhysicalKey>();
  if (input.productId) {
    const product: PhysicalKey = { targetType: "PRODUCT", productId: input.productId };
    keys.set(physicalTargetKey(product), product);
  }
  for (const line of input.lines) collectLinePhysicalKeys(line, keys);
  for (const line of input.nomenclatureLines) {
    const nom: PhysicalKey = { targetType: "NOMENCLATURE", nomenclatureId: line.nomenclatureId };
    keys.set(physicalTargetKey(nom), nom);
  }
  return [...keys.values()];
}

export function mergePhysicalKeys(...lists: PhysicalKey[][]): PhysicalKey[] {
  const keys = new Map<string, PhysicalKey>();
  for (const list of lists) {
    for (const key of list) keys.set(physicalTargetKey(key), key);
  }
  return [...keys.values()];
}

export function collectPreparedUpakovkaPhysicalKeys(prepared: PreparedUpakovkaApply): PhysicalKey[] {
  const keys = new Map<string, PhysicalKey>();
  const product: PhysicalKey = { targetType: "PRODUCT", productId: prepared.productId };
  keys.set(physicalTargetKey(product), product);
  for (const detail of prepared.details) {
    if (detail.prisadkaTorcevaya || detail.prisadkaPloskost) {
      const dest: PhysicalKey = {
        targetType: "DETAIL",
        detailId: detail.detailId,
        torcevayaDone: detail.prisadkaTorcevaya,
        ploskostDone: detail.prisadkaPloskost,
      };
      keys.set(physicalTargetKey(dest), dest);
    } else {
      const blank: PhysicalKey = {
        targetType: "BLANK",
        materialId: detail.materialId,
        lengthM: canonicalBlankLengthM(detail.lengthM),
        detailType: detail.detailType,
        sort: detail.sort,
      };
      keys.set(physicalTargetKey(blank), blank);
    }
  }
  for (const fastener of prepared.fasteners) {
    const nom: PhysicalKey = { targetType: "NOMENCLATURE", nomenclatureId: fastener.nomenclatureId };
    keys.set(physicalTargetKey(nom), nom);
  }
  if (prepared.packagingId) {
    const nom: PhysicalKey = { targetType: "NOMENCLATURE", nomenclatureId: prepared.packagingId };
    keys.set(physicalTargetKey(nom), nom);
  }
  for (const extra of prepared.extras) {
    const nom: PhysicalKey = { targetType: "NOMENCLATURE", nomenclatureId: extra.nomenclatureId };
    keys.set(physicalTargetKey(nom), nom);
  }
  return [...keys.values()];
}

export async function collectExistingDetailStockKeys(
  tx: Prisma.TransactionClient,
  detailIds: Iterable<string>,
): Promise<PhysicalKey[]> {
  const unique = [...new Set([...detailIds].filter(Boolean))].sort();
  if (unique.length === 0) return [];
  const rows = await tx.detailStock.findMany({
    where: { detailId: { in: unique } },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => ({
    targetType: "DETAIL" as const,
    detailId: row.detailId,
    torcevayaDone: row.torcevayaDone,
    ploskostDone: row.ploskostDone,
  }));
}

export async function lockQuantityEditPhysicalTargets(
  tx: Prisma.TransactionClient,
  keys: PhysicalKey[],
): Promise<void> {
  const detailIds = keys.filter((k) => k.targetType === "DETAIL").map((k) => k.detailId);
  const blanks = keys
    .filter((k): k is Extract<PhysicalKey, { targetType: "BLANK" }> => k.targetType === "BLANK")
    .map((k) => ({
      materialId: k.materialId,
      lengthM: k.lengthM,
      detailType: k.detailType,
      sort: k.sort,
    }));
  const noms = keys
    .filter((k): k is Extract<PhysicalKey, { targetType: "NOMENCLATURE" }> => k.targetType === "NOMENCLATURE")
    .map((k) => k.nomenclatureId);
  const products = keys
    .filter((k): k is Extract<PhysicalKey, { targetType: "PRODUCT" }> => k.targetType === "PRODUCT")
    .map((k) => k.productId);

  await lockDetails(tx, detailIds);
  await lockBlankSpecs(tx, blanks);
  if (detailIds.length > 0) {
    const stocks = await tx.detailStock.findMany({
      where: { detailId: { in: [...new Set(detailIds)].sort() } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    await lockDetailStocks(tx, stocks.map((s) => s.id));
  }
  await lockNomenclatureIds(tx, noms);
  await lockProductIds(tx, products);
}

export async function snapshotPhysicalQuantities(
  tx: Prisma.TransactionClient,
  keys: PhysicalKey[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const key of keys) {
    const id = physicalTargetKey(key);
    if (key.targetType === "BLANK") {
      const row = await tx.blankStock.findUnique({
        where: {
          materialId_lengthM_detailType_sort: {
            materialId: key.materialId,
            lengthM: key.lengthM,
            detailType: key.detailType,
            sort: key.sort,
          },
        },
      });
      out.set(id, row?.quantity ?? 0);
      continue;
    }
    if (key.targetType === "DETAIL") {
      const row = await tx.detailStock.findUnique({
        where: {
          detailId_torcevayaDone_ploskostDone: {
            detailId: key.detailId,
            torcevayaDone: key.torcevayaDone,
            ploskostDone: key.ploskostDone,
          },
        },
      });
      out.set(id, row?.quantity ?? 0);
      continue;
    }
    if (key.targetType === "NOMENCLATURE") {
      const row = await tx.nomenclatureStock.findUnique({
        where: { nomenclatureId: key.nomenclatureId },
      });
      out.set(id, row?.quantity ?? 0);
      continue;
    }
    const row = await tx.productStock.findUnique({
      where: { productId: key.productId },
    });
    out.set(id, row?.quantity ?? 0);
  }
  return out;
}

export function derivePhysicalAdjustments(
  keys: PhysicalKey[],
  before: Map<string, number>,
  after: Map<string, number>,
): QuantityEditPhysicalAdjustment[] {
  const adjustments: QuantityEditPhysicalAdjustment[] = [];
  for (const key of keys) {
    const id = physicalTargetKey(key);
    if (!before.has(id)) {
      throw new Error(`${QUANTITY_EDIT_BEFORE_SNAPSHOT_INCOMPLETE}: ${id}`);
    }
    if (!after.has(id)) {
      throw new Error(`${QUANTITY_EDIT_BEFORE_SNAPSHOT_INCOMPLETE}: after:${id}`);
    }
    const quantityDelta = after.get(id)! - before.get(id)!;
    if (quantityDelta === 0) continue;
    if (key.targetType === "BLANK") {
      adjustments.push({ ...key, quantityDelta });
    } else if (key.targetType === "DETAIL") {
      adjustments.push({ ...key, quantityDelta });
    } else if (key.targetType === "NOMENCLATURE") {
      adjustments.push({ ...key, quantityDelta });
    } else {
      adjustments.push({ ...key, quantityDelta });
    }
  }
  return sortPhysicalAdjustments(adjustments);
}

export function physicalAdjustmentSortKey(adjustment: QuantityEditPhysicalAdjustment): string {
  if (adjustment.targetType === "BLANK") {
    return `BLANK|${adjustment.materialId}|${adjustment.lengthM}|${adjustment.detailType}|${adjustment.sort}`;
  }
  if (adjustment.targetType === "DETAIL") {
    return `DETAIL|${adjustment.detailId}|${adjustment.torcevayaDone ? "1" : "0"}|${adjustment.ploskostDone ? "1" : "0"}`;
  }
  if (adjustment.targetType === "NOMENCLATURE") {
    return `NOMENCLATURE|${adjustment.nomenclatureId}`;
  }
  return `PRODUCT|${adjustment.productId}`;
}

export function sortPhysicalAdjustments(
  adjustments: QuantityEditPhysicalAdjustment[],
): QuantityEditPhysicalAdjustment[] {
  return [...adjustments].sort((a, b) => {
    if (a.targetType !== b.targetType) return a.targetType < b.targetType ? -1 : 1;
    const ka = physicalAdjustmentSortKey(a);
    const kb = physicalAdjustmentSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function buildQuantityEditEffectSnapshot(input: {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  physicalAdjustments: QuantityEditPhysicalAdjustment[];
}): QuantityEditEffectSnapshotV1 {
  return {
    v: 1,
    before: input.before,
    after: input.after,
    physicalAdjustments: sortPhysicalAdjustments(input.physicalAdjustments),
  };
}

export function assertNoMoneyInQuantityEditContract(value: unknown, path = "root"): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoMoneyInQuantityEditContract(item, `${path}[${i}]`));
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(value|money|amount|cost|price|rate)/i.test(key)) {
      throw new Error(`Quantity-edit contract must not include monetary field ${path}.${key}`);
    }
    assertNoMoneyInQuantityEditContract(child, `${path}.${key}`);
  }
}
