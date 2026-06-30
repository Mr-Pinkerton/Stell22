"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { writeChangeLog } from "@/server/change-log";
import { D } from "@/lib/cost";
import { batchExtraShare, batchTotalCost, dealDeliveryExtra } from "@/lib/deal-cost";
import { recalcBatchCosts } from "@/server/cost";
import { is1CStatement, parse1CStatement } from "@/lib/bank-statement-1c";
import type {
  FinanceAccount,
  FinanceArticle,
  FinanceAutoRule,
  FinanceCashFlowRow,
  FinanceCounterparty,
  FinanceDeal,
  FinanceStatementRow,
} from "@/mocks/finance-fixtures";
import type { ArticleFormValues } from "@/components/finance/article-form-dialog";
import type { AutoRuleFormValues } from "@/components/finance/auto-rule-form-dialog";
import type { CashflowFormValues } from "@/components/finance/cashflow-form-dialog";
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

// ============================ ЧТЕНИЕ =======================================

export interface FinanceData {
  accounts: FinanceAccount[];
  articles: FinanceArticle[];
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
    unassignedCount: s.cashFlows.filter((cf) => !cf.articleId).length,
    uploaded: s.uploadedAt != null,
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
    dealName: r.dealId ? dealNameById.get(r.dealId) ?? null : null,
  };
}

function serCashFlow(cf: CashFlowWithRefs): FinanceCashFlowRow {
  return {
    id: cf.id,
    date: cf.date.toISOString().slice(0, 10),
    amount: num(cf.amount),
    flowType: cf.flowType,
    accountName: cf.account.name,
    counterpartyName: cf.counterparty?.name ?? null,
    description: cf.description ?? "",
    articleName: cf.article?.name ?? null,
    dealName: cf.deal?.name ?? null,
    dealId: cf.dealId,
    isAutoAssigned: cf.isAutoAssigned,
  };
}

export async function getFinanceData(): Promise<FinanceData> {
  const [accounts, articles, counterparties, deals, autoRules, cashFlows, statements, batches] =
    await Promise.all([
      prisma.account.findMany({ orderBy: { name: "asc" } }),
      prisma.article.findMany({ include: { category: true }, orderBy: { name: "asc" } }),
      prisma.counterparty.findMany({ orderBy: { name: "asc" } }),
      prisma.deal.findMany({ include: { items: { include: { batch: true } } }, orderBy: { name: "asc" } }),
      prisma.autoRule.findMany({ include: { counterparty: true, article: true } }),
      prisma.cashFlow.findMany({
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

  // Сумма расходных операций по каждой сделке (для доставки/доп. расходов).
  const expenseByDeal = new Map<string, number>();
  for (const cf of cashFlows) {
    if (cf.dealId && cf.flowType === "EXPENSE") {
      expenseByDeal.set(cf.dealId, (expenseByDeal.get(cf.dealId) ?? 0) + num(cf.amount));
    }
  }

  return {
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, balance: num(a.balance) })),
    articles: articles.map(serArticle),
    counterparties: counterparties.map((c) => ({ id: c.id, name: c.name })),
    deals: deals.map((d) => serDeal(d, expenseByDeal)),
    autoRules: autoRules.map((r) => serAutoRule(r, dealNameById)),
    cashFlows: cashFlows.map(serCashFlow),
    statements: statements.map(serStatement),
    batchOptions: batches.map((b) => ({ id: b.id, name: b.name, status: b.status })),
  };
}

// ============================ КОНТРАГЕНТЫ ==================================

export async function createCounterparty(name: string): Promise<FinanceCounterparty> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Укажите название контрагента");
  const created = await prisma.counterparty.create({ data: { name: trimmed } });
  await writeChangeLog({ entity: "Counterparty", entityId: created.id, newValues: { name: trimmed } });
  revalidatePath(PATH);
  return { id: created.id, name: created.name };
}

export async function updateCounterparty(id: string, name: string): Promise<FinanceCounterparty> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Укажите название контрагента");
  const updated = await prisma.counterparty.update({ where: { id }, data: { name: trimmed } });
  await writeChangeLog({ entity: "Counterparty", entityId: id, newValues: { name: trimmed } });
  revalidatePath(PATH);
  return { id: updated.id, name: updated.name };
}

export async function deleteCounterparty(id: string): Promise<void> {
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
      { entity: "Article", entityId: article.id, newValues: { name, category: values.categoryName } },
      tx,
    );
    return article;
  });

  revalidatePath(PATH);
  return serArticle(created);
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
    ? (await prisma.deal.findUnique({ where: { id: rule.dealId } }))?.name ?? null
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
  const data = await resolveRuleRefs(patch);
  await prisma.autoRule.update({ where: { id }, data });
  await writeChangeLog({ entity: "AutoRule", entityId: id, newValues: { ...patch } });
  revalidatePath(PATH);
  return loadAutoRule(id);
}

