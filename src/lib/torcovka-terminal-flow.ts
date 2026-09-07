/** Клиентская UX-логика TORCOVKA: пререквизиты, грязный ввод, смена лота/партии. */

export const OPERATION_SAVED_TITLE = "Операция сохранена";
export const SUCCESS_ACK_TIMEOUT_MS = 8000;

export const TORCOVKA_SWITCH_WARNING = "Введённые данные будут сброшены.";
export const TORCOVKA_SWITCH_STAY = "Остаться";
export const TORCOVKA_SWITCH_RESET = "Сбросить и сменить";

export function canEnterTorcovkaBlanks(opts: {
  lotId: string | null;
  railsTaken: number;
}): boolean {
  return Boolean(opts.lotId) && opts.railsTaken > 0;
}

export function isTorcovkaDirty(opts: { railsTaken: number; pickedCount: number }): boolean {
  return opts.railsTaken > 0 || opts.pickedCount > 0;
}

export type LotTapDecision =
  | { action: "edit-rails" }
  | { action: "open-pending-rails"; nextLotId: string }
  | { action: "confirm-switch"; nextLotId: string };

export function decideLotTap(opts: {
  tappedLotId: string;
  committedLotId: string | null;
  dirty: boolean;
}): LotTapDecision {
  if (opts.tappedLotId === opts.committedLotId) return { action: "edit-rails" };
  if (opts.dirty) return { action: "confirm-switch", nextLotId: opts.tappedLotId };
  return { action: "open-pending-rails", nextLotId: opts.tappedLotId };
}

export type BatchTapDecision = "noop" | "switch" | "confirm-switch";

export function decideBatchTap(opts: {
  tappedBatchId: string;
  committedBatchId: string | null;
  dirty: boolean;
}): BatchTapDecision {
  if (opts.tappedBatchId === opts.committedBatchId) return "noop";
  if (opts.dirty) return "confirm-switch";
  return "switch";
}

export function applyRailsConfirmed(opts: {
  pendingLotId: string;
  committedLotId: string | null;
  railsTaken: number;
}): { lotId: string; railsTaken: number; resetPicks: boolean } {
  return {
    lotId: opts.pendingLotId,
    railsTaken: opts.railsTaken,
    resetPicks: opts.pendingLotId !== opts.committedLotId,
  };
}

export function applyRailsCancelled(): { pendingLotId: null } {
  return { pendingLotId: null };
}

export function nextTorcovkaStateAfterSuccess(opts: {
  batchId: string | null;
  lotId: string | null;
  batches: { id: string }[];
  lots: { id: string; remainingQuantity: number }[];
}): { batchId: string | null; lotId: string | null; railsTaken: 0 } {
  const batchId =
    opts.batchId != null && opts.batches.some((b) => b.id === opts.batchId) ? opts.batchId : null;
  if (!batchId) return { batchId: null, lotId: null, railsTaken: 0 };
  const lot = opts.lots.find((l) => l.id === opts.lotId);
  const lotId = lot && lot.remainingQuantity > 0 ? lot.id : null;
  return { batchId, lotId, railsTaken: 0 };
}

export function torcovkaBlankPrerequisiteHint(opts: {
  batchId: string | null;
  lotId: string | null;
  railsTaken: number;
}): string | null {
  if (!opts.batchId) return null;
  if (!opts.lotId) return "Выберите пакет / рейку";
  if (opts.railsTaken <= 0) return "Укажите количество взятых реек";
  return null;
}

export function shouldShowTorcovkaConfirmBar(opts: { pickedCount: number }): boolean {
  return opts.pickedCount > 0;
}

/** После успеха партия/лот остаются на экране, но cleared draft нельзя сразу перезаписать. */
export function shouldSkipTorcovkaDraftPersist(opts: {
  suppressPostSuccess: boolean;
  railsTaken: number;
  pickedCount: number;
}): boolean {
  return opts.suppressPostSuccess && !isTorcovkaDirty(opts);
}

/** Refresh после уже записанной операции: не маскировать под «Ошибка внесения». */
export const TERMINAL_REFRESH_AFTER_SAVE_WARNING =
  `${OPERATION_SAVED_TITLE}, но не удалось обновить данные терминала`;

export async function refreshAfterSavedOperation(
  refresh: () => Promise<void>,
): Promise<"ok" | "refresh-failed"> {
  try {
    await refresh();
    return "ok";
  } catch {
    return "refresh-failed";
  }
}

function blankNoun(count: number): string {
  const n10 = count % 10;
  const n100 = count % 100;
  if (n10 === 1 && n100 !== 11) return "заготовка";
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return "заготовки";
  return "заготовок";
}

export function torcovkaSavedDetail(count: number): string {
  return `Торцовка сохранена: ${count} ${blankNoun(count)}`;
}
