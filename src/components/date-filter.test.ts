import { describe, expect, it } from "vitest";
import {
  getDefaultDateFilterValue,
  isDefaultDateFilterValue,
  formatDateFilterTriggerLabel,
  selectDateFilterMonth,
} from "@/components/date-filter";
import { addMonths, createLocalDate } from "@/lib/dates";

describe("isDefaultDateFilterValue", () => {
  it("считает дефолтом текущий месяц без диапазона, даже если Date другой identity", () => {
    const a = getDefaultDateFilterValue();
    const b = getDefaultDateFilterValue();
    expect(a.month).not.toBe(b.month);
    expect(isDefaultDateFilterValue(a)).toBe(true);
    expect(isDefaultDateFilterValue({ ...b, month: new Date(b.month.getTime()) })).toBe(true);
  });

  it("не дефолт при allTime", () => {
    expect(isDefaultDateFilterValue({ ...getDefaultDateFilterValue(), allTime: true })).toBe(
      false,
    );
  });

  it("не дефолт при диапазоне", () => {
    const month = createLocalDate(2026, 8, 1);
    expect(
      isDefaultDateFilterValue({
        month,
        rangeStart: createLocalDate(2026, 8, 1),
        rangeEnd: createLocalDate(2026, 8, 7),
        allTime: false,
      }),
    ).toBe(false);
  });

  it("не дефолт при другом месяце", () => {
    const def = getDefaultDateFilterValue();
    expect(
      isDefaultDateFilterValue({
        ...def,
        month: addMonths(def.month, -1),
      }),
    ).toBe(false);
  });

  it("custom ALL TIME default считается default; current month — нет", () => {
    const salesDefault = {
      month: getDefaultDateFilterValue().month,
      rangeStart: null,
      rangeEnd: null,
      allTime: true as const,
    };
    expect(isDefaultDateFilterValue(salesDefault, salesDefault)).toBe(true);
    expect(isDefaultDateFilterValue({ ...salesDefault, allTime: true })).toBe(false);
    expect(isDefaultDateFilterValue(getDefaultDateFilterValue(), salesDefault)).toBe(false);
  });
});

describe("DateFilter month-only API", () => {
  const july = createLocalDate(2026, 6, 1);
  const ranged = {
    month: july,
    rangeStart: createLocalDate(2026, 6, 10),
    rangeEnd: createLocalDate(2026, 6, 20),
    allTime: false,
  };

  it("default consumer (allowRange) показывает range в подписи", () => {
    expect(formatDateFilterTriggerLabel(ranged)).toMatch(/10/);
    expect(formatDateFilterTriggerLabel(ranged, true)).toMatch(/10/);
  });

  it("month-only не показывает range в подписи", () => {
    expect(formatDateFilterTriggerLabel(ranged, false)).not.toMatch(/10/);
    expect(formatDateFilterTriggerLabel(ranged, false)).toMatch(/2026/);
  });

  it("selectDateFilterMonth выбирает месяц и сбрасывает range", () => {
    const next = selectDateFilterMonth(createLocalDate(2026, 6, 15));
    expect(next.rangeStart).toBeNull();
    expect(next.rangeEnd).toBeNull();
    expect(next.allTime).toBe(false);
    expect(next.month.getFullYear()).toBe(2026);
    expect(next.month.getMonth()).toBe(6);
    expect(next.month.getDate()).toBe(1);
  });
});
