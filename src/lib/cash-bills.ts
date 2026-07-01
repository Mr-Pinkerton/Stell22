import { roundCashTo100 } from "@/lib/format";

export const BILL_DENOMINATIONS = [5000, 1000, 500, 100] as const;

export type BillDenomination = (typeof BILL_DENOMINATIONS)[number];

export type BanknoteBreakdown = Record<BillDenomination, number>;

/** Разбивка суммы на купюры после округления до 100 ₽. */
export function calcBanknotes(rawAmount: number): {
  rounded: number;
  bills: BanknoteBreakdown;
} {
  const rounded = roundCashTo100(rawAmount);
  let remaining = rounded;
  const bills: BanknoteBreakdown = { 5000: 0, 1000: 0, 500: 0, 100: 0 };

  for (const denomination of BILL_DENOMINATIONS) {
    bills[denomination] = Math.floor(remaining / denomination);
    remaining %= denomination;
  }

  return { rounded, bills };
}

/** Сумма купюр по каждому работнику (округление и разбивка — отдельно на каждого). */
export function aggregateBanknotes(amounts: number[]): {
  rounded: number;
  bills: BanknoteBreakdown;
} {
  const bills: BanknoteBreakdown = { 5000: 0, 1000: 0, 500: 0, 100: 0 };
  let rounded = 0;
  for (const amount of amounts) {
    const one = calcBanknotes(amount);
    rounded += one.rounded;
    for (const denomination of BILL_DENOMINATIONS) {
      bills[denomination] += one.bills[denomination];
    }
  }
  return { rounded, bills };
}
