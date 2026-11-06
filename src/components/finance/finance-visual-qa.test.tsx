/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FinanceCashflowTab } from "@/components/finance/finance-cashflow-tab";
import { FinanceStatementsTab } from "@/components/finance/finance-statements-tab";
import type { AccountCoverageSummary } from "@/lib/bank-statement-integrity";
import type { FinanceCashFlowRow, FinanceStatementRow } from "@/mocks/finance-fixtures";

afterEach(() => cleanup());

function row(patch: Partial<FinanceCashFlowRow> & Pick<FinanceCashFlowRow, "id">): FinanceCashFlowRow {
  return {
    date: "2026-09-04",
    amount: 100,
    flowType: "EXPENSE",
    accountName: "Касса",
    counterpartyName: null,
    description: "Операция",
    articleName: null,
    dealName: null,
    dealId: null,
    isAutoAssigned: false,
    source: "MANUAL",
    ...patch,
  };
}

const rows: FinanceCashFlowRow[] = [
  row({
    id: "imported",
    date: "2026-09-01",
    source: "BANK",
    accountName: "Расчётный Альфа",
    counterpartyName: "ООО Проверка",
    description: "Оплата поставки",
    amount: 1500,
  }),
  row({
    id: "manual",
    description: "Канцтовары офиса",
    articleName: null,
  }),
  row({
    id: "transfer",
    date: "2026-09-03",
    source: "BANK",
    isTransfer: true,
    pairedTransfer: true,
    accountName: "Расчётный Бета",
    description: "Перевод с Альфа",
    flowType: "INCOME",
    amount: 800,
  }),
  row({
    id: "unassigned",
    date: "2026-09-02",
    description: "Без статьи",
  }),
  row({
    id: "deal",
    description: "Привязана к сделке",
    articleName: "Материалы",
    dealId: "deal-1",
    dealName: "Поставка",
  }),
];

describe("DDS table responsiveness", () => {
  it("keeps six columns and scrolls inside the table instead of compressing them", () => {
    render(
      <FinanceCashflowTab
        rows={rows}
        articles={[]}
        counterparties={[]}
        deals={[{ id: "deal-1", name: "Поставка", status: "OPEN", total: 1, batchNames: [], deliveryExtra: 0 }]}
        autoRules={[]}
        onEdit={() => {}}
        onDelete={() => {}}
        onConvertToTransfer={() => {}}
        onUnlinkTransfer={() => {}}
      />,
    );
    for (const name of ["Сумма", "Контрагент", "Назначение", "Статья", "Сделка"]) {
      expect(screen.getByRole("columnheader", { name })).toBeTruthy();
    }
    const table = document.querySelector("table");
    expect(table).toBeTruthy();
    expect(table?.querySelectorAll("col")).toHaveLength(6);
    expect(table?.className).toMatch(/min-w-/);
    expect(table?.parentElement?.className).toMatch(/overflow-x-auto/);
    expect(table?.parentElement?.className).toMatch(/overflow-y-auto/);
    const imported = screen.getByText("Оплата поставки").closest("tr");
    const manual = screen.getByText("Канцтовары офиса").closest("tr");
    const transfer = screen.getByText("Перевод с Альфа").closest("tr");
    const unassigned = screen.getByText("Без статьи").closest("tr");
    const linked = screen.getByText("Привязана к сделке").closest("tr");
    for (const line of [imported, manual, transfer, unassigned, linked]) {
      expect(line?.querySelectorAll("td")).toHaveLength(6);
    }
    expect(imported?.querySelector('[aria-label="Сделать переводом"]')).toBeTruthy();
    expect(imported?.querySelector('[aria-label="Изменить"]')).toBeNull();
    expect(manual?.querySelector('[aria-label="Изменить"]')).toBeTruthy();
    expect(manual?.querySelector('[aria-label="Удалить"]')).toBeTruthy();
    expect(manual?.querySelector('[aria-label="Автоправила нет"]')).toBeTruthy();
    expect(transfer?.querySelector("button")).toBeNull();
    expect(unassigned?.querySelector('[aria-label="Автоправила нет"]')).toBeTruthy();
    expect(linked?.querySelector('[aria-label="Сделать переводом"]')).toBeTruthy();
    const actions = manual?.lastElementChild;
    expect(actions?.className).toMatch(/whitespace-nowrap/);
  });
});

const coverage: AccountCoverageSummary = {
  accountId: "alfa",
  accountName: "Расчётный Альфа",
  status: "VERIFIED",
  asOf: "2026-11-06",
  coveredRanges: [{ start: "2026-11-02", end: "2026-11-02" }],
  missingDates: [],
  possibleGapDates: ["2026-09-06", "2026-11-04"],
  overlappingDates: [],
  trailingFrom: "2026-11-03",
  trailingTo: "2026-11-06",
  trailingBusinessDates: ["2026-11-03", "2026-11-05"],
};

const statement: FinanceStatementRow = {
  id: "stmt-overlap",
  date: "2026-09-03",
  accountName: "Расчётный Альфа",
  operationsCount: 1,
  unassignedCount: 0,
  uploaded: true,
  periodStart: "2026-09-01",
  periodEnd: "2026-09-03",
  source: "BANK_1C",
  periodStatus: "VERIFIED",
  overlapDates: ["2026-09-03"],
};

describe("statement visual labels", () => {
  it("shows overlap dates as DD.MM.YYYY and splits holidays from weekends", () => {
    render(<FinanceStatementsTab statements={[statement]} coverage={[coverage]} asOf="2026-11-06" />);
    expect(screen.getByText("Пересечение: 03.09.2026")).toBeTruthy();
    expect(document.body.textContent).not.toContain("2026-09-03");
    const text = document.body.textContent ?? "";
    expect(text).toContain("Выходные внутри пропусков, покрытие не ставится: 06.09.2026");
    expect(text).toContain("Праздники внутри пропусков, покрытие не ставится: 04.11.2026");
    expect(text).not.toContain("Выходные внутри пропусков, покрытие не ставится: 06.09.2026, 04.11.2026");
  });
});
