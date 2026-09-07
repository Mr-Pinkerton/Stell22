/** Правила подтверждения количества в QuantityDialog (клиентский UX). */

export function canConfirmQuantity(opts: {
  numeric: number;
  max?: number;
  allowZero?: boolean;
}): boolean {
  if (!Number.isFinite(opts.numeric) || opts.numeric < 0) return false;
  if (opts.max != null && opts.numeric > opts.max) return false;
  if (opts.numeric === 0) return opts.allowZero === true;
  return opts.numeric > 0;
}

/** `null` — снять одну выбранную позицию, не трогая остальные. */
export function nextPickedQuantity(value: number): number | null {
  return value > 0 ? value : null;
}
