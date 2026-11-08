/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { FinanceStatementsTab } from "@/components/finance/finance-statements-tab";
import type { AccountCoverageSummary } from "@/lib/bank-statement-integrity";
import type { FinanceStatementRow } from "@/mocks/finance-fixtures";

afterEach(() => cleanup());

function account(
  patch: Partial<AccountCoverageSummary> & Pick<AccountCoverageSummary, "accountId" | "accountName" | "status">,
): AccountCoverageSummary {
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

function statement(patch: Partial<FinanceStatementRow> & Pick<FinanceStatementRow, "id">): FinanceStatementRow {
  return {
    date: "2026-11-02",
    accountName: "Расчётный Альфа",
    operationsCount: 1,
    unassignedCount: 0,
    uploaded: true,
    periodStart: "2026-11-02",
    periodEnd: "2026-11-02",
    source: "BANK_1C",
    periodStatus: "VERIFIED",
    ...patch,
  };
}

function summaryText() {
  return document.querySelector("[data-slot=coverage-summary]")?.textContent ?? "";
}

describe("compact statement coverage notice", () => {
  it("shows one shared date, several dates, missing days and trailing days as separate warnings", () => {
    const { rerender } = render(
      <FinanceStatementsTab
        statements={[statement({ id: "one", overlapDates: ["2026-11-02"] })]}
        coverage={[
          account({
            accountId: "alfa",
            accountName: "Расчётный Альфа",
            status: "VERIFIED",
            overlappingDates: [{ date: "2026-11-02", statementIds: ["one", "two"] }],
          }),
        ]}
      />,
    );
    expect(summaryText()).toContain("Есть замечания");
    expect(summaryText()).toContain("За 02.11.2026 загружено несколько выписок");
    expect(screen.getAllByText("За 02.11.2026 загружено несколько выписок").length).toBeGreaterThan(0);

    rerender(
      <FinanceStatementsTab
        statements={[statement({ id: "many", overlapDates: ["2026-11-02", "2026-11-03"] })]}
        coverage={[
          account({
            accountId: "alfa",
            accountName: "Расчётный Альфа",
            status: "VERIFIED",
            overlappingDates: [
              { date: "2026-11-02", statementIds: ["a", "b"] },
              { date: "2026-11-03", statementIds: ["a", "b"] },
            ],
            missingDates: ["2026-11-05", "2026-11-06"],
            trailingBusinessDates: ["2026-11-09"],
          }),
        ]}
      />,
    );
    const text = summaryText();
    expect(text).toContain("За даты 02.11.2026, 03.11.2026 загружено по несколько выписок");
    expect(text).toContain("Нет выписок за рабочие дни: 05.11.2026, 06.11.2026");
    expect(text).toContain("После последней выписки нет данных за рабочие дни: 09.11.2026");
    expect(text).not.toMatch(/Пересечени/);
    expect(text).not.toContain("Дубли операций");
    expect(text).not.toContain("Дублированные платежи");
    expect(text).not.toContain("Ошибочный импорт");
    expect(text).not.toContain("Повторное списание");
  });

  it("keeps weekends, holidays and unknown accounts out of the warning", async () => {
    const user = userEvent.setup();
    render(
      <FinanceStatementsTab
        statements={[]}
        coverage={[
          account({
            accountId: "weekend",
            accountName: "Только выходной",
            status: "VERIFIED",
            coveredRanges: [{ start: "2026-11-02", end: "2026-11-06" }],
            possibleGapDates: ["2026-11-07", "2026-11-08"],
          }),
          account({
            accountId: "holiday",
            accountName: "Только праздник",
            status: "VERIFIED",
            coveredRanges: [{ start: "2026-11-02", end: "2026-11-03" }],
            possibleGapDates: ["2026-11-04"],
          }),
          account({ accountId: "cash", accountName: "Касса", status: "UNKNOWN" }),
        ]}
      />,
    );
    expect(summaryText()).toBe("Проверка выписокЗамечаний по проверенным периодам нет");
    expect(summaryText()).not.toContain("Есть замечания");
    expect(summaryText()).not.toContain("Касса");
    const toggle = screen.getByRole("button", { name: "Подробнее" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("statement-coverage-details");
    expect(toggle.className).toContain("focus-visible:ring");
    expect(document.getElementById("statement-coverage-details")).toBeNull();
    expect(document.querySelector("[data-coverage-notice]")?.className).not.toContain("overflow-y-auto");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Период выписок пока не подтверждён")).toBeTruthy();
    expect(screen.getByText("Выходные внутри пропусков, покрытие не ставится: 07.11.2026, 08.11.2026")).toBeTruthy();
    expect(screen.getByText("Праздники внутри пропусков, покрытие не ставится: 04.11.2026")).toBeTruthy();
    expect(document.body.textContent).not.toContain("VERIFIED");
    expect(document.body.textContent).not.toContain("UNKNOWN");
    expect(document.body.textContent).not.toMatch(/Пересечени/);

    toggle.focus();
    await user.keyboard("{Enter}");
    expect(screen.queryByText("Период выписок пока не подтверждён")).toBeNull();
    expect(screen.getByRole("button", { name: "Подробнее" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("uses a neutral notice when every account is unconfirmed and hides an empty coverage list", () => {
    const { rerender } = render(
      <FinanceStatementsTab
        statements={[]}
        coverage={[account({ accountId: "cash", accountName: "Касса", status: "UNKNOWN" })]}
      />,
    );
    expect(summaryText()).toContain("Нет подтверждённых периодов выписок");
    expect(summaryText()).not.toContain("Есть замечания");

    rerender(<FinanceStatementsTab statements={[]} />);
    expect(screen.queryByText("Проверка выписок")).toBeNull();
    expect(screen.getByText("Выписок нет")).toBeTruthy();
  });

  it("counts several accounts without listing them until the details open", async () => {
    const user = userEvent.setup();
    render(
      <FinanceStatementsTab
        statements={[
          statement({ id: "bank", accountName: "Расчётный Альфа", operationsCount: 2 }),
          statement({
            id: "manual",
            accountName: "Ручная заготовка",
            source: "MANUAL",
            periodStatus: "PLACEHOLDER",
            operationsCount: 0,
            uploaded: false,
          }),
        ]}
        coverage={[
          account({
            accountId: "alfa",
            accountName: "Расчётный Альфа",
            status: "VERIFIED",
            overlappingDates: [{ date: "2026-11-02", statementIds: ["a", "b"] }],
          }),
          account({
            accountId: "beta",
            accountName: "Расчётный Бета",
            status: "VERIFIED",
            missingDates: ["2026-11-05"],
            coveredRanges: [{ start: "2026-11-02", end: "2026-11-04" }],
            trailingFrom: "2026-11-06",
            trailingTo: "2026-11-08",
            trailingBusinessDates: ["2026-11-06"],
          }),
          account({
            accountId: "ok",
            accountName: "Чистый счёт",
            status: "VERIFIED",
            coveredRanges: [{ start: "2026-11-02", end: "2026-11-08" }],
          }),
        ]}
        onLoadDetail={async () => []}
        onDelete={() => {}}
        onUploadRequest={() => {}}
      />,
    );
    expect(summaryText()).toContain("Замечания по 2 счетам");
    expect(summaryText()).not.toContain("Расчётный Бета");
    expect(summaryText()).not.toContain("Чистый счёт");
    const bank = screen.getByText("Расчётный Альфа").closest("tr");
    expect(bank?.textContent).toContain("Банк");
    expect(bank?.querySelector('[aria-label="Изменить"]')).toBeNull();
    expect(bank?.querySelector('[aria-label="Удалить"]')).toBeNull();
    expect(bank?.querySelector('[aria-label="Откатить выписку"]')).toBeNull();
    const uploads = screen.getAllByRole("button", { name: /Загрузить|Перезагрузить/ });
    for (const upload of uploads) {
      expect(upload.parentElement?.className).toContain("justify-end");
      expect(upload.parentElement?.lastElementChild).toBe(upload);
    }

    await user.click(screen.getByRole("button", { name: "Подробнее" }));
    const details = document.getElementById("statement-coverage-details");
    expect(details?.textContent).toContain("Расчётный Альфа");
    expect(details?.textContent).toContain("Расчётный Бета");
    expect(details?.textContent).toContain("Чистый счёт");
    expect(details?.textContent).toContain("За 02.11.2026 загружено несколько выписок");
    expect(details?.textContent).toContain("Нет выписок за рабочие дни: 05.11.2026");
    expect(details?.textContent).toContain("После последней выписки 06.11.2026 — 08.11.2026");
    expect(details?.textContent).toContain("После последней выписки нет данных за рабочие дни: 06.11.2026");
    expect(details?.textContent).toContain("Проверенный период: 02.11.2026 — 08.11.2026");
    expect(details?.className).toContain("overflow-y-auto");
    expect(details?.className).toContain("scrollbar-thin-y");
  });
});
