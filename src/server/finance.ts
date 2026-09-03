"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { requireAdmin } from "@/server/session";
import { importStatementInternal } from "@/server/internal/statement-import";
import {
  applyAutoRulesInternal,
  syncBatchTotalCostInternal,
  syncDealInternal,
} from "@/server/internal/finance-operations";
import { writeChangeLog } from "@/server/change-log";
import { sumConfirmedExpense, type DealCashFlowLite } from "@/lib/deal-cost";
import { computeAccountBalances, type BalanceFlow } from "@/lib/account-balance";
import type { FlowType } from "@/types/domain";
import type {
  FinanceAccount,
  FinanceArticle,
  FinanceAutoRule,
  FinanceCashFlowRow,
  FinanceCategory,
  FinanceCounterparty,
  FinanceDeal,
  FinanceStatementRow,
} from "@/mocks/finance-fixtures";
import type { ArticleFormValues } from "@/components/finance/article-form-dialog";
import type { AutoRuleFormValues } from "@/components/finance/auto-rule-form-dialog";
import type { CashflowFormValues } from "@/components/finance/cashflow-form-dialog";
import type { TransferFormValues } from "@/components/finance/transfer-form-dialog";
import type { DealFormValues } from "@/components/finance/deal-form-dialog";
import type { StatementUploadValues } from "@/components/finance/statement-upload-dialog";

const PATH = "/finance";

const OVERHEAD_CATEGORY = "Производственные (накладные)";

export interface BatchOption {
  id: string;
  name: string;
  status: string;
}

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

/** yyyy-mm-dd из Date (UTC). */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Полночь UTC для строки yyyy-mm-dd (+ смещение в днях). */
function dayToDate(iso: string, plusDays = 0): Date {
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (plusDays) d.setUTCDate(d.getUTCDate() + plusDays);
  return d;
}

type AccountRow = Prisma.AccountGetPayload<object>;
type BalanceFlowRow = {
  accountId: string;
  date: Date;
  flowType: FlowType;
  amount: Prisma.Decimal | number;
};

function serAccount(a: AccountRow, balance: number): FinanceAccount {
  return {
    id: a.id,
    name: a.name,
    balance,
    accountNumber: a.accountNumber,
    bik: a.bik,
    openingBalance: num(a.openingBalance),
    openingDate: a.balanceAsOf ? isoDay(a.balanceAsOf) : null,
    balanceMismatch: a.balanceMismatch,
    confirmed: a.confirmed,
    isPrimary: a.isPrimary,
  };
}

/** Сериализация счетов с вычислением текущего остатка (якорь + операции). */
function serAccountsWithBalances(
  accounts: AccountRow[],
  flows: BalanceFlowRow[],
): FinanceAccount[] {
  const balanceFlows: BalanceFlow[] = flows.map((f) => ({
    accountId: f.accountId,
    date: isoDay(f.date),
    flowType: f.flowType,
    amount: num(f.amount),
  }));
  const balances = computeAccountBalances(
    accounts.map((a) => ({
      id: a.id,
      openingBalance: num(a.openingBalance),
      balanceAsOf: a.balanceAsOf ? isoDay(a.balanceAsOf) : null,
    })),
    balanceFlows,
  );
  return accounts.map((a) => serAccount(a, balances.get(a.id) ?? num(a.openingBalance)));
}

// ============================ ЧТЕНИЕ =======================================

export interface FinanceData {
  accounts: FinanceAccount[];
  articles: FinanceArticle[];
  categories: FinanceCategory[];
  counterparties: FinanceCounterparty[];
  deals: FinanceDeal[];
  autoRules: FinanceAutoRule[];
  cashFlows: FinanceCashFlowRow[];
  statements: FinanceStatementRow[];
  batchOptions: BatchOption[];
}

type ArticleWithCategory = Prisma.ArticleGetPayload<{ include: { category: true } }>;
type DealWithItems = Prisma.DealGetPayload<{ include: { items: { include: { batch: true } } } }>;
type AutoRuleWithRefs = Prisma.AutoRuleGetPayload<{
  include: { counterparty: true; article: true };
}>;
type CashFlowWithRefs = Prisma.CashFlowGetPayload<{
  include: { account: true; counterparty: true; article: true; deal: true };
}>;
type StatementWithRefs = Prisma.StatementGetPayload<{
  include: { account: true; cashFlows: true };
}>;

function serArticle(a: ArticleWithCategory): FinanceArticle {
  return {
    id: a.id,
    name: a.name,
    flowType: a.flowType,
    categoryName: a.category.name,
    isOverhead: a.category.isOverhead,
    parentId: a.parentId,
    description: a.description ?? undefined,
  };
}

/** Расходные операции сделки сверх закупочных стоимостей партий = доставка/доп. */
function dealExtraAndTotal(d: DealWithItems, expenseByDeal: Map<string, number>) {
  const purchaseTotal = d.items.reduce((s, i) => s + num(i.batch?.purchaseCost ?? null), 0);
  const expense = expenseByDeal.get(d.id) ?? 0;
  const deliveryExtra = Math.max(0, expense - purchaseTotal);
  return { purchaseTotal, deliveryExtra, total: purchaseTotal + deliveryExtra };
}

function serDeal(d: DealWithItems, expenseByDeal: Map<string, number>): FinanceDeal {
  const { purchaseTotal, deliveryExtra, total } = dealExtraAndTotal(d, expenseByDeal);
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    total,
    purchaseTotal,
    batchNames: d.items.map((i) => i.batch?.name).filter((n): n is string => Boolean(n)),
    deliveryExtra,
  };
}

function serStatement(s: StatementWithRefs): FinanceStatementRow {
  return {
    id: s.id,
    date: s.date.toISOString().slice(0, 10),
    accountName: s.account?.name ?? null,
    operationsCount: s.cashFlows.length,
    unassignedCount: s.cashFlows.filter((cf) => !cf.articleId && !cf.isTransfer).length,
    uploaded: s.uploadedAt != null,
    mismatch: s.mismatch,
  };
}

