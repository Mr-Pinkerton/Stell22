import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import { D } from "@/lib/cost";
import {
  batchExtraShare,
  batchTotalCost,
  dealDeliveryExtra,
  sumConfirmedExpense,
  type DealCashFlowLite,
} from "@/lib/deal-cost";
import type { FinanceAutoRule } from "@/mocks/finance-fixtures";
import type { FlowType } from "@/types/domain";

export type FinanceDb = Prisma.TransactionClient | typeof prisma;

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

export async function applyAutoRulesInternal(cf: {
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

type CashFlowWithAccountConfirmed = {
  flowType: FlowType;
  amount: Prisma.Decimal;
  account: { confirmed: boolean };
};
function toCfLite(flows: CashFlowWithAccountConfirmed[]): DealCashFlowLite[] {
  return flows.map((c) => ({
    flowType: c.flowType,
    amount: num(c.amount),
    accountConfirmed: c.account.confirmed,
  }));
}
const CF_WITH_CONFIRMED = { include: { account: { select: { confirmed: true } } } } as const;

const TABLE_IDENT = {
  Account: Prisma.raw(`"Account"`),
  Deal: Prisma.raw(`"Deal"`),
  Batch: Prisma.raw(`"Batch"`),
  ProductionOperation: Prisma.raw(`"ProductionOperation"`),
  RailLot: Prisma.raw(`"RailLot"`),
} as const;

export function sortedUniqueIds(ids: Iterable<string | null | undefined>): string[] {
  return [...new Set([...ids].filter((id): id is string => Boolean(id)))].sort();
}

export function sameSortedIds(
  a: Iterable<string | null | undefined>,
  b: Iterable<string | null | undefined>,
): boolean {
  const left = sortedUniqueIds(a);
  const right = sortedUniqueIds(b);
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

/** Thrown to roll back a writer TX and retry from scratch (lock set changed). */
export class LockSetChangedError extends Error {
  constructor() {
    super("LOCK_SET_CHANGED");
    this.name = "LockSetChangedError";
  }
}

const WRITER_LOCK_RETRY_ATTEMPTS = 4;

export async function retryOnLockSetChange<T>(
  run: () => Promise<T>,
  attempts = WRITER_LOCK_RETRY_ATTEMPTS,
): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await run();
    } catch (err) {
      last = err;
      if (!(err instanceof LockSetChangedError)) throw err;
    }
  }
  throw last;
}

async function lockTableIds(
  db: FinanceDb,
  table: keyof typeof TABLE_IDENT,
  ids: Iterable<string | null | undefined>,
): Promise<void> {
  const unique = sortedUniqueIds(ids);
  if (unique.length === 0) return;
  await db.$queryRaw(
    Prisma.sql`SELECT id FROM ${TABLE_IDENT[table]} WHERE id IN (${Prisma.join(unique)}) ORDER BY id FOR UPDATE`,
  );
}

export async function lockBatches(
  db: FinanceDb,
  ids: Iterable<string | null | undefined>,
): Promise<void> {
  await lockTableIds(db, "Batch", ids);
}

export async function lockProductionOperations(
  db: FinanceDb,
  ids: Iterable<string | null | undefined>,
): Promise<void> {
  await lockTableIds(db, "ProductionOperation", ids);
}

export async function lockRailLots(
  db: FinanceDb,
  ids: Iterable<string | null | undefined>,
): Promise<void> {
  await lockTableIds(db, "RailLot", ids);
}

export async function lockDealsThenBatches(
  db: FinanceDb,
  dealIds: Iterable<string | null | undefined>,
  extraBatchIds: Iterable<string | null | undefined> = [],
): Promise<void> {
  const deals = sortedUniqueIds(dealIds);
  await lockTableIds(db, "Deal", deals);
  const items =
    deals.length > 0
      ? await db.dealItem.findMany({
          where: { dealId: { in: deals } },
          select: { batchId: true },
        })
      : [];
  await lockBatches(db, [
    ...items.map((i) => i.batchId),
    ...extraBatchIds,
  ]);
}

export async function lockAccountsThenDealsThenBatches(
  db: FinanceDb,
  accountIds: Iterable<string | null | undefined>,
  dealIds: Iterable<string | null | undefined>,
  extraBatchIds: Iterable<string | null | undefined> = [],
): Promise<void> {
  await lockTableIds(db, "Account", accountIds);
  await lockDealsThenBatches(db, dealIds, extraBatchIds);
}

/**
 * «Стоимость общая» партии = закупочная + доставка/доп. расходы из её сделок.
 * Доставка сделки = расходные операции ДДС сверх суммы закупочных стоимостей
 * привязанных партий, распределённая по партиям пропорционально закупке.
 * Учитываются только операции по подтверждённым счетам (A13, карантин импорта).
 * Замороженные партии не трогаем (cost-integrity).
 */
export async function syncBatchTotalCostInternal(
  batchId: string,
  db: FinanceDb = prisma,
): Promise<string | null> {
  await lockBatches(db, [batchId]);
  const batch = await db.batch.findUnique({ where: { id: batchId } });
  if (!batch || batch.frozenAt) return null;

  const items = await db.dealItem.findMany({
    where: { batchId },
    include: {
      deal: { include: { items: { include: { batch: true } }, cashFlows: CF_WITH_CONFIRMED } },
    },
  });

  let extra = D(0);
  for (const { deal } of items) {
    const expense = sumConfirmedExpense(toCfLite(deal.cashFlows));
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
  const written = await db.batch.updateMany({
    where: { id: batchId, frozenAt: null },
    data: { totalCost: newTotal.toFixed(2) },
  });
  if (written.count === 0) return null;
  return batchId;
}

/** Пересчёт суммы сделки и «Стоимости общей» её партий. */
export async function syncDealInternal(
  dealId: string,
  db: FinanceDb = prisma,
): Promise<string[]> {
  await lockDealsThenBatches(db, [dealId]);
  const deal = await db.deal.findUnique({
    where: { id: dealId },
    include: { items: { include: { batch: true } }, cashFlows: CF_WITH_CONFIRMED },
  });
  if (!deal) return [];

  const expense = sumConfirmedExpense(toCfLite(deal.cashFlows)).toNumber();
  const purchaseTotal = deal.items.reduce((s, i) => s + num(i.batch?.purchaseCost ?? null), 0);
  const total = purchaseTotal + Math.max(0, expense - purchaseTotal);

  await db.deal.update({ where: { id: dealId }, data: { total: total.toFixed(2) } });

  const batchIds: string[] = [];
  for (const item of deal.items) {
    if (!item.batchId) continue;
    const written = await syncBatchTotalCostInternal(item.batchId, db);
    if (written) batchIds.push(written);
  }
  return batchIds;
}
