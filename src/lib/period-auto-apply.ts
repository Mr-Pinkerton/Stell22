import type { DateFilterValue } from "@/lib/date-filter-value";

export type PeriodCommitKind = "incomplete" | "month" | "range" | "all";

/** Пауза перед применением месяца, чтобы стрелки календаря не слали запрос на каждый щелчок. */
export const PERIOD_MONTH_APPLY_DELAY_MS = 250;

/**
 * Незавершённый диапазон (есть начало и нет конца) не готов к серверной навигации.
 * Месяц, «за всё время» и закрытый диапазон — готовы.
 */
export function classifyDateFilterCommit(value: DateFilterValue): PeriodCommitKind {
  if (value.rangeStart && !value.rangeEnd) return "incomplete";
  if (value.allTime) return "all";
  if (value.rangeStart && value.rangeEnd) return "range";
  return "month";
}

/** Смена месяца делает выбранную неделю зарплаты невалидной. */
export function weekAfterDateChange(previousMonth: Date, nextMonth: Date, week: string): string {
  return previousMonth.getTime() === nextMonth.getTime() ? week : "";
}

export function applyDelayMs(kind: PeriodCommitKind): number {
  return kind === "month" ? PERIOD_MONTH_APPLY_DELAY_MS : 0;
}

/**
 * Один переход, только если канонический адрес черновика отличается от уже применённого.
 * `null` — не вызывать router.replace.
 */
export function navigationHrefIfNeeded(
  draftHref: string | null,
  appliedHref: string,
): string | null {
  if (!draftHref || draftHref === appliedHref) return null;
  return draftHref;
}
