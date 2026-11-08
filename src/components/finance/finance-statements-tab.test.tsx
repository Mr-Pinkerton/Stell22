/** @vitest-environment happy-dom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinanceStatementsTab } from "@/components/finance/finance-statements-tab";
import type { AccountCoverageSummary } from "@/lib/bank-statement-integrity";
import type { FinanceStatementRow } from "@/mocks/finance-fixtures";

afterEach(() => cleanup());

function statement(
  patch: Partial<FinanceStatementRow> & Pick<FinanceStatementRow, "id">,
): FinanceStatementRow {
  return {
    date: "2026-09-03",
    accountName: "Расчётный Альфа",
    operationsCount: 1,
    unassignedCount: 0,
    uploaded: true,
    periodStart: "2026-09-01",
    periodEnd: "2026-09-03",
    source: "BANK_1C",
    periodStatus: "VERIFIED",
    ...patch,
  };
}

function rowByAccount(name: string) {
  const cell = screen.getByText(name);
  const row = cell.closest("tr");
  if (!row) throw new Error(`row not found for ${name}`);
  return row;
}

function uploadButton(row: HTMLElement) {
  return within(row).getByRole("button", { name: /^(Перезагрузить|Загрузить)$/ });
}

const coverage: AccountCoverageSummary = {
  accountId: "alfa",
  accountName: "Расчётный Альфа",
  status: "VERIFIED",
  asOf: "2026-11-06",
  coveredRanges: [{ start: "2026-09-01", end: "2026-09-03" }],
  missingDates: ["2026-09-04"],
  possibleGapDates: ["2026-09-06", "2026-11-04"],
  overlappingDates: [{ date: "2026-09-03", statementIds: ["bank-overlap"] }],
  trailingFrom: "2026-11-03",
  trailingTo: "2026-11-06",
  trailingBusinessDates: ["2026-11-03"],
};

describe("statement source labels and actions", () => {
  const rows: FinanceStatementRow[] = [
    statement({
      id: "bank-overlap",
      accountName: "Банк с пересечением",
      source: "BANK_1C",
      periodStatus: "VERIFIED",
      operationsCount: 2,
      uploaded: true,
      overlapDates: ["2026-09-03", "2026-09-04"],
      mismatch: true,
    }),
    statement({
      id: "bank-empty",
      accountName: "Банк без операций",
      source: "BANK_1C",
      periodStatus: "VERIFIED",
      operationsCount: 0,
      uploaded: false,
    }),
    statement({
      id: "manual",
      accountName: "Ручная заготовка",
      source: "MANUAL",
      periodStatus: "PLACEHOLDER",
      operationsCount: 0,
      uploaded: false,
    }),
    statement({
      id: "unknown",
      accountName: "Неизвестный источник",
      source: null,
      periodStatus: "UNKNOWN",
      operationsCount: 0,
      uploaded: true,
    }),
  ];

  it("shows only the source name and keeps coverage in the summary", () => {
    render(
      <FinanceStatementsTab
        statements={rows}
        coverage={[coverage]}
        asOf="2026-11-06"
        onLoadDetail={async () => []}
        onDelete={() => {}}
        onUploadRequest={() => {}}
      />,
    );

    expect(screen.getByRole("columnheader", { name: "Источник" })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: "Статус" })).toBeNull();

    expect(within(rowByAccount("Банк с пересечением")).getByText("Банк")).toBeTruthy();
    expect(within(rowByAccount("Ручная заготовка")).getByText("Вручную")).toBeTruthy();
    expect(within(rowByAccount("Неизвестный источник")).getByText("Источник неизвестен")).toBeTruthy();

    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Банк 1С");
    expect(text).not.toContain("покрытие доказано");
    expect(text).not.toContain("не банковское покрытие");
    expect(text).not.toContain("покрытие неизвестно");
    expect(text).toContain("Покрыто:");
    expect(text).toContain("Пропуски рабочих дней:");
    expect(text).toContain("Выходные внутри пропусков, покрытие не ставится: 06.09.2026");
    expect(text).toContain("Праздники внутри пропусков, покрытие не ставится: 04.11.2026");
    expect(text).toContain("Пересечение периодов: 03.09.2026, 04.09.2026");
    expect(text).not.toContain("Пересечение: 03.09.2026");
  });

  it("keeps upload rightmost and leaves bank rows without delete", async () => {
    const user = userEvent.setup();
    const onLoadDetail = vi.fn(async () => []);
    const onDelete = vi.fn();
    const onUploadRequest = vi.fn();
    render(
      <FinanceStatementsTab
        statements={rows}
        onLoadDetail={onLoadDetail}
        onDelete={onDelete}
        onUploadRequest={onUploadRequest}
      />,
    );

    const uploads = rows.map((row) => uploadButton(rowByAccount(row.accountName ?? "")));
    for (const upload of uploads) {
      const group = upload.parentElement;
      expect(group?.className).toContain("justify-end");
      expect(group?.className).not.toContain("justify-center");
      expect(group?.className).toContain("w-full");
      expect(group?.lastElementChild).toBe(upload);
    }

    const withEye = rowByAccount("Банк с пересечением");
    const eye = within(withEye).getByRole("button", { name: "Операции выписки" });
    expect(eye.compareDocumentPosition(uploadButton(withEye)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(withEye).queryByRole("button", { name: "Откатить выписку" })).toBeNull();

    const withoutEye = rowByAccount("Банк без операций");
    expect(within(withoutEye).queryByRole("button", { name: "Операции выписки" })).toBeNull();
    expect(within(withoutEye).queryByRole("button", { name: "Откатить выписку" })).toBeNull();
    expect(uploadButton(withoutEye).textContent).toContain("Загрузить");

    const manual = rowByAccount("Ручная заготовка");
    const remove = within(manual).getByRole("button", { name: "Откатить выписку" });
    expect(remove.compareDocumentPosition(uploadButton(manual)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const mismatch = within(withEye).getByText("≠");
    expect(mismatch.className).toContain("text-red-600");
    await user.hover(mismatch);
    expect(await screen.findByText("«Конечный остаток» выписки не совпал с расчётным")).toBeTruthy();

    await user.click(uploadButton(withoutEye));
    expect(onUploadRequest).toHaveBeenCalledOnce();
    await user.click(remove);
    expect(onDelete).toHaveBeenCalledWith("manual");
    await user.click(eye);
    expect(onLoadDetail).toHaveBeenCalledWith("bank-overlap");
  });
});
