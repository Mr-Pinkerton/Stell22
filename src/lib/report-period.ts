// =============================================================================
// Периодность отчётов (A11/A12). Дата производства = дата операции (workDate).
// searchParams ⇄ Period ⇄ DateFilterValue. Базовый период — календарный месяц;
// поддержаны произвольный диапазон и «за всё время».
// =============================================================================

import {
  createLocalDate,
  endOfDay,
  getCurrentMonth,
  getMonthPeriod,
  isSameDay,
  isSameMonth,
  normalizeRange,
  startOfBusinessDay,
  startOfMonth,
  type Period,
} from "@/lib/dates";
import type { DateFilterValue } from "@/components/date-filter";

type ParamValue = string | string[] | undefined;

function first(v: ParamValue): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function ym(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function parseDay(s: string | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? createLocalDate(+m[1], +m[2] - 1, +m[3]) : null;
}

function parseMonth(s: string | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  return m ? createLocalDate(+m[1], +m[2] - 1, 1) : null;
}

/** Дата попадает в период (границы включительно). `null` период = всё время. */
export function inPeriod(date: Date, period: Period | null): boolean {
  return !period || (date >= period.start && date <= period.end);
}

/**
 * `week=YYYY-MM-DD` (пятница недели пт–чт) → диапазон [пт 00:00 … чт 23:59:59.999].
 * Вспомогательный фильтр ЗП (v2 §недели). Нет/невалиден → null.
 */
export function weekRangeFromParams(params: Record<string, ParamValue>): Period | null {
  const friday = parseDay(first(params.week));
  if (!friday) return null;
  const thursday = createLocalDate(friday.getFullYear(), friday.getMonth(), friday.getDate() + 6);
  return { start: startOfBusinessDay(friday), end: endOfDay(thursday) };
}

/**
 * searchParams → охват отчёта. `all=1` → всё время (null). `from`+`to` →
 * произвольный диапазон (границы включительно, конец = конец дня). `month=YYYY-MM`
 * → календарный месяц. Ничего не задано → текущий месяц.
 */
export function periodFromParams(params: Record<string, ParamValue>): Period | null {
  if (first(params.all) === "1") return null;

  const from = parseDay(first(params.from));
  const to = parseDay(first(params.to));
  if (from && to) {
    const { start, end } = normalizeRange(from, to);
    return { start: startOfBusinessDay(start), end: endOfDay(end) };
  }

  const month = parseMonth(first(params.month));
  return month ? getMonthPeriod(month) : getMonthPeriod();
}

/** DateFilterValue → query string для URL отчёта. */
export function paramsFromDateFilter(v: DateFilterValue): URLSearchParams {
  const p = new URLSearchParams();
  if (v.allTime) {
    p.set("all", "1");
    return p;
  }
  if (v.rangeStart && v.rangeEnd) {
    const { start, end } = normalizeRange(v.rangeStart, v.rangeEnd);
    p.set("from", ymd(start));
    p.set("to", ymd(end));
    return p;
  }
  p.set("month", ym(v.month));
  return p;
}

/** query string → DateFilterValue (инициализация фильтра из URL). */
export function dateFilterFromParams(params: URLSearchParams): DateFilterValue {
  // База для UI-календаря — локальный месяц (отображение), не UTC+3-инстант.
  const base = getCurrentMonth();
  if (params.get("all") === "1") {
    return { month: base, rangeStart: null, rangeEnd: null, allTime: true };
  }
  const from = parseDay(params.get("from") ?? undefined);
  const to = parseDay(params.get("to") ?? undefined);
  if (from && to) {
    const { start, end } = normalizeRange(from, to);
    return { month: startOfMonth(start), rangeStart: start, rangeEnd: end, allTime: false };
  }
  const month = parseMonth(params.get("month") ?? undefined);
  return { month: month ?? base, rangeStart: null, rangeEnd: null, allTime: false };
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

/** Query отчёта из черновика FiltersBar (Apply и Reset). */
export function reportsHrefFromDraft(filter: DateFilterValue, week = ""): string {
  const params = paramsFromDateFilter(filter);
  if (week) params.set("week", week);
  const qs = params.toString();
  return qs ? `/reports?${qs}` : "/reports";
}

/** Черновик совпадает с уже применённым URL (Показать можно disabled). */
export function isReportsDraftApplied(
  draft: DateFilterValue,
  week: string,
  params: URLSearchParams,
): boolean {
  const applied = dateFilterFromParams(params);
  const appliedWeek = params.get("week") ?? "";
  return dateFiltersEqual(draft, applied) && week === appliedWeek;
}

export function reportsDraftFromParams(params: URLSearchParams): {
  dateFilter: DateFilterValue;
  week: string;
} {
  return {
    dateFilter: dateFilterFromParams(params),
    week: params.get("week") ?? "",
  };
}

/** Стабильная сигнатура applied URL: пустой query ≡ текущий месяц. */
export function reportsAppliedKey(params: URLSearchParams): string {
  const { dateFilter, week } = reportsDraftFromParams(params);
  return reportsHrefFromDraft(dateFilter, week);
}

/**
 * Синхронизация draft с applied URL только если canonical applied изменился
 * (Back/Forward). Неподтверждённый ввод сохраняется, пока ключ тот же.
 */
export function syncReportsDraftIfAppliedChanged(
  prevAppliedKey: string,
  params: URLSearchParams,
  draft: { dateFilter: DateFilterValue; week: string },
): { appliedKey: string; dateFilter: DateFilterValue; week: string } {
  const appliedKey = reportsAppliedKey(params);
  if (appliedKey === prevAppliedKey) {
    return { appliedKey, dateFilter: draft.dateFilter, week: draft.week };
  }
  const next = reportsDraftFromParams(params);
  return { appliedKey, dateFilter: next.dateFilter, week: next.week };
}
