import type { DateFilterValue } from "@/components/date-filter";
import { createLocalDate, isDayInRange, isSameMonth } from "@/lib/dates";

export function parseIsoDateLocal(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return createLocalDate(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Попадает ли ISO-дата (YYYY-MM-DD) в выбранный фильтр. */
export function matchesDateFilter(iso: string, filter: DateFilterValue): boolean {
  if (filter.allTime) return true;

  const day = parseIsoDateLocal(iso);

  if (filter.rangeStart && filter.rangeEnd) {
    return isDayInRange(day, filter.rangeStart, filter.rangeEnd);
  }

  return isSameMonth(day, filter.month);
}
