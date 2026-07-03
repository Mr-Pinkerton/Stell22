// Моки для раздела «Финансы» (UI-прототип, Этап 2).

import type { DealStatus, FlowType } from "@/types/domain";

export interface FinanceAccount {
  id: string;
  name: string;
  /** Текущий остаток = начальный остаток + операции ДДС с даты `openingDate`. */
  balance: number;
  accountNumber?: string | null;
  bik?: string | null;
  /** Зафиксированная точка отсчёта остатка (вручную или из выписки). */
  openingBalance?: number;
  /** Дата точки отсчёта (yyyy-mm-dd); операции с неё двигают остаток. */
  openingDate?: string | null;
  /** Последняя выписка разошлась с расчётным остатком (бейдж «≠»). */
  balanceMismatch?: boolean;
  /** Требует подтверждения (авто-создан импортом выписки) — операции скрыты в ДДС. */
  confirmed?: boolean;
}

export interface FinanceArticle {
  id: string;
  name: string;
  flowType: FlowType;
  categoryName: string;
  isOverhead: boolean;
  parentId: string | null;
  description?: string;
}

export interface FinanceCounterparty {
  id: string;
  name: string;
  inn?: string | null;
}

export interface FinanceCategory {
  id: string;
  name: string;
  /** «Производственные (накладные)» — участвует в распределении накладных. */
  isOverhead: boolean;
  /** Сколько статей относится к категории (для запрета удаления непустой). */
  articleCount: number;
}

export interface FinanceDeal {
  id: string;
  name: string;
  status: DealStatus;
  total: number;
  batchNames: string[];
  deliveryExtra: number;
  /** Сумма закупочных стоимостей привязанных партий (для разбивки в табе). */
  purchaseTotal?: number;
}

export interface FinanceCashFlowRow {
  id: string;
  date: string;
  amount: number;
  flowType: FlowType;
  accountId?: string;
  accountName: string;
  counterpartyName: string | null;
  description: string;
  articleName: string | null;
  dealName: string | null;
  dealId: string | null;
  isAutoAssigned: boolean;
  /** Перевод между своими счетами — не учитывается в доходах/расходах. */
  isTransfer?: boolean;
}

export type AutoRuleLogic = "AND" | "OR";

export interface FinanceAutoRule {
  id: string;
  flowType: FlowType;
  counterpartyName: string | null;
  /** Связь между контрагентом и ключевыми словами: «и» / «или». */
  logicOperator: AutoRuleLogic;
  descriptionKeywords: string | null;
  articleName: string | null;
  dealName: string | null;
}

export interface FinanceStatementRow {
  id: string;
  date: string;
  accountName: string | null;
  operationsCount: number;
  unassignedCount: number;
  uploaded: boolean;
  /** «Конечный остаток» выписки разошёлся с расчётным (бейдж «≠»). */
  mismatch?: boolean;
}

export interface ExpenseChartSlice {
  category: string;
  amount: number;
  pct: number;
}

export const financeAccounts: FinanceAccount[] = [
  { id: "acc-1", name: "Расчётный (Тинькофф)", balance: 1_842_500 },
  { id: "acc-2", name: "Расчётный (Сбер)", balance: 456_200 },
  { id: "acc-3", name: "Наличные", balance: 38_000 },
];

export const financeCounterparties: FinanceCounterparty[] = [
  { id: "cp-1", name: "ООО «Лесопром»", inn: "7801234567" },
  { id: "cp-2", name: "ИП Козлов А.В.", inn: "780112345678" },
  { id: "cp-3", name: "ООО «Доставка Северо-Запад»", inn: "7802345678" },
  { id: "cp-4", name: "АО «Энергосбыт»", inn: "7803456789" },
  { id: "cp-5", name: "Озон (маркетплейс)", inn: "7704217370" },
];

