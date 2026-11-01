import { describe, expect, it } from "vitest";
import { createLocalDate } from "@/lib/dates";
import type { DateFilterValue } from "@/lib/date-filter-value";
import {
  applyDelayMs,
  classifyDateFilterCommit,
  navigationHrefIfNeeded,
  PERIOD_MONTH_APPLY_DELAY_MS,
  weekAfterDateChange,
} from "@/lib/period-auto-apply";
import { filterSalesRows } from "@/lib/sales-table-filters";
import {
  getDefaultSalesDateFilterValue,
  salesAppliedKey,
  salesHrefFromDraft,
} from "@/lib/sales-period";
import {
  getDefaultDateFilterValue,
} from "@/components/date-filter";
import { getDefaultWeekFilterValue } from "@/components/week-filter";
import { reportsHrefFromDraft } from "@/lib/report-period";

function monthFilter(year: number, month: number): DateFilterValue {
  return {
    month: createLocalDate(year, month, 1),
    rangeStart: null,
    rangeEnd: null,
    allTime: false,
  };
}

describe("автоприменение периода", () => {
  it("месяц даёт канонический адрес и не повторяет уже применённый", () => {
    const march = monthFilter(2026, 2);
    const sameMarch = monthFilter(2026, 2);
    const href = salesHrefFromDraft(march);
    expect(href).toBe("/sales?month=2026-03");
    expect(navigationHrefIfNeeded(href, salesAppliedKey(new URLSearchParams()))).toBe(href);
    expect(navigationHrefIfNeeded(salesHrefFromDraft(sameMarch), href)).toBeNull();
    expect(classifyDateFilterCommit(march)).toBe("month");
    expect(applyDelayMs("month")).toBe(PERIOD_MONTH_APPLY_DELAY_MS);
  });

  it("«За всё время» в продажах снимает период с адреса", () => {
    const allTime = getDefaultSalesDateFilterValue();
    const href = salesHrefFromDraft(allTime);
    expect(href).toBe("/sales");
    expect(classifyDateFilterCommit(allTime)).toBe("all");
    expect(navigationHrefIfNeeded(href, "/sales?month=2026-03")).toBe("/sales");
    expect(applyDelayMs("all")).toBe(0);
  });

  it("завершённый диапазон применяется, незавершённый — нет", () => {
    const open = {
      month: createLocalDate(2026, 6, 1),
      rangeStart: createLocalDate(2026, 6, 10),
      rangeEnd: null,
      allTime: false,
    };
    const closed = { ...open, rangeEnd: createLocalDate(2026, 6, 20) };
    expect(classifyDateFilterCommit(open)).toBe("incomplete");
    expect(navigationHrefIfNeeded(null, "/sales")).toBeNull();
    expect(classifyDateFilterCommit(closed)).toBe("range");
    expect(salesHrefFromDraft(closed)).toBe("/sales?from=2026-07-10&to=2026-07-20");
    expect(applyDelayMs("range")).toBe(0);
  });

  it("неделя зарплаты входит в адрес и сбрасывается при смене месяца", () => {
    const march = monthFilter(2026, 2);
    const april = monthFilter(2026, 3);
    const week = "2026-03-06";
    expect(reportsHrefFromDraft(march, week)).toBe("/reports?month=2026-03&week=2026-03-06");
    expect(weekAfterDateChange(march.month, april.month, week)).toBe("");
    expect(reportsHrefFromDraft(april, weekAfterDateChange(march.month, april.month, week))).toBe(
      "/reports?month=2026-04",
    );
    expect(weekAfterDateChange(march.month, monthFilter(2026, 2).month, week)).toBe(week);
  });

  it("сброс даёт один переход и не повторяет его, когда адрес уже совпал", () => {
    const applied = "/sales?month=2026-03";
    const resetHref = salesHrefFromDraft(getDefaultSalesDateFilterValue());
    expect(navigationHrefIfNeeded(resetHref, applied)).toBe("/sales");
    expect(navigationHrefIfNeeded(resetHref, resetHref)).toBeNull();

    const reportsReset = reportsHrefFromDraft(
      getDefaultDateFilterValue(),
      getDefaultWeekFilterValue(),
    );
    expect(navigationHrefIfNeeded(reportsReset, "/reports?month=2026-01&week=2026-01-02")).toBe(
      reportsReset,
    );
    expect(navigationHrefIfNeeded(reportsReset, reportsReset)).toBeNull();
  });

  it("поиск продаж не меняет адрес периода", () => {
    const rows = [
      {
        id: "1",
        productName: "Полка",
        sku: "SKU-1",
        soldQty: 1,
        revenue: 10,
      },
    ];
    const href = salesHrefFromDraft(monthFilter(2026, 2));
    expect(href).not.toContain("SKU");
    expect(filterSalesRows(rows, "SKU").map((row) => row.sku)).toEqual(["SKU-1"]);
    expect(filterSalesRows(rows, "нет")).toEqual([]);
    expect(salesHrefFromDraft(monthFilter(2026, 2))).toBe(href);
  });
});
