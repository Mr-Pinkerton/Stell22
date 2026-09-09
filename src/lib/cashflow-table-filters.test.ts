import { describe, expect, it } from "vitest";
import { createLocalDate } from "@/lib/dates";
import { matchesDateFilter } from "@/lib/match-date-filter";
import {
  filterCashFlowTableRows,
  getDefaultCashFlowTableFilters,
  isCashFlowExtraFiltersDefault,
  type CashFlowTableFilters,
} from "@/lib/cashflow-table-filters";
import {
  financeCashFlows,
  financePeriodExpense,
  financePeriodIncome,
  type FinanceCashFlowRow,
} from "@/mocks/finance-fixtures";

const june = {
  month: createLocalDate(2026, 5, 1),
  rangeStart: null,
  rangeEnd: null,
  allTime: false,
};

function periodRows(rows: FinanceCashFlowRow[] = financeCashFlows) {
  return rows.filter((row) => matchesDateFilter(row.date, june));
}

function visible(filters: Partial<CashFlowTableFilters>, rows = periodRows()) {
  return filterCashFlowTableRows(rows, { ...getDefaultCashFlowTableFilters(), ...filters });
}

describe("getDefaultCashFlowTableFilters / extra default", () => {
  it("Reset extra filters возвращает default", () => {
    const dirty: CashFlowTableFilters = {
      search: "Лесопром",
      flowType: "EXPENSE",
      unassignedOnly: true,
    };
    expect(isCashFlowExtraFiltersDefault(dirty)).toBe(false);
    const reset = getDefaultCashFlowTableFilters();
    expect(reset).toEqual({ search: "", flowType: "ALL", unassignedOnly: false });
    expect(isCashFlowExtraFiltersDefault(reset)).toBe(true);
  });
});

describe("period vs visible ДДС datasets", () => {
  it("date period продолжает определять KPI dataset", () => {
    const period = periodRows();
    expect(period.length).toBe(financeCashFlows.length);
    expect(financePeriodIncome(period)).toBe(financePeriodIncome(financeCashFlows));
    expect(financePeriodExpense(period)).toBe(financePeriodExpense(financeCashFlows));

    const otherMonth = financeCashFlows.filter((row) =>
      matchesDateFilter(row.date, {
        month: createLocalDate(2026, 8, 1),
        rangeStart: null,
        rangeEnd: null,
        allTime: false,
      }),
    );
    // Фикстуры — июнь 2026; сентябрь → KPI пустые.
    expect(otherMonth).toEqual([]);
    expect(financePeriodIncome(otherMonth)).toBe(0);
    expect(financePeriodExpense(otherMonth)).toBe(0);
  });

  it("search режет только visible ДДС rows", () => {
    const period = periodRows();
    const byCounterparty = visible({ search: "Лесопром" });
    expect(byCounterparty.every((r) => r.counterpartyName?.includes("Лесопром"))).toBe(true);
    expect(byCounterparty.length).toBeGreaterThan(0);
    expect(byCounterparty.length).toBeLessThan(period.length);

    const byDescription = visible({ search: "комиссия" });
    expect(byDescription.map((r) => r.id)).toEqual(["cf-7"]);
    expect(financePeriodIncome(period)).toBe(financePeriodIncome(financeCashFlows));
  });

  it("flowType режет visible rows", () => {
    const income = visible({ flowType: "INCOME" });
    const expense = visible({ flowType: "EXPENSE" });
    expect(income.every((r) => r.flowType === "INCOME")).toBe(true);
    expect(expense.every((r) => r.flowType === "EXPENSE")).toBe(true);
    expect(income.length + expense.length).toBe(periodRows().length);
  });

  it("unassigned режет только isAutoAssigned === false", () => {
    const rows = visible({ unassignedOnly: true });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.isAutoAssigned === false)).toBe(true);
    expect(periodRows().some((r) => r.isAutoAssigned)).toBe(true);

    const transferAssigned: FinanceCashFlowRow = {
      id: "tr-assigned",
      date: "2026-06-15",
      amount: 1,
      flowType: "EXPENSE",
      accountName: "A",
      counterpartyName: null,
      description: "Перевод",
      articleName: null,
      dealName: null,
      dealId: null,
      isAutoAssigned: true,
      isTransfer: true,
    };
    expect(
      filterCashFlowTableRows([transferAssigned], {
        search: "",
        flowType: "ALL",
        unassignedOnly: true,
      }),
    ).toEqual([]);
  });

  it("комбинация filters работает через AND", () => {
    const rows = visible({
      search: "крепеж",
      flowType: "EXPENSE",
      unassignedOnly: true,
    });
    expect(rows.map((r) => r.id)).toEqual(["cf-6"]);
  });

  it("extra filters НЕ влияют на KPI dataset", () => {
    const period = periodRows();
    const table = visible({ flowType: "INCOME", unassignedOnly: true, search: "Озон" });
    expect(financePeriodExpense(table)).toBe(0);
    expect(financePeriodExpense(period)).toBe(financePeriodExpense(financeCashFlows));
    expect(financePeriodIncome(period)).toBe(financePeriodIncome(financeCashFlows));
    expect(table.length).toBeLessThan(period.length);
  });

  it("nullable description / counterparty не падают", () => {
    const rows: FinanceCashFlowRow[] = [
      {
        id: "n1",
        date: "2026-06-01",
        amount: 1,
        flowType: "EXPENSE",
        accountName: "A",
        counterpartyName: null,
        description: null as unknown as string,
        articleName: null,
        dealName: null,
        dealId: null,
        isAutoAssigned: false,
      },
    ];
    expect(() =>
      filterCashFlowTableRows(rows, { search: "банк", flowType: "ALL", unassignedOnly: false }),
    ).not.toThrow();
    expect(
      filterCashFlowTableRows(rows, { search: "банк", flowType: "ALL", unassignedOnly: false }),
    ).toEqual([]);
  });
});