export const financeArticles: FinanceArticle[] = [
  {
    id: "art-1",
    name: "Выручка МП",
    flowType: "INCOME",
    categoryName: "Продажи",
    isOverhead: false,
    parentId: null,
    description: "Поступления с маркетплейсов",
  },
  {
    id: "art-2",
    name: "Прочие поступления",
    flowType: "INCOME",
    categoryName: "Прочее",
    isOverhead: false,
    parentId: null,
  },
  {
    id: "art-3",
    name: "Закупка сырья",
    flowType: "EXPENSE",
    categoryName: "Материалы",
    isOverhead: false,
    parentId: null,
    description: "Партии реек и пакетов",
  },
  {
    id: "art-4",
    name: "Доставка",
    flowType: "EXPENSE",
    categoryName: "Материалы",
    isOverhead: false,
    parentId: "art-3",
    description: "Субстатья под «Закупка сырья»",
  },
  {
    id: "art-5",
    name: "Электроэнергия",
    flowType: "EXPENSE",
    categoryName: "Производственные (накладные)",
    isOverhead: true,
    parentId: null,
  },
  {
    id: "art-6",
    name: "Аренда цеха",
    flowType: "EXPENSE",
    categoryName: "Производственные (накладные)",
    isOverhead: true,
    parentId: null,
  },
  {
    id: "art-7",
    name: "ЗП производство",
    flowType: "EXPENSE",
    categoryName: "Зарплата",
    isOverhead: false,
    parentId: null,
    description: "Не входит в накладные — отдельный учёт работы",
  },
  {
    id: "art-8",
    name: "Канцелярия",
    flowType: "EXPENSE",
    categoryName: "Административные",
    isOverhead: false,
    parentId: null,
  },
  {
    id: "art-9",
    name: "Банковская комиссия",
    flowType: "EXPENSE",
    categoryName: "Финансовые",
    isOverhead: false,
    parentId: null,
  },
];

export const financeDeals: FinanceDeal[] = [
  {
    id: "deal-1",
    name: "Волочек 2419 + доставка",
    status: "OPEN",
    total: 168_500,
    batchNames: ["Волочек 2419"],
    deliveryExtra: 10_500,
  },
  {
    id: "deal-2",
    name: "Сосна 3020",
    status: "OPEN",
    total: 102_000,
    batchNames: ["Сосна 3020"],
    deliveryExtra: 4_000,
  },
  {
    id: "deal-3",
    name: "Бук 4025 (архив)",
    status: "ARCHIVED",
    total: 225_000,
    batchNames: ["Бук 4025"],
    deliveryExtra: 7_000,
  },
];

export const financeAutoRules: FinanceAutoRule[] = [
  {
    id: "rule-1",
    flowType: "EXPENSE",
    counterpartyName: "ООО «Лесопром»",
    logicOperator: "AND",
    descriptionKeywords: null,
    articleName: "Закупка сырья",
    dealName: null,
  },
  {
    id: "rule-2",
    flowType: "EXPENSE",
    counterpartyName: "ООО «Доставка Северо-Запад»",
    logicOperator: "OR",
    descriptionKeywords: "доставка",
    articleName: "Доставка",
    dealName: "Волочек 2419 + доставка",
  },
  {
    id: "rule-3",
    flowType: "INCOME",
    counterpartyName: "Озон (маркетплейс)",
    logicOperator: "AND",
    descriptionKeywords: "выплата",
    articleName: "Выручка МП",
    dealName: null,
  },
  {
    id: "rule-4",
    flowType: "EXPENSE",
    counterpartyName: "АО «Энергосбыт»",
    logicOperator: "AND",
    descriptionKeywords: "электро",
    articleName: "Электроэнергия",
    dealName: null,
  },
];

export function createEmptyAutoRule(): FinanceAutoRule {
  return {
    id: `rule-${Date.now()}`,
    flowType: "EXPENSE",
    counterpartyName: null,
    logicOperator: "AND",
    descriptionKeywords: null,
    articleName: null,
    dealName: null,
  };
}

