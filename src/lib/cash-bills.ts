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
