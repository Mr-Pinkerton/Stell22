// Расчёт остатка счёта от «якоря».
//
// Модель: у счёта есть точка отсчёта — фиксированный остаток `openingBalance`
// на дату `balanceAsOf`. Текущий остаток = якорь + сумма операций ДДС с этой
// даты (включительно). Банковская выписка при импорте переносит якорь на свой
// «конечный остаток» (банк — источник истины), а расхождение с расчётом
// помечается бейджем. Переводы между своими счетами здесь УЧИТЫВАЮТСЯ: они
// реально двигают деньги конкретного счёта (в отличие от KPI доход/расход).

import type { FlowType } from "@/types/domain";

export interface BalanceAnchor {
  openingBalance: number;
  /** yyyy-mm-dd. Операции с этой даты (включительно) двигают остаток. null → все. */
  balanceAsOf: string | null;
}

export interface BalanceFlow {
  accountId: string;
  /** yyyy-mm-dd */
  date: string;
  flowType: FlowType;
  /** Всегда положительная сумма; знак задаёт `flowType`. */
  amount: number;
}

export interface AccountWithAnchor extends BalanceAnchor {
  id: string;
}

/** Знаковая сумма операции: приход «+», расход «−». */
export function signedFlow(flowType: FlowType, amount: number): number {
  return flowType === "INCOME" ? amount : -amount;
}

/** Остаток одного счёта = якорь + операции с даты якоря (включительно). */
export function computeAccountBalance(anchor: BalanceAnchor, flows: BalanceFlow[]): number {
  return flows.reduce((sum, f) => {
    if (anchor.balanceAsOf && f.date < anchor.balanceAsOf) return sum;
    return sum + signedFlow(f.flowType, f.amount);
  }, anchor.openingBalance);
}

/** Остатки по каждому счёту (операции группируются по `accountId`). */
export function computeAccountBalances(
  accounts: AccountWithAnchor[],
  flows: BalanceFlow[],
): Map<string, number> {
  const byAccount = new Map<string, BalanceFlow[]>();
  for (const f of flows) {
    const arr = byAccount.get(f.accountId);
    if (arr) arr.push(f);
    else byAccount.set(f.accountId, [f]);
  }

  const result = new Map<string, number>();
  for (const a of accounts) {
    result.set(a.id, computeAccountBalance(a, byAccount.get(a.id) ?? []));
  }
  return result;
}

/** Суммарный остаток по всем счетам (KPI «Остаток на счетах»). */
export function totalAccountBalance(accounts: AccountWithAnchor[], flows: BalanceFlow[]): number {
  let sum = 0;
  for (const balance of computeAccountBalances(accounts, flows).values()) sum += balance;
  return sum;
}

/**
 * Двигать ли якорь остатка при импорте выписки: новая точка отсчёта (день
 * после конца периода выписки) не должна быть раньше текущей — иначе старая
 * выписка откатила бы остаток назад. Даты — ISO yyyy-mm-dd.
 */
export function shouldAdvanceAnchor(currentAsOf: string | null, newAsOf: string): boolean {
  return currentAsOf == null || newAsOf >= currentAsOf;
}

/**
 * Подтверждён ли счёт для целей ДДС/KPI. `undefined` трактуется как «да» —
 * для обратной совместимости со старыми данными/фикстурами без этого поля
 * (в БД у поля жёсткий default true, `undefined` там не встречается).
 */
export function isAccountConfirmed(confirmed: boolean | undefined): boolean {
  return confirmed !== false;
}
