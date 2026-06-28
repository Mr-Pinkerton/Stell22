import { createLocalDate, getDaysInMonth } from "@/lib/dates";
import { formatFilterDateRange } from "@/lib/format";

export interface PayWeek {
  id: string;
  start: Date;
  end: Date;
  label: string;
}

function addDays(date: Date, days: number): Date {
  return createLocalDate(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function toId(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Пятница недели (пт–чт), в которую попадает дата. */
export function getWeekFriday(date: Date): Date {
  const day = date.getDay(); // 0=вс … 5=пт
  const daysSinceFriday = (day + 2) % 7;
  return addDays(date, -daysSinceFriday);
}

/** Недели пт–чт: только те, чья пятница в выбранном месяце. */
export function buildPayWeeksForMonth(month: Date): PayWeek[] {
  const year = month.getFullYear();
  const m = month.getMonth();
  const monthStart = createLocalDate(year, m, 1);
  const monthEnd = createLocalDate(year, m, getDaysInMonth(month));

  let friday = monthStart;
  while (friday.getDay() !== 5 && friday <= monthEnd) {
    friday = addDays(friday, 1);
  }

  const weeks: PayWeek[] = [];
  while (friday <= monthEnd && friday.getMonth() === m) {
    const thursday = addDays(friday, 6);
    weeks.push({
      id: toId(friday),
      start: friday,
      end: thursday,
      label: formatFilterDateRange(friday, thursday),
    });
    friday = addDays(friday, 7);
  }

  return weeks;
}
