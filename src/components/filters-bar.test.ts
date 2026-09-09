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

  it("невидимая дата не делает бар dirty", () => {
    expect(
      isFiltersBarDefault({
        ...pristine,
        search: true,
        archive: true,
        dateFilter: { ...getDefaultDateFilterValue(), allTime: true },
      }),
    ).toBe(true);
  });

  it("непустая неделя dirty даже если WeekFilter скрыт", () => {
    expect(
      isFiltersBarDefault({
        ...pristine,
        search: true,
        archive: true,
        weekFilter: "2026-09-04",
      }),
    ).toBe(false);
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

  it("extraFiltersDirty=true → Reset enabled (не default)", () => {
    expect(
      isFiltersBarDefault({
        ...pristine,
        date: true,
        extraFiltersDirty: true,
      }),
    ).toBe(false);
  });

  it("extraFiltersDirty=false не ломает встроенный default", () => {
    expect(
      isFiltersBarDefault({
        ...pristine,
        date: true,
        extraFiltersDirty: false,
      }),
    ).toBe(true);
  });

  it("без custom default current month остаётся default", () => {
    expect(
      isFiltersBarDefault({
        ...pristine,
        date: true,
        dateFilter: getDefaultDateFilterValue(),
      }),
    ).toBe(true);
    expect(
      isFiltersBarDefault({
        ...pristine,
        date: true,
        dateFilter: { ...getDefaultDateFilterValue(), allTime: true },
      }),
    ).toBe(false);
  });

  it("Sales ALL TIME custom default: allTime = default, current month dirty", () => {
    const salesDefault = {
      month: getDefaultDateFilterValue().month,
      rangeStart: null,
      rangeEnd: null,
      allTime: true,
    };
    expect(
      isFiltersBarDefault({
        ...pristine,
        date: true,
        dateFilter: salesDefault,
        dateDefaultValue: salesDefault,
      }),
    ).toBe(true);
    expect(
      isFiltersBarDefault({
        ...pristine,
        date: true,
        dateFilter: getDefaultDateFilterValue(),
        dateDefaultValue: salesDefault,
      }),
    ).toBe(false);
  });
});
