// Форматирование денег, измерений и дат. Часовой пояс проекта — UTC+3.

import { parseDecimalText, type DecimalDraft } from "@/lib/decimal-input";

export const TIME_ZONE = "Europe/Moscow"; // UTC+3 без перехода на летнее время

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const numberFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 4,
  useGrouping: true,
});

const groupedIntegerFormatter = new Intl.NumberFormat("ru-RU", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
  useGrouping: true,
});

/** Сумма в ₽, напр. "1 234 ₽" (без копеек, пробел — разделитель тысяч). */
export function formatMoney(value: number): string {
  return moneyFormatter.format(value);
}

const moneyDecimalFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/**
 * Сумма в ₽ с копейками, когда они есть: "0,36 ₽", "35 ₽", "1 234,5 ₽".
 * Для цен за единицу дешёвых позиций (крепёж/упаковка) — целые рубли обрезают
 * копейки и «0,36 ₽» превратилось бы в «0 ₽». Агрегаты по-прежнему formatMoney.
 */
export function formatMoneyDecimal(value: number): string {
  return moneyDecimalFormatter.format(value);
}

/**
 * Компактная подпись артикулов изделия для мест с одной колонкой/строкой.
 * Одинаковые артикулы Ozon/WB → показываем один; иначе «OZ … · WB …».
 * Пустые значения опускаем; если оба пусты — «—».
 */
export function formatProductSku(skuOzon: string, skuWb: string): string {
  const oz = skuOzon.trim();
  const wb = skuWb.trim();
  if (oz && wb && oz === wb) return oz;
  const parts: string[] = [];
  if (oz) parts.push(`OZ ${oz}`);
  if (wb) parts.push(`WB ${wb}`);
  return parts.join(" · ") || "—";
}

/** Целое число с разделителем тысяч для полей ввода, напр. "1 234 567". */
export function formatGroupedInteger(value: number): string {
  return groupedIntegerFormatter.format(Math.round(value));
}

/** Разбор строки поля денег: только цифры, без копеек. */
export function parseGroupedInteger(raw: string): number | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  return Number(digits);
}

/**
 * Отображаемое значение денежного поля с копейками (для controlled MoneyInput).
 * Пусто и ноль различаются: null не рисуется, 0 рисуется как «0».
 * Хвостовые нули дробной части не добавляются: 0.36→"0,36", 35→"35", 1234.5→"1 234,5".
 */
export function formatGroupedDecimal(value: number, decimals: number): string {
  return new Intl.NumberFormat("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
    useGrouping: true,
  }).format(value);
}

function groupDecimalText(text: string): string {
  if (!text || /[^0-9.,]/.test(text)) return text;
  const sepAt = text.search(/[.,]/);
  const sep = sepAt === -1 ? "" : text[sepAt]!;
  const intRaw = sepAt === -1 ? text : text.slice(0, sepAt);
  const frac = sepAt === -1 ? "" : text.slice(sepAt + 1);
  if (!/^\d*$/.test(intRaw)) return text;
  const grouped = intRaw === "" ? "" : formatGroupedInteger(Number(intRaw));
  return sep ? `${grouped}${sep}${frac}` : grouped;
}

/**
 * Разбор ввода денег. Запятая и точка — один разделитель.
 * "0," и "0." остаются незавершённым черновиком и не становятся нулём.
 * Лишние знаки после запятой — ошибка, значение не обрезается.
 */
export function parseGroupedMoney(raw: string, decimals: number): DecimalDraft {
  const draft = parseDecimalText(raw, decimals);
  return { ...draft, text: groupDecimalText(draft.text) };
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

/** Дата и время в зоне проекта, напр. "04.06.2026, 14:30". */
export function formatDateTime(date: Date): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/** Дата и время из ISO-строки в зоне проекта; пустую/битую строку отдаёт как есть. */
export function formatIsoDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : formatDateTime(d);
}

/** Ключ дня `YYYY-MM-DD` в зоне проекта (сортируемый, для группировок). */
export function dayKeyInProjectTz(date: Date | string = new Date()): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
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

/** Дата из ISO "2026-06-01" → "01.06.2026". */
export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d.padStart(2, "0")}.${m.padStart(2, "0")}.${y}`;
}

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
