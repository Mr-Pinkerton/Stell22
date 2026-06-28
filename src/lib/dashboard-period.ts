import {
  addMonths,
  createLocalDate,
  getDaysInMonth,
  getMondayBasedWeekday,
  isDayInRange,
  normalizeRange,
  startOfMonth,
} from "@/lib/dates";

export type DashboardPeriodMode = "month" | "week" | "custom";

export interface DashboardPeriod {
  mode: DashboardPeriodMode;
  start: Date;
  end: Date;
}

export interface StandardWeek {
  id: string;
  start: Date;
  end: Date;
  label: string;
}

function endOfMonth(date: Date): Date {
  return createLocalDate(date.getFullYear(), date.getMonth(), getDaysInMonth(date));
}

function addDays(date: Date, days: number): Date {
  return createLocalDate(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function startOfStandardWeek(date: Date): Date {
  const offset = getMondayBasedWeekday(date);
  return addDays(date, -offset);
}

/** Диапазон для режима периода (относительно «сейчас»). */
export function resolveDashboardPeriod(
  mode: DashboardPeriodMode,
  now: Date = new Date(),
  custom?: { start: Date; end: Date },
): DashboardPeriod {
  if (mode === "week") {
    const start = startOfStandardWeek(now);
    return { mode, start, end: addDays(start, 6) };
  }

  if (mode === "custom" && custom) {
    const { start, end } = normalizeRange(custom.start, custom.end);
    return { mode, start, end };
  }

  const start = startOfMonth(now);
  return { mode: "month", start, end: endOfMonth(now) };
}

/** Предыдущий период той же длины для сравнения KPI. */
export function previousDashboardPeriod(period: DashboardPeriod): DashboardPeriod {
  if (period.mode === "month") {
    const prevMonth = addMonths(period.start, -1);
    return {
      mode: period.mode,
      start: startOfMonth(prevMonth),
      end: endOfMonth(prevMonth),
    };
  }

  const days = Math.round((period.end.getTime() - period.start.getTime()) / 86_400_000) + 1;
  const prevEnd = addDays(period.start, -1);
  const prevStart = addDays(prevEnd, -(days - 1));
  return { mode: period.mode, start: prevStart, end: prevEnd };
}

export function isDateInDashboardPeriod(isoDate: string, period: DashboardPeriod): boolean {
  const [y, m, d] = isoDate.split("-").map(Number);
  const day = createLocalDate(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  return isDayInRange(day, period.start, period.end);
}

/** Стандартные недели (пн–вс), пересекающиеся с диапазоном. */
export function buildStandardWeeksInPeriod(period: DashboardPeriod): StandardWeek[] {
  const weeks: StandardWeek[] = [];
  let monday = startOfStandardWeek(period.start);

  while (monday <= period.end) {
    const sunday = addDays(monday, 6);
    if (sunday >= period.start) {
      weeks.push({
        id: toIsoDate(monday),
        start: monday < period.start ? period.start : monday,
        end: sunday > period.end ? period.end : sunday,
        label: `${String(monday.getDate()).padStart(2, "0")}.${String(monday.getMonth() + 1).padStart(2, "0")}`,
      });
    }
    monday = addDays(monday, 7);
  }

  return weeks;
}

export function periodDayCount(period: DashboardPeriod): number {
  return (
    Math.round((period.end.getTime() - period.start.getTime()) / 86_400_000) + 1
  );
}

export function elapsedDaysInPeriod(period: DashboardPeriod, now: Date = new Date()): number {
  if (now < period.start) return 0;
  const end = now > period.end ? period.end : now;
  return Math.max(1, Math.round((end.getTime() - period.start.getTime()) / 86_400_000) + 1);
}
