import { describe, expect, it } from "vitest";
import { findMatchingAutoRule, ruleMatchesRow } from "./auto-rule-match";
import type { FinanceAutoRule, FinanceCashFlowRow } from "@/mocks/finance-fixtures";

function rule(overrides: Partial<FinanceAutoRule> = {}): FinanceAutoRule {
  return {
    id: "rule-1",
    flowType: "EXPENSE",
    counterpartyName: null,
    logicOperator: "AND",
    descriptionKeywords: null,
    articleName: "Аренда",
    dealName: null,
    ...overrides,
  };
}

function row(overrides: Partial<FinanceCashFlowRow> = {}): FinanceCashFlowRow {
  return {
    id: "cf-1",
    date: "2026-07-01",
    amount: 1000,
    flowType: "EXPENSE",
    accountName: "Расчётный счёт",
    counterpartyName: "ООО Ромашка",
    description: "Оплата аренды за июль",
    articleName: null,
    dealName: null,
    dealId: null,
    isAutoAssigned: false,
    ...overrides,
  };
}

describe("ruleMatchesRow", () => {
  it("не совпадает при другом типе операции", () => {
    expect(ruleMatchesRow(rule({ flowType: "INCOME" }), row())).toBe(false);
  });

  it("не совпадает без статьи в правиле", () => {
    expect(ruleMatchesRow(rule({ articleName: null }), row())).toBe(false);
  });

  it("не совпадает без единого условия (пустое правило)", () => {
    expect(ruleMatchesRow(rule(), row())).toBe(false);
  });

  it("совпадает по контрагенту", () => {
    expect(
      ruleMatchesRow(rule({ counterpartyName: "ООО Ромашка" }), row()),
    ).toBe(true);
  });

  it("не совпадает при другом контрагенте", () => {
    expect(
      ruleMatchesRow(rule({ counterpartyName: "ИП Иванов" }), row()),
    ).toBe(false);
  });

  it("совпадает по ключевым словам в описании (без учёта регистра)", () => {
    expect(
      ruleMatchesRow(rule({ descriptionKeywords: "АРЕНД" }), row()),
    ).toBe(true);
  });

  it("AND: оба условия должны совпасть", () => {
    const r = rule({ counterpartyName: "ИП Иванов", descriptionKeywords: "аренд", logicOperator: "AND" });
    expect(ruleMatchesRow(r, row())).toBe(false);
  });

  it("OR: достаточно одного условия", () => {
    const r = rule({ counterpartyName: "ИП Иванов", descriptionKeywords: "аренд", logicOperator: "OR" });
    expect(ruleMatchesRow(r, row())).toBe(true);
  });
});

describe("findMatchingAutoRule", () => {
  it("возвращает первое совпавшее правило", () => {
    const rules = [
      rule({ id: "r1", counterpartyName: "ИП Иванов" }),
      rule({ id: "r2", counterpartyName: "ООО Ромашка" }),
    ];
    expect(findMatchingAutoRule(rules, row())?.id).toBe("r2");
  });

  it("возвращает null, если ничего не совпало", () => {
    const rules = [rule({ counterpartyName: "ИП Иванов" })];
    expect(findMatchingAutoRule(rules, row())).toBeNull();
  });
});
