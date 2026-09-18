/** PSR-P2 R-05: retained identity for `correctTorcovkaRailsTaken`. Not Correction Center. */

export const STALE_CORRECTION =
  "STALE_CORRECTION: текущее количество реек не совпадает с ожидаемым";

export const REQUEST_ID_REUSE =
  "REQUEST_ID_REUSE: ключ попытки уже использован для другой команды";

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
