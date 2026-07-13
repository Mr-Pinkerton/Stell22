import { describe, expect, it } from "vitest";
import { createLocalDate, getMonthPeriod } from "./dates";
import {
  dateFilterFromParams,
  inPeriod,
  paramsFromDateFilter,
  periodFromParams,
  weekRangeFromParams,
} from "./report-period";

describe("periodFromParams", () => {
  it("all=1 → всё время (null)", () => {
    expect(periodFromParams({ all: "1" })).toBeNull();
  });

  it("month=YYYY-MM → календарный месяц", () => {
    const p = periodFromParams({ month: "2026-02" });
    expect(p).not.toBeNull();
    expect(p!.start).toEqual(createLocalDate(2026, 1, 1));
    expect(p!.end.getDate()).toBe(28); // февраль 2026
  });

  it("from+to → диапазон, конец = конец дня, нормализован", () => {
    const p = periodFromParams({ from: "2026-07-10", to: "2026-07-05" });
    expect(p!.start).toEqual(createLocalDate(2026, 6, 5));
    expect(p!.end.getDate()).toBe(10);
    expect(p!.end.getHours()).toBe(23);
  });

  it("пусто → текущий месяц", () => {
    const p = periodFromParams({});
    const cur = getMonthPeriod();
    expect(p!.start).toEqual(cur.start);
  });

  it("массив в параметре → берётся первый", () => {
    const p = periodFromParams({ month: ["2026-03", "2026-09"] });
    expect(p!.start).toEqual(createLocalDate(2026, 2, 1));
  });
});

describe("inPeriod", () => {
  const p = getMonthPeriod(createLocalDate(2026, 6, 1)); // июль 2026
  it("null период → всегда true", () => {
    expect(inPeriod(createLocalDate(2020, 0, 1), null)).toBe(true);
  });
  it("границы включительно", () => {
    expect(inPeriod(createLocalDate(2026, 6, 1), p)).toBe(true);
    expect(inPeriod(new Date(2026, 6, 31, 23, 0), p)).toBe(true);
    expect(inPeriod(createLocalDate(2026, 5, 30), p)).toBe(false);
    expect(inPeriod(createLocalDate(2026, 7, 1), p)).toBe(false);
  });
});

describe("weekRangeFromParams", () => {
  it("пятница → диапазон пт–чт (7 дней), конец дня четверга", () => {
    const r = weekRangeFromParams({ week: "2026-07-03" }); // пт 3 июля
    expect(r).not.toBeNull();
    expect(r!.start).toEqual(createLocalDate(2026, 6, 3));
    expect(r!.end.getDate()).toBe(9); // чт 9 июля
    expect(r!.end.getHours()).toBe(23);
  });
  it("нет параметра → null", () => {
    expect(weekRangeFromParams({})).toBeNull();
  });
});

describe("paramsFromDateFilter", () => {
  it("allTime → all=1", () => {
    const p = paramsFromDateFilter({
      month: createLocalDate(2026, 6, 1),
      rangeStart: null,
      rangeEnd: null,
      allTime: true,
    });
    expect(p.get("all")).toBe("1");
  });

  it("месяц → month=YYYY-MM", () => {
    const p = paramsFromDateFilter({
      month: createLocalDate(2026, 6, 1),
      rangeStart: null,
      rangeEnd: null,
      allTime: false,
    });
    expect(p.get("month")).toBe("2026-07");
  });

  it("диапазон → from/to", () => {
    const p = paramsFromDateFilter({
      month: createLocalDate(2026, 6, 1),
      rangeStart: createLocalDate(2026, 6, 3),
      rangeEnd: createLocalDate(2026, 6, 20),
      allTime: false,
    });
    expect(p.get("from")).toBe("2026-07-03");
    expect(p.get("to")).toBe("2026-07-20");
  });
});

describe("round-trip filter ⇄ params", () => {
  it("месяц сохраняется", () => {
    const v = dateFilterFromParams(paramsFromDateFilter({
      month: createLocalDate(2026, 3, 1),
      rangeStart: null,
      rangeEnd: null,
      allTime: false,
    }));
    expect(v.month).toEqual(createLocalDate(2026, 3, 1));
    expect(v.allTime).toBe(false);
  });

  it("диапазон сохраняется", () => {
    const v = dateFilterFromParams(paramsFromDateFilter({
      month: createLocalDate(2026, 3, 1),
      rangeStart: createLocalDate(2026, 3, 2),
      rangeEnd: createLocalDate(2026, 3, 25),
      allTime: false,
    }));
    expect(v.rangeStart).toEqual(createLocalDate(2026, 3, 2));
    expect(v.rangeEnd).toEqual(createLocalDate(2026, 3, 25));
  });

  it("всё время сохраняется", () => {
    const v = dateFilterFromParams(paramsFromDateFilter({
      month: createLocalDate(2026, 3, 1),
      rangeStart: null,
      rangeEnd: null,
      allTime: true,
    }));
    expect(v.allTime).toBe(true);
  });
});