function serAutoRule(r: AutoRuleWithRefs, dealNameById: Map<string, string>): FinanceAutoRule {
  return {
    id: r.id,
    flowType: r.flowType,
    counterpartyName: r.counterparty?.name ?? null,
    logicOperator: r.logicOperator === "OR" ? "OR" : "AND",
    descriptionKeywords: r.descriptionKeywords,
    articleName: r.article?.name ?? null,
    dealName: r.dealId ? (dealNameById.get(r.dealId) ?? null) : null,
  };
}

function serCashFlow(cf: CashFlowWithRefs): FinanceCashFlowRow {
  return {
    id: cf.id,
    date: cf.date.toISOString().slice(0, 10),
    amount: num(cf.amount),
    flowType: cf.flowType,
    accountId: cf.accountId,
    accountName: cf.account.name,
    counterpartyName: cf.counterparty?.name ?? null,
    description: cf.description ?? "",
    articleName: cf.article?.name ?? null,
    dealName: cf.deal?.name ?? null,
    dealId: cf.dealId,
    isAutoAssigned: cf.isAutoAssigned,
    isTransfer: cf.isTransfer,
  };
}

export async function getFinanceData(): Promise<FinanceData> {
  await requireAdmin();
  const [
    accounts,
    allFlows,
    articles,
    categories,
    counterparties,
    deals,
    autoRules,
    cashFlows,
    statements,
    batches,
  ] = await Promise.all([
    prisma.account.findMany({ orderBy: { name: "asc" } }),
    // Остаток счёта считаем по ВСЕМ его операциям (даже в карантине) — на
    // Финансах видно реальный банковский остаток независимо от подтверждения.
    prisma.cashFlow.findMany({
      select: { accountId: true, date: true, flowType: true, amount: true },
    }),
    prisma.article.findMany({ include: { category: true }, orderBy: { name: "asc" } }),
    prisma.articleCategory.findMany({
      include: { _count: { select: { articles: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.counterparty.findMany({ orderBy: { name: "asc" } }),
    prisma.deal.findMany({
      include: { items: { include: { batch: true } } },
      orderBy: { name: "asc" },
    }),
    prisma.autoRule.findMany({ include: { counterparty: true, article: true } }),
    // Счета в карантине (авто-созданные импортом, не подтверждены) не
    // попадают в ДДС/KPI/себестоимость сделок — только в Настройки на
    // проверку. Просмотр операций конкретной выписки (getStatementDetail)
    // и её счётчики (serStatement, отдельный запрос ниже) не фильтруются —
    // это инструмент проверки ДО подтверждения.
    prisma.cashFlow.findMany({
      where: { account: { confirmed: true } },
      include: { account: true, counterparty: true, article: true, deal: true },
      orderBy: { date: "desc" },
    }),
    prisma.statement.findMany({
      include: { account: true, cashFlows: true },
      orderBy: { date: "desc" },
    }),
    prisma.batch.findMany({ orderBy: { purchaseDate: "desc" } }),
  ]);

  const dealNameById = new Map(deals.map((d) => [d.id, d.name]));

  // Сумма расходных операций по каждой сделке (для доставки/доп. расходов);
  // считаем только по подтверждённым счетам, как и остальную ДДС.
  const expenseByDeal = new Map<string, number>();
  for (const cf of cashFlows) {
    if (cf.dealId && cf.flowType === "EXPENSE") {
      expenseByDeal.set(cf.dealId, (expenseByDeal.get(cf.dealId) ?? 0) + num(cf.amount));
    }
  }

  return {
    accounts: serAccountsWithBalances(accounts, allFlows),
    articles: articles.map(serArticle),
    categories: categories.map(serCategory),
    counterparties: counterparties.map((c) => ({ id: c.id, name: c.name, inn: c.inn })),
    deals: deals.map((d) => serDeal(d, expenseByDeal)),
    autoRules: autoRules.map((r) => serAutoRule(r, dealNameById)),
    cashFlows: cashFlows.map(serCashFlow),
    statements: statements.map(serStatement),
    batchOptions: batches.map((b) => ({ id: b.id, name: b.name, status: b.status })),
  };
}

// ============================ СЧЕТА ========================================

export interface AccountFormValues {
  name: string;
  openingBalance: number;
  /** yyyy-mm-dd — дата фиксации начального остатка. */
  openingDate: string;
}

const SETTINGS_PATH = "/settings";

async function loadAccount(id: string): Promise<FinanceAccount> {
  const [account, flows] = await Promise.all([
    prisma.account.findUniqueOrThrow({ where: { id } }),
    prisma.cashFlow.findMany({
      where: { accountId: id },
      select: { accountId: true, date: true, flowType: true, amount: true },
    }),
  ]);
  return serAccountsWithBalances([account], flows)[0];
}

/** Реальные счета из БД с текущим остатком (для Настроек и форм). */
async function getAccounts(): Promise<FinanceAccount[]> {
  const [accounts, flows] = await Promise.all([
    prisma.account.findMany({ orderBy: { name: "asc" } }),
    prisma.cashFlow.findMany({
      select: { accountId: true, date: true, flowType: true, amount: true },
    }),
  ]);
  return serAccountsWithBalances(accounts, flows);
}

export async function createAccount(values: AccountFormValues): Promise<FinanceAccount> {
  await requireAdmin();
  const name = values.name.trim();
  if (!name) throw new Error("Укажите название счёта");

  const created = await prisma.account.create({
    data: {
      name,
      openingBalance: values.openingBalance.toFixed(2),
      balanceAsOf: values.openingDate ? dayToDate(values.openingDate) : null,
      balance: values.openingBalance.toFixed(2),
    },
  });
  await writeChangeLog({
    entity: "Account",
    entityId: created.id,
    newValues: { name, openingBalance: values.openingBalance, openingDate: values.openingDate },
  });
  revalidatePath(PATH);
  revalidatePath(SETTINGS_PATH);
  return serAccount(created, num(created.openingBalance));
}

export async function updateAccount(
  id: string,
  values: AccountFormValues,
): Promise<FinanceAccount> {
  await requireAdmin();
  const name = values.name.trim();
  if (!name) throw new Error("Укажите название счёта");

  await prisma.account.update({
    where: { id },
    data: {
      name,
      openingBalance: values.openingBalance.toFixed(2),
      balanceAsOf: values.openingDate ? dayToDate(values.openingDate) : null,
      // Ручная смена точки отсчёта снимает бейдж расхождения по прошлой выписке.
      balanceMismatch: false,
    },
  });
  await writeChangeLog({
    entity: "Account",
    entityId: id,
    newValues: { name, openingBalance: values.openingBalance, openingDate: values.openingDate },
  });
  revalidatePath(PATH);
  revalidatePath(SETTINGS_PATH);
  return loadAccount(id);
}

/**
 * Подтверждение счёта, авто-созданного импортом выписки. До подтверждения
 * его операции не участвуют в ДДС/KPI/себестоимости сделок — только сам
 * счёт и его остаток видны в Настройках для проверки. Можно и снять
 * подтверждение обратно, если счёт завели по ошибке (не удаляя данные).
 */
export async function setAccountConfirmed(id: string, confirmed: boolean): Promise<FinanceAccount> {
  await requireAdmin();
  await prisma.account.update({ where: { id }, data: { confirmed } });
  await writeChangeLog({ entity: "Account", entityId: id, newValues: { confirmed } });
  revalidatePath(PATH);
  revalidatePath(SETTINGS_PATH);
  return loadAccount(id);
}

/**
 * Пометить счёт «основным» (или снять пометку). Основных может быть несколько.
 * Влияет только на отображение в плитках остатка (дашборд/финансы) — расчёты
 * не затрагивает.
 */
export async function setAccountPrimary(id: string, isPrimary: boolean): Promise<FinanceAccount> {
  await requireAdmin();
  await prisma.account.update({ where: { id }, data: { isPrimary } });
  await writeChangeLog({ entity: "Account", entityId: id, newValues: { isPrimary } });
  revalidatePath(PATH);
  revalidatePath(SETTINGS_PATH);
  return loadAccount(id);
}

export async function deleteAccount(id: string): Promise<void> {
  await requireAdmin();
  const opsCount = await prisma.cashFlow.count({ where: { accountId: id } });
  if (opsCount > 0) {
    throw new Error("Нельзя удалить счёт с операциями ДДС. Сначала удалите/перенесите операции.");
  }

  await prisma.$transaction(async (tx) => {
    await tx.statement.deleteMany({ where: { accountId: id } });
    await tx.account.delete({ where: { id } });
  });
  await writeChangeLog({ entity: "Account", entityId: id, oldValues: { deleted: true } });
  revalidatePath(PATH);
  revalidatePath(SETTINGS_PATH);
}

// ============================ КОНТРАГЕНТЫ ==================================

export async function createCounterparty(
  name: string,
  inn?: string | null,
): Promise<FinanceCounterparty> {
  await requireAdmin();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Укажите название контрагента");
  const innClean = inn?.trim() || null;
  const created = await prisma.counterparty.create({ data: { name: trimmed, inn: innClean } });
  await writeChangeLog({
    entity: "Counterparty",
    entityId: created.id,
    newValues: { name: trimmed, inn: innClean },
  });
  revalidatePath(PATH);
  return { id: created.id, name: created.name, inn: created.inn };
}

export async function updateCounterparty(
  id: string,
  name: string,
  inn?: string | null,
): Promise<FinanceCounterparty> {
  await requireAdmin();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Укажите название контрагента");
  const innClean = inn?.trim() || null;
  const updated = await prisma.counterparty.update({
    where: { id },
    data: { name: trimmed, inn: innClean },
  });
  await writeChangeLog({
    entity: "Counterparty",
    entityId: id,
    newValues: { name: trimmed, inn: innClean },
  });
  revalidatePath(PATH);
  return { id: updated.id, name: updated.name, inn: updated.inn };
}

export async function deleteCounterparty(id: string): Promise<void> {
  await requireAdmin();
  const [flows, rules] = await Promise.all([
    prisma.cashFlow.count({ where: { counterpartyId: id } }),
    prisma.autoRule.count({ where: { counterpartyId: id } }),
  ]);
  if (flows > 0 || rules > 0) {
    throw new Error("Нельзя удалить: контрагент используется в ДДС или автоправилах");
  }
  await prisma.counterparty.delete({ where: { id } });
  await writeChangeLog({ entity: "Counterparty", entityId: id, oldValues: { deleted: true } });
  revalidatePath(PATH);
}

// ============================ КАТЕГОРИИ СТАТЕЙ =============================

type CategoryWithCount = Prisma.ArticleCategoryGetPayload<{
  include: { _count: { select: { articles: true } } };
}>;

function serCategory(c: CategoryWithCount): FinanceCategory {
  return { id: c.id, name: c.name, isOverhead: c.isOverhead, articleCount: c._count.articles };
}

async function loadCategory(id: string): Promise<FinanceCategory> {
  const category = await prisma.articleCategory.findUniqueOrThrow({
    where: { id },
    include: { _count: { select: { articles: true } } },
  });
  return serCategory(category);
}

export async function createArticleCategory(
  name: string,
  isOverhead: boolean,
): Promise<FinanceCategory> {
  await requireAdmin();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Укажите название категории");
  const existing = await prisma.articleCategory.findFirst({ where: { name: trimmed } });
  if (existing) throw new Error("Категория с таким названием уже есть");

  const created = await prisma.articleCategory.create({
    data: { name: trimmed, isOverhead },
  });
  await writeChangeLog({
    entity: "ArticleCategory",
    entityId: created.id,
    newValues: { name: trimmed, isOverhead },
  });
  revalidatePath(PATH);
  return loadCategory(created.id);
}

export async function updateArticleCategory(
  id: string,
  name: string,
  isOverhead: boolean,
): Promise<FinanceCategory> {
  await requireAdmin();
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Укажите название категории");
  const clash = await prisma.articleCategory.findFirst({
    where: { name: trimmed, id: { not: id } },
  });
  if (clash) throw new Error("Категория с таким названием уже есть");

  await prisma.articleCategory.update({
    where: { id },
    data: { name: trimmed, isOverhead },
  });
  await writeChangeLog({
    entity: "ArticleCategory",
    entityId: id,
    newValues: { name: trimmed, isOverhead },
  });
  revalidatePath(PATH);
  return loadCategory(id);
}

export async function deleteArticleCategory(id: string): Promise<void> {
  await requireAdmin();
  const count = await prisma.article.count({ where: { categoryId: id } });
  if (count > 0) {
    throw new Error("Нельзя удалить категорию со статьями. Сначала перенесите статьи.");
  }
  await prisma.articleCategory.delete({ where: { id } });
  await writeChangeLog({ entity: "ArticleCategory", entityId: id, oldValues: { deleted: true } });
  revalidatePath(PATH);
}

// ============================ СТАТЬИ =======================================

/** Найти категорию по имени или создать (накладные — по фикс. имени). */
async function resolveCategoryId(tx: Prisma.TransactionClient, name: string): Promise<string> {
  const existing = await tx.articleCategory.findFirst({ where: { name } });
  if (existing) return existing.id;
  const created = await tx.articleCategory.create({
    data: { name, isOverhead: name === OVERHEAD_CATEGORY },
  });
  return created.id;
}

export async function createArticle(values: ArticleFormValues): Promise<FinanceArticle> {
  await requireAdmin();
  const name = values.name.trim();
  if (!name) throw new Error("Укажите название статьи");
  if (!values.categoryName.trim()) throw new Error("Укажите категорию");

  const created = await prisma.$transaction(async (tx) => {
    const categoryId = await resolveCategoryId(tx, values.categoryName.trim());
    const article = await tx.article.create({
      data: {
        name,
        flowType: values.flowType,
        categoryId,
        parentId: values.parentId,
        description: values.description.trim() || null,
      },
      include: { category: true },
    });
    await writeChangeLog(
      {
        entity: "Article",
        entityId: article.id,
        newValues: { name, category: values.categoryName },
      },
      tx,
    );
    return article;
  });

  revalidatePath(PATH);
  return serArticle(created);
}

export async function updateArticle(
  id: string,
  values: ArticleFormValues,
): Promise<FinanceArticle> {
  await requireAdmin();
  const name = values.name.trim();
  if (!name) throw new Error("Укажите название статьи");
  if (!values.categoryName.trim()) throw new Error("Укажите категорию");
  if (values.parentId === id) throw new Error("Статья не может быть своей субстатьёй");

  const updated = await prisma.$transaction(async (tx) => {
    const categoryId = await resolveCategoryId(tx, values.categoryName.trim());
    const article = await tx.article.update({
      where: { id },
      data: {
        name,
        flowType: values.flowType,
        categoryId,
        parentId: values.parentId,
        description: values.description.trim() || null,
      },
      include: { category: true },
    });
    await writeChangeLog(
      { entity: "Article", entityId: id, newValues: { name, category: values.categoryName } },
      tx,
    );
    return article;
  });

  revalidatePath(PATH);
  return serArticle(updated);
}

export async function deleteArticle(id: string): Promise<void> {
  await requireAdmin();
  const [children, cashFlows, autoRules] = await Promise.all([
    prisma.article.count({ where: { parentId: id } }),
    prisma.cashFlow.count({ where: { articleId: id } }),
    prisma.autoRule.count({ where: { articleId: id } }),
  ]);
  if (children > 0) {
    throw new Error("Нельзя удалить статью с субстатьями. Сначала удалите/перенесите субстатьи.");
  }
  if (cashFlows > 0) {
    throw new Error(`Статья используется в операциях ДДС (${cashFlows}). Сначала перенесите их.`);
  }
  if (autoRules > 0) {
    throw new Error("Статья используется в автоправилах. Сначала измените правила.");
  }

  await prisma.article.delete({ where: { id } });
  await writeChangeLog({ entity: "Article", entityId: id, oldValues: { deleted: true } });
  revalidatePath(PATH);
}

// ============================ АВТОПРАВИЛА ==================================

interface AutoRulePatch {
  flowType?: FinanceAutoRule["flowType"];
  counterpartyName?: string | null;
  articleName?: string | null;
  dealName?: string | null;
  logicOperator?: FinanceAutoRule["logicOperator"];
  descriptionKeywords?: string | null;
}

interface AutoRuleResolved {
  flowType?: FinanceAutoRule["flowType"];
  logicOperator?: string;
  descriptionKeywords?: string | null;
  counterpartyId?: string | null;
  articleId?: string | null;
  dealId?: string | null;
}

async function resolveRuleRefs(patch: AutoRulePatch): Promise<AutoRuleResolved> {
  const data: AutoRuleResolved = {};
  if (patch.flowType !== undefined) data.flowType = patch.flowType;
  if (patch.logicOperator !== undefined) data.logicOperator = patch.logicOperator;
  if (patch.descriptionKeywords !== undefined) {
    data.descriptionKeywords = patch.descriptionKeywords?.trim() || null;
  }
  if (patch.counterpartyName !== undefined) {
    const cp = patch.counterpartyName
      ? await prisma.counterparty.findFirst({ where: { name: patch.counterpartyName } })
      : null;
    data.counterpartyId = cp?.id ?? null;
  }
  if (patch.articleName !== undefined) {
    const art = patch.articleName
      ? await prisma.article.findFirst({ where: { name: patch.articleName } })
      : null;
    data.articleId = art?.id ?? null;
  }
  if (patch.dealName !== undefined) {
    const deal = patch.dealName
      ? await prisma.deal.findFirst({ where: { name: patch.dealName } })
      : null;
    data.dealId = deal?.id ?? null;
  }
  return data;
}

async function loadAutoRule(id: string): Promise<FinanceAutoRule> {
  const rule = await prisma.autoRule.findUniqueOrThrow({
    where: { id },
    include: { counterparty: true, article: true },
  });
  const dealName = rule.dealId
    ? ((await prisma.deal.findUnique({ where: { id: rule.dealId } }))?.name ?? null)
    : null;
  return {
    id: rule.id,
    flowType: rule.flowType,
    counterpartyName: rule.counterparty?.name ?? null,
    logicOperator: rule.logicOperator === "OR" ? "OR" : "AND",
    descriptionKeywords: rule.descriptionKeywords,
    articleName: rule.article?.name ?? null,
    dealName,
  };
}

export async function createAutoRule(values: AutoRuleFormValues): Promise<FinanceAutoRule> {
  await requireAdmin();
  const data = await resolveRuleRefs({
    flowType: values.flowType,
    counterpartyName: values.counterpartyName,
    articleName: values.articleName,
    dealName: values.dealName,
    logicOperator: values.logicOperator,
    descriptionKeywords: values.descriptionKeywords,
  });
  const created = await prisma.autoRule.create({
    data: { flowType: values.flowType, ...data },
  });
  await writeChangeLog({ entity: "AutoRule", entityId: created.id, newValues: { ...values } });
  revalidatePath(PATH);
  return loadAutoRule(created.id);
}

export async function updateAutoRule(id: string, patch: AutoRulePatch): Promise<FinanceAutoRule> {
  await requireAdmin();
  const data = await resolveRuleRefs(patch);
  await prisma.autoRule.update({ where: { id }, data });
  await writeChangeLog({ entity: "AutoRule", entityId: id, newValues: { ...patch } });
  revalidatePath(PATH);
  return loadAutoRule(id);
}

export async function deleteAutoRule(id: string): Promise<void> {
  await requireAdmin();
  await prisma.autoRule.delete({ where: { id } });
  await writeChangeLog({ entity: "AutoRule", entityId: id, oldValues: { deleted: true } });
  revalidatePath(PATH);
}

// ============================ ДДС ==========================================

/**
 * Подбор статьи/сделки по автоправилам. Условия: тип совпадает И
 * (контрагент) [И/ИЛИ] (описание содержит ключевые слова). Первое совпадение.
 */
export interface ReapplyAutoRulesResult {
  ok: boolean;
  assigned: number;
  updated: FinanceCashFlowRow[];
}

/**
 * Массовое авторазнесение: прогоняет автоправила по уже импортированным
 * НЕразнесённым операциям (articleId IS NULL) и проставляет статью/сделку.
 * Запускается кнопкой после правки правил или импорта. Ручные операции с
 * выбранной статьёй не трогаются.
 */
export async function reapplyAutoRules(): Promise<ReapplyAutoRulesResult> {
  await requireAdmin();
  const pending = await prisma.cashFlow.findMany({ where: { articleId: null } });
  const updatedIds: string[] = [];
  const dealsToSync = new Set<string>();

  for (const cf of pending) {
    const auto = await applyAutoRulesInternal({
      flowType: cf.flowType,
      counterpartyId: cf.counterpartyId,
      description: cf.description ?? "",
    });
    if (!auto?.articleId) continue;

    const dealId = cf.dealId ?? auto.dealId;
    await prisma.cashFlow.update({
      where: { id: cf.id },
      data: { articleId: auto.articleId, dealId, isAutoAssigned: true },
    });
    if (auto.dealId && !cf.dealId) dealsToSync.add(auto.dealId);
    updatedIds.push(cf.id);
  }

  for (const d of dealsToSync) await syncDealInternal(d);
  if (updatedIds.length > 0) {
    await writeChangeLog({
      entity: "CashFlow",
      entityId: "reapply",
      newValues: { reappliedCount: updatedIds.length, ids: updatedIds },
    });
    revalidatePath(PATH);
  }

  const updated = updatedIds.length
    ? await prisma.cashFlow.findMany({
        where: { id: { in: updatedIds } },
        include: { account: true, counterparty: true, article: true, deal: true },
      })
    : [];
  return { ok: true, assigned: updatedIds.length, updated: updated.map(serCashFlow) };
}

async function loadCashFlow(id: string): Promise<FinanceCashFlowRow> {
  const cf = await prisma.cashFlow.findUniqueOrThrow({
    where: { id },
    include: { account: true, counterparty: true, article: true, deal: true },
  });
  return serCashFlow(cf);
}

export async function createCashFlow(values: CashflowFormValues): Promise<FinanceCashFlowRow> {
  await requireAdmin();
  if (!(values.amount > 0)) throw new Error("Сумма должна быть положительной");
  if (!values.accountName) throw new Error("Выберите счёт");

  const [account, counterparty, article] = await Promise.all([
    prisma.account.findFirst({ where: { name: values.accountName } }),
    values.counterpartyName
      ? prisma.counterparty.findFirst({ where: { name: values.counterpartyName } })
      : Promise.resolve(null),
    values.articleName
      ? prisma.article.findFirst({ where: { name: values.articleName } })
      : Promise.resolve(null),
  ]);
  if (!account) throw new Error("Счёт не найден");

  let articleId = article?.id ?? null;
  let dealId = values.dealId;
  let isAutoAssigned = Boolean(articleId);

  // Если статья не выбрана вручную — пробуем автоправила.
  if (!articleId) {
    const auto = await applyAutoRulesInternal({
      flowType: values.flowType,
      counterpartyId: counterparty?.id ?? null,
      description: values.description,
    });
    if (auto) {
      articleId = auto.articleId;
      if (!dealId) dealId = auto.dealId;
      isAutoAssigned = true;
    }
  }

  const created = await prisma.cashFlow.create({
    data: {
      amount: values.amount,
      flowType: values.flowType,
      accountId: account.id,
      counterpartyId: counterparty?.id ?? null,
      description: values.description.trim(),
      articleId,
      dealId,
      date: new Date(values.date),
      isAutoAssigned,
    },
  });
  await writeChangeLog({
    entity: "CashFlow",
    entityId: created.id,
    newValues: { amount: values.amount, flowType: values.flowType, article: values.articleName },
  });
  if (dealId) await syncDealInternal(dealId);
  revalidatePath(PATH);
  return loadCashFlow(created.id);
}

/**
 * Перевод между своими счетами: создаёт две связанные операции —
 * списание с одного счёта и зачисление на другой. Обе помечаются
 * `isTransfer` и НЕ учитываются в доходах/расходах и диаграмме расходов
 * (иначе один перевод задвоил бы обороты). Возвращает обе ноги (списание,
 * затем зачисление).
 */
export async function createTransfer(values: TransferFormValues): Promise<FinanceCashFlowRow[]> {
  await requireAdmin();
  if (!(values.amount > 0)) throw new Error("Сумма должна быть положительной");
  if (!values.fromAccountId || !values.toAccountId) throw new Error("Выберите оба счёта");
  if (values.fromAccountId === values.toAccountId) {
    throw new Error("Счёт списания и зачисления должны отличаться");
  }

  const [from, to] = await Promise.all([
    prisma.account.findUnique({ where: { id: values.fromAccountId } }),
    prisma.account.findUnique({ where: { id: values.toAccountId } }),
  ]);
  if (!from || !to) throw new Error("Счёт не найден");

  const note = values.description.trim();
  const date = new Date(values.date);
  const transferId = randomUUID();
  const base = {
    amount: values.amount,
    date,
    isTransfer: true,
    isAutoAssigned: true,
    transferId,
  };

  const [expenseLeg, incomeLeg] = await prisma.$transaction([
    prisma.cashFlow.create({
      data: {
        ...base,
        flowType: "EXPENSE",
        accountId: from.id,
        description: note || `Перевод на «${to.name}»`,
      },
    }),
    prisma.cashFlow.create({
      data: {
        ...base,
        flowType: "INCOME",
        accountId: to.id,
        description: note || `Перевод с «${from.name}»`,
      },
    }),
  ]);

  await writeChangeLog({
    entity: "CashFlow",
    entityId: expenseLeg.id,
    newValues: { transfer: `${from.name} → ${to.name}`, amount: values.amount },
  });

  revalidatePath(PATH);
  const [expenseRow, incomeRow] = await Promise.all([
    loadCashFlow(expenseLeg.id),
    loadCashFlow(incomeLeg.id),
  ]);
  return [expenseRow, incomeRow];
}

export interface CashFlowAssignPatch {
  counterpartyId?: string | null;
  articleId?: string | null;
  dealId?: string | null;
}

/** Ручное разнесение операции ДДС (инлайн-селекты). */
export async function assignCashFlow(
  id: string,
  patch: CashFlowAssignPatch,
): Promise<FinanceCashFlowRow> {
  await requireAdmin();
  const before = await prisma.cashFlow.findUnique({ where: { id } });

  const data: Prisma.CashFlowUncheckedUpdateInput = {};
  if (patch.counterpartyId !== undefined) data.counterpartyId = patch.counterpartyId;
  if (patch.dealId !== undefined) data.dealId = patch.dealId;
  if (patch.articleId !== undefined) {
    data.articleId = patch.articleId;
    // Разнесение вручную снимает подсветку «не разнесено».
    data.isAutoAssigned = Boolean(patch.articleId);
  }
  await prisma.cashFlow.update({ where: { id }, data });
  await writeChangeLog({ entity: "CashFlow", entityId: id, newValues: { ...patch } });

  // Привязка/отвязка к сделке меняет её доставку → пересчёт партий.
  const affectedDeals = new Set<string>();
  if (before?.dealId) affectedDeals.add(before.dealId);
  if (patch.dealId) affectedDeals.add(patch.dealId);
  for (const dealId of affectedDeals) await syncDealInternal(dealId);

  revalidatePath(PATH);
  return loadCashFlow(id);
}

/**
 * Удаление операции ДДС. Если операция — нога перевода между счетами,
 * удаляем обе ноги (списание и зачисление), чтобы перевод не «повис»
 * половиной. Возвращает id всех удалённых строк (для обновления UI).
 */
export async function deleteCashFlow(id: string): Promise<string[]> {
  await requireAdmin();
  const before = await prisma.cashFlow.findUnique({ where: { id } });

  let removedIds = [id];
  if (before?.isTransfer && before.transferId) {
    const legs = await prisma.cashFlow.findMany({
      where: { transferId: before.transferId },
      select: { id: true },
    });
    removedIds = legs.map((l) => l.id);
    await prisma.cashFlow.deleteMany({ where: { transferId: before.transferId } });
  } else {
    await prisma.cashFlow.delete({ where: { id } });
  }

  await writeChangeLog({ entity: "CashFlow", entityId: id, oldValues: { deleted: true } });
  if (before?.dealId) await syncDealInternal(before.dealId);
  revalidatePath(PATH);
  return removedIds;
}

/**
 * Превратить обычную операцию в перевод между своими счетами. Пример: оплата с
 * р/с, а деньги получены наличными — операция должна стать переводом на счёт
 * «Наличные», а не расходом. Исходная нога помечается `isTransfer` (снимаются
 * статья/контрагент/сделка), на втором счёте создаётся встречная нога с общим
 * `transferId`. Обе перестают считаться доходом/расходом. Возвращает обе ноги.
 */
export async function convertCashFlowToTransfer(
  id: string,
  otherAccountId: string,
): Promise<FinanceCashFlowRow[]> {
  await requireAdmin();
  const source = await prisma.cashFlow.findUnique({ where: { id } });
  if (!source) throw new Error("Операция не найдена");
  if (source.isTransfer) throw new Error("Операция уже является переводом");
  if (!otherAccountId) throw new Error("Выберите второй счёт");
  if (otherAccountId === source.accountId) {
    throw new Error("Второй счёт должен отличаться от счёта операции");
  }
  const other = await prisma.account.findUnique({ where: { id: otherAccountId } });
  if (!other) throw new Error("Счёт не найден");

  const transferId = randomUUID();
  // Списание с р/с → деньги пришли на второй счёт (зачисление), и наоборот.
  const oppositeType = source.flowType === "INCOME" ? "EXPENSE" : "INCOME";
  const note = source.description?.trim() || "";

  const [, otherLeg] = await prisma.$transaction([
    prisma.cashFlow.update({
      where: { id },
      data: {
        isTransfer: true,
        transferId,
        isAutoAssigned: true,
        counterpartyId: null,
        articleId: null,
        dealId: null,
      },
    }),
    prisma.cashFlow.create({
      data: {
        amount: source.amount,
        date: source.date,
        flowType: oppositeType,
        accountId: other.id,
        description: note || `Перевод ${source.flowType === "INCOME" ? "на" : "с"} «${other.name}»`,
        isTransfer: true,
        isAutoAssigned: true,
        transferId,
      },
    }),
  ]);

  // Операция могла быть привязана к сделке (её доставка) — пересчитать.
  if (source.dealId) await syncDealInternal(source.dealId);

  await writeChangeLog({
    entity: "CashFlow",
    entityId: id,
    newValues: { convertedToTransfer: other.name, amount: num(source.amount) },
  });
  revalidatePath(PATH);
  const [sourceRow, otherRow] = await Promise.all([loadCashFlow(id), loadCashFlow(otherLeg.id)]);
  return [sourceRow, otherRow];
}

/**
 * Расцепить перевод: вернуть операцию в обычный доход/расход. Сохраняем ногу из
 * банковской выписки (реальная операция), удаляем встречную (ручную/наличную).
 * Если ни одна нога не из выписки (перевод заведён формой) — сохраняем ту, по
 * которой вызвали. Сохранённая нога помечается «не разнесена». Возвращает id
 * удалённых строк и обновлённую операцию.
 */
export async function unlinkTransfer(
  id: string,
): Promise<{ removedIds: string[]; updated: FinanceCashFlowRow }> {
  await requireAdmin();
  const leg = await prisma.cashFlow.findUnique({ where: { id } });
  if (!leg || !leg.isTransfer || !leg.transferId) throw new Error("Это не перевод");

  const legs = await prisma.cashFlow.findMany({ where: { transferId: leg.transferId } });
  const keep = legs.find((l) => l.statementId) ?? leg;
  const removed = legs.filter((l) => l.id !== keep.id);

  await prisma.$transaction([
    prisma.cashFlow.deleteMany({ where: { id: { in: removed.map((l) => l.id) } } }),
    prisma.cashFlow.update({
      where: { id: keep.id },
      data: { isTransfer: false, transferId: null, isAutoAssigned: false },
    }),
  ]);

  await writeChangeLog({
    entity: "CashFlow",
    entityId: keep.id,
    newValues: { unlinkedTransfer: true },
  });
  revalidatePath(PATH);
  return { removedIds: removed.map((l) => l.id), updated: await loadCashFlow(keep.id) };
}

// ============================ СДЕЛКИ → СЕБЕСТОИМОСТЬ =======================

// Операции сделки → lite-вид с флагом подтверждения счёта (для A13).
type CashFlowWithAccountConfirmed = {
  flowType: FlowType;
  amount: Prisma.Decimal;
  account: { confirmed: boolean };
};

function toCfLite(flows: CashFlowWithAccountConfirmed[]): DealCashFlowLite[] {
  return flows.map((cashFlow) => ({
    flowType: cashFlow.flowType,
    amount: num(cashFlow.amount),
    accountConfirmed: cashFlow.account.confirmed,
  }));
}

const CF_WITH_CONFIRMED = {
  include: { account: { select: { confirmed: true } } },
} as const;

async function loadDeal(id: string): Promise<FinanceDeal> {
  const d = await prisma.deal.findUniqueOrThrow({
    where: { id },
    include: { items: { include: { batch: true } }, cashFlows: CF_WITH_CONFIRMED },
  });
  const expense = sumConfirmedExpense(toCfLite(d.cashFlows)).toNumber();
  return serDeal(d, new Map([[id, expense]]));
}

export async function createDeal(values: DealFormValues): Promise<FinanceDeal> {
  await requireAdmin();
  const name = values.name.trim();
  if (!name) throw new Error("Укажите название сделки");
  if (values.batchNames.length === 0) throw new Error("Выберите хотя бы одну закупку");

  const found = await prisma.batch.findMany({ where: { name: { in: values.batchNames } } });
  const deal = await prisma.deal.create({
    data: {
      name,
      status: "OPEN",
      total: 0,
      items: { create: found.map((b) => ({ batchId: b.id })) },
    },
  });
  await writeChangeLog({
    entity: "Deal",
    entityId: deal.id,
    newValues: { name, batches: values.batchNames },
  });
  await syncDealInternal(deal.id);
  revalidatePath(PATH);
  return loadDeal(deal.id);
}

export async function updateDeal(id: string, values: DealFormValues): Promise<FinanceDeal> {
  await requireAdmin();
  const name = values.name.trim();
  if (!name) throw new Error("Укажите название сделки");
  if (values.batchNames.length === 0) throw new Error("Выберите хотя бы одну закупку");

  const found = await prisma.batch.findMany({ where: { name: { in: values.batchNames } } });
  const newBatchIds = new Set(found.map((b) => b.id));
  const oldItems = await prisma.dealItem.findMany({ where: { dealId: id } });

  await prisma.$transaction(async (tx) => {
    await tx.dealItem.deleteMany({ where: { dealId: id } });
    await tx.deal.update({
      where: { id },
      data: { name, items: { create: found.map((b) => ({ batchId: b.id })) } },
    });
  });
  await writeChangeLog({
    entity: "Deal",
    entityId: id,
    newValues: { name, batches: values.batchNames },
  });

  await syncDealInternal(id);
  // Партии, отвязанные от сделки, тоже пересчитываем.
  for (const item of oldItems) {
    if (item.batchId && !newBatchIds.has(item.batchId))
      await syncBatchTotalCostInternal(item.batchId);
  }
  revalidatePath(PATH);
  return loadDeal(id);
}

export async function setDealStatus(id: string, status: "OPEN" | "ARCHIVED"): Promise<FinanceDeal> {
  await requireAdmin();
  await prisma.deal.update({ where: { id }, data: { status } });
  await writeChangeLog({ entity: "Deal", entityId: id, newValues: { status } });
  revalidatePath(PATH);
  return loadDeal(id);
}

export async function deleteDeal(id: string): Promise<void> {
  await requireAdmin();
  const items = await prisma.dealItem.findMany({ where: { dealId: id } });
  const batchIds = items.map((i) => i.batchId).filter((b): b is string => Boolean(b));

  await prisma.$transaction(async (tx) => {
    await tx.cashFlow.updateMany({ where: { dealId: id }, data: { dealId: null } });
    await tx.dealItem.deleteMany({ where: { dealId: id } });
    await tx.deal.delete({ where: { id } });
  });
  await writeChangeLog({ entity: "Deal", entityId: id, oldValues: { deleted: true } });

  for (const batchId of batchIds) await syncBatchTotalCostInternal(batchId);
  revalidatePath(PATH);
}

// ============================ ВЫПИСКИ ======================================

export async function createStatement(values: StatementUploadValues): Promise<FinanceStatementRow> {
  await requireAdmin();
  const iso = values.date;
  if (!iso) throw new Error("Укажите дату выписки");
  const account = values.accountName
    ? await prisma.account.findFirst({ where: { name: values.accountName } })
    : null;

  const created = await prisma.statement.create({
    data: {
      date: new Date(iso),
      accountId: account?.id ?? null,
      fileUrl: values.fileName || null,
      uploadedAt: new Date(),
    },
    include: { account: true, cashFlows: true },
  });
  await writeChangeLog({
    entity: "Statement",
    entityId: created.id,
    newValues: { date: iso, account: values.accountName, file: values.fileName },
  });
  revalidatePath(PATH);
  return serStatement(created);
}

// ============================ ИМПОРТ ВЫПИСКИ 1С ============================

export interface ImportStatementResult {
  statement: FinanceStatementRow;
  newCashFlows: FinanceCashFlowRow[];
  accounts: FinanceAccount[];
  counterparties: FinanceCounterparty[];
  importedCount: number;
  unassignedCount: number;
  skippedCount: number;
  warning: string | null;
}

export async function importStatement(
  content: string,
  fileName: string,
  bindAccountId?: string | null,
): Promise<ImportStatementResult> {
  await requireAdmin();
  return importStatementInternal(content, fileName, bindAccountId);
}

/** Операции конкретной выписки (для просмотра карточки). */
export async function getStatementDetail(id: string): Promise<FinanceCashFlowRow[]> {
  await requireAdmin();
  const flows = await prisma.cashFlow.findMany({
    where: { statementId: id },
    include: { account: true, counterparty: true, article: true, deal: true },
    orderBy: { date: "asc" },
  });
  return flows.map(serCashFlow);
}

export interface DeleteStatementResult {
  /** id удалённых операций ДДС (для очистки UI). */
  removedIds: string[];
  /** Счета с пересчитанными остатками (якорь мог восстановиться). */
  accounts: FinanceAccount[];
}

/**
 * Откат выписки: удаляет её операции ДДС и саму выписку, пересчитывает
 * затронутые сделки. Если выписка держала якорь остатка счёта — якорь
 * восстанавливается из последней оставшейся выписки этого счёта.
 */
export async function deleteStatement(id: string): Promise<DeleteStatementResult> {
  await requireAdmin();
  const [stmt, flows] = await Promise.all([
    prisma.statement.findUnique({ where: { id } }),
    prisma.cashFlow.findMany({
      where: { statementId: id },
      select: { id: true, dealId: true },
    }),
  ]);
  const removedIds = flows.map((f) => f.id);
  const affectedDeals = new Set(flows.map((f) => f.dealId).filter((d): d is string => Boolean(d)));

  await prisma.$transaction(async (tx) => {
    await tx.cashFlow.deleteMany({ where: { statementId: id } });
    await tx.statement.delete({ where: { id } });

    // Восстановление якоря: если точка отсчёта счёта была установлена именно
    // этой выпиской (день после её конца), переносим её на последнюю из
    // оставшихся выписок с остатком. Если таких нет — якорь не трогаем
    // (его можно поправить вручную в Настройках → Счета).
    if (stmt?.accountId && stmt.closingBalance != null) {
      const account = await tx.account.findUnique({ where: { id: stmt.accountId } });
      const anchorHeldByStmt =
        account?.balanceAsOf != null &&
        account.balanceAsOf.getTime() === dayToDate(isoDay(stmt.date), 1).getTime();

      if (account && anchorHeldByStmt) {
        const prev = await tx.statement.findFirst({
          where: { accountId: account.id, closingBalance: { not: null } },
          orderBy: { date: "desc" },
        });
        if (prev?.closingBalance != null) {
          await tx.account.update({
            where: { id: account.id },
            data: {
              balance: prev.closingBalance,
              openingBalance: prev.closingBalance,
              balanceAsOf: dayToDate(isoDay(prev.date), 1),
              balanceMismatch: prev.mismatch,
            },
          });
        }
      }
    }
  });
  await writeChangeLog({ entity: "Statement", entityId: id, oldValues: { deleted: true } });

  for (const dealId of affectedDeals) await syncDealInternal(dealId);
  revalidatePath(PATH);
  revalidatePath(SETTINGS_PATH);
  return { removedIds, accounts: await getAccounts() };
}
