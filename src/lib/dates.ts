/** Утилиты календаря для фильтров (локальные даты, без времени). */

export function createLocalDate(year: number, month: number, day: number): Date {
  return new Date(year, month, day);
}

export function startOfMonth(date: Date): Date {
  return createLocalDate(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, months: number): Date {
  return createLocalDate(date.getFullYear(), date.getMonth() + months, 1);
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function isSameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

export function isDayInRange(day: Date, start: Date, end: Date): boolean {
  const value = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const from = new Date(start.getFullYear(), start.getMonth(), start.getDate()).getTime();
  const to = new Date(end.getFullYear(), end.getMonth(), end.getDate()).getTime();
  const min = Math.min(from, to);
  const max = Math.max(from, to);
  return value >= min && value <= max;
}

export function normalizeRange(start: Date, end: Date): { start: Date; end: Date } {
  return start <= end ? { start, end } : { start: end, end: start };
}

/** Понедельник = 0 … воскресенье = 6. */
export function getMondayBasedWeekday(date: Date): number {
  return (date.getDay() + 6) % 7;
}

export function getDaysInMonth(date: Date): number {
  return createLocalDate(date.getFullYear(), date.getMonth() + 1, 0).getDate();
}

export interface CalendarCell {
  date: Date;
  inCurrentMonth: boolean;
}

/** Сетка 6×7: дни текущего месяца + хвосты соседних. */
export function buildCalendarMonth(viewMonth: Date): CalendarCell[] {
  const year = viewMonth.getFullYear();
  const month = viewMonth.getMonth();
  const firstDay = createLocalDate(year, month, 1);
  const leading = getMondayBasedWeekday(firstDay);
  const daysInMonth = getDaysInMonth(viewMonth);
  const cells: CalendarCell[] = [];

  for (let i = leading; i > 0; i -= 1) {
    cells.push({
      date: createLocalDate(year, month, 1 - i),
      inCurrentMonth: false,
    });
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({
      date: createLocalDate(year, month, day),
      inCurrentMonth: true,
    });
  }

  while (cells.length < 42) {
    const nextDay = cells.length - leading - daysInMonth + 1;
    cells.push({
      date: createLocalDate(year, month + 1, nextDay),
      inCurrentMonth: false,
    });
  }

  return cells;
}

export function getCurrentMonth(): Date {
  const now = new Date();
  return startOfMonth(now);
}

/** Диапазон дат для фильтрации отчётов. Границы включительны. */
export interface Period {
  start: Date;
  end: Date;
}

/** Конец дня (23:59:59.999 локально) — правая граница периода включительно. */
export function endOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/** Период календарного месяца: [1-е 00:00 … последний день 23:59:59.999]. */
export function getMonthPeriod(month: Date = getCurrentMonth()): Period {
  const start = startOfMonth(month);
  const lastDay = createLocalDate(month.getFullYear(), month.getMonth() + 1, 0);
  return { start, end: endOfDay(lastDay) };
}
