/** @vitest-environment happy-dom */
import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { selectDateFilterMonth, type DateFilterValue } from "@/components/date-filter";
import { FinanceCashflowTab } from "@/components/finance/finance-cashflow-tab";
import { FinanceKpiBlock } from "@/components/finance/finance-kpi-block";
import { createLocalDate } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { matchesDateFilter } from "@/lib/match-date-filter";
import {
  financePeriodExpense,
  financePeriodIncome,
  type FinanceCashFlowRow,
} from "@/mocks/finance-fixtures";
import { parseIsoDateLocal } from "@/lib/match-date-filter";
import { latestRecordedCashFlowDate } from "@/lib/finance-freshness";

afterEach(() => cleanup());

const octoberRow: FinanceCashFlowRow = {
  id: "oct-1",
  date: "2026-10-27",
  amount: 1500,
  flowType: "EXPENSE",
  accountName: "Расчётный",
  counterpartyName: "ООО Архив",
  description: "Октябрьская оплата",
  articleName: null,
  dealName: null,
  dealId: null,
  isAutoAssigned: false,
  source: "BANK",
};

const november = {
  month: createLocalDate(2026, 10, 1),
  rangeStart: null,
  rangeEnd: null,
  allTime: false,
};

function PeriodHarness() {
  const stored = [{ ...octoberRow }];
  const [filter, setFilter] = useState<DateFilterValue>(november);
  const visible = stored.filter((row) => matchesDateFilter(row.date, filter));
  return (
    <>
      <FinanceKpiBlock
        rows={visible}
        accounts={[{ id: "acc", name: "Расчётный", balance: 8000, confirmed: true }]}
        articles={[]}
        dateFilter={filter}
      />
      <FinanceCashflowTab
        rows={visible}
        periodOperationCount={visible.length}
        latestRecordedDate={latestRecordedCashFlowDate(stored.map((row) => row.date))}
        onShowRecordedPeriod={() => {
          const latest = latestRecordedCashFlowDate(stored.map((row) => row.date));
          if (!latest) return;
          setFilter(selectDateFilterMonth(parseIsoDateLocal(latest)));
        }}
        articles={[]}
        counterparties={[]}
        deals={[]}
        autoRules={[]}
      />
    </>
  );
}

describe("finance freshness empty period", () => {
  it("shows an empty selected period and the latest stored date without claiming a loss", async () => {
    const user = userEvent.setup();
    render(<PeriodHarness />);

    expect(screen.getByText("Нет операций в выбранном периоде")).toBeTruthy();
    expect(screen.getByText("Последняя сохранённая операция: 27.10.2026")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/потер/i);
    expect(screen.queryByText("Октябрьская оплата")).toBeNull();
    expect(document.body.textContent?.replace(/\s/g, "")).toContain(formatMoney(0).replace(/\s/g, ""));
    expect(document.body.textContent?.replace(/\s/g, "")).toContain(formatMoney(8000).replace(/\s/g, ""));

    await user.click(screen.getByRole("button", { name: "Показать период с последней операцией" }));

    expect(screen.getByText("Октябрьская оплата")).toBeTruthy();
    expect(screen.getByText("27.10.2026")).toBeTruthy();
    expect(document.body.textContent?.replace(/\s/g, "")).toContain(formatMoney(1500).replace(/\s/g, ""));
    expect(octoberRow.date).toBe("2026-10-27");
    expect(octoberRow.amount).toBe(1500);
    expect(financePeriodExpense([octoberRow])).toBe(1500);
    expect(financePeriodIncome([octoberRow])).toBe(0);
    expect(screen.getByText("Период показателей: Октябрь 2026")).toBeTruthy();
    expect(document.body.textContent?.replace(/\s/g, "")).toContain(formatMoney(8000).replace(/\s/g, ""));
  });
});
