// Форматирование денег, измерений и дат. Часовой пояс проекта — UTC+3.

const TIME_ZONE = "Europe/Moscow"; // UTC+3 без перехода на летнее время

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
});

/** Сумма в ₽, напр. "1 234,50 ₽". */
export function formatMoney(value: number): string {
  return moneyFormatter.format(value);
}

/** Длина в метрах, напр. "2,4 м". */
export function formatLength(meters: number): string {
  return `${numberFormatter.format(meters)} м`;
}

/** Объём в м³, напр. "0,1234 м³". */
export function formatVolume(m3: number): string {
  return `${numberFormatter.format(m3)} м³`;
}

const WEEKDAYS = [
  "воскресенье",
  "понедельник",
  "вторник",
  "среда",
  "четверг",
  "пятница",
  "суббота",
];

/** Заголовок даты для хедера, напр. "Сегодня четверг 04.06.2026 г". */
export function formatHeaderDate(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  return `Сегодня ${weekday} ${get("day")}.${get("month")}.${get("year")} г`;
}

/** Дата в формате "04.06.2026". */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

const MONTH_NAMES = [
  "Январь",
  "Февраль",
  "Март",
  "Апрель",
  "Май",
  "Июнь",
  "Июль",
  "Август",
  "Сентябрь",
  "Октябрь",
  "Ноябрь",
  "Декабрь",
];

/** Месяц для фильтра, напр. "Июнь 2026". */
export function formatFilterMonth(date: Date): string {
  return `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`;
}

/** Период для фильтра, напр. "01.06.2026 — 15.06.2026". */
export function formatFilterDateRange(start: Date, end: Date): string {
  const from = start <= end ? start : end;
  const to = start <= end ? end : start;
  return `${formatDate(from)} — ${formatDate(to)}`;
}

/**
 * Округление суммы до 100 ₽ по правилам математики (50 и более — вверх).
 * Используется для расчёта купюр к выдаче.
 */
export function roundCashTo100(value: number): number {
  return Math.round(value / 100) * 100;
}

export { WEEKDAYS };
