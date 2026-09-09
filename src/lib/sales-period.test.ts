import { describe, expect, it } from "vitest";
import { createLocalDate, getMonthPeriod } from "@/lib/dates";
import { dateFiltersEqual } from "@/lib/date-filter-value";
import {
  getDefaultSalesDateFilterValue,
  isSalesDraftApplied,
  saleDatePrismaWhere,
  salesAppliedKey,
  salesDraftFromParams,
  salesHrefFromDraft,
  salesPeriodFromParams,
  syncSalesDraftIfAppliedChanged,
} from "@/lib/sales-period";

function queryFromHref(href: string): URLSearchParams {
  const q = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
  return new URLSearchParams(q);
}

const allTime = getDefaultSalesDateFilterValue();
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
const julyRange = {
  month: createLocalDate(2026, 6, 1),
  rangeStart: createLocalDate(2026, 6, 3),
  rangeEnd: createLocalDate(2026, 6, 20),
  allTime: false,
};

describe("salesPeriodFromParams", () => {
  it("empty query → ALL TIME", () => {
    expect(salesPeriodFromParams({})).toBeNull();
    expect(salesPeriodFromParams(new URLSearchParams())).toBeNull();
  });

  it("explicit all-time → ALL TIME", () => {
    expect(salesPeriodFromParams({ all: "1" })).toBeNull();
  });

  it("month → календарный месяц (UTC+3)", () => {
    const p = salesPeriodFromParams({ month: "2026-02" });
    expect(p).not.toBeNull();
    expect(p!.start.toISOString()).toBe("2026-01-31T21:00:00.000Z");
    expect(p!.end.toISOString()).toBe("2026-02-28T20:59:59.999Z");
  });

  it("from/to → inclusive range, конец = конец дня (UTC+3)", () => {
    const p = salesPeriodFromParams({ from: "2026-07-10", to: "2026-07-05" });
    expect(p!.start.toISOString()).toBe("2026-07-04T21:00:00.000Z");
    expect(p!.end.toISOString()).toBe("2026-07-10T20:59:59.999Z");
  });

  it("empty ≡ explicit all-time applied key", () => {
    expect(salesAppliedKey(new URLSearchParams())).toBe(salesAppliedKey({ all: "1" }));
    expect(salesAppliedKey(new URLSearchParams())).toBe("/sales");
  });

  it("empty и all=1 → ALL TIME draft", () => {
    expect(salesDraftFromParams({}).allTime).toBe(true);
    expect(salesDraftFromParams({ all: "1" }).allTime).toBe(true);
  });
});

describe("salesHrefFromDraft", () => {
  it("ALL TIME → canonical /sales", () => {
    expect(salesHrefFromDraft(allTime)).toBe("/sales");
    expect(salesHrefFromDraft({ ...allTime, month: createLocalDate(2026, 0, 1) })).toBe("/sales");
  });

  it("month → month=YYYY-MM", () => {
    expect(salesHrefFromDraft(march)).toBe("/sales?month=2026-03");
  });

  it("range → from + to", () => {
    const q = queryFromHref(salesHrefFromDraft(julyRange));
    expect(q.get("from")).toBe("2026-07-03");
    expect(q.get("to")).toBe("2026-07-20");
    expect(q.has("month")).toBe(false);
    expect(q.has("all")).toBe(false);
  });

  it("Reset не оставляет stale period params", () => {
    const href = salesHrefFromDraft(allTime, new URLSearchParams("month=2026-03&from=2026-01-01&to=2026-01-02&all=1"));
    expect(href).toBe("/sales");
  });

  it("несвязанные params сохраняются", () => {
    expect(salesHrefFromDraft(allTime, new URLSearchParams("tab=x"))).toBe("/sales?tab=x");
    expect(salesHrefFromDraft(march, new URLSearchParams("tab=x"))).toBe("/sales?tab=x&month=2026-03");
  });

  it("Reset /sales?foo=bar&month=2026-03 → /sales?foo=bar", () => {
    expect(
      salesHrefFromDraft(allTime, new URLSearchParams("foo=bar&month=2026-03")),
    ).toBe("/sales?foo=bar");
  });
});

describe("isSalesDraftApplied", () => {
  it("all-time draft + empty URL → applied", () => {
    expect(isSalesDraftApplied(allTime, new URLSearchParams())).toBe(true);
    expect(isSalesDraftApplied(allTime, { all: "1" })).toBe(true);
  });

  it("month draft + all-time URL → dirty", () => {
    expect(isSalesDraftApplied(march, new URLSearchParams())).toBe(false);
  });

  it("same month → applied", () => {
    expect(isSalesDraftApplied(march, queryFromHref(salesHrefFromDraft(march)))).toBe(true);
  });

  it("range equality semantics", () => {
    const sameDays = {
      ...julyRange,
      rangeStart: createLocalDate(2026, 6, 3),
      rangeEnd: createLocalDate(2026, 6, 20),
    };
    expect(isSalesDraftApplied(sameDays, queryFromHref(salesHrefFromDraft(julyRange)))).toBe(true);
    expect(
      isSalesDraftApplied(
        { ...julyRange, rangeEnd: createLocalDate(2026, 6, 21) },
        queryFromHref(salesHrefFromDraft(julyRange)),
      ),
    ).toBe(false);
  });
});

describe("syncSalesDraftIfAppliedChanged", () => {
  it("Back/Forward applied-key change восстанавливает draft", () => {
    const marchParams = queryFromHref(salesHrefFromDraft(march));
    const aprilParams = queryFromHref(salesHrefFromDraft(april));
    const next = syncSalesDraftIfAppliedChanged(salesAppliedKey(marchParams), aprilParams, march);
    expect(dateFiltersEqual(next.dateFilter, april)).toBe(true);
    expect(isSalesDraftApplied(next.dateFilter, aprilParams)).toBe(true);
  });

  it("обычный rerender не уничтожает un-applied draft", () => {
    const params = queryFromHref(salesHrefFromDraft(march));
    const key = salesAppliedKey(params);
    const next = syncSalesDraftIfAppliedChanged(key, params, april);
    expect(dateFiltersEqual(next.dateFilter, april)).toBe(true);
    expect(isSalesDraftApplied(next.dateFilter, params)).toBe(false);
  });
});

describe("saleDatePrismaWhere", () => {
  it("ALL TIME → undefined (нет where)", () => {
    expect(saleDatePrismaWhere(null)).toBeUndefined();
  });

  it("bounded period → date gte/lte тех же границ, что period", () => {
    const period = getMonthPeriod(createLocalDate(2026, 5, 1));
    expect(saleDatePrismaWhere(period)).toEqual({
      date: { gte: period.start, lte: period.end },
    });
  });
});
