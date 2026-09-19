/** PSR-P2 R-05: retained identity for `correctTorcovkaRailsTaken`. Not Correction Center. */

import type { Prisma } from "@prisma/client";

export const STALE_CORRECTION =
  "STALE_CORRECTION: текущее количество реек не совпадает с ожидаемым";

export const REQUEST_ID_REUSE =
  "REQUEST_ID_REUSE: ключ попытки уже использован для другой команды";

/**
 * Dedicated two-int advisory namespace for R-05 requestId serialization.
 * Distinct from R-10 InventoryMovement SHADOW `(8322, 1)`.
 * key2 = hashtext(requestId); collisions only extra-serialize.
 */
export const R05_CORRECTION_REQUEST_LOCK_NAMESPACE = 8325;

export const R05_CORRECTION_REQUEST_LOCK_TX_REQUIRED =
  "R-05 correction request lock requires an open Prisma transaction client.";

export async function acquireCorrectionRequestLock(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<void> {
  if (typeof (tx as { $transaction?: unknown }).$transaction === "function") {
    throw new Error(R05_CORRECTION_REQUEST_LOCK_TX_REQUIRED);
  }
  await tx.$queryRaw`
    SELECT 1 AS acquired
    FROM (
      SELECT pg_advisory_xact_lock(
        ${R05_CORRECTION_REQUEST_LOCK_NAMESPACE}::integer,
        hashtext(${requestId})
      )
    ) AS r05_correction_request_lock
  `;
}

export interface ProductionOperationCorrectionPayload {
  operationId: string;
  adminUserId: string;
  expectedOldRailsTaken: number;
  newRailsTaken: number;
  reason: string;
}

export interface CorrectTorcovkaRailsTakenResult {
  correctionId: string;
  requestId: string;
  operationId: string;
  oldRailsTaken: number;
  newRailsTaken: number;
  deltaReturned: number;
  recordedAt: Date;
  replayed: boolean;
}

export function canonicalCorrectionReason(reason: string): string {
  return reason.trim();
}

export function correctionDeltaReturned(expectedOldRailsTaken: number, newRailsTaken: number): number {
  return expectedOldRailsTaken - newRailsTaken;
}

export function assertCorrectionCommandIntegers(input: {
  expectedOldRailsTaken: number;
  newRailsTaken: number;
}): void {
  const { expectedOldRailsTaken, newRailsTaken } = input;
  if (!Number.isInteger(expectedOldRailsTaken) || expectedOldRailsTaken <= 0) {
    throw new Error("Ожидаемое количество реек должно быть целым и больше нуля");
  }
  if (!Number.isInteger(newRailsTaken) || newRailsTaken <= 0) {
    throw new Error("Количество реек должно быть целым и больше нуля");
  }
  if (!(newRailsTaken < expectedOldRailsTaken)) {
    throw new Error("Можно только уменьшить количество фактически взятых реек");
  }
}

export function correctionPayloadMatches(
  stored: ProductionOperationCorrectionPayload,
  incoming: ProductionOperationCorrectionPayload,
): boolean {
  return (
    stored.operationId === incoming.operationId &&
    stored.adminUserId === incoming.adminUserId &&
    stored.expectedOldRailsTaken === incoming.expectedOldRailsTaken &&
    stored.newRailsTaken === incoming.newRailsTaken &&
    stored.reason === incoming.reason
  );
}

export function assertCorrectionPayloadMatch(
  stored: ProductionOperationCorrectionPayload,
  incoming: ProductionOperationCorrectionPayload,
): void {
  if (!correctionPayloadMatches(stored, incoming)) {
    throw new Error(REQUEST_ID_REUSE);
  }
}

export function correctionResultFromRow(
  row: {
    id: string;
    requestId: string;
    operationId: string;
    expectedOldRailsTaken: number;
    newRailsTaken: number;
    deltaReturned: number;
    recordedAt: Date;
  },
  replayed: boolean,
): CorrectTorcovkaRailsTakenResult {
  return {
    correctionId: row.id,
    requestId: row.requestId,
    operationId: row.operationId,
    oldRailsTaken: row.expectedOldRailsTaken,
    newRailsTaken: row.newRailsTaken,
    deltaReturned: row.deltaReturned,
    recordedAt: row.recordedAt,
    replayed,
  };
}
