import type { DateFilterValue } from "@/components/date-filter";
import { isSameMonth, startOfMonth } from "@/lib/dates";
import { formatGoalMonthIso, parseGoalMonthIso } from "@/lib/goals";
import type { GoalRow } from "@/mocks/goals-fixtures";
import { matchesDateFilter } from "@/lib/match-date-filter";

export function filterGoalsByDate(goals: GoalRow[], filter: DateFilterValue): GoalRow[] {
  if (filter.allTime) return goals;
  return goals.filter((g) => matchesDateFilter(g.month, filter));
}

export function splitGoalsForView(
  goals: GoalRow[],
  filter: DateFilterValue,
  now: Date = new Date(),
): { active: GoalRow[]; past: GoalRow[] } {
  const viewMonth = filter.allTime ? startOfMonth(now) : startOfMonth(filter.month);
  const viewMonthIso = formatGoalMonthIso(viewMonth);

  const filtered = filterGoalsByDate(goals, filter);

  const active = filtered.filter((g) => g.status === "ACTIVE" && g.month === viewMonthIso);
  const activeIds = new Set(active.map((g) => g.id));
  const past = filtered
    .filter((g) => !activeIds.has(g.id))
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0));

  return { active, past };
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
