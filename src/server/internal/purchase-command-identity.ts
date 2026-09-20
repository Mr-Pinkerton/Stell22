/** PSR-P2 raw receipt/write-off retained identities. Not InventoryMovement. */

import { Decimal } from "decimal.js";
import type { Prisma } from "@prisma/client";
import type { BatchFormValues, BatchRailInput, SimplePurchaseFormValues } from "@/server/purchases";

export const PURCHASE_REQUEST_ID_REUSE = "PURCHASE_REQUEST_ID_REUSE";
export const PURCHASE_REPLAY_TARGET_MISSING = "PURCHASE_REPLAY_TARGET_MISSING";

/**
 * Dedicated two-int advisory namespace for purchase command requestId serialization.
 * Distinct from SHADOW `(8322, 1)` and R-05 `8325`.
 * key2 = hashtext(kind:requestId); collisions only extra-serialize.
 */
export const PURCHASE_COMMAND_REQUEST_LOCK_NAMESPACE = 8326;

export const PURCHASE_COMMAND_REQUEST_LOCK_TX_REQUIRED =
  "Purchase command request lock requires an open Prisma transaction client.";

export type PurchaseCommandKind = "batch-create" | "batch-writeoff" | "simple-purchase";

export function purchaseCommandLockKey(kind: PurchaseCommandKind, requestId: string): string {
  return `${kind}:${requestId}`;
}

export async function acquirePurchaseCommandRequestLock(
  tx: Prisma.TransactionClient,
  kind: PurchaseCommandKind,
  requestId: string,
): Promise<void> {
  if (typeof (tx as { $transaction?: unknown }).$transaction === "function") {
    throw new Error(PURCHASE_COMMAND_REQUEST_LOCK_TX_REQUIRED);
  }
  const lockKey = purchaseCommandLockKey(kind, requestId);
  await tx.$queryRaw`
    SELECT 1 AS acquired
    FROM (
      SELECT pg_advisory_xact_lock(
        ${PURCHASE_COMMAND_REQUEST_LOCK_NAMESPACE}::integer,
        hashtext(${lockKey})
      )
    ) AS purchase_command_request_lock
  `;
}

export function exactFixedDecimal(value: number, places: number): string {
  return new Decimal(value).toFixed(places);
}

export function moneySnapshotString(value: number): string {
  return exactFixedDecimal(value, 2);
}

export function lengthSnapshotString(value: number): string {
  return exactFixedDecimal(value, 4);
}

export interface BatchCreateRailSnapshotV1 {
  mode: BatchRailInput["mode"];
  lengthM: string;
  railType: BatchRailInput["railType"];
  sort: BatchRailInput["sort"];
  quantity: number;
  rows: number | null;
  layers: number | null;
}

export interface BatchCreateRequestSnapshotV1 {
  v: 1;
  d: "BATCH_CREATE";
  name: string;
  materialId: string;
  purchaseDateInput: string | null;
  purchaseCost: string;
  priceSort1: string;
  priceSort2: string;
  note: string | null;
  rails: BatchCreateRailSnapshotV1[];
}

export interface SimplePurchaseCreateRequestSnapshotV1 {
  v: 1;
  d: "SIMPLE_PURCHASE_CREATE";
  nomenclatureId: string;
  quantity: number;
  unitPrice: string;
  purchaseDateInput: string | null;
}

export interface BatchRemainderWriteOffEffectV1 {
  railLotId: string;
  quantityBefore: number;
  quantityDelta: number;
}

export interface BatchRemainderWriteOffSnapshotV1 {
  v: 1;
  d: "BATCH_REMAINDER_WRITEOFF";
  batchId: string;
  effects: BatchRemainderWriteOffEffectV1[];
}

export function canonicalBatchCreateSnapshot(values: BatchFormValues): BatchCreateRequestSnapshotV1 {
  return {
    v: 1,
    d: "BATCH_CREATE",
    name: values.name.trim(),
    materialId: values.materialId,
    purchaseDateInput: values.purchaseDate,
    purchaseCost: moneySnapshotString(values.purchaseCost ?? 0),
    priceSort1: moneySnapshotString(values.priceSort1 ?? 0),
    priceSort2: moneySnapshotString(values.priceSort2 ?? 0),
    note: values.note.trim() || null,
    rails: values.rails.map((r) => ({
      mode: r.mode,
      lengthM: lengthSnapshotString(r.lengthM),
      railType: r.railType,
      sort: r.sort,
      quantity: r.quantity,
      rows: r.rows ?? null,
      layers: r.layers ?? null,
    })),
  };
}

export function canonicalSimplePurchaseSnapshot(
  values: SimplePurchaseFormValues,
): SimplePurchaseCreateRequestSnapshotV1 {
  return {
    v: 1,
    d: "SIMPLE_PURCHASE_CREATE",
    nomenclatureId: values.nomenclatureId,
    quantity: values.quantity ?? 0,
    unitPrice: moneySnapshotString(values.unitPrice ?? 0),
    purchaseDateInput: values.purchaseDate,
  };
}

export function canonicalWriteOffEffectSnapshot(input: {
  batchId: string;
  lots: Array<{ id: string; remainingQuantity: number }>;
}): BatchRemainderWriteOffSnapshotV1 {
  const effects = input.lots
    .filter((lot) => lot.remainingQuantity > 0)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((lot) => ({
      railLotId: lot.id,
      quantityBefore: lot.remainingQuantity,
      quantityDelta: -lot.remainingQuantity,
    }));
  return {
    v: 1,
    d: "BATCH_REMAINDER_WRITEOFF",
    batchId: input.batchId,
    effects,
  };
}

export function writeOffTotalQuantity(snapshot: BatchRemainderWriteOffSnapshotV1): number {
  return snapshot.effects.reduce((sum, effect) => sum + effect.quantityBefore, 0);
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalizeJson((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function snapshotsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalizeJson(a)) === JSON.stringify(canonicalizeJson(b));
}

export function snapshotJsonValue(snapshot: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue;
}

export function assertPurchaseCommandMatch(input: {
  storedAdminUserId: string;
  incomingAdminUserId: string;
  storedSnapshot?: unknown;
  incomingSnapshot?: unknown;
  storedBatchId?: string;
  incomingBatchId?: string;
}): void {
  if (input.storedAdminUserId !== input.incomingAdminUserId) {
    throw new Error(PURCHASE_REQUEST_ID_REUSE);
  }
  if (
    input.storedBatchId !== undefined &&
    input.incomingBatchId !== undefined &&
    input.storedBatchId !== input.incomingBatchId
  ) {
    throw new Error(PURCHASE_REQUEST_ID_REUSE);
  }
  if (
    input.storedSnapshot !== undefined &&
    input.incomingSnapshot !== undefined &&
    !snapshotsEqual(input.storedSnapshot, input.incomingSnapshot)
  ) {
    throw new Error(PURCHASE_REQUEST_ID_REUSE);
  }
}
