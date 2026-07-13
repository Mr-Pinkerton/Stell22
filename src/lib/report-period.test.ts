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

  // Инстанты сверяем в UTC (toISOString) — не зависит от локали хоста.
  it("month=YYYY-MM → календарный месяц (UTC+3)", () => {
    const p = periodFromParams({ month: "2026-02" });
    expect(p).not.toBeNull();
    expect(p!.start.toISOString()).toBe("2026-01-31T21:00:00.000Z");
    expect(p!.end.toISOString()).toBe("2026-02-28T20:59:59.999Z");
  });

  it("from+to → диапазон, конец = конец дня, нормализован (UTC+3)", () => {
    const p = periodFromParams({ from: "2026-07-10", to: "2026-07-05" });
    expect(p!.start.toISOString()).toBe("2026-07-04T21:00:00.000Z");
    expect(p!.end.toISOString()).toBe("2026-07-10T20:59:59.999Z");
  });

  it("пусто → текущий месяц", () => {
    const p = periodFromParams({});
    const cur = getMonthPeriod();
    expect(p!.start.getTime()).toBe(cur.start.getTime());
  });

  it("массив в параметре → берётся первый", () => {
    const p = periodFromParams({ month: ["2026-03", "2026-09"] });
    expect(p!.start.toISOString()).toBe("2026-02-28T21:00:00.000Z"); // 01.03 00:00 МСК
  });
});

describe("inPeriod", () => {
  const p = getMonthPeriod(createLocalDate(2026, 6, 1)); // июль 2026 (UTC+3)
  it("null период → всегда true", () => {
    expect(inPeriod(createLocalDate(2020, 0, 1), null)).toBe(true);
  });
  it("границы включительно (инстанты в UTC)", () => {
    expect(inPeriod(new Date("2026-06-30T21:00:00.000Z"), p)).toBe(true); // 01.07 00:00 МСК
    expect(inPeriod(new Date("2026-07-31T20:59:59.999Z"), p)).toBe(true); // 31.07 23:59:59.999 МСК
    expect(inPeriod(new Date("2026-06-30T20:59:59.999Z"), p)).toBe(false); // до начала
    expect(inPeriod(new Date("2026-07-31T21:00:00.000Z"), p)).toBe(false); // 01.08 00:00 МСК
  });
});

describe("weekRangeFromParams", () => {
  it("пятница → диапазон пт–чт (7 дней), конец дня четверга (UTC+3)", () => {
    const r = weekRangeFromParams({ week: "2026-07-03" }); // пт 3 июля
    expect(r).not.toBeNull();
    expect(r!.start.toISOString()).toBe("2026-07-02T21:00:00.000Z"); // 03.07 00:00 МСК
    expect(r!.end.toISOString()).toBe("2026-07-09T20:59:59.999Z"); // чт 09.07 23:59:59.999 МСК
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
