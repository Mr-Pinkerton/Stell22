import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  canonicalStatementDocument,
  cashFlowSource,
  coverAccounts,
  decideTransferPair,
  isBankImportedOperation,
  isPotentialBankReportingGap,
  statementContentIdentity,
  transferGroupIsBankProtected,
  validateVerifiedPeriod,
} from "@/lib/bank-statement-integrity";

describe("bank statement provenance", () => {
  it("treats statementId or importKey as bank origin and ignores isAutoAssigned", () => {
    expect(isBankImportedOperation({ statementId: "st", importKey: null })).toBe(true);
    expect(isBankImportedOperation({ statementId: null, importKey: "doc|1" })).toBe(true);
    expect(isBankImportedOperation({ statementId: null, importKey: null })).toBe(false);
    expect(
      cashFlowSource({
        statementId: null,
        importKey: null,
        isAutoAssigned: true,
        linkedToImportedTransfer: false,
      }),
    ).toBe("MANUAL");
  });

  it("protects a whole transfer group when any leg is imported", () => {
    expect(
      transferGroupIsBankProtected([
        { statementId: null, importKey: null },
        { statementId: "st", importKey: "k" },
      ]),
    ).toBe(true);
    expect(
      cashFlowSource({
        statementId: null,
        importKey: null,
        isAutoAssigned: false,
        linkedToImportedTransfer: true,
      }),
    ).toBe("BANK");
  });
});

