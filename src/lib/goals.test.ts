import { describe, expect, it } from "vitest";
import { createLocalDate } from "@/lib/dates";
import {
  countWorkingDaysInMonth,
  dailyPlan,
  formatGoalMonthIso,
  goalCompletionPercent,
  isWorkingDay,
  weeklyPlan,
} from "@/lib/goals";

describe("isWorkingDay", () => {
  it("воскресенье — не рабочий", () => {
    expect(isWorkingDay(createLocalDate(2026, 5, 28))).toBe(false); // вс 28.06.2026
  });

  it("понедельник — рабочий", () => {
    expect(isWorkingDay(createLocalDate(2026, 5, 29))).toBe(true);
  });
});

describe("countWorkingDaysInMonth", () => {
  it("считает дни без воскресений", () => {
    const june2026 = createLocalDate(2026, 5, 1);
    expect(countWorkingDaysInMonth(june2026)).toBe(26);
  });
});

describe("dailyPlan", () => {
  it("делит цель на рабочие дни", () => {
    expect(dailyPlan(260, 26)).toBe(10);
    expect(dailyPlan(0, 26)).toBe(0);
  });
});

describe("weeklyPlan", () => {
  it("суммирует дневной план рабочих дней недели в месяце", () => {
    const month = createLocalDate(2026, 5, 1);
    const weekMon = createLocalDate(2026, 5, 22); // пн 22.06
    expect(weeklyPlan(260, month, weekMon)).toBe(60); // 6 рабочих дней × 10
  });
});

describe("goalCompletionPercent", () => {
  it("считает долю факта от плана", () => {
    expect(goalCompletionPercent(50, 100)).toBe(50);
    expect(goalCompletionPercent(75, 100)).toBe(75);
  });
});

describe("formatGoalMonthIso", () => {
  it("форматирует первый день месяца", () => {
    expect(formatGoalMonthIso(createLocalDate(2026, 5, 15))).toBe("2026-06-01");
  });
});
