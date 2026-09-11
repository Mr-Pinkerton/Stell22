import { describe, expect, it } from "vitest";
import { createLocalDate } from "@/lib/dates";
import { formatGoalMonthIso } from "@/lib/goals";
import { filterGoalsByDate, splitGoalsForView } from "@/lib/goals-view";
import type { GoalRow } from "@/mocks/goals-fixtures";
import type { DateFilterValue } from "@/lib/date-filter-value";

function goal(
  id: string,
  month: Date,
  status: GoalRow["status"],
): GoalRow {
  return {
    id,
    name: id,
    productId: "prod-1",
    productName: "Полка",
    quantity: 10,
    month: formatGoalMonthIso(month),
    status,
    producedQty: 1,
  };
}

const july = createLocalDate(2026, 6, 1);
const june = createLocalDate(2026, 5, 1);
const august = createLocalDate(2026, 7, 1);

const julyActive = goal("july-active", july, "ACTIVE");
const julyArchived = goal("july-archived", july, "ARCHIVED");
const juneActive = goal("june-active", june, "ACTIVE");
const juneArchived = goal("june-archived", june, "ARCHIVED");
const augustActive = goal("aug-active", august, "ACTIVE");

const allGoals = [julyActive, julyArchived, juneActive, juneArchived, augustActive];

function monthFilter(month: Date): DateFilterValue {
  return { month, rangeStart: null, rangeEnd: null, allTime: false };
}

const allTime: DateFilterValue = {
  month: july,
  rangeStart: null,
  rangeEnd: null,
  allTime: true,
};

describe("splitGoalsForView", () => {
  it("выбранный месяц: ACTIVE → active, ARCHIVED → archived; другие месяцы скрыты", () => {
    const { active, archived } = splitGoalsForView(allGoals, monthFilter(july));
    expect(active.map((g) => g.id)).toEqual(["july-active"]);
    expect(archived.map((g) => g.id)).toEqual(["july-archived"]);
  });

  it("прошлый месяц: ACTIVE прошлого в active, не в archived", () => {
    const { active, archived } = splitGoalsForView(allGoals, monthFilter(june));
    expect(active.map((g) => g.id)).toEqual(["june-active"]);
    expect(archived.map((g) => g.id)).toEqual(["june-archived"]);
    expect(active.some((g) => g.id === "july-active")).toBe(false);
    expect(archived.some((g) => g.id === "july-archived")).toBe(false);
  });

  it("allTime: все ACTIVE любого месяца в active; ARCHIVED — в archived; ACTIVE прошлого не в archived", () => {
    const { active, archived } = splitGoalsForView(allGoals, allTime);
    expect(active.map((g) => g.id).sort()).toEqual(["aug-active", "july-active", "june-active"]);
    expect(archived.map((g) => g.id).sort()).toEqual(["july-archived", "june-archived"]);
    expect(archived.some((g) => g.status === "ACTIVE")).toBe(false);
  });

  it("day range внутри июля всё равно = July; Goal.month 1 июля не исчезает", () => {
    const ranged: DateFilterValue = {
      month: july,
      rangeStart: createLocalDate(2026, 6, 10),
      rangeEnd: createLocalDate(2026, 6, 20),
      allTime: false,
    };
    const filtered = filterGoalsByDate(allGoals, ranged);
    expect(filtered.map((g) => g.id).sort()).toEqual(["july-active", "july-archived"]);
    const { active, archived } = splitGoalsForView(allGoals, ranged);
    expect(active.map((g) => g.id)).toEqual(["july-active"]);
    expect(archived.map((g) => g.id)).toEqual(["july-archived"]);
  });
});