describe("verified statement period", () => {
  it("requires both 1C dates, a real calendar, and documents inside the inclusive interval", () => {
    expect(
      validateVerifiedPeriod({
        dateStart: "2026-09-01",
        dateEnd: "2026-09-03",
        documentDates: ["2026-09-01", "2026-09-03"],
        accountNumber: "40702810000000000001",
        boundAccountNumber: "40702810000000000001",
      }).ok,
    ).toBe(true);

    expect(
      validateVerifiedPeriod({
        dateStart: null,
        dateEnd: "2026-09-03",
        documentDates: [],
        accountNumber: "40702810000000000001",
        boundAccountNumber: null,
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateVerifiedPeriod({
        dateStart: "2026-02-31",
        dateEnd: "2026-03-01",
        documentDates: [],
        accountNumber: "40702810000000000001",
        boundAccountNumber: null,
      }),
    ).toMatchObject({ ok: false });

    expect(
      validateVerifiedPeriod({
        dateStart: "2026-09-03",
        dateEnd: "2026-09-01",
        documentDates: [],
        accountNumber: "40702810000000000001",
        boundAccountNumber: null,
      }),
    ).toMatchObject({ ok: false });

    const outside = validateVerifiedPeriod({
      dateStart: "2026-09-01",
      dateEnd: "2026-09-02",
      documentDates: ["2026-09-04"],
      accountNumber: "40702810000000000001",
      boundAccountNumber: null,
    });
    expect(outside.ok).toBe(false);

    expect(
      validateVerifiedPeriod({
        dateStart: "2026-09-01",
        dateEnd: "2026-09-01",
        documentDates: [],
        accountNumber: "40702810000000000001",
        boundAccountNumber: "40702810000000000002",
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("per-account statement coverage", () => {
  const asOf = "2026-09-10";

  it("reports a gap, covers a silent day, and does not mix accounts", () => {
    const rows = coverAccounts({
      asOf,
      accounts: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      intervals: [
        { statementId: "s1", accountId: "a", periodStart: "2026-09-01", periodEnd: "2026-09-01" },
        { statementId: "s2", accountId: "a", periodStart: "2026-09-03", periodEnd: "2026-09-05" },
        { statementId: "s3", accountId: "b", periodStart: "2026-09-01", periodEnd: "2026-09-01" },
      ],
    });
    const a = rows.find((row) => row.accountId === "a");
    const b = rows.find((row) => row.accountId === "b");
    expect(a?.missingDates).toEqual(["2026-09-02"]);
    expect(a?.missingDates).not.toContain("2026-09-04");
    expect(a?.coveredRanges).toEqual([
      { start: "2026-09-01", end: "2026-09-01" },
      { start: "2026-09-03", end: "2026-09-05" },
    ]);
    expect(b?.missingDates).toEqual([]);
    expect(b?.status).toBe("VERIFIED");
    expect(a?.overlappingDates).toEqual([]);
  });

  it("keeps history before the first verified statement unknown", () => {
    const [only] = coverAccounts({
      asOf,
      accounts: [{ id: "a", name: "A" }],
      intervals: [],
    });
    expect(only?.status).toBe("UNKNOWN");
    expect(only?.missingDates).toEqual([]);
    expect(only?.coveredRanges).toEqual([]);
    expect(only?.trailingFrom).toBeNull();
  });

  it("shows trailing uncovered days through the explicit as-of date and marks weekends as gaps, not coverage", () => {
    const [row] = coverAccounts({
      asOf: "2026-09-07",
      accounts: [{ id: "a", name: "A" }],
      intervals: [
        { statementId: "s1", accountId: "a", periodStart: "2026-09-01", periodEnd: "2026-09-04" },
      ],
    });
    expect(row?.trailingFrom).toBe("2026-09-05");
    expect(row?.trailingTo).toBe("2026-09-07");
    expect(row?.asOf).toBe("2026-09-07");
    expect(row?.missingDates).not.toContain("2026-09-05");
    expect(row?.trailingBusinessDates).toEqual(["2026-09-07"]);
    expect(row?.possibleGapDates).toContain("2026-09-05");
    expect(row?.possibleGapDates).toContain("2026-09-06");
    expect(isPotentialBankReportingGap("2026-11-04")).toBe(true);
    expect(isPotentialBankReportingGap("2026-09-02")).toBe(false);
    expect(row?.coveredRanges).toEqual([{ start: "2026-09-01", end: "2026-09-04" }]);
  });

  it("lists overlapping days and does not call them a clean covered range", () => {
    const [row] = coverAccounts({
      asOf: "2026-09-03",
      accounts: [{ id: "a", name: "A" }],
      intervals: [
        { statementId: "s1", accountId: "a", periodStart: "2026-09-01", periodEnd: "2026-09-03" },
        { statementId: "s2", accountId: "a", periodStart: "2026-09-02", periodEnd: "2026-09-03" },
      ],
    });
    expect(row?.overlappingDates.map((day) => day.date)).toEqual(["2026-09-02", "2026-09-03"]);
    expect(row?.coveredRanges).toEqual([{ start: "2026-09-01", end: "2026-09-01" }]);
    expect(row?.missingDates).toEqual([]);
  });
});

describe("import paths share one statement rule", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  it("sends file, ZIP, and mail intake through the guarded importer", () => {
    const view = readFileSync(path.join(root, "src/components/finance/finance-view.tsx"), "utf8");
    const upload = readFileSync(path.join(root, "src/components/finance/statement-upload-dialog.tsx"), "utf8");
    const mail = readFileSync(path.join(root, "src/server/statement-mail.ts"), "utf8");
    const finance = readFileSync(path.join(root, "src/server/finance.ts"), "utf8");
    expect(upload).toContain("unzipSync");
    expect(view).toContain("importStatement(");
    expect(finance).toContain("importStatementInternal");
    expect(mail).toContain("importStatementInternal");
  });
});

describe("statement identity and transfer pairing", () => {
  const document = (purpose: string, payerName = "Плательщик", payerInn = "7700000001") =>
    canonicalStatementDocument({
      docNumber: "1",
      date: "2026-09-01",
      amount: "10.00",
      payerName,
      payerInn,
      payerAccount: "4070",
      payeeName: "Получатель",
      payeeInn: "7800000002",
      payeeAccount: "4080",
      purpose,
    });

  it("builds the same identity for the same bank content regardless of document order", () => {
    const first = statementContentIdentity({
      accountNumber: "4070",
      bik: "044525104",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-01",
      openingBalance: "0.00",
      closingBalance: "10.00",
      documents: [document("Оплата", "Б"), document("Оплата", "А")],
    });
    const second = statementContentIdentity({
      accountNumber: "4070",
      bik: "044525104",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-01",
      openingBalance: "0.00",
      closingBalance: "10.00",
      documents: [document("Оплата", "А"), document("Оплата", "Б")],
    });
    expect(first).toBe(second);
  });

  it("changes identity when purpose, counterparty name, or INN changes", () => {
    const base = statementContentIdentity({
      accountNumber: "4070",
      bik: null,
      periodStart: "2026-09-01",
      periodEnd: "2026-09-01",
      openingBalance: "0.00",
      closingBalance: "10.00",
      documents: [document("Оплата")],
    });
    expect(
      statementContentIdentity({
        accountNumber: "4070",
        bik: null,
        periodStart: "2026-09-01",
        periodEnd: "2026-09-01",
        openingBalance: "0.00",
        closingBalance: "10.00",
        documents: [document("Другое назначение")],
      }),
    ).not.toBe(base);
    expect(
      statementContentIdentity({
        accountNumber: "4070",
        bik: null,
        periodStart: "2026-09-01",
        periodEnd: "2026-09-01",
        openingBalance: "0.00",
        closingBalance: "10.00",
        documents: [document("Оплата", "Другой плательщик")],
      }),
    ).not.toBe(base);
    expect(
      statementContentIdentity({
        accountNumber: "4070",
        bik: null,
        periodStart: "2026-09-01",
        periodEnd: "2026-09-01",
        openingBalance: "0.00",
        closingBalance: "10.00",
        documents: [document("Оплата", "Плательщик", "7700000099")],
      }),
    ).not.toBe(base);
  });

  it("links one opposite bank document and refuses an amount-only match", () => {
    const source = {
      id: "src",
      accountId: "a",
      flowType: "EXPENSE" as const,
      amount: "100.00",
      date: "2026-09-01",
      isTransfer: false,
      paired: false,
      statementId: "s1",
      importKey: "77|2026-09-01|100.00|4070|4080",
    };
    const opposite = {
      id: "dst",
      accountId: "b",
      flowType: "INCOME" as const,
      amount: "100.00",
      date: "2026-09-01",
      isTransfer: false,
      paired: false,
      statementId: "s2",
      importKey: "77|2026-09-01|100.00|4070|4080",
    };
    expect(decideTransferPair({ source, otherAccountId: "b", candidates: [opposite] })).toEqual({
      action: "link-existing",
      candidateId: "dst",
    });

    const otherDoc = { ...opposite, id: "other", importKey: "88|2026-09-01|100.00|4070|4080" };
    expect(decideTransferPair({ source, otherAccountId: "b", candidates: [otherDoc] }).action).toBe(
      "refuse",
    );
    expect(decideTransferPair({ source, otherAccountId: "b", candidates: [] })).toEqual({
      action: "create-synthetic",
    });
    const otherDay = { ...opposite, id: "later", date: "2026-09-02" };
    expect(decideTransferPair({ source, otherAccountId: "b", candidates: [otherDay] }).action).toBe(
      "refuse",
    );
  });
});
