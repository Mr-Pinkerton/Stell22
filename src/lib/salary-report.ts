import type { Period } from "@/lib/dates";
import type { SalaryDayLine } from "@/mocks/report-fixtures";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Все дни начисления, новые сверху. Сумма строк совпадает с суммой операций. */
export function listSalaryDays(days: SalaryDayLine[]): SalaryDayLine[] {
  return days
    .map((day) => ({ ...day, total: round2(day.total) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Неделя ограничивает только историю выплат по дате выплаты. */
export function paidHistoryRange(
  scope?: Period | null,
): { gte: Date; lte: Date } | undefined {
  if (!scope) return undefined;
  return { gte: scope.start, lte: scope.end };
}
