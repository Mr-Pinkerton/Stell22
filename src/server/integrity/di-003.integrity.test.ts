import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { parse1CStatement } from "@/lib/bank-statement-1c";
import {
  isDuplicateAccountNumber,
  isDuplicateImportKey,
  prismaUniqueDiscriminator,
} from "@/lib/prisma-unique-conflict";
import { importStatementInternal } from "@/server/internal/statement-import";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityFinance,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

function statementFile(accountNumber: string): string {
  return `1CClientBankExchange
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
}

describe.skipIf(!enabled)("DI-003 integrity", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityFinance(prismaA);
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
  });

  it("duplicate accountNumber Prisma error exposes a stable discriminator", async () => {
    const num = "40802810900000000001";
    await prismaA.account.create({
      data: { name: "A", accountNumber: num, confirmed: false },
    });
    try {
      await prismaA.account.create({
        data: { name: "B", accountNumber: num, confirmed: false },
      });
      throw new Error("expected P2002");
    } catch (e) {
      expect(e).toMatchObject({ code: "P2002" });
      const disc = prismaUniqueDiscriminator(e);
      expect(disc.length).toBeGreaterThan(0);
      expect(isDuplicateAccountNumber(e)).toBe(true);
      expect(isDuplicateImportKey(e)).toBe(false);
    }
  });

  it("duplicate importKey Prisma error exposes a stable discriminator", async () => {
    const account = await prismaA.account.create({
      data: { name: "Bank", accountNumber: "40802810900000000002", confirmed: true },
    });
    const key = "doc|2026-09-01|100.00|payer|payee";
    const cf = {
      amount: new Prisma.Decimal("100.00"),
      flowType: "INCOME" as const,
      accountId: account.id,
      date: new Date("2026-09-01T00:00:00.000Z"),
      importKey: key,
    };
    await prismaA.cashFlow.create({ data: cf });
    try {
      await prismaA.cashFlow.create({ data: cf });
      throw new Error("expected P2002");
    } catch (e) {
      expect(e).toMatchObject({ code: "P2002" });
      const disc = prismaUniqueDiscriminator(e);
      expect(disc.length).toBeGreaterThan(0);
      expect(isDuplicateImportKey(e)).toBe(true);
      expect(isDuplicateAccountNumber(e)).toBe(false);
    }
  });

  it("concurrent importStatementInternal of the same file creates one Account and one CF set", async () => {
    const ourNumber = "40802810900000000003";
    const file = statementFile(ourNumber);
    const parsedDocCount = parse1CStatement(file).documents.length;
    expect(await prismaA.account.count({ where: { accountNumber: ourNumber } })).toBe(0);

    await Promise.all([
      importStatementInternal(file, "a.txt"),
      importStatementInternal(file, "b.txt"),
    ]);

    const accounts = await prismaA.account.findMany({ where: { accountNumber: ourNumber } });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].confirmed).toBe(false);
    const keys = await prismaA.cashFlow.findMany({
      where: { accountId: accounts[0].id, importKey: { not: null } },
      select: { importKey: true },
    });
    expect(keys.map((k) => k.importKey).sort()).toEqual(
      [...new Set(keys.map((k) => k.importKey))].sort(),
    );
    expect(keys).toHaveLength(parsedDocCount);
  });

  it("sequential second importStatementInternal same file skips documents", async () => {
    const ourNumber = "40802810900000000004";
    const file = statementFile(ourNumber);
    const first = await importStatementInternal(file, "a.txt");
    const second = await importStatementInternal(file, "b.txt");
    expect(first.importedCount).toBeGreaterThan(0);
    expect(second.importedCount).toBe(0);
    expect(second.skippedCount).toBeGreaterThan(0);
    const accounts = await prismaA.account.findMany({ where: { accountNumber: ourNumber } });
    expect(accounts).toHaveLength(1);
    expect(
      await prismaA.cashFlow.count({
        where: { accountId: accounts[0].id, importKey: { not: null } },
      }),
    ).toBe(first.importedCount);
  });

  it("concurrent create same accountId+importKey yields one CashFlow", async () => {
    const account = await prismaA.account.create({
      data: { name: "Existing", accountNumber: "40802810900000000005", confirmed: true },
    });
    const key = "doc|2026-09-01|100.00|payer|payee";
    const data = {
      amount: new Prisma.Decimal("100.00"),
      flowType: "INCOME" as const,
      accountId: account.id,
      date: new Date("2026-09-01T00:00:00.000Z"),
      importKey: key,
    };
    const results = await Promise.allSettled([
      prismaA.cashFlow.create({ data }),
      prismaB.cashFlow.create({ data }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const fail = results.filter((r) => r.status === "rejected").length;
    expect(ok).toBe(1);
    expect(fail).toBe(1);
    expect(await prismaA.cashFlow.count({ where: { accountId: account.id, importKey: key } })).toBe(
      1,
    );
  });
});
