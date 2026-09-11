import type { DateFilterValue } from "@/lib/date-filter-value";
import { isSameMonth } from "@/lib/dates";
import { parseGoalMonthIso } from "@/lib/goals";
import type { GoalRow } from "@/mocks/goals-fixtures";

/** Month-only: allTime → все; иначе тот же календарный месяц, что filter.month. Range игнорируется. */
export function filterGoalsByDate(goals: GoalRow[], filter: DateFilterValue): GoalRow[] {
  if (filter.allTime) return goals;
  return goals.filter((g) => isSameMonth(parseGoalMonthIso(g.month), filter.month));
}

export function splitGoalsForView(
  goals: GoalRow[],
  filter: DateFilterValue,
): { active: GoalRow[]; archived: GoalRow[] } {
  const filtered = filterGoalsByDate(goals, filter);
  const active = filtered.filter((g) => g.status === "ACTIVE");
  const archived = filtered
    .filter((g) => g.status === "ARCHIVED")
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));
  return { active, archived };
}

export function goalMonthLabel(iso: string): string {
  const d = parseGoalMonthIso(iso);
  const months = [
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
  return `${months[d.getMonth()]} ${d.getFullYear()}`;
}

export function isGoalMonthCurrent(iso: string, now: Date = new Date()): boolean {
  return isSameMonth(parseGoalMonthIso(iso), now);
}
