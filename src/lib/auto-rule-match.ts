import type { FinanceAutoRule, FinanceCashFlowRow } from "@/mocks/finance-fixtures";

type MatchableRow = Pick<FinanceCashFlowRow, "flowType" | "counterpartyName" | "description">;

/**
 * Клиентская копия логики applyAutoRules (src/server/finance.ts), но по
 * именам вместо id — нужна, чтобы в таблице ДДС показать, есть ли для строки
 * подходящее автоправило, без похода на сервер.
 */
export function ruleMatchesRow(rule: FinanceAutoRule, row: MatchableRow): boolean {
  if (rule.flowType !== row.flowType) return false;
  if (!rule.articleName) return false;

  const conditions: boolean[] = [];
  if (rule.counterpartyName) conditions.push(rule.counterpartyName === row.counterpartyName);
  const kw = rule.descriptionKeywords?.trim().toLowerCase();
  if (kw) conditions.push(row.description.toLowerCase().includes(kw));
  if (conditions.length === 0) return false;

  return rule.logicOperator === "OR" ? conditions.some(Boolean) : conditions.every(Boolean);
}

/** Первое автоправило, которое сработало бы для этой строки, или null. */
export function findMatchingAutoRule(
  rules: FinanceAutoRule[],
  row: MatchableRow,
): FinanceAutoRule | null {
  return rules.find((rule) => ruleMatchesRow(rule, row)) ?? null;
}
