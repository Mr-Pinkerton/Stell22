import { createLocalDate, getDaysInMonth, getMondayBasedWeekday, isSameMonth } from "@/lib/dates";

/** Воскресенье — выходной (как в моках терминала). */
export function isWorkingDay(date: Date): boolean {
  return date.getDay() !== 0;
}

/** Рабочие дни календарного месяца. */
export function countWorkingDaysInMonth(month: Date): number {
  const year = month.getFullYear();
  const m = month.getMonth();
  const total = getDaysInMonth(month);
  let count = 0;
  for (let day = 1; day <= total; day += 1) {
    if (isWorkingDay(createLocalDate(year, m, day))) count += 1;
  }
  return count;
}

/** Дневной план = месячная цель / рабочие дни месяца. */
export function dailyPlan(monthlyTarget: number, workingDays: number): number {
  if (workingDays <= 0 || monthlyTarget <= 0) return 0;
  return monthlyTarget / workingDays;
}

export function startOfWeekMonday(date: Date): Date {
  const offset = getMondayBasedWeekday(date);
  return createLocalDate(date.getFullYear(), date.getMonth(), date.getDate() - offset);
}

/**
 * Недельный план = сумма дневных планов рабочих дней недели,
 * попадающих в календарный месяц цели.
 */
export function weeklyPlan(
  monthlyTarget: number,
  goalMonth: Date,
  weekMonday: Date,
): number {
  const workingDays = countWorkingDaysInMonth(goalMonth);
  const daily = dailyPlan(monthlyTarget, workingDays);
  let sum = 0;

  for (let i = 0; i < 7; i += 1) {
    const day = createLocalDate(
      weekMonday.getFullYear(),
      weekMonday.getMonth(),
      weekMonday.getDate() + i,
    );
    if (!isSameMonth(day, goalMonth)) continue;
    if (isWorkingDay(day)) sum += daily;
  }

  return sum;
}

/** % выполнения по одной цели. */
export function goalCompletionPercent(produced: number, target: number): number {
  if (target <= 0) return 0;
  return Math.round((produced / target) * 1000) / 10;
}

/** ISO первого дня месяца: `2026-06-01`. */
export function formatGoalMonthIso(month: Date): string {
  const y = month.getFullYear();
  const m = String(month.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}-01`;
}

export function parseGoalMonthIso(iso: string): Date {
  const [y, m] = iso.split("-").map(Number);
  return createLocalDate(y ?? 1970, (m ?? 1) - 1, 1);
}
