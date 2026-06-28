// =============================================================================
// Процент отхода — чистые функции по разделу «ОТЧЁТЫ / ПРОЦЕНТ ОТХОДА»
// и «ПРАВИЛА УЧЁТА МАТЕРИАЛА» (Описание проекта v2).
//
//   Отход = суммарная длина взятых реек − суммарная длина произведённых деталей.
//
// Длины — Decimal (см. cost.ts), точность внутри не теряем.
// =============================================================================

import { D, type Num } from "@/lib/cost";
import type { Decimal } from "decimal.js";

const ZERO = D(0);

/** Длина отхода = взято − произведено (не уходит ниже нуля). */
export function wasteLengthM(takenM: Num, producedM: Num): Decimal {
  const waste = D(takenM).minus(D(producedM));
  return waste.isNegative() ? ZERO : waste;
}

/** Процент отхода = отход / база × 100 (0 при нулевой базе). */
export function wastePercent(wasteM: Num, baseM: Num): Decimal {
  const base = D(baseM);
  if (base.isZero()) return ZERO;
  return D(wasteM).div(base).times(100);
}

export interface BatchWasteInput {
  /** Закуплено реек, м (сумма длин всех реек партии). */
  purchasedM: Num;
  /** Взято в торцовку, м. */
  takenM: Num;
  /** Произведено деталей, м (сумма длин произведённых деталей). */
  producedM: Num;
  /** Списано остатка в отход, м. */
  writtenOffM?: Num;
}

export interface BatchWasteResult {
  remainingM: Decimal;
  wasteTorcovkaM: Decimal;
  writtenOffM: Decimal;
  /** Израсходовано материала = взято + списано. */
  consumedM: Decimal;
  /** Весь отход = торцовка + списанное. */
  totalWasteM: Decimal;
  /** Процент отхода = весь отход / израсходовано × 100. */
  wastePct: Decimal;
}

/**
 * Отход по партии. Остаток (ещё не отход) отделён от списанного.
 * База процента — израсходованный материал (взято на торцовку + списано),
 * чтобы остаток «в работе» не занижал процент.
 */
export function batchWaste(input: BatchWasteInput): BatchWasteResult {
  const purchased = D(input.purchasedM);
  const taken = D(input.takenM);
  const writtenOff = D(input.writtenOffM ?? 0);

  const remaining = purchased.minus(taken).minus(writtenOff);
  const wasteTorcovka = wasteLengthM(taken, input.producedM);
  const consumed = taken.plus(writtenOff);
  const totalWaste = wasteTorcovka.plus(writtenOff);

  return {
    remainingM: remaining.isNegative() ? ZERO : remaining,
    wasteTorcovkaM: wasteTorcovka,
    writtenOffM: writtenOff,
    consumedM: consumed,
    totalWasteM: totalWaste,
    wastePct: wastePercent(totalWaste, consumed),
  };
}

export interface EmployeeWasteResult {
  wasteM: Decimal;
  /** Процент отхода = отход / взято × 100. */
  wastePct: Decimal;
}

/** Отход по работнику: отход = взято − произведено, процент к взятому. */
export function employeeWaste(takenM: Num, producedM: Num): EmployeeWasteResult {
  const waste = wasteLengthM(takenM, producedM);
  return { wasteM: waste, wastePct: wastePercent(waste, takenM) };
}

/** Превышение порога отхода (по умолчанию 30%) — сигнал на дашборд. */
export function isWasteOverThreshold(wastePct: Num, thresholdPct: Num = 30): boolean {
  return D(wastePct).gt(D(thresholdPct));
}