export const financeCashFlows: FinanceCashFlowRow[] = [
  {
    id: "cf-1",
    date: "2026-06-02",
    amount: 150_000,
    flowType: "EXPENSE",
    accountName: "Расчётный (Тинькофф)",
    counterpartyName: "ООО «Лесопром»",
    description: "Оплата по счёту №1847, рейки сосна",
    articleName: "Закупка сырья",
    dealName: "Волочек 2419 + доставка",
    dealId: "deal-1",
    isAutoAssigned: true,
  },
  {
    id: "cf-2",
    date: "2026-06-03",
    amount: 10_500,
    flowType: "EXPENSE",
    accountName: "Расчётный (Тинькофф)",
    counterpartyName: "ООО «Доставка Северо-Запад»",
    description: "Доставка партии Волочек",
    articleName: "Доставка",
    dealName: "Волочек 2419 + доставка",
    dealId: "deal-1",
    isAutoAssigned: true,
  },
  {
    id: "cf-3",
    date: "2026-06-05",
    amount: 98_000,
    flowType: "EXPENSE",
    accountName: "Расчётный (Сбер)",
    counterpartyName: "ООО «Лесопром»",
    description: "Партия Сосна 3020",
    articleName: "Закупка сырья",
    dealName: "Сосна 3020",
    dealId: "deal-2",
    isAutoAssigned: true,
  },
  {
    id: "cf-4",
    date: "2026-06-07",
    amount: 42_800,
    flowType: "INCOME",
    accountName: "Расчётный (Тинькофф)",
    counterpartyName: "Озон (маркетплейс)",
    description: "Выплата за период 01–05.06",
    articleName: "Выручка МП",
    dealName: null,
    dealId: null,
    isAutoAssigned: true,
  },
  {
    id: "cf-5",
    date: "2026-06-08",
    amount: 18_200,
    flowType: "EXPENSE",
    accountName: "Расчётный (Тинькофф)",
    counterpartyName: "АО «Энергосбыт»",
    description: "Электроэнергия май 2026",
    articleName: "Электроэнергия",
    dealName: null,
    dealId: null,
    isAutoAssigned: true,
  },
  {
    id: "cf-6",
    date: "2026-06-09",
    amount: 12_400,
    flowType: "EXPENSE",
    accountName: "Расчётный (Тинькофф)",
    counterpartyName: "ИП Козлов А.В.",
    description: "Поставка крепежа — без правила",
    articleName: null,
    dealName: null,
    dealId: null,
    isAutoAssigned: false,
  },
  {
    id: "cf-7",
    date: "2026-06-10",
    amount: 3_200,
    flowType: "EXPENSE",
    accountName: "Расчётный (Тинькофф)",
    counterpartyName: null,
    description: "Комиссия банка — не разнесено",
    articleName: null,
    dealName: null,
    dealId: null,
    isAutoAssigned: false,
  },
  {
    id: "cf-8",
    date: "2026-06-12",
    amount: 55_000,
    flowType: "INCOME",
    accountName: "Расчётный (Сбер)",
    counterpartyName: "Озон (маркетплейс)",
    description: "Выплата за период 06–11.06",
    articleName: "Выручка МП",
    dealName: null,
    dealId: null,
    isAutoAssigned: true,
  },
  {
    id: "cf-9",
    date: "2026-06-14",
    amount: 45_000,
    flowType: "EXPENSE",
    accountName: "Расчётный (Тинькофф)",
    counterpartyName: "ООО «Лесопром»",
    description: "Аванс по партии Ель 1812",
    articleName: "Закупка сырья",
    dealName: null,
    dealId: null,
    isAutoAssigned: true,
  },
  {
    id: "cf-10",
    date: "2026-06-15",
    amount: 85_000,
    flowType: "EXPENSE",
    accountName: "Наличные",
    counterpartyName: null,
    description: "Выплата ЗП неделя 24 — вручную",
    articleName: "ЗП производство",
    dealName: null,
    dealId: null,
    isAutoAssigned: false,
  },
];

