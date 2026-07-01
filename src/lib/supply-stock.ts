// Чистая логика списания склада производства по поставке МП.
// Используется в src/server/marketplace.ts (синхронизация) и покрыта тестами.

export interface SupplyDeductionInput {
  /** Сколько единиц должно быть учтено к текущему моменту (0 — не отгружено). */
  targetQty: number;
  /** Уже фактически списано со склада производства. */
  alreadyDeducted: number;
  /** Уже учтённая недостача ГП (в минус не уходим). */
  alreadyShort: number;
  /** Доступный остаток на складе производства. */
  available: number;
}

export interface SupplyDeductionResult {
  /** Списать со склада прямо сейчас. */
  toRemove: number;
  /** Новая недостача ГП прямо сейчас («потеря ГП»). */
  shortfall: number;
  /** Итоговое фактически списанное (для хранения в Supply.deductedQty). */
  newDeducted: number;
  /** Итоговая учтённая недостача (Supply.shortfallQty). */
  newShort: number;
}

/**
 * Идемпотентный расчёт списания: учитываем только «новую» часть
 * (target − уже учтённое), где учтённое = фактически списано + недостача.
 * Недостача не списывается повторно; в минус склад не уходит.
 */
export function computeSupplyDeduction(input: SupplyDeductionInput): SupplyDeductionResult {
  const { targetQty, alreadyDeducted, alreadyShort, available } = input;
  const delta = targetQty - (alreadyDeducted + alreadyShort);

  if (delta <= 0) {
    return {
      toRemove: 0,
      shortfall: 0,
      newDeducted: alreadyDeducted,
      newShort: alreadyShort,
    };
  }

  const toRemove = Math.max(0, Math.min(delta, Math.max(0, available)));
  const shortfall = delta - toRemove;

  return {
    toRemove,
    shortfall,
    newDeducted: alreadyDeducted + toRemove,
    newShort: alreadyShort + shortfall,
  };
}
