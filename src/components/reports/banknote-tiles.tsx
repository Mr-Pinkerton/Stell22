import { calcBanknotes, type BanknoteBreakdown, type BillDenomination } from "@/lib/cash-bills";
import { cn } from "@/lib/utils";

const BILL_STYLES: Record<
  BillDenomination,
  { bg: string; text: string; border: string }
> = {
  5000: {
    bg: "bg-[#e8d4c4]",
    text: "text-[#5c3d2e]",
    border: "border-[#c4a882]",
  },
  1000: {
    bg: "bg-[#c5d4e8]",
    text: "text-[#1e3a5f]",
    border: "border-[#8fa8c9]",
  },
  500: {
    bg: "bg-[#d4c5e8]",
    text: "text-[#3d2e5c]",
    border: "border-[#a882c4]",
  },
  100: {
    bg: "bg-[#c8e0c5]",
    text: "text-[#2e5c3d]",
    border: "border-[#82c48f]",
  },
};

export function BanknoteTiles({
  amount,
  bills: billsOverride,
}: {
  amount?: number;
  bills?: BanknoteBreakdown;
}) {
  const bills = billsOverride ?? calcBanknotes(amount ?? 0).bills;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {([5000, 1000, 500, 100] as BillDenomination[]).map((denom) => {
        const style = BILL_STYLES[denom];
        return (
          <div
            key={denom}
            className={cn(
              "flex min-h-[5.5rem] flex-col justify-between rounded-xl border-2 px-4 py-3 shadow-soft",
              style.bg,
              style.border,
            )}
          >
            <span className={cn("text-xs font-semibold tracking-wide uppercase", style.text)}>
              {denom.toLocaleString("ru-RU")} ₽
            </span>
            <span className={cn("text-3xl font-bold tabular-nums", style.text)}>
              {bills[denom]}
            </span>
            <span className={cn("text-xs opacity-70", style.text)}>шт</span>
          </div>
        );
      })}
    </div>
  );
}
