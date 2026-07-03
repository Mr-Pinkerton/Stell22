import { describe, expect, it } from "vitest";
import {
  financeAccountBalance,
  financeCashFlows,
  financeArticles,
  financeExpenseChart,
  financePeriodExpense,
  financePeriodIncome,
  financeUnassignedCount,
  financeAccounts,
  formatAutoRuleCondition,
  financeAutoRules,
  groupCashFlowsByDate,
  type FinanceCashFlowRow,
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

describe("переводы между счетами не искажают обороты", () => {
  const transferLegs: FinanceCashFlowRow[] = [
    {
      id: "tr-out",
      date: "2026-06-15",
      amount: 100_000,
      flowType: "EXPENSE",
      accountName: "Счёт А",
      counterpartyName: null,
      description: "Перевод на «Счёт Б»",
      articleName: null,
      dealName: null,
      dealId: null,
      isAutoAssigned: true,
      isTransfer: true,
    },
    {
      id: "tr-in",
      date: "2026-06-15",
      amount: 100_000,
      flowType: "INCOME",
      accountName: "Счёт Б",
      counterpartyName: null,
      description: "Перевод с «Счёт А»",
      articleName: null,
      dealName: null,
      dealId: null,
      isAutoAssigned: true,
      isTransfer: true,
    },
  ];

  it("перевод не попадает в поступления/расходы", () => {
    const withTransfer = [...financeCashFlows, ...transferLegs];
    expect(financePeriodIncome(withTransfer)).toBe(financePeriodIncome(financeCashFlows));
    expect(financePeriodExpense(withTransfer)).toBe(financePeriodExpense(financeCashFlows));
  });

  it("перевод не попадает в диаграмму расходов и в счётчик неразнесённых", () => {
    const withTransfer = [...financeCashFlows, ...transferLegs];
    const base = financeExpenseChart(financeCashFlows, financeArticles);
    const withTr = financeExpenseChart(withTransfer, financeArticles);
    expect(withTr).toEqual(base);
    expect(financeUnassignedCount(withTransfer)).toBe(financeUnassignedCount(financeCashFlows));
  });

  it("превращение операции в перевод убирает её из расходов", () => {
    // Оплата с р/с, деньги получены наличными → операция должна стать переводом
    // и не считаться расходом; встречная нога — зачисление на «Наличные».
    const payment: FinanceCashFlowRow = {
      id: "pay-1",
      date: "2026-06-15",
      amount: 50_000,
      flowType: "EXPENSE",
      accountName: "Расчётный счёт",
      counterpartyName: "Иванов",
      description: "Оплата",
      articleName: "Материалы",
      dealName: null,
      dealId: null,
      isAutoAssigned: true,
      isTransfer: false,
    };
    const asExpense = [...financeCashFlows, payment];
    const expenseBefore = financePeriodExpense(asExpense);

    // После конвертации: исходная нога помечена переводом (без статьи), плюс
    // встречное зачисление на наличные — обе с isTransfer.
    const converted: FinanceCashFlowRow[] = [
      { ...payment, articleName: null, counterpartyName: null, isTransfer: true },
      {
        ...payment,
        id: "pay-1-cash",
        flowType: "INCOME",
        accountName: "Наличные",
        articleName: null,
        counterpartyName: null,
        isTransfer: true,
      },
    ];
    const afterConvert = [...financeCashFlows, ...converted];

    expect(expenseBefore - financePeriodExpense(afterConvert)).toBe(50_000);
    expect(financePeriodExpense(afterConvert)).toBe(financePeriodExpense(financeCashFlows));
    expect(financePeriodIncome(afterConvert)).toBe(financePeriodIncome(financeCashFlows));
  });
});
