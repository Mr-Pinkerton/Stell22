import { describe, expect, it } from "vitest";
import { getDefaultDateFilterValue } from "@/components/date-filter";
import { createLocalDate } from "@/lib/dates";
import { matchesDateFilter } from "@/lib/match-date-filter";

describe("matchesDateFilter", () => {
  it("пропускает все даты при allTime", () => {
    expect(
      matchesDateFilter("2020-01-01", { ...getDefaultDateFilterValue(), allTime: true }),
    ).toBe(true);
  });

  it("фильтрует по месяцу", () => {
    const filter = {
      month: createLocalDate(2026, 5, 1),
      rangeStart: null,
      rangeEnd: null,
      allTime: false,
    };
    expect(matchesDateFilter("2026-06-15", filter)).toBe(true);
    expect(matchesDateFilter("2026-05-31", filter)).toBe(false);
  });

  it("фильтрует по диапазону", () => {
    const filter = {
      month: createLocalDate(2026, 5, 1),
      rangeStart: createLocalDate(2026, 5, 10),
      rangeEnd: createLocalDate(2026, 5, 12),
      allTime: false,
    };
    expect(matchesDateFilter("2026-06-11", filter)).toBe(true);
    expect(matchesDateFilter("2026-06-09", filter)).toBe(false);
  });
});