export const financeStatements: FinanceStatementRow[] = [
  {
    id: "st-1",
    date: "2026-06-14",
    accountName: "Расчётный (Тинькофф)",
    operationsCount: 6,
    unassignedCount: 2,
    uploaded: true,
  },
  {
    id: "st-2",
    date: "2026-06-14",
    accountName: "Расчётный (Сбер)",
    operationsCount: 2,
    unassignedCount: 0,
    uploaded: true,
  },
  {
    id: "st-3",
    date: "2026-06-13",
    accountName: "Расчётный (Тинькофф)",
    operationsCount: 4,
    unassignedCount: 0,
    uploaded: true,
  },
  {
    id: "st-4",
    date: "2026-06-12",
    accountName: null,
    operationsCount: 0,
    unassignedCount: 0,
    uploaded: false,
  },
  {
    id: "st-5",
    date: "2026-06-11",
    accountName: "Расчётный (Тинькофф)",
    operationsCount: 3,
    unassignedCount: 1,
    uploaded: true,
  },
];

export function financeAccountBalance(accounts: FinanceAccount[]) {
  return accounts.reduce((sum, a) => sum + a.balance, 0);
}

export function financePeriodIncome(rows: FinanceCashFlowRow[]) {
  return rows
    .filter((r) => r.flowType === "INCOME" && !r.isTransfer)
    .reduce((s, r) => s + r.amount, 0);
}

export function financePeriodExpense(rows: FinanceCashFlowRow[]) {
  return rows
    .filter((r) => r.flowType === "EXPENSE" && !r.isTransfer)
    .reduce((s, r) => s + r.amount, 0);
}

export function financeUnassignedCount(rows: FinanceCashFlowRow[]) {
  return rows.filter((r) => !r.isAutoAssigned && !r.isTransfer).length;
}

/** Группы операций ДДС по дате (сверху — новые). */
export function groupCashFlowsByDate(rows: FinanceCashFlowRow[]) {
  const sorted = [...rows].sort(
    (a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id),
  );
  const groups: { date: string; rows: FinanceCashFlowRow[] }[] = [];

  for (const row of sorted) {
    const last = groups[groups.length - 1];
    if (last?.date === row.date) last.rows.push(row);
    else groups.push({ date: row.date, rows: [row] });
  }

  return groups;
}

/** Расходы по корневым категориям статей за период (для диаграммы). */
export function financeExpenseChart(rows: FinanceCashFlowRow[], articles: FinanceArticle[]): ExpenseChartSlice[] {
  const byCategory = new Map<string, number>();

  for (const row of rows) {
    if (row.flowType !== "EXPENSE" || row.isTransfer || !row.articleName) continue;
    const article = articles.find((a) => a.name === row.articleName);
    const root = article?.parentId
      ? articles.find((a) => a.id === article.parentId)
      : article;
    const category = root?.categoryName ?? "Без статьи";
    byCategory.set(category, (byCategory.get(category) ?? 0) + row.amount);
  }

  const unassigned = rows
    .filter((r) => r.flowType === "EXPENSE" && !r.isTransfer && !r.articleName)
    .reduce((s, r) => s + r.amount, 0);
  if (unassigned > 0) byCategory.set("Не разнесено", unassigned);

  const total = [...byCategory.values()].reduce((s, v) => s + v, 0) || 1;
  return [...byCategory.entries()]
    .map(([category, amount]) => ({
      category,
      amount,
      pct: Math.round((amount / total) * 100),
    }))
    .sort((a, b) => b.amount - a.amount);
}

export function formatAutoRuleCondition(rule: FinanceAutoRule): string {
  const type = rule.flowType === "INCOME" ? "поступление" : "списание";
  const cp = rule.counterpartyName ? `контрагент «${rule.counterpartyName}»` : "любой контрагент";
  const logic = rule.logicOperator === "OR" ? "или" : "и";
  const parts = [`Если ${type}`, cp];
  if (rule.descriptionKeywords?.trim()) {
    parts.push(`${logic} описание содержит «${rule.descriptionKeywords.trim()}»`);
  }
  return parts.join(" ");
}

export function formatAutoRuleAction(rule: FinanceAutoRule): string {
  const parts: string[] = [];
  if (rule.articleName) parts.push(`статья «${rule.articleName}»`);
  if (rule.dealName) parts.push(`сделка «${rule.dealName}»`);
  return parts.length > 0 ? parts.join(", ") : "—";
}
