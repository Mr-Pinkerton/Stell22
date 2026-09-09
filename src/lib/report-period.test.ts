import { describe, expect, it } from "vitest";
import { getDefaultDateFilterValue } from "@/components/date-filter";
import { createLocalDate, getMonthPeriod } from "./dates";
import {
  dateFilterFromParams,
  dateFiltersEqual,
  inPeriod,
  isReportsDraftApplied,
  paramsFromDateFilter,
  periodFromParams,
  reportsAppliedKey,
  reportsHrefFromDraft,
  syncReportsDraftIfAppliedChanged,
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

function queryFromHref(href: string): URLSearchParams {
  const q = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
  return new URLSearchParams(q);
}

describe("reportsHrefFromDraft", () => {
  it("месяц → /reports?month=YYYY-MM", () => {
    expect(
      reportsHrefFromDraft({
        month: createLocalDate(2026, 6, 1),
        rangeStart: null,
        rangeEnd: null,
        allTime: false,
      }),
    ).toBe("/reports?month=2026-07");
  });

  it("диапазон → from/to без month/all", () => {
    const q = queryFromHref(
      reportsHrefFromDraft({
        month: createLocalDate(2026, 6, 1),
        rangeStart: createLocalDate(2026, 6, 3),
        rangeEnd: createLocalDate(2026, 6, 20),
        allTime: false,
      }),
    );
    expect(q.get("from")).toBe("2026-07-03");
    expect(q.get("to")).toBe("2026-07-20");
    expect(q.has("month")).toBe(false);
    expect(q.has("all")).toBe(false);
  });

  it("всё время → all=1 без month/from/to", () => {
    const q = queryFromHref(
      reportsHrefFromDraft({
        month: createLocalDate(2026, 6, 1),
        rangeStart: null,
        rangeEnd: null,
        allTime: true,
      }),
    );
    expect(q.get("all")).toBe("1");
    expect(q.has("month")).toBe(false);
    expect(q.has("from")).toBe(false);
    expect(q.has("to")).toBe(false);
  });

  it("неделя ЗП → week=YYYY-MM-DD (пятница)", () => {
    const q = queryFromHref(
      reportsHrefFromDraft(
        {
          month: createLocalDate(2026, 6, 1),
          rangeStart: null,
          rangeEnd: null,
          allTime: false,
        },
        "2026-07-03",
      ),
    );
    expect(q.get("month")).toBe("2026-07");
    expect(q.get("week")).toBe("2026-07-03");
  });

  it("reset (default + пустая неделя) не оставляет from/to/all/week", () => {
    const q = queryFromHref(reportsHrefFromDraft(getDefaultDateFilterValue(), ""));
    expect(q.has("from")).toBe(false);
    expect(q.has("to")).toBe(false);
    expect(q.has("all")).toBe(false);
    expect(q.has("week")).toBe(false);
    expect(q.get("month")).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("isReportsDraftApplied", () => {
  it("пустой URL совпадает с текущим месяцем без недели", () => {
    expect(isReportsDraftApplied(getDefaultDateFilterValue(), "", new URLSearchParams())).toBe(
      true,
    );
  });

  it("month текущего месяца совпадает с дефолтным draft", () => {
    const href = reportsHrefFromDraft(getDefaultDateFilterValue(), "");
    expect(isReportsDraftApplied(getDefaultDateFilterValue(), "", queryFromHref(href))).toBe(
      true,
    );
  });

  it("черновик allTime не совпадает с URL месяца", () => {
    expect(
      isReportsDraftApplied(
        { ...getDefaultDateFilterValue(), allTime: true },
        "",
        queryFromHref(reportsHrefFromDraft(getDefaultDateFilterValue(), "")),
      ),
    ).toBe(false);
  });

  it("неприменённая неделя — dirty", () => {
    const date = {
      month: createLocalDate(2026, 6, 1),
      rangeStart: null,
      rangeEnd: null,
      allTime: false,
    };
    expect(
      isReportsDraftApplied(date, "2026-07-03", queryFromHref(reportsHrefFromDraft(date, ""))),
    ).toBe(false);
  });

  it("применённые month+week совпадают с draft", () => {
    const date = {
      month: createLocalDate(2026, 6, 1),
      rangeStart: null,
      rangeEnd: null,
      allTime: false,
    };
    expect(
      isReportsDraftApplied(
        date,
        "2026-07-03",
        queryFromHref(reportsHrefFromDraft(date, "2026-07-03")),
      ),
    ).toBe(true);
  });
});

const march = {
  month: createLocalDate(2026, 2, 1),
  rangeStart: null,
  rangeEnd: null,
  allTime: false,
};
const april = {
  month: createLocalDate(2026, 3, 1),
  rangeStart: null,
  rangeEnd: null,
  allTime: false,
};

describe("reportsAppliedKey", () => {
  it("пустой query и month текущего месяца — одна applied-сигнатура", () => {
    expect(reportsAppliedKey(new URLSearchParams())).toBe(
      reportsAppliedKey(queryFromHref(reportsHrefFromDraft(getDefaultDateFilterValue(), ""))),
    );
  });

  it("март и апрель — разные ключи", () => {
    expect(reportsAppliedKey(queryFromHref(reportsHrefFromDraft(march, "")))).not.toBe(
      reportsAppliedKey(queryFromHref(reportsHrefFromDraft(april, ""))),
    );
  });

  it("week меняет ключ", () => {
    expect(reportsAppliedKey(queryFromHref(reportsHrefFromDraft(march, "2026-03-06")))).not.toBe(
      reportsAppliedKey(queryFromHref(reportsHrefFromDraft(march, ""))),
    );
  });
});

describe("syncReportsDraftIfAppliedChanged", () => {
  it("applied март + draft март → applied=true, draft не трогаем", () => {
    const params = queryFromHref(reportsHrefFromDraft(march, ""));
    const key = reportsAppliedKey(params);
    const next = syncReportsDraftIfAppliedChanged(key, params, { dateFilter: march, week: "" });
    expect(dateFiltersEqual(next.dateFilter, march)).toBe(true);
    expect(isReportsDraftApplied(next.dateFilter, next.week, params)).toBe(true);
  });

  it("draft апрель при URL март → applied=false, ввод сохраняется", () => {
    const params = queryFromHref(reportsHrefFromDraft(march, ""));
    const key = reportsAppliedKey(params);
    const next = syncReportsDraftIfAppliedChanged(key, params, { dateFilter: april, week: "" });
    expect(dateFiltersEqual(next.dateFilter, april)).toBe(true);
    expect(next.week).toBe("");
    expect(isReportsDraftApplied(next.dateFilter, next.week, params)).toBe(false);
  });

  it("canonical URL сменился на апрель → draft восстанавливается, applied=true", () => {
    const marchParams = queryFromHref(reportsHrefFromDraft(march, ""));
    const aprilParams = queryFromHref(reportsHrefFromDraft(april, ""));
    const next = syncReportsDraftIfAppliedChanged(reportsAppliedKey(marchParams), aprilParams, {
      dateFilter: march,
      week: "",
    });
    expect(dateFiltersEqual(next.dateFilter, april)).toBe(true);
    expect(isReportsDraftApplied(next.dateFilter, next.week, aprilParams)).toBe(true);
  });

  it("URL с week → URL без week восстанавливает пустую неделю", () => {
    const withWeek = queryFromHref(reportsHrefFromDraft(march, "2026-03-06"));
    const withoutWeek = queryFromHref(reportsHrefFromDraft(march, ""));
    const next = syncReportsDraftIfAppliedChanged(reportsAppliedKey(withWeek), withoutWeek, {
      dateFilter: march,
      week: "2026-03-06",
    });
    expect(next.week).toBe("");
    expect(isReportsDraftApplied(next.dateFilter, next.week, withoutWeek)).toBe(true);
  });
});
