import { describe, expect, it } from "vitest";
import { createLocalDate } from "@/lib/dates";
import { buildPayWeeksForMonth } from "./pay-weeks";

describe("buildPayWeeksForMonth", () => {
  it("включает только недели с пятницей в выбранном месяце", () => {
    const month = createLocalDate(2026, 5, 1); // июнь 2026
    const weeks = buildPayWeeksForMonth(month);

    expect(weeks.length).toBe(4);
    expect(weeks.every((w) => w.start.getMonth() === 5 && w.start.getDay() === 5)).toBe(true);
    expect(weeks[0]!.start.getDate()).toBe(5);
    expect(weeks[1]!.start.getDate()).toBe(12);
    expect(weeks[2]!.start.getDate()).toBe(19);
    expect(weeks[3]!.start.getDate()).toBe(26);
    expect(weeks.every((w) => w.end.getDay() === 4)).toBe(true);
  });
});
