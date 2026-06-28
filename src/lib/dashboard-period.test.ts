import { describe, expect, it } from "vitest";
import { createLocalDate } from "@/lib/dates";
import {
  buildStandardWeeksInPeriod,
  previousDashboardPeriod,
  resolveDashboardPeriod,
} from "@/lib/dashboard-period";

describe("resolveDashboardPeriod", () => {
  const now = createLocalDate(2026, 5, 15);

  it("месяц — с 1 по последний день", () => {
    const p = resolveDashboardPeriod("month", now);
    expect(p.start.getDate()).toBe(1);
    expect(p.end.getDate()).toBe(30);
  });

  it("неделя — пн–вс", () => {
    const p = resolveDashboardPeriod("week", now);
    expect(p.start.getDay()).toBe(1);
    expect(p.end.getDay()).toBe(0);
  });
});

describe("previousDashboardPeriod", () => {
  it("для месяца возвращает прошлый месяц", () => {
    const current = resolveDashboardPeriod("month", createLocalDate(2026, 5, 10));
    const prev = previousDashboardPeriod(current);
    expect(prev.start.getMonth()).toBe(4);
  });
});

describe("buildStandardWeeksInPeriod", () => {
  it("строит недели внутри месяца", () => {
    const period = resolveDashboardPeriod("month", createLocalDate(2026, 5, 10));
    const weeks = buildStandardWeeksInPeriod(period);
    expect(weeks.length).toBeGreaterThan(3);
  });
});
