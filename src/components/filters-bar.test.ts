import { describe, expect, it } from "vitest";
import { getDefaultDateFilterValue } from "@/components/date-filter";
import { isFiltersBarDefault } from "@/components/filters-bar";
import { getDefaultWeekFilterValue } from "@/components/week-filter";

const pristine = {
  query: "",
  showArchive: false,
  dateFilter: getDefaultDateFilterValue(),
  weekFilter: getDefaultWeekFilterValue(),
};

describe("isFiltersBarDefault", () => {
  it("пустой поиск и archive=false → default", () => {
    expect(
      isFiltersBarDefault({
        ...pristine,
        search: true,
        archive: true,
      }),
    ).toBe(true);
  });

  it("непустой поиск → dirty", () => {
    expect(
      isFiltersBarDefault({
        ...pristine,
        search: true,
        archive: true,
        query: "Иванов",
      }),
    ).toBe(false);
  });

  it("архив включён → dirty", () => {
    expect(
      isFiltersBarDefault({
        ...pristine,
        search: true,
        archive: true,
        showArchive: true,
      }),
    ).toBe(false);
  });

  it("невидимые date/week не делают бар dirty", () => {
    expect(
      isFiltersBarDefault({
        ...pristine,
        search: true,
        archive: true,
        weekFilter: "2026-09-04",
        dateFilter: { ...getDefaultDateFilterValue(), allTime: true },
      }),
    ).toBe(true);
  });

  it("выбранная неделя при weeks → dirty", () => {
    expect(
      isFiltersBarDefault({
        ...pristine,
        weeks: true,
        date: true,
        weekFilter: "2026-09-04",
      }),
    ).toBe(false);
  });
});