export async function deleteAutoRule(id: string): Promise<void> {
  await prisma.autoRule.delete({ where: { id } });
  await writeChangeLog({ entity: "AutoRule", entityId: id, oldValues: { deleted: true } });
  revalidatePath(PATH);
}

// ============================ ДДС ==========================================

/**
 * Подбор статьи/сделки по автоправилам. Условия: тип совпадает И
 * (контрагент) [И/ИЛИ] (описание содержит ключевые слова). Первое совпадение.
 */
async function applyAutoRules(cf: {
  flowType: FinanceAutoRule["flowType"];
  counterpartyId: string | null;
  description: string;
}): Promise<{ articleId: string | null; dealId: string | null } | null> {
  const rules = await prisma.autoRule.findMany({ where: { flowType: cf.flowType } });
  const desc = cf.description.toLowerCase();

  for (const rule of rules) {
    const conditions: boolean[] = [];
    if (rule.counterpartyId) conditions.push(rule.counterpartyId === cf.counterpartyId);
    const kw = rule.descriptionKeywords?.trim().toLowerCase();
    if (kw) conditions.push(desc.includes(kw));
    if (conditions.length === 0) continue;

    const matched =
      rule.logicOperator === "OR" ? conditions.some(Boolean) : conditions.every(Boolean);
    if (matched && rule.articleId) {
      return { articleId: rule.articleId, dealId: rule.dealId };
    }
  }
  return null;
}

async function loadCashFlow(id: string): Promise<FinanceCashFlowRow> {
  const cf = await prisma.cashFlow.findUniqueOrThrow({
    where: { id },
    include: { account: true, counterparty: true, article: true, deal: true },
  });
  return serCashFlow(cf);
}

export async function createCashFlow(values: CashflowFormValues): Promise<FinanceCashFlowRow> {
  if (!(values.amount > 0)) throw new Error("Сумма должна быть положительной");
  if (!values.accountName) throw new Error("Выберите счёт");

  const [account, counterparty, article] = await Promise.all([
    prisma.account.findFirst({ where: { name: values.accountName } }),
    values.counterpartyName
      ? prisma.counterparty.findFirst({ where: { name: values.counterpartyName } })
      : Promise.resolve(null),
    values.articleName ? prisma.article.findFirst({ where: { name: values.articleName } }) : Promise.resolve(null),
  ]);
  if (!account) throw new Error("Счёт не найден");

  let articleId = article?.id ?? null;
  let dealId = values.dealId;
  let isAutoAssigned = Boolean(articleId);

  // Если статья не выбрана вручную — пробуем автоправила.
  if (!articleId) {
    const auto = await applyAutoRules({
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
  if (dealId) await syncDeal(dealId);
  revalidatePath(PATH);
  return loadCashFlow(created.id);
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
  for (const dealId of affectedDeals) await syncDeal(dealId);

  revalidatePath(PATH);
  return loadCashFlow(id);
}

export async function deleteCashFlow(id: string): Promise<void> {
  const before = await prisma.cashFlow.findUnique({ where: { id } });
  await prisma.cashFlow.delete({ where: { id } });
  await writeChangeLog({ entity: "CashFlow", entityId: id, oldValues: { deleted: true } });
  if (before?.dealId) await syncDeal(before.dealId);
  revalidatePath(PATH);
}

// ============================ СДЕЛКИ → СЕБЕСТОИМОСТЬ =======================

/**
 * «Стоимость общая» партии = закупочная + доставка/доп. расходы из её сделок.
 * Доставка сделки = расходные операции ДДС сверх суммы закупочных стоимостей
 * привязанных партий, распределённая по партиям пропорционально закупке.
 * Закрытые (замороженные) партии не трогаем (cost-integrity).
 */
async function syncBatchTotalCost(batchId: string): Promise<void> {
  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch || batch.closedAt) return;

  const items = await prisma.dealItem.findMany({
    where: { batchId },
    include: { deal: { include: { items: { include: { batch: true } }, cashFlows: true } } },
  });

  let extra = D(0);
  for (const { deal } of items) {
    const expense = deal.cashFlows
      .filter((c) => c.flowType === "EXPENSE")
      .reduce((s, c) => s.plus(D(num(c.amount))), D(0));
    const purchaseTotal = deal.items.reduce(
      (s, i) => s.plus(D(num(i.batch?.purchaseCost ?? null))),
      D(0),
    );
    const dealExtra = dealDeliveryExtra(expense, purchaseTotal);
    extra = extra.plus(
      batchExtraShare(dealExtra, num(batch.purchaseCost), purchaseTotal, deal.items.length),
    );
  }

  const newTotal = batchTotalCost(num(batch.purchaseCost), extra);
  await prisma.batch.update({ where: { id: batchId }, data: { totalCost: newTotal.toFixed(2) } });
  await recalcBatchCosts({ batchId });
}

/** Пересчёт суммы сделки и «Стоимости общей» её партий. */
async function syncDeal(dealId: string): Promise<void> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { items: { include: { batch: true } }, cashFlows: true },
  });
  if (!deal) return;

  const expense = deal.cashFlows
    .filter((c) => c.flowType === "EXPENSE")
    .reduce((s, c) => s + num(c.amount), 0);
  const purchaseTotal = deal.items.reduce((s, i) => s + num(i.batch?.purchaseCost ?? null), 0);
  const total = purchaseTotal + Math.max(0, expense - purchaseTotal);

  await prisma.deal.update({ where: { id: dealId }, data: { total: total.toFixed(2) } });

  for (const item of deal.items) {
    if (item.batchId) await syncBatchTotalCost(item.batchId);
  }
  revalidatePath("/purchases");
  revalidatePath("/reports");
}

