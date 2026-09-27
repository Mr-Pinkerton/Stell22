export const UPAKOVKA_PARTIAL_TITLE = "Часть изделий уже записана";
export const UPAKOVKA_PARTIAL_BODY =
  "Вся упаковка не сохранена. Сверьте журнал с фактически упакованными изделиями. Повторно отправлять весь набор не нужно.";
export const UPAKOVKA_RECOVERY_HINT =
  "Укажите количество только тех изделий, которые ещё не учтены. Количество не подставляется само. Не отмечайте изделия, которые уже упакованы отдельной операцией.";
export const UPAKOVKA_RECOVERY_ACTION = "Начать отдельную упаковку";
export const UPAKOVKA_RECOVERY_CONFIRM = "Сохранить отдельную упаковку";

export function unrecordedCandidates(opts: {
  draftPicks: readonly { productId: string; quantity: number }[];
  savedProductIds: readonly string[];
  separatelyPackedIds?: readonly string[];
}): string[] {
  const blocked = new Set([...opts.savedProductIds, ...(opts.separatelyPackedIds ?? [])]);
  const ids: string[] = [];
  for (const pick of opts.draftPicks) {
    if (!pick.productId || pick.quantity <= 0 || blocked.has(pick.productId)) continue;
    if (!ids.includes(pick.productId)) ids.push(pick.productId);
  }
  return ids;
}

/** Uses only quantities the employee entered for the new request. */
export function confirmedRecoveryPicks(opts: {
  candidates: readonly string[];
  confirmedQuantities: Readonly<Record<string, number>>;
  savedProductIds: readonly string[];
}): { productId: string; quantity: number }[] {
  const saved = new Set(opts.savedProductIds);
  const allowed = new Set(opts.candidates);
  const picks: { productId: string; quantity: number }[] = [];
  for (const productId of opts.candidates) {
    if (!allowed.has(productId) || saved.has(productId)) continue;
    const quantity = opts.confirmedQuantities[productId] ?? 0;
    if (!Number.isInteger(quantity) || quantity <= 0) continue;
    picks.push({ productId, quantity });
  }
  return picks;
}
