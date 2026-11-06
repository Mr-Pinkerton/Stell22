import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db";
import {
  applyAutoRulesInternal,
  lockAccountsThenDealsThenBatches,
  lockDealsThenBatches,
  syncDealInternal,
} from "@/server/internal/finance-operations";
import { writeChangeLog } from "@/server/change-log";
import { is1CStatement, parse1CStatement } from "@/lib/bank-statement-1c";
import {
  cashFlowSource,
  periodsOverlap,
  canonicalStatementDocument,
  statementContentIdentity,
  statementPeriodFields,
  validateVerifiedPeriod,
  coverAccounts,
} from "@/lib/bank-statement-integrity";
import { statementImportKey } from "@/lib/statement-import";
import {
  retryOnceOnImportUnique,
  throwFriendlyAccountNumberBindConflict,
} from "@/lib/prisma-unique-conflict";
import {
  computeAccountBalance,
  computeAccountBalances,
  shouldAdvanceAnchor,
  type BalanceFlow,
} from "@/lib/account-balance";
import type { FlowType } from "@/types/domain";
import type {
  FinanceAccount,
  FinanceCashFlowRow,
  FinanceCounterparty,
  FinanceStatementRow,
} from "@/mocks/finance-fixtures";
import type { AccountCoverageSummary } from "@/lib/bank-statement-integrity";

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

type StatementWithRefs = Prisma.StatementGetPayload<{
  include: { account: true; cashFlows: true };
}>;
type CashFlowWithRefs = Prisma.CashFlowGetPayload<{
  include: { account: true; counterparty: true; article: true; deal: true };
}>;

function serStatement(s: StatementWithRefs, overlapDates: string[] = []): FinanceStatementRow {
  const period = statementPeriodFields({
    source: s.source,
    periodStart: s.periodStart ? isoDay(s.periodStart) : null,
    periodEnd: s.periodEnd ? isoDay(s.periodEnd) : null,
    contentKey: s.contentKey,
    operationsCount: s.cashFlows.length,
  });
  return {
    id: s.id,
    date: isoDay(s.date),
    accountName: s.account?.name ?? null,
    operationsCount: s.cashFlows.length,
    unassignedCount: s.cashFlows.filter((cf) => !cf.articleId && !cf.isTransfer).length,
    uploaded: s.uploadedAt != null,
    mismatch: s.mismatch,
    ...period,
    overlapDates,
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
    source: cashFlowSource({
      statementId: cf.statementId,
      importKey: cf.importKey,
      linkedToImportedTransfer: false,
    }),
  };
}

