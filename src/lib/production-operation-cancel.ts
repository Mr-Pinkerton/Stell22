export const CANCEL_PAID_BLOCKED =
  "Нельзя аннулировать — операция уже выплачена. Изменение выплаты требует отдельной проверенной корректировки.";
export const CANCEL_FROZEN_BLOCKED =
  "Нельзя аннулировать — себестоимость партии заморожена.";
export const CANCEL_DOWNSTREAM_BLOCKED =
  "Нельзя аннулировать: результат этой записи уже израсходован следующими операциями.";
export const CANCEL_ALREADY =
  "Операция уже аннулирована и остаётся в журнале.";
export const CANCEL_EDIT_BLOCKED = "Операция аннулирована — правка недоступна.";
export const STALE_OPERATION_CANCEL =
  "Запись уже изменилась. Обновите страницу и повторите аннулирование.";
export const CANCEL_REASON_REQUIRED = "Укажите причину аннулирования";
export const CANCEL_REQUEST_ID_REUSE =
  "REQUEST_ID_REUSE: ключ попытки уже использован для другой команды";

const SUPPORTED = new Set(["TORCOVKA", "PRISADKA", "UPAKOVKA", "HOURS"]);

export type CancelFingerprintInput = {
  operationId: string;
  type: string;
  isPaid: boolean;
  cancelledAt: string | null;
  railsTaken: number | null;
  hours: string | null;
  productQty: number | null;
  lines: Array<{ id: string; quantity: number }>;
};

export type CancelCommandPayload = {
  operationId: string;
  adminUserId: string;
  reason: string;
  expectedStateFingerprint: string;
};

export function canonicalCancelReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error(CANCEL_REASON_REQUIRED);
  if (trimmed.length > 500) throw new Error("Причина слишком длинная");
  return trimmed;
}

export function productionCancelFingerprint(input: CancelFingerprintInput): string {
  const lines = input.lines
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((line) => `${line.id}:${line.quantity}`)
    .join(",");
  return [
    input.operationId,
    input.type,
    input.isPaid ? "1" : "0",
    input.cancelledAt ?? "",
    input.railsTaken ?? "",
    input.hours ?? "",
    input.productQty ?? "",
    lines,
  ].join("|");
}

export function assertSupportedCancelType(type: string): void {
  if (!SUPPORTED.has(type)) {
    throw new Error("Аннулирование этого типа операции недоступно.");
  }
}

export function cancellationPayloadMatches(
  stored: CancelCommandPayload,
  incoming: CancelCommandPayload,
): boolean {
  return (
    stored.operationId === incoming.operationId &&
    stored.adminUserId === incoming.adminUserId &&
    stored.reason === incoming.reason &&
    stored.expectedStateFingerprint === incoming.expectedStateFingerprint
  );
}

export function assertCancellationPayloadMatch(
  stored: CancelCommandPayload,
  incoming: CancelCommandPayload,
): void {
  if (!cancellationPayloadMatches(stored, incoming)) {
    throw new Error(CANCEL_REQUEST_ID_REUSE);
  }
}

export function cancelCommandKey(input: {
  operationId: string;
  expectedStateFingerprint: string;
  reason: string;
}): string {
  return [input.operationId, input.expectedStateFingerprint, input.reason.trim()].join("\0");
}

export function shouldRotateCancelRequestId(errorMessage: string): boolean {
  return (
    errorMessage.startsWith(STALE_OPERATION_CANCEL) ||
    errorMessage.startsWith("REQUEST_ID_REUSE")
  );
}
