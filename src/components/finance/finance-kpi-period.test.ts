import { describe, expect, it } from "vitest";
import { formatDateFilterTriggerLabel } from "@/components/date-filter";
import { formatFinanceKpiPeriodCaption } from "@/components/finance/finance-kpi-block";
import { createLocalDate } from "@/lib/dates";

describe("formatFinanceKpiPeriodCaption", () => {
  it("показывает месяц выбранного периода", () => {
    expect(
      formatFinanceKpiPeriodCaption({
        month: createLocalDate(2026, 9, 1),
        rangeStart: null,
        rangeEnd: null,
        allTime: false,
      }),
    ).toBe("Период показателей: Октябрь 2026");
  });

  it("показывает всё время", () => {
    expect(
      formatFinanceKpiPeriodCaption({
        month: createLocalDate(2026, 9, 1),
        rangeStart: null,
        rangeEnd: null,
        allTime: true,
      }),
    ).toBe("Период показателей: За всё время");
  });

  it("показывает завершённый диапазон тем же форматтером, что и фильтр даты", () => {
    const ranged = {
      month: createLocalDate(2026, 9, 1),
      rangeStart: createLocalDate(2026, 9, 2),
      rangeEnd: createLocalDate(2026, 9, 15),
      allTime: false,
    };
    expect(formatFinanceKpiPeriodCaption(ranged)).toBe(
      `Период показателей: ${formatDateFilterTriggerLabel(ranged)}`,
    );
    expect(formatFinanceKpiPeriodCaption(ranged)).toContain("—");
  });

  it("незавершённый диапазон остаётся подписью месяца", () => {
    expect(
      formatFinanceKpiPeriodCaption({
        month: createLocalDate(2026, 9, 1),
        rangeStart: createLocalDate(2026, 9, 2),
        rangeEnd: null,
        allTime: false,
      }),
    ).toBe("Период показателей: Октябрь 2026");
  });
});
