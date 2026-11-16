/** @vitest-environment happy-dom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    bankDocument: true,
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
    bankDocument: true,
    isTransfer: true,
    pairedTransfer: true,
    accountName: "Расчётный Бета",
    description: "Перевод с Альфа",
    flowType: "INCOME",
    amount: 800,
  }),
  row({
    id: "synthetic",
    date: "2026-09-03",
    source: "BANK",
    bankDocument: false,
    isTransfer: true,
    pairedTransfer: true,
    accountName: "Касса",
    description: "Синтетическая нога",
    flowType: "EXPENSE",
    amount: 800,
  }),
  row({
    id: "long",
    description: `Поставка${"ОченьДлинноеНазначение".repeat(8)} конец`,
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
        filters={<div>Поиск</div>}
      />,
    );
    expect(document.querySelector("[data-slot=table-top-gap]")).toBeNull();
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
    const synthetic = screen.getByText("Синтетическая нога").closest("tr");
    const unassigned = screen.getByText("Без статьи").closest("tr");
    const linked = screen.getByText("Привязана к сделке").closest("tr");
    const longText = `Поставка${"ОченьДлинноеНазначение".repeat(8)} конец`;
    const longRow = screen.getByText(longText).closest("tr");
    for (const line of [imported, manual, transfer, synthetic, unassigned, linked, longRow]) {
      expect(line?.querySelectorAll("td")).toHaveLength(6);
    }
    expect(imported?.textContent).toContain("Банк");
    expect(imported?.querySelector('[aria-label="Сделать переводом"]')).toBeTruthy();
    expect(imported?.querySelector('[aria-label="Автоправила нет"]')).toBeTruthy();
    expect(imported?.textContent).toContain("Не разнесено");
    expect(imported?.querySelector('[aria-label="Изменить"]')).toBeNull();
    expect(imported?.querySelector('[aria-label="Удалить"]')).toBeNull();
    expect(synthetic?.textContent).toContain("Встречная");
    expect(synthetic?.textContent).not.toContain("Банк");
    expect(synthetic?.querySelector('[aria-label="Удалить"]')).toBeNull();
    expect(synthetic?.querySelector('[aria-label="Изменить"]')).toBeNull();
    expect(synthetic?.querySelector('[aria-label="Убрать перевод"]')).toBeTruthy();
    expect(manual?.querySelector('[aria-label="Изменить"]')).toBeTruthy();
    expect(manual?.querySelector('[aria-label="Удалить"]')).toBeTruthy();
    expect(manual?.querySelector('[aria-label="Автоправила нет"]')).toBeTruthy();
    expect(transfer?.querySelector('[aria-label="Убрать перевод"]')).toBeTruthy();
    expect(transfer?.querySelector('[aria-label="Удалить"]')).toBeNull();
    expect(transfer?.querySelector('[aria-label="Изменить"]')).toBeNull();
    expect(transfer?.querySelector('[aria-label="Автоправила нет"]')).toBeNull();
    expect(unassigned?.querySelector('[aria-label="Автоправила нет"]')).toBeTruthy();
    expect(linked?.querySelector('[aria-label="Сделать переводом"]')).toBeTruthy();
    const description = longRow?.querySelector("[data-slot=dds-description]");
    expect(description?.textContent).toBe(longText);
    expect(description?.getAttribute("title")).toBe(longText);
    expect(description?.className).toMatch(/break-words/);
    expect(description?.className).not.toMatch(/line-clamp/);
    const actions = manual?.lastElementChild;
    expect(actions?.className).not.toMatch(/whitespace-nowrap/);
    expect(actions?.className).toMatch(/max-w-0/);
    expect(longRow?.className).toMatch(/!h-auto/);
  });

  it("opens a prefilled rule from a bank row and an existing rule from a manual row", async () => {
    const user = userEvent.setup();
    const onGoToRule = vi.fn();
    const onAutoRuleCreated = vi.fn();
    render(
      <FinanceCashflowTab
        rows={rows}
        articles={[{ id: "art", name: "Материалы", flowType: "EXPENSE", categoryName: "Закупки", isOverhead: false, parentId: null }]}
        counterparties={[{ id: "cp", name: "ООО Проверка" }]}
        deals={[]}
        autoRules={[{
          id: "rule-1",
          flowType: "EXPENSE",
          counterpartyName: null,
          logicOperator: "AND",
          descriptionKeywords: "Канцтовары",
          articleName: "Материалы",
          dealName: null,
        }]}
        onGoToRule={onGoToRule}
        onAutoRuleCreated={onAutoRuleCreated}
      />,
    );
    await user.click(screen.getByText("Оплата поставки").closest("tr")!.querySelector('[aria-label="Автоправила нет"]')!);
    expect(screen.getByText("Добавить автоправило")).toBeTruthy();
    expect(screen.getByDisplayValue("Оплата поставки")).toBeTruthy();
    await user.click(screen.getByText("Канцтовары офиса").closest("tr")!.querySelector('[aria-label="Автоправило есть"]')!);
    expect(onGoToRule).toHaveBeenCalledWith("rule-1");
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
  it("shows overlap dates as DD.MM.YYYY and splits holidays from weekends", async () => {
    const user = userEvent.setup();
    render(<FinanceStatementsTab statements={[statement]} coverage={[coverage]} asOf="2026-11-06" />);
    const gap = document.querySelector("[data-slot=table-top-gap]");
    expect(gap?.className).toContain("h-[16px]");
    expect(gap?.className).toContain("border-b");
    expect(gap?.className).toContain("border-border");
    expect(gap?.textContent).toBe("");
    expect(gap?.nextElementSibling?.querySelector("table")).toBeTruthy();
    expect(screen.getByText("За 03.09.2026 загружено несколько выписок")).toBeTruthy();
    expect(document.body.textContent).not.toContain("2026-09-03");
    await user.click(screen.getByRole("button", { name: "Подробнее" }));
    const text = document.body.textContent ?? "";
    expect(text).toContain("Выходные дни (не считаются пропусками выписок): 06.09.2026");
    expect(text).toContain("Праздничные дни (не считаются пропусками выписок): 04.11.2026");
    expect(text).not.toContain("Выходные дни (не считаются пропусками выписок): 06.09.2026, 04.11.2026");
  });

  it("draws the header line above an empty statements table", () => {
    render(<FinanceStatementsTab statements={[]} asOf="2026-11-06" />);
    const gap = document.querySelector("[data-slot=table-top-gap]");
    expect(gap?.className).toContain("h-[16px]");
    expect(gap?.className).toContain("border-b");
    expect(gap?.className).toContain("border-border");
    expect(screen.getByText("Выписок нет")).toBeTruthy();
    expect(gap?.closest("[data-slot=card]")?.className).not.toMatch(/\bborder-b\b/);
    expect(document.querySelector("th")?.className).toContain("h-[49px]");
  });
});
