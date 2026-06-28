import { describe, expect, it } from "vitest";
import {
  financeAccountBalance,
  financeCashFlows,
  financeArticles,
  financeExpenseChart,
  financePeriodExpense,
  financePeriodIncome,
  financeAccounts,
  formatAutoRuleCondition,
  financeAutoRules,
  groupCashFlowsByDate,
} from "@/mocks/finance-fixtures";

describe("finance fixtures", () => {
  it("считает остаток на счетах", () => {
    expect(financeAccountBalance(financeAccounts)).toBe(2_336_700);
  });

  it("считает поступления и расходы за период", () => {
    expect(financePeriodIncome(financeCashFlows)).toBe(97_800);
    expect(financePeriodExpense(financeCashFlows)).toBe(422_300);
  });

  it("строит диаграмму расходов по категориям", () => {
    const chart = financeExpenseChart(financeCashFlows, financeArticles);
    expect(chart.length).toBeGreaterThan(0);
    expect(chart.reduce((s, c) => s + c.pct, 0)).toBe(100);
    expect(chart.some((c) => c.category === "Не разнесено")).toBe(true);
  });

  it("форматирует условие автоправила", () => {
    expect(formatAutoRuleCondition(financeAutoRules[0])).toContain("списание");
    expect(formatAutoRuleCondition(financeAutoRules[0])).toContain("Лесопром");
  });

  it("группирует ДДС по дате", () => {
    const groups = groupCashFlowsByDate(financeCashFlows);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups[0]!.date >= groups[1]!.date).toBe(true);
    expect(groups.reduce((s, g) => s + g.rows.length, 0)).toBe(financeCashFlows.length);
  });
});