async function loadDeal(id: string): Promise<FinanceDeal> {
  const d = await prisma.deal.findUniqueOrThrow({
    where: { id },
    include: { items: { include: { batch: true } }, cashFlows: true },
  });
  const expense = d.cashFlows
    .filter((c) => c.flowType === "EXPENSE")
    .reduce((s, c) => s + num(c.amount), 0);
  return serDeal(d, new Map([[id, expense]]));
}

export async function createDeal(values: DealFormValues): Promise<FinanceDeal> {
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
  await syncDeal(deal.id);
  revalidatePath(PATH);
  return loadDeal(deal.id);
}

export async function updateDeal(id: string, values: DealFormValues): Promise<FinanceDeal> {
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
  await writeChangeLog({ entity: "Deal", entityId: id, newValues: { name, batches: values.batchNames } });

  await syncDeal(id);
  // Партии, отвязанные от сделки, тоже пересчитываем.
  for (const item of oldItems) {
    if (item.batchId && !newBatchIds.has(item.batchId)) await syncBatchTotalCost(item.batchId);
  }
  revalidatePath(PATH);
  return loadDeal(id);
}

export async function setDealStatus(
  id: string,
  status: "OPEN" | "ARCHIVED",
): Promise<FinanceDeal> {
  await prisma.deal.update({ where: { id }, data: { status } });
  await writeChangeLog({ entity: "Deal", entityId: id, newValues: { status } });
  revalidatePath(PATH);
  return loadDeal(id);
}

export async function deleteDeal(id: string): Promise<void> {
  const items = await prisma.dealItem.findMany({ where: { dealId: id } });
  const batchIds = items.map((i) => i.batchId).filter((b): b is string => Boolean(b));

  await prisma.$transaction(async (tx) => {
    await tx.cashFlow.updateMany({ where: { dealId: id }, data: { dealId: null } });
    await tx.dealItem.deleteMany({ where: { dealId: id } });
    await tx.deal.delete({ where: { id } });
  });
  await writeChangeLog({ entity: "Deal", entityId: id, oldValues: { deleted: true } });

  for (const batchId of batchIds) await syncBatchTotalCost(batchId);
  revalidatePath(PATH);
}

// ============================ ВЫПИСКИ ======================================

export async function createStatement(values: StatementUploadValues): Promise<FinanceStatementRow> {
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
}

const last4 = (account: string) => account.slice(-4);

/** Найти или создать контрагента по ИНН (приоритет) либо по названию. */
async function resolveCounterparty(
  tx: Prisma.TransactionClient,
  name: string | null,
  inn: string | null,
  created: { id: string; name: string }[],
): Promise<string | null> {
  const cleanName = name?.trim() || null;
  const cleanInn = inn?.trim() || null;
  if (!cleanName && !cleanInn) return null;

  if (cleanInn) {
    const byInn = await tx.counterparty.findFirst({ where: { inn: cleanInn } });
    if (byInn) return byInn.id;
  }
  if (cleanName) {
    const byName = await tx.counterparty.findFirst({ where: { name: cleanName } });
    if (byName) return byName.id;
  }

  const cp = await tx.counterparty.create({
    data: { name: cleanName ?? `ИНН ${cleanInn}`, inn: cleanInn },
  });
  created.push({ id: cp.id, name: cp.name });
  return cp.id;
}

