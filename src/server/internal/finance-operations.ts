import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { prisma } from "@/server/db";
import { D } from "@/lib/cost";
import {
  batchExtraShare,
  batchTotalCost,
  dealDeliveryExtra,
  sumConfirmedExpense,
  type DealCashFlowLite,
} from "@/lib/deal-cost";
import { enqueueRecalcBatchCosts } from "@/server/cost-queue";
import type { FinanceAutoRule } from "@/mocks/finance-fixtures";
import type { FlowType } from "@/types/domain";

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

/**
 * «Стоимость общая» партии = закупочная + доставка/доп. расходы из её сделок.
 * Доставка сделки = расходные операции ДДС сверх суммы закупочных стоимостей
 * привязанных партий, распределённая по партиям пропорционально закупке.
 * Учитываются только операции по подтверждённым счетам (A13, карантин импорта).
 * Замороженные партии не трогаем (cost-integrity).
 */
export async function syncBatchTotalCostInternal(batchId: string): Promise<void> {
  const batch = await prisma.batch.findUnique({ where: { id: batchId } });
  if (!batch || batch.frozenAt) return;

  const items = await prisma.dealItem.findMany({
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
  await prisma.batch.update({ where: { id: batchId }, data: { totalCost: newTotal.toFixed(2) } });
  await enqueueRecalcBatchCosts(batchId);
}

/** Пересчёт суммы сделки и «Стоимости общей» её партий. */
export async function syncDealInternal(dealId: string): Promise<void> {
  const deal = await prisma.deal.findUnique({
    where: { id: dealId },
    include: { items: { include: { batch: true } }, cashFlows: CF_WITH_CONFIRMED },
  });
  if (!deal) return;

  const expense = sumConfirmedExpense(toCfLite(deal.cashFlows)).toNumber();
  const purchaseTotal = deal.items.reduce((s, i) => s + num(i.batch?.purchaseCost ?? null), 0);
  const total = purchaseTotal + Math.max(0, expense - purchaseTotal);

  await prisma.deal.update({ where: { id: dealId }, data: { total: total.toFixed(2) } });

  for (const item of deal.items) {
    if (item.batchId) await syncBatchTotalCostInternal(item.batchId);
  }
  revalidatePath("/purchases");
  revalidatePath("/reports");
}
