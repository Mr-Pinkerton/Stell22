import { describe, expect, it } from "vitest";
import type { AccountCoverageSummary } from "@/lib/bank-statement-integrity";
import {
  coverageNotice,
  missingBusinessDaysLabel,
  severalStatementsLabel,
  trailingBusinessDaysLabel,
} from "@/lib/statement-coverage-copy";

function account(patch: Partial<AccountCoverageSummary> & Pick<AccountCoverageSummary, "accountId" | "accountName" | "status">): AccountCoverageSummary {
  return {
    asOf: "2026-11-08",
    coveredRanges: [],
    missingDates: [],
    possibleGapDates: [],
    overlappingDates: [],
    trailingFrom: null,
    trailingTo: null,
    trailingBusinessDates: [],
    ...patch,
  };
}

describe("statement coverage copy", () => {
  it("names one shared date and several shared dates without calling them duplicates", () => {
    expect(severalStatementsLabel(["2026-11-02"])).toBe(
      "За 02.11.2026 загружено несколько выписок",
    );
    expect(severalStatementsLabel(["2026-11-02", "2026-11-03"])).toBe(
      "За даты 02.11.2026, 03.11.2026 загружено по несколько выписок",
    );
    const text = `${severalStatementsLabel(["2026-11-02"])} ${missingBusinessDaysLabel(["2026-11-05"])} ${trailingBusinessDaysLabel(["2026-11-06"])}`;
    expect(text).not.toMatch(/пересечен/i);
    expect(text).not.toContain("Дубли");
    expect(text).not.toContain("Ошибочный импорт");
    expect(text).not.toContain("Повторное списание");
  });

  it("keeps missing days and days after the last statement as separate sentences", () => {
    expect(missingBusinessDaysLabel(["2026-11-05", "2026-11-06"])).toBe(
      "Нет выписок за рабочие дни: 05.11.2026, 06.11.2026",
    );
    expect(trailingBusinessDaysLabel(["2026-11-05"])).toBe(
      "После последней выписки нет данных за рабочие дни: 05.11.2026",
    );
  });

  it("summarises one account, several accounts, a clear period and unknown periods", () => {
    const overlap = account({
      accountId: "alfa",
      accountName: "Расчётный Альфа",
      status: "VERIFIED",
      overlappingDates: [{ date: "2026-11-02", statementIds: ["a", "b"] }],
    });
    const missing = account({
      accountId: "beta",
      accountName: "Расчётный Бета",
      status: "VERIFIED",
      missingDates: ["2026-11-05"],
    });
    expect(coverageNotice([overlap])).toEqual({
      tone: "warning",
      headline: "Есть замечания",
      summary: "Расчётный Альфа: За 02.11.2026 загружено несколько выписок.",
    });
    const many = coverageNotice([overlap, missing]);
    expect(many.summary).toContain("Замечания по 2 счетам");
    expect(many.summary).not.toContain("Расчётный Альфа");
    expect(many.summary).not.toContain("Расчётный Бета");
    expect(
      coverageNotice([
        account({
          accountId: "ok",
          accountName: "Ок",
          status: "VERIFIED",
          coveredRanges: [{ start: "2026-11-02", end: "2026-11-06" }],
          possibleGapDates: ["2026-11-07"],
        }),
      ]).summary,
    ).toBe("Замечаний по проверенным периодам нет");
    expect(
      coverageNotice([
        account({ accountId: "cash", accountName: "Касса", status: "UNKNOWN" }),
      ]).summary,
    ).toBe("Нет подтверждённых периодов выписок");
  });
});
