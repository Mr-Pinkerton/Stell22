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

export function getCurrentMonth(now: Date = new Date()): Date {
  return startOfMonth(businessCalendarDate(now));
}

/** Диапазон дат для фильтрации отчётов. Границы включительны (UTC-инстанты). */
export interface Period {
  start: Date;
  end: Date;
}

/**
 * Бизнес-зона проекта — UTC+3 (v2). Границы периодов считаем в ней, а не в
 * локали хоста: иначе на UTC-сервере край дня уедет на 3 часа и операции у
 * полуночи попадут не в тот период. Y-M-D берём из переданной даты (её собирают
 * через createLocalDate — локаль хоста), а сам инстант фиксируем в UTC+3.
 */
export const BUSINESS_UTC_OFFSET_HOURS = 3;

/** 00:00:00.000 бизнес-зоны (UTC+3) для календарной даты Y-M-D. */
export function startOfBusinessDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), -BUSINESS_UTC_OFFSET_HOURS, 0, 0, 0),
  );
}

/** 23:59:59.999 бизнес-зоны (UTC+3) — правая граница периода включительно. */
export function endOfDay(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      23 - BUSINESS_UTC_OFFSET_HOURS,
      59,
      59,
      999,
    ),
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export interface BusinessDateParts {
  year: number;
  /** 0–11. */
  month: number;
  day: number;
}

/**
 * Календарные компоненты абсолютного момента в фиксированном UTC+3.
 * Сдвиг и UTC-геттеры не зависят от зоны хоста.
 */
export function businessDateParts(instant: Date): BusinessDateParts {
  const shifted = new Date(instant.getTime() + BUSINESS_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
  };
}

/** YYYY-MM-DD хозяйственных суток. Для абсолютной метки события, не для календарной даты фильтра. */
export function businessDateKey(instant: Date): string {
  const { year, month, day } = businessDateParts(instant);
  return `${year}-${pad2(month + 1)}-${pad2(day)}`;
}

/**
 * YYYY-MM-01 хозяйственного месяца момента.
 * Для сохранённого Goal.month (полночь выбранного месяца, а не новое событие)
 * та же функция сохраняет месяц: и 00:00Z 1-го, и 21:00Z предыдущих суток
 * дают один и тот же YYYY-MM-01.
 */
export function businessMonthIso(instant: Date): string {
  const { year, month } = businessDateParts(instant);
  return `${year}-${pad2(month + 1)}-01`;
}

/**
 * Локальная календарная дата с компонентами хозяйственного дня.
 * Дальше её читают через getFullYear/getMonth/getDate, как createLocalDate.
 */
export function businessCalendarDate(instant: Date = new Date()): Date {
  const { year, month, day } = businessDateParts(instant);
  return createLocalDate(year, month, day);
}

/** YYYY-MM-DD из календарных компонент даты, уже собранной как локальный день. */
export function calendarDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 00:00 UTC+3 первого дня хозяйственного месяца, к которому относится момент. */
export function startOfBusinessMonth(instant: Date = new Date()): Date {
  const { year, month } = businessDateParts(instant);
  return startOfBusinessDay(createLocalDate(year, month, 1));
}

/** Период календарного месяца: [1-е 00:00 … последний день 23:59:59.999] в UTC+3. */
export function getMonthPeriod(month: Date = getCurrentMonth()): Period {
  const start = startOfBusinessDay(createLocalDate(month.getFullYear(), month.getMonth(), 1));
  const lastDay = createLocalDate(month.getFullYear(), month.getMonth() + 1, 0);
  return { start, end: endOfDay(lastDay) };
}
