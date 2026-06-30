// =============================================================================
// Расчёт ЗП и трудозатрат для себестоимости — чистые функции по разделам
// «СОТРУДНИКИ» и «МОДЕЛЬ СЕБЕСТОИМОСТИ / 2. РАБОТА» (Описание проекта v2).
//
// Правила оплаты:
//  - Сдельщик: оплата по фактическим расценкам за операции.
//  - Почасовик/окладник: оплата за часы (часы × ставка).
//  - За день возможны обе части: ЗП = сдельная + почасовая.
//  - Если сдельных расценок НЕТ — работник на окладе: для себестоимости
//    операции берётся (оклад смены / кол-во операций).
//
// Деньги — Decimal (см. cost.ts), точность внутри не теряем.
// =============================================================================

import { D, type Num } from "@/lib/cost";
import type { Decimal } from "decimal.js";

/** Сдельные расценки работника (₽/деталь, ₽/изделие). null/undefined = нет. */
export interface PieceRates {
  torcovkaSort1?: Num | null;
  torcovkaSort2?: Num | null;
  prisadkaTorcev?: Num | null;
  prisadkaPlosk?: Num | null;
  upakovka?: Num | null;
}

/** Кол-во выполненных операций по типам за период. */
export interface OperationCounts {
  torcovkaSort1?: Num;
  torcovkaSort2?: Num;
  prisadkaTorcev?: Num;
  prisadkaPlosk?: Num;
  upakovka?: Num;
}

const RATE_KEYS = [
  "torcovkaSort1",
  "torcovkaSort2",
  "prisadkaTorcev",
  "prisadkaPlosk",
  "upakovka",
] as const;

/** Работник сдельный, если задана хотя бы одна сдельная расценка. */
export function hasPieceRates(rates: PieceRates): boolean {
  return RATE_KEYS.some((k) => rates[k] != null);
}

/** Сдельный заработок = Σ(расценка × кол-во операций этого типа). */
export function pieceworkEarning(rates: PieceRates, counts: OperationCounts): Decimal {
  return RATE_KEYS.reduce<Decimal>((sum, key) => {
    const rate = rates[key];
    const qty = counts[key];
    if (rate == null || qty == null) return sum;
    return sum.plus(D(rate).times(D(qty)));
  }, D(0));
}

/** Почасовой заработок = часы × ставка. Без ставки — 0. */
export function hourlyEarning(hours: Num, hourlyRate?: Num | null): Decimal {
  if (hourlyRate == null) return D(0);
  return D(hours).times(D(hourlyRate));
}

/** Общая ЗП за период = сдельная часть + почасовая часть. */
export function totalSalary(input: {
  rates: PieceRates;
  counts: OperationCounts;
  hours?: Num;
  hourlyRate?: Num | null;
}): Decimal {
  const piece = pieceworkEarning(input.rates, input.counts);
  const hourly = hourlyEarning(input.hours ?? 0, input.hourlyRate);
  return piece.plus(hourly);
}

/**
 * Себестоимость операции окладника = оклад смены / кол-во операций смены.
 * Чаще всего — упаковка. При нулевом кол-ве операций — 0 (делёжки нет).
 */
export function salaryPerOperation(shiftSalary: Num, operationsCount: Num): Decimal {
  const count = D(operationsCount);
  if (count.isZero()) return D(0);
  return D(shiftSalary).div(count);
}

/**
 * Средняя стоимость за единицу для строки отчёта ЗП:
 *  - сдельщик: из расценки (тут — фактическая средняя = сумма / кол-во);
 *  - почасовик: рассчитывается (сумма / кол-во произведённого).
 * При нулевом производстве — 0.
 */
export function avgPerUnit(totalAmount: Num, producedQty: Num): Decimal {
  const qty = D(producedQty);
  if (qty.isZero()) return D(0);
  return D(totalAmount).div(qty);
}

// -----------------------------------------------------------------------------
// Заработок за одну операцию терминала — единый источник для журнала
// производства (server/production) и отчёта ЗП (server/payroll). Сумма и
// количество считаются по типу операции и расценкам работника.
// -----------------------------------------------------------------------------

export type OperationKind = "TORCOVKA" | "PRISADKA" | "UPAKOVKA" | "HOURS";

/** Расценки работника, разложенные по типам (₽). */
export interface OperationRates {
  hourly: number;
  torcovkaSort1: number;
  torcovkaSort2: number;
  prisadkaTorcev: number;
  prisadkaPlosk: number;
  upakovka: number;
}

/** Строка операции: кол-во и признаки (сорт детали / виды присадки). */
export interface OperationLineInput {
  quantity: number;
  sort?: "SORT1" | "SORT2";
  prisadkaTorcevaya?: boolean;
  prisadkaPloskost?: boolean;
}

export interface OperationEarningInput {
  type: OperationKind;
  rates: OperationRates;
  hours?: number | null;
  productQty?: number | null;
  lines?: OperationLineInput[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Сумма и количество за операцию:
 *  - HOURS: часы × ставка;
 *  - UPAKOVKA: изделия × расценка упаковки;
 *  - TORCOVKA: Σ(кол-во × расценка по сорту детали);
 *  - PRISADKA: Σ(кол-во × (торцевая? + плоскостная?)).
 */
export function operationEarning(op: OperationEarningInput): {
  quantity: number;
  amount: number;
} {
  const r = op.rates;
  const lines = op.lines ?? [];
  let quantity = 0;
  let amount = 0;

  if (op.type === "HOURS") {
    quantity = op.hours ?? 0;
    amount = quantity * r.hourly;
  } else if (op.type === "UPAKOVKA") {
    quantity = op.productQty ?? 0;
    amount = quantity * r.upakovka;
  } else if (op.type === "TORCOVKA") {
    for (const l of lines) {
      quantity += l.quantity;
      amount += l.quantity * (l.sort === "SORT2" ? r.torcovkaSort2 : r.torcovkaSort1);
    }
  } else {
    for (const l of lines) {
      quantity += l.quantity;
      amount +=
        l.quantity *
        ((l.prisadkaTorcevaya ? r.prisadkaTorcev : 0) + (l.prisadkaPloskost ? r.prisadkaPlosk : 0));
    }
  }

  return { quantity, amount: round2(amount) };
}
