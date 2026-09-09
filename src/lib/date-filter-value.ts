import { isSameDay, isSameMonth } from "@/lib/dates";

export interface DateFilterValue {
  month: Date;
  rangeStart: Date | null;
  rangeEnd: Date | null;
  allTime?: boolean;
}

function sameOptionalDay(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return isSameDay(a, b);
}

/** Семантическое равенство черновика даты (без identity Date). */
export function dateFiltersEqual(a: DateFilterValue, b: DateFilterValue): boolean {
  if (Boolean(a.allTime) !== Boolean(b.allTime)) return false;
  if (a.allTime) return true;

  const aRange = Boolean(a.rangeStart && a.rangeEnd);
  const bRange = Boolean(b.rangeStart && b.rangeEnd);
  if (aRange && bRange) {
    return isSameDay(a.rangeStart!, b.rangeStart!) && isSameDay(a.rangeEnd!, b.rangeEnd!);
  }
  if (a.rangeStart || a.rangeEnd || b.rangeStart || b.rangeEnd) {
    return sameOptionalDay(a.rangeStart, b.rangeStart) && sameOptionalDay(a.rangeEnd, b.rangeEnd);
  }
  return isSameMonth(a.month, b.month);
}