/**
 * Импорт банковской выписки формата 1CClientBankExchange. На вход — уже
 * декодированный текст. Создаёт/находит счёт по номеру, заводит выписку,
 * разносит каждую операцию (направление по нашему РасчСчёту), применяет
 * автоправила и обновляет остаток счёта по «КонечныйОстаток».
 */
export async function importStatement(
  content: string,
  fileName: string,
): Promise<ImportStatementResult> {
  if (!is1CStatement(content)) {
    throw new Error("Файл не в формате 1CClientBankExchange");
  }
  const parsed = parse1CStatement(content);
  if (!parsed.accountNumber) {
    throw new Error("В выписке не найден номер счёта (РасчСчет)");
  }

  const ourNumber = parsed.accountNumber;
  const statementDate = parsed.dateEnd ?? parsed.dateStart ?? new Date().toISOString().slice(0, 10);

  const newCounterparties: { id: string; name: string }[] = [];
  const affectedDeals = new Set<string>();
  let imported = 0;
  let unassigned = 0;

  const statementId = await prisma.$transaction(async (tx) => {
    // Счёт: по номеру или создаём новый.
    let account = await tx.account.findFirst({ where: { accountNumber: ourNumber } });
    if (!account) {
      account = await tx.account.create({
        data: {
          name: `Счёт ••${last4(ourNumber)}`,
          accountNumber: ourNumber,
          bik: parsed.bik,
          balance: parsed.closingBalance != null ? parsed.closingBalance.toFixed(2) : 0,
        },
      });
    } else if (parsed.bik && !account.bik) {
      await tx.account.update({ where: { id: account.id }, data: { bik: parsed.bik } });
    }

    const statement = await tx.statement.create({
      data: {
        date: new Date(statementDate),
        accountId: account.id,
        fileUrl: fileName || null,
        uploadedAt: new Date(),
      },
    });

    for (const doc of parsed.documents) {
      const isExpense = doc.payerAccount === ourNumber;
      const flowType = isExpense ? "EXPENSE" : "INCOME";
      const cpName = isExpense ? doc.payeeName : doc.payerName;
      const cpInn = isExpense ? doc.payeeInn : doc.payerInn;
      const counterpartyId = await resolveCounterparty(tx, cpName, cpInn, newCounterparties);
      const description = doc.purpose ?? "";

      const auto = await applyAutoRules({ flowType, counterpartyId, description });
      const articleId = auto?.articleId ?? null;
      const dealId = auto?.dealId ?? null;

      await tx.cashFlow.create({
        data: {
          amount: doc.amount.toFixed(2),
          flowType,
          accountId: account.id,
          counterpartyId,
          description,
          articleId,
          dealId,
          statementId: statement.id,
          date: new Date(doc.date || statementDate),
          isAutoAssigned: Boolean(articleId),
        },
      });

      imported += 1;
      if (!articleId) unassigned += 1;
      if (dealId) affectedDeals.add(dealId);
    }

    // Остаток счёта берём из выписки (конечный остаток — источник истины).
    if (parsed.closingBalance != null) {
      await tx.account.update({
        where: { id: account.id },
        data: { balance: parsed.closingBalance.toFixed(2) },
      });
    }

    return statement.id;
  });

  await writeChangeLog({
    entity: "Statement",
    entityId: statementId,
    newValues: { file: fileName, account: ourNumber, operations: imported },
  });

  // Сделки, затронутые автоправилами, пересчитываем (доставка → себестоимость).
  for (const dealId of affectedDeals) await syncDeal(dealId);

  const [statement, accounts, counterparties] = await Promise.all([
    prisma.statement.findUniqueOrThrow({
      where: { id: statementId },
      include: { account: true, cashFlows: true },
    }),
    prisma.account.findMany({ orderBy: { name: "asc" } }),
    prisma.counterparty.findMany({ orderBy: { name: "asc" } }),
  ]);

  const newCashFlows = await prisma.cashFlow.findMany({
    where: { statementId },
    include: { account: true, counterparty: true, article: true, deal: true },
    orderBy: { date: "desc" },
  });

  revalidatePath(PATH);
  return {
    statement: serStatement(statement),
    newCashFlows: newCashFlows.map(serCashFlow),
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, balance: num(a.balance) })),
    counterparties: counterparties.map((c) => ({ id: c.id, name: c.name })),
    importedCount: imported,
    unassignedCount: unassigned,
  };
}
