import {
  createLocalDate,
  endOfDay,
  getCurrentMonth,
  getMonthPeriod,
  normalizeRange,
  startOfBusinessDay,
  startOfMonth,
  type Period,
} from "@/lib/dates";
import { dateFiltersEqual, type DateFilterValue } from "@/lib/date-filter-value";

type ParamValue = string | string[] | undefined;
type ParamSource = Record<string, ParamValue> | URLSearchParams;

const PERIOD_KEYS = new Set(["month", "from", "to", "all"]);

function first(params: ParamSource, key: string): string | undefined {
  if (params instanceof URLSearchParams) {
    return params.get(key) ?? undefined;
  }
  const v = params[key];
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

/** Default Sales DateFilter: ALL TIME. Не current month. */
export function getDefaultSalesDateFilterValue(): DateFilterValue {
  return { month: getCurrentMonth(), rangeStart: null, rangeEnd: null, allTime: true };
}

/**
 * searchParams → период Sales. Пустой query и `all=1` → ALL TIME (`null`).
 * `from`+`to` → inclusive range (конец = конец дня UTC+3). `month=YYYY-MM` → месяц.
 * Не использует report-period: там пустой URL = текущий месяц.
 */
export function salesPeriodFromParams(params: ParamSource): Period | null {
  if (first(params, "all") === "1") return null;

  const from = parseDay(first(params, "from"));
  const to = parseDay(first(params, "to"));
  if (from && to) {
    const { start, end } = normalizeRange(from, to);
    return { start: startOfBusinessDay(start), end: endOfDay(end) };
  }

  const month = parseMonth(first(params, "month"));
  return month ? getMonthPeriod(month) : null;
}

/** Prisma `where` для Sale.date. ALL TIME → undefined (без where). */
export function saleDatePrismaWhere(
  period: Period | null,
): { date: { gte: Date; lte: Date } } | undefined {
  if (!period) return undefined;
  return { date: { gte: period.start, lte: period.end } };
}

/** URL/searchParams → DateFilterValue. Пустой query ≡ ALL TIME. */
export function salesDraftFromParams(params: ParamSource): DateFilterValue {
  const base = getCurrentMonth();
  if (first(params, "all") === "1") {
    return { month: base, rangeStart: null, rangeEnd: null, allTime: true };
  }
  const from = parseDay(first(params, "from"));
  const to = parseDay(first(params, "to"));
  if (from && to) {
    const { start, end } = normalizeRange(from, to);
    return { month: startOfMonth(start), rangeStart: start, rangeEnd: end, allTime: false };
  }
  const month = parseMonth(first(params, "month"));
  if (month) {
    return { month, rangeStart: null, rangeEnd: null, allTime: false };
  }
  return { month: base, rangeStart: null, rangeEnd: null, allTime: true };
}

function toUrlSearchParams(params?: ParamSource): URLSearchParams {
  if (!params) return new URLSearchParams();
  if (params instanceof URLSearchParams) return new URLSearchParams(params.toString());
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const v = Array.isArray(value) ? value[0] : value;
    if (v != null && v !== "") p.set(key, v);
  }
  return p;
}

/**
 * Draft → href. ALL TIME канонически `/sales` (без month/from/to/all).
 * Несвязанные query params сохраняются.
 */
export function salesHrefFromDraft(filter: DateFilterValue, current?: ParamSource): string {
  const p = toUrlSearchParams(current);
  for (const key of PERIOD_KEYS) p.delete(key);
  if (!filter.allTime) {
    if (filter.rangeStart && filter.rangeEnd) {
      const { start, end } = normalizeRange(filter.rangeStart, filter.rangeEnd);
      p.set("from", ymd(start));
      p.set("to", ymd(end));
    } else {
      p.set("month", ym(filter.month));
    }
  }
  const qs = p.toString();
  return qs ? `/sales?${qs}` : "/sales";
}

export function isSalesDraftApplied(draft: DateFilterValue, params: ParamSource): boolean {
  return dateFiltersEqual(draft, salesDraftFromParams(params));
}

/** Пустой query ≡ `all=1` ≡ `/sales`. */
export function salesAppliedKey(params: ParamSource): string {
  return salesHrefFromDraft(salesDraftFromParams(params));
}

export function syncSalesDraftIfAppliedChanged(
  prevAppliedKey: string,
  params: ParamSource,
  draft: DateFilterValue,
): { appliedKey: string; dateFilter: DateFilterValue } {
  const appliedKey = salesAppliedKey(params);
  if (appliedKey === prevAppliedKey) {
    return { appliedKey, dateFilter: draft };
  }
  return { appliedKey, dateFilter: salesDraftFromParams(params) };
}