export interface ImportStatementInternalResult {
  statement: FinanceStatementRow;
  newCashFlows: FinanceCashFlowRow[];
  accounts: FinanceAccount[];
  counterparties: FinanceCounterparty[];
  importedCount: number;
  unassignedCount: number;
  skippedCount: number;
  warning: string | null;
  affectedBatchIds: string[];
  statementCoverage: AccountCoverageSummary[];
  coverageAsOf: string;
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
export async function importStatementInternal(
  content: string,
  fileName: string,
  bindAccountId?: string | null,
): Promise<ImportStatementInternalResult> {
  if (!is1CStatement(content)) {
    throw new Error("Файл не в формате 1CClientBankExchange");
  }
  const parsed = parse1CStatement(content);
  if (!parsed.accountNumber) {
    throw new Error("В выписке не найден номер счёта (РасчСчет)");
  }

  const ourNumber = parsed.accountNumber;
  const period = validateVerifiedPeriod({
    dateStart: parsed.dateStart,
    dateEnd: parsed.dateEnd,
    documentDates: parsed.documents.map((doc) => doc.date),
    accountNumber: ourNumber,
    boundAccountNumber: null,
  });
  if (!period.ok) throw new Error(period.reason);
  for (const doc of parsed.documents) {
    const payer = doc.payerAccount === ourNumber;
    const payee = doc.payeeAccount === ourNumber;
    if (payer === payee) {
      throw new Error(
        `Счёт документа ${doc.docNumber ?? "без номера"} не совпадает с расчётным счётом выписки`,
      );
    }
  }
  const statementDate = period.periodEnd;
  const statementStart = period.periodStart;
  const contentKey = createHash("sha256")
    .update(
      statementContentIdentity({
        accountNumber: ourNumber,
        bik: parsed.bik,
        periodStart: statementStart,
        periodEnd: statementDate,
        openingBalance: parsed.openingBalance == null ? null : parsed.openingBalance.toFixed(2),
        closingBalance: parsed.closingBalance == null ? null : parsed.closingBalance.toFixed(2),
        documents: parsed.documents.map((doc) =>
          canonicalStatementDocument({
            docNumber: doc.docNumber,
            date: doc.date,
            amount: doc.amount.toFixed(2),
            payerName: doc.payerName,
            payerInn: doc.payerInn,
            payerAccount: doc.payerAccount,
            payeeName: doc.payeeName,
            payeeInn: doc.payeeInn,
            payeeAccount: doc.payeeAccount,
            purpose: doc.purpose,
          }),
        ),
      }),
    )
    .digest("hex");

  return retryOnceOnImportUnique(async () => {
  const newCounterparties: { id: string; name: string }[] = [];
  const affectedDeals = new Set<string>();
  let imported = 0;
  let unassigned = 0;
  let skipped = 0;
  let warning: string | null = null;
  let isNewAccount = false;
  let accountConfirmed = true;
  let identical = false;

  const result = await prisma.$transaction(async (tx) => {
    // Счёт: по номеру → по явной привязке → создаём новый.
    let account = await tx.account.findFirst({ where: { accountNumber: ourNumber } });
    if (!account && bindAccountId) {
      account = await tx.account.findUnique({ where: { id: bindAccountId } });
    }

    isNewAccount = !account;
    if (!account) {
      // Новый счёт: точка отсчёта = «начальный остаток» выписки на дату начала
      // периода. Так расчёт (якорь + операции периода) сойдётся с «конечным».
      // Карантин: авто-созданный счёт не подтверждён — его операции не попадут
      // в ДДС/KPI, пока пользователь не подтвердит его в Настройках → Счета.
      account = await tx.account.create({
        data: {
          name: `Счёт ••${last4(ourNumber)}`,
          accountNumber: ourNumber,
          bik: parsed.bik,
          openingBalance: parsed.openingBalance != null ? parsed.openingBalance.toFixed(2) : 0,
          balanceAsOf: dayToDate(statementStart),
          balance: parsed.closingBalance != null ? parsed.closingBalance.toFixed(2) : 0,
          confirmed: false,
        },
      });
    } else {
      if (account.accountNumber && account.accountNumber !== ourNumber) {
        throw new Error("Номер счёта выписки не совпадает со счётом привязки");
      }
      const patch: Prisma.AccountUncheckedUpdateInput = {};
      if (!account.accountNumber) patch.accountNumber = ourNumber;
      if (parsed.bik && !account.bik) patch.bik = parsed.bik;
      if (Object.keys(patch).length > 0) {
        try {
          account = await tx.account.update({ where: { id: account.id }, data: patch });
        } catch (err) {
          throwFriendlyAccountNumberBindConflict(err);
          throw err;
        }
      }
    }

    await lockAccountsThenDealsThenBatches(tx, [account.id], []);

    const lockedAccount = await tx.account.findUnique({ where: { id: account.id } });
    if (!lockedAccount) throw new Error("Счёт не найден");
    account = lockedAccount;
    accountConfirmed = account.confirmed;
    if (account.accountNumber !== ourNumber) {
      throw new Error("Номер счёта выписки не совпадает со счётом привязки");
    }

    const duplicate = await tx.statement.findFirst({
      where: { accountId: account.id, contentKey },
      select: { id: true },
    });
    if (duplicate) {
      identical = true;
      skipped = parsed.documents.length;
      return { statementId: duplicate.id, syncedBatchIds: [] as string[] };
    }

    const verified = await tx.statement.findMany({
      where: {
        accountId: account.id,
        source: "BANK_1C",
        periodStart: { not: null },
        periodEnd: { not: null },
      },
      select: { id: true, periodStart: true, periodEnd: true },
    });
    for (const other of verified) {
      if (!other.periodStart || !other.periodEnd) continue;
      const start = isoDay(other.periodStart);
      const end = isoDay(other.periodEnd);
      if (
        periodsOverlap(
          { periodStart: statementStart, periodEnd: statementDate },
          { periodStart: start, periodEnd: end },
        )
      ) {
        throw new Error(
          `Периоды выписок пересекаются: ${other.id} ${start}–${end} и новая ${statementStart}–${statementDate}`,
        );
      }
    }

    // Точка отсчёта ДО импорта — по ней сверяем расчётный остаток с выпиской.
    const priorOpening = num(account.openingBalance);
    const priorAsOf = account.balanceAsOf ? isoDay(account.balanceAsOf) : null;

    const statement = await tx.statement.create({
      data: {
        date: dayToDate(statementDate),
        accountId: account.id,
        fileUrl: fileName || null,
        uploadedAt: new Date(),
        openingBalance: parsed.openingBalance != null ? parsed.openingBalance.toFixed(2) : null,
        closingBalance: parsed.closingBalance != null ? parsed.closingBalance.toFixed(2) : null,
        periodStart: dayToDate(statementStart),
        periodEnd: dayToDate(statementDate),
        source: "BANK_1C",
        contentKey,
      },
    });

    // Номера всех наших счетов — чтобы распознать перевод между своими
    // счетами (контрагент по операции — тоже наш счёт).
    const ourAccounts = await tx.account.findMany({
      where: { accountNumber: { not: null } },
      select: { accountNumber: true },
    });
    const ourNumbers = new Set(ourAccounts.map((a) => a.accountNumber as string));
    ourNumbers.add(ourNumber);

    for (const doc of parsed.documents) {
      const key = statementImportKey(doc);
      const exists = await tx.cashFlow.findFirst({
        where: { accountId: account.id, importKey: key },
        select: { id: true },
      });
      if (exists) {
        skipped += 1;
        continue;
      }

      const payerOurs = doc.payerAccount === ourNumber;
      const flowType = payerOurs ? "EXPENSE" : "INCOME";
      // Вторая сторона операции — тоже наш счёт → перевод между своими счетами
      // (не доход/расход, контрагент не нужен, статья не назначается).
      const otherAccount = payerOurs ? doc.payeeAccount : doc.payerAccount;
      const isTransfer = otherAccount != null && ourNumbers.has(otherAccount);
      const cpName = isTransfer ? null : payerOurs ? doc.payeeName : doc.payerName;
      const cpInn = isTransfer ? null : payerOurs ? doc.payeeInn : doc.payerInn;
      const counterpartyId = await resolveCounterparty(tx, cpName, cpInn, newCounterparties);
      const description = doc.purpose ?? "";

      const auto = isTransfer
        ? null
        : await applyAutoRulesInternal({ flowType, counterpartyId, description });
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
          date: dayToDate(doc.date),
          isAutoAssigned: isTransfer || Boolean(articleId),
          isTransfer,
          importKey: key,
        },
      });

      imported += 1;
      if (!isTransfer && !articleId) unassigned += 1;
      if (dealId) affectedDeals.add(dealId);
    }

    // Банк — источник истины: остаток приравниваем к «конечному остатку»
    // выписки и переносим точку отсчёта на конец периода. Расчётный остаток
    // (прошлый якорь + операции периода) сверяем с фактом; при расхождении
    // ставим бейдж «≠» на счёт и выписку, но оставляем сумму из выписки.
    //
    // Защита от отката: выписка за прошлый период (конец раньше текущей точки
    // отсчёта) якорь НЕ двигает — иначе повторная загрузка старого архива
    // вернула бы остаток в прошлое. Операции при этом импортируются как обычно
    // (дедупликация отсеет повторы).
    const advanceAnchor = shouldAdvanceAnchor(priorAsOf, isoDay(dayToDate(statementDate, 1)));
    if (parsed.closingBalance != null && !advanceAnchor) {
      warning =
        `Выписка за прошлый период (по ${statementDate}) — остаток счёта не изменён, ` +
        `текущая точка отсчёта (${priorAsOf}) новее.`;
    }

    let mismatch = false;
    if (parsed.closingBalance != null && advanceAnchor) {
      const accountFlows = await tx.cashFlow.findMany({
        where: { accountId: account.id },
        select: { accountId: true, date: true, flowType: true, amount: true },
      });
      const flowsUpToEnd: BalanceFlow[] = accountFlows
        .map((f) => ({
          accountId: f.accountId,
          date: isoDay(f.date),
          flowType: f.flowType,
          amount: num(f.amount),
        }))
        .filter((f) => f.date <= statementDate);

      const expected = computeAccountBalance(
        { openingBalance: priorOpening, balanceAsOf: priorAsOf },
        flowsUpToEnd,
      );
      mismatch = Math.abs(expected - parsed.closingBalance) > 0.01;

      await tx.account.update({
        where: { id: account.id },
        data: {
          balance: parsed.closingBalance.toFixed(2),
          openingBalance: parsed.closingBalance.toFixed(2),
          balanceAsOf: dayToDate(statementDate, 1),
          balanceMismatch: mismatch,
        },
      });
      await tx.statement.update({ where: { id: statement.id }, data: { mismatch } });

      if (mismatch) {
        warning =
          `Расчётный остаток (${expected.toFixed(2)}) не совпал с конечным остатком ` +
          `выписки (${parsed.closingBalance.toFixed(2)}). Оставлен остаток из выписки.`;
      }
    }

    await lockDealsThenBatches(tx, [...affectedDeals]);
    const syncedBatchIds: string[] = [];
    for (const dealId of affectedDeals) {
      syncedBatchIds.push(...(await syncDealInternal(dealId, tx)));
    }

    return { statementId: statement.id, syncedBatchIds };
  });

