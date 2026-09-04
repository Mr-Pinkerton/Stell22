vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/server/session", () => ({ requireAdmin: async () => {} }));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import {
  createCashFlow,
  getFinanceData,
  setAccountConfirmed,
} from "@/server/finance";
import { importStatementInternal } from "@/server/internal/statement-import";
import { getPeriodOverhead } from "@/server/internal/cost";
import {
  financeAccountBalance,
  financePeriodExpense,
  financePeriodIncome,
} from "@/mocks/finance-fixtures";
import { isAccountConfirmed } from "@/lib/account-balance";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityFinance,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

function num(value: Prisma.Decimal | number): number {
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

const MARCH = {
  start: new Date("2026-03-01T00:00:00.000Z"),
  end: new Date("2026-03-31T23:59:59.999Z"),
};

describe.skipIf(!enabled)("DI-002 integrity", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityFinance(prismaA);
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
  });

  async function snapshotCompanyFinance(uId: string, dealId: string, batchId: string) {
    const data = await getFinanceData();
    const marchRows = data.cashFlows.filter(
      (r) => r.date >= "2026-03-01" && r.date <= "2026-03-31",
    );
    const confirmedAccounts = data.accounts.filter((a) => isAccountConfirmed(a.confirmed));
    const previewU = data.accounts.find((a) => a.id === uId);
    const deal = await prismaA.deal.findUniqueOrThrow({ where: { id: dealId } });
    const batch = await prismaA.batch.findUniqueOrThrow({ where: { id: batchId } });
    return {
      income: financePeriodIncome(marchRows),
      expense: financePeriodExpense(marchRows),
      companyBalance: financeAccountBalance(confirmedAccounts),
      overhead: (await getPeriodOverhead(MARCH)).toNumber(),
      dealTotal: num(deal.total),
      batchTotalCost: num(batch.totalCost),
      ddsCountFromU: data.cashFlows.filter((r) => r.accountId === uId).length,
      previewBalanceU: previewU?.balance ?? null,
    };
  }

  it("unconfirmed Account is a full financial quarantine; confirm uses original dates; unconfirm excludes again", async () => {
    const material = await prismaA.material.create({
      data: { name: `q-${Date.now()}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const batch = await prismaA.batch.create({
      data: {
        name: `qb-${Date.now()}`,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 150_000,
        totalCost: 150_000,
        priceSort1: 0,
        priceSort2: 0,
        purchaseDate: new Date("2026-01-15T00:00:00.000Z"),
      },
    });
    const deal = await prismaA.deal.create({
      data: {
        name: "Purchase deal",
        status: "OPEN",
        total: 150_000,
        items: { create: [{ batchId: batch.id }] },
      },
    });
    await prismaA.account.create({
      data: {
        name: "Primary",
        confirmed: true,
        openingBalance: 100_000,
        balance: 100_000,
        balanceAsOf: new Date("2026-03-01T00:00:00.000Z"),
      },
    });
    const u = await prismaA.account.create({
      data: {
        name: "Quarantine",
        confirmed: false,
        openingBalance: 50_000,
        balance: 50_000,
        balanceAsOf: new Date("2026-03-01T00:00:00.000Z"),
      },
    });
    const overheadCat = await prismaA.articleCategory.create({
      data: { name: "Производственные (накладные)", isOverhead: true },
    });
    const overheadArticle = await prismaA.article.create({
      data: { name: "Накладные", flowType: "EXPENSE", categoryId: overheadCat.id },
    });

    await prismaA.cashFlow.createMany({
      data: [
        {
          accountId: u.id,
          amount: 5_000,
          flowType: "INCOME",
          date: new Date("2026-03-10T00:00:00.000Z"),
          description: "income",
        },
        {
          accountId: u.id,
          amount: 3_000,
          flowType: "EXPENSE",
          date: new Date("2026-03-11T00:00:00.000Z"),
          description: "overhead",
          articleId: overheadArticle.id,
        },
        {
          accountId: u.id,
          amount: 150_000,
          flowType: "EXPENSE",
          date: new Date("2026-03-12T00:00:00.000Z"),
          description: "purchase",
          dealId: deal.id,
        },
        {
          accountId: u.id,
          amount: 8_000,
          flowType: "EXPENSE",
          date: new Date("2026-03-13T00:00:00.000Z"),
          description: "delivery",
          dealId: deal.id,
        },
      ],
    });

    const before = await snapshotCompanyFinance(u.id, deal.id, batch.id);
    expect(before.income).toBe(0);
    expect(before.expense).toBe(0);
    expect(before.companyBalance).toBe(100_000);
    expect(before.overhead).toBe(0);
    expect(before.dealTotal).toBe(150_000);
    expect(before.batchTotalCost).toBe(150_000);
    expect(before.ddsCountFromU).toBe(0);
    expect(before.previewBalanceU).toBe(-106_000);

    await setAccountConfirmed(u.id, true);

    const confirmed = await snapshotCompanyFinance(u.id, deal.id, batch.id);
    expect(confirmed.income).toBe(5_000);
    expect(confirmed.expense).toBe(161_000);
    expect(confirmed.companyBalance).toBe(-6_000);
    expect(confirmed.overhead).toBe(3_000);
    expect(confirmed.dealTotal).toBe(158_000);
    expect(confirmed.batchTotalCost).toBe(158_000);
    expect(confirmed.ddsCountFromU).toBe(4);

    await setAccountConfirmed(u.id, false);

    const again = await snapshotCompanyFinance(u.id, deal.id, batch.id);
    expect(again).toEqual(before);
    expect(await prismaA.cashFlow.count({ where: { accountId: u.id } })).toBe(4);
  });

  it("setAccountConfirmed vs concurrent create CashFlow still syncs the new Deal if confirmed=true", async () => {
    const material = await prismaA.material.create({
      data: { name: `race-${Date.now()}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const batch = await prismaA.batch.create({
      data: {
        name: `rb-${Date.now()}`,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 15_000,
        totalCost: 15_000,
        priceSort1: 0,
        priceSort2: 0,
        purchaseDate: new Date("2026-01-15T00:00:00.000Z"),
      },
    });
    const deal = await prismaA.deal.create({
      data: {
        name: "Race deal",
        status: "OPEN",
        total: 15_000,
        items: { create: [{ batchId: batch.id }] },
      },
    });
    const u = await prismaA.account.create({
      data: { name: "Race U", confirmed: false, openingBalance: 0, balance: 0 },
    });

    await Promise.all([
      setAccountConfirmed(u.id, true),
      createCashFlow({
        date: "2026-03-01",
        amount: 20_000,
        flowType: "EXPENSE",
        accountName: u.name,
        counterpartyName: null,
        description: "race",
        articleName: null,
        dealId: deal.id,
        dealName: deal.name,
      }),
    ]);

    const account = await prismaA.account.findUniqueOrThrow({ where: { id: u.id } });
    if (account.confirmed) {
      const dealAfter = await prismaA.deal.findUniqueOrThrow({ where: { id: deal.id } });
      const batchAfter = await prismaA.batch.findUniqueOrThrow({ where: { id: batch.id } });
      expect(num(dealAfter.total)).toBe(20_000);
      expect(num(batchAfter.totalCost)).toBe(20_000);
    }
  });

  it("unconfirm || import: final unconfirmed account returns no DDS rows", async () => {
    const accountNumber = "40802810900000000999";
    const account = await prismaA.account.create({
      data: {
        name: "Import race",
        accountNumber,
        confirmed: true,
        openingBalance: 0,
        balance: 0,
      },
    });
    const file = `1CClientBankExchange
ВерсияФормата=1.03
Кодировка=Windows
СекцияРасчСчет
ДатаНачала=01.09.2026
ДатаКонца=01.09.2026
РасчСчет=${accountNumber}
БИК=044525104
НачальныйОстаток=0.00
КонечныйОстаток=100.00
КонецРасчСчет
СекцияДокумент=Платежное поручение
Номер=1
Дата=01.09.2026
Сумма=100.00
ПлательщикСчет=40702810000000001111
Плательщик=ООО Плательщик
ПлательщикИНН=7700000001
ПолучательСчет=${accountNumber}
Получатель=ИП Наш
ПолучательИНН=7800000002
НазначениеПлатежа=Оплата
КонецДокумента
КонецФайла`;

    let imported: Awaited<ReturnType<typeof importStatementInternal>> | undefined;
    const importPromise = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      imported = await importStatementInternal(file, "race.txt");
    })();

    await prismaA.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${account.id} FOR UPDATE`;
      await new Promise((resolve) => setTimeout(resolve, 200));
      await tx.account.update({ where: { id: account.id }, data: { confirmed: false } });
    });
    await importPromise;

    const after = await prismaA.account.findUniqueOrThrow({ where: { id: account.id } });
    expect(after.confirmed).toBe(false);
    expect(imported?.newCashFlows).toEqual([]);
    expect(await prismaA.cashFlow.count({ where: { accountId: account.id } })).toBeGreaterThan(0);

    const data = await getFinanceData();
    expect(data.cashFlows.filter((row) => row.accountId === account.id)).toHaveLength(0);
    expect(financePeriodIncome(data.cashFlows)).toBe(0);
    expect(financePeriodExpense(data.cashFlows)).toBe(0);
    const confirmedAccounts = data.accounts.filter((a) => isAccountConfirmed(a.confirmed));
    expect(confirmedAccounts.some((a) => a.id === account.id)).toBe(false);
  });
});
