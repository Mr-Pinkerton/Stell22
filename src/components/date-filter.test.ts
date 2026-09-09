import { describe, expect, it } from "vitest";
import {
  getDefaultDateFilterValue,
  isDefaultDateFilterValue,
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
});