  const statementId = result.statementId;
  const affectedBatchIds = [...new Set(result.syncedBatchIds)];

  if (isNewAccount) {
    const quarantineNote =
      "Счёт создан автоматически и не подтверждён — его операции скрыты в ДДС до " +
      "подтверждения в Настройках → Счета.";
    warning = warning ? `${warning} ${quarantineNote}` : quarantineNote;
  }

  if (!identical) {
    await writeChangeLog({
      entity: "Statement",
      entityId: statementId,
      newValues: { file: fileName, account: ourNumber, operations: imported, skipped },
    });
  }

  const [statement, accounts, allFlows, counterparties, periodRows] = await Promise.all([
    prisma.statement.findUniqueOrThrow({
      where: { id: statementId },
      include: { account: true, cashFlows: true },
    }),
    prisma.account.findMany({ orderBy: { name: "asc" } }),
    prisma.cashFlow.findMany({
      select: { accountId: true, date: true, flowType: true, amount: true },
    }),
    prisma.counterparty.findMany({ orderBy: { name: "asc" } }),
    prisma.statement.findMany({
      select: { id: true, accountId: true, source: true, periodStart: true, periodEnd: true },
    }),
  ]);
  const coverageAsOf = isoDay(new Date());
  const statementCoverage = coverAccounts({
    asOf: coverageAsOf,
    accounts: accounts.map((account) => ({ id: account.id, name: account.name })),
    intervals: periodRows.flatMap((row) => {
      if (row.source !== "BANK_1C" || !row.periodStart || !row.periodEnd || !row.accountId) return [];
      return [{
        statementId: row.id,
        accountId: row.accountId,
        periodStart: isoDay(row.periodStart),
        periodEnd: isoDay(row.periodEnd),
      }];
    }),
  });

  // Операции счёта в карантине не отдаём в ДДС клиента (даже как «новые»
  // после импорта) — подтверждение в Настройках подтянет их сразу.
  const newCashFlows = accountConfirmed && !identical
    ? await prisma.cashFlow.findMany({
        where: { statementId },
        include: { account: true, counterparty: true, article: true, deal: true },
        orderBy: { date: "desc" },
      })
    : [];

  return {
    statement: serStatement(statement),
    newCashFlows: newCashFlows.map(serCashFlow),
    accounts: serAccountsWithBalances(accounts, allFlows),
    counterparties: counterparties.map((c) => ({ id: c.id, name: c.name, inn: c.inn })),
    importedCount: imported,
    unassignedCount: unassigned,
    skippedCount: skipped,
    warning,
    affectedBatchIds: [...new Set(affectedBatchIds)],
    statementCoverage,
    coverageAsOf,
  };
  });
}
