// Чистые функции журнала внесений терминала: фильтр по периоду, группировка по
// дням и итоги. Без UI и доступа к данным — легко тестировать.

import type { OperationType, TerminalEntry } from "@/types/domain";
import { dayKeyInProjectTz } from "@/lib/format";

const DAY_MS = 24 * 60 * 60 * 1000;

export type JournalPeriod = "week" | "month";

/** Длина окна журнала в днях (скользящее окно от «сейчас»). */
export const PERIOD_DAYS: Record<JournalPeriod, number> = { week: 7, month: 30 };

export interface DayTypeStat {
  quantity: number;
  amount: number;
}

export interface DayGroup {
  /** Ключ дня в зоне UTC+3, формат `YYYY-MM-DD` (сортируемый). */
  date: string;
  entries: TerminalEntry[];
  byType: Partial<Record<OperationType, DayTypeStat>>;
  totalAmount: number;
}

/** Ключ дня (YYYY-MM-DD) в зоне проекта для произвольной даты/ISO-строки. */
export function dayKey(date: Date | string): string {
  return dayKeyInProjectTz(date);
}

/** Внесения за скользящее окно [now - N дней, now]. */
export function filterEntriesByPeriod(
  entries: TerminalEntry[],
  period: JournalPeriod,
  now: Date = new Date(),
): TerminalEntry[] {
  const end = now.getTime();
  const start = end - PERIOD_DAYS[period] * DAY_MS;
  return entries.filter((e) => {
    const t = new Date(e.occurredAt).getTime();
    return t >= start && t <= end;
  });
}

/** Группировка по дням (свежие сверху), внутри дня — свежие сверху. */
export function groupEntriesByDay(entries: TerminalEntry[]): DayGroup[] {
  const map = new Map<string, DayGroup>();

  for (const e of entries) {
    const date = dayKey(e.occurredAt);
    let group = map.get(date);
    if (!group) {
      group = { date, entries: [], byType: {}, totalAmount: 0 };
      map.set(date, group);
    }
    group.entries.push(e);
    const stat = group.byType[e.type] ?? { quantity: 0, amount: 0 };
    stat.quantity += e.quantity;
    stat.amount += e.amount;
    group.byType[e.type] = stat;
    group.totalAmount += e.amount;
  }

  const groups = [...map.values()];
  groups.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  for (const g of groups) {
    g.entries.sort(
      (a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );
  }
  return groups;
}

/** Готовый журнал: фильтр по периоду + группировка по дням. */
export function buildJournal(
  entries: TerminalEntry[],
  period: JournalPeriod,
  now: Date = new Date(),
): DayGroup[] {
  return groupEntriesByDay(filterEntriesByPeriod(entries, period, now));
}

/** Сумма заработка по всем дням журнала, ₽. */
export function journalTotal(groups: DayGroup[]): number {
  return groups.reduce((sum, g) => sum + g.totalAmount, 0);
}
