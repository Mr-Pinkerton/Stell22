/** @vitest-environment happy-dom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Trash2 } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoRuleInlineRow } from "@/components/finance/auto-rule-inline-row";
import { AutoRuleQuickButton } from "@/components/finance/auto-rule-quick-button";
import { FinanceCashflowTab } from "@/components/finance/finance-cashflow-tab";
import { FinanceStatementsTab } from "@/components/finance/finance-statements-tab";
import { tableActionClass, tableActionDestructiveClass } from "@/components/nomenclature/form-shared";
import { Button } from "@/components/ui/button";
import type { FinanceAutoRule, FinanceCashFlowRow, FinanceStatementRow } from "@/mocks/finance-fixtures";

afterEach(() => cleanup());

const SHARED_HOVER = [
  "hover:text-foreground",
  "hover:bg-muted/60",
  "dark:hover:bg-muted/60",
  "size-8",
  "rounded-[8px]",
  "[&_svg]:size-4",
];

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

function cashflow(
  patch: Partial<FinanceCashFlowRow> & Pick<FinanceCashFlowRow, "id">,
): FinanceCashFlowRow {
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

function rowByText(text: string) {
  const row = screen.getByText(text).closest("tr");
  if (!row) throw new Error(`row not found for ${text}`);
  return row;
}

describe("compact icon action style", () => {
  it("uses one shared hover for ordinary and destructive icon actions", () => {
    expect(tableActionDestructiveClass).toBe(tableActionClass);
    for (const token of SHARED_HOVER) {
      expect(tableActionClass).toContain(token);
    }
    expect(tableActionClass).toContain("text-muted-foreground");
    expect(tableActionClass).not.toContain("hover:text-destructive");
    expect(tableActionClass).not.toContain("hover:bg-destructive");
    expect(tableActionClass).not.toContain("scale");
  });

  it("gives the statement eye and trash the same hover, focus, labels and actions", async () => {
    const user = userEvent.setup();
    const onLoadDetail = vi.fn(async () => []);
    const onDelete = vi.fn();
    render(
      <FinanceStatementsTab
        statements={[
          statement({
            id: "bank",
            accountName: "Банковская выписка",
            operationsCount: 2,
            source: "BANK_1C",
          }),
          statement({
            id: "manual",
            accountName: "Ручная заготовка",
            source: "MANUAL",
            periodStatus: "PLACEHOLDER",
            operationsCount: 0,
            uploaded: false,
          }),
        ]}
        onLoadDetail={onLoadDetail}
        onDelete={onDelete}
        onUploadRequest={() => {}}
      />,
    );

    const bank = rowByText("Банковская выписка");
    const eye = within(bank).getByRole("button", { name: "Операции выписки" });
    expect(within(bank).queryByRole("button", { name: "Откатить выписку" })).toBeNull();
    expect(within(bank).queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(within(bank).queryByRole("button", { name: "Удалить" })).toBeNull();

    const manual = rowByText("Ручная заготовка");
    const remove = within(manual).getByRole("button", { name: "Откатить выписку" });
    expect(eye.className).toBe(remove.className);
    for (const token of SHARED_HOVER) {
      expect(eye.className).toContain(token);
    }
    expect(eye.className).toContain("focus-visible:ring");
    expect(eye.className).not.toContain("hover:scale");
    expect(remove.parentElement?.className).toContain("justify-end");
    expect(remove.parentElement?.lastElementChild?.textContent).toContain("Загрузить");
    expect(eye.className).not.toContain("dark:hover:bg-muted/50");

    await user.hover(eye);
    expect(await screen.findAllByText("Операции выписки")).toHaveLength(1);
    await user.unhover(eye);

    eye.focus();
    expect(document.activeElement).toBe(eye);
    await user.keyboard("{Enter}");
    expect(onLoadDetail).toHaveBeenCalledWith("bank");

    remove.focus();
    expect(document.activeElement).toBe(remove);
    await user.keyboard(" ");
    expect(onDelete).toHaveBeenCalledWith("manual");
  });

  it("keeps edit and delete on the same icon action base without bank controls", async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <FinanceCashflowTab
        rows={[
          cashflow({
            id: "imported",
            source: "BANK",
            description: "Оплата поставки",
          }),
          cashflow({ id: "manual", description: "Канцтовары офиса" }),
        ]}
        articles={[]}
        counterparties={[]}
        deals={[]}
        autoRules={[]}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    );

    const imported = rowByText("Оплата поставки");
    expect(within(imported).queryByRole("button", { name: "Изменить" })).toBeNull();
    expect(within(imported).queryByRole("button", { name: "Удалить" })).toBeNull();

    const manual = rowByText("Канцтовары офиса");
    const edit = within(manual).getByRole("button", { name: "Изменить" });
    const remove = within(manual).getByRole("button", { name: "Удалить" });
    expect(edit.className).toBe(remove.className);
    for (const token of SHARED_HOVER) {
      expect(edit.className).toContain(token);
    }
    await user.click(edit);
    expect(onEdit).toHaveBeenCalledOnce();
    await user.click(remove);
    expect(onDelete).toHaveBeenCalledWith("manual");

    await user.hover(edit);
    expect(await screen.findAllByText("Изменить")).toHaveLength(1);
  });

  it("keeps a disabled icon action from firing and keeps tooltip text", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={tableActionDestructiveClass}
        disabled
        aria-label="Удалить"
        onClick={onClick}
      >
        <Trash2 />
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Удалить" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.className).toContain("disabled:pointer-events-none");
    expect(button.className).toContain("disabled:opacity-50");
    expect(button.className).toContain("focus-visible:ring");
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("uses the shared hover on rule delete and the rule toggle", async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn();
    const onOpen = vi.fn();
    const rule: FinanceAutoRule = {
      id: "rule-1",
      flowType: "EXPENSE",
      counterpartyName: null,
      logicOperator: "AND",
      descriptionKeywords: "канц",
      articleName: null,
      dealName: null,
    };
    render(
      <>
        <AutoRuleInlineRow
          rule={rule}
          articles={[]}
          counterparties={[]}
          onChange={() => {}}
          onDelete={onDelete}
        />
        <AutoRuleQuickButton hasRule onClick={onOpen} />
        <AutoRuleQuickButton hasRule={false} onClick={onOpen} />
      </>,
    );

    const remove = screen.getByRole("button", { name: "Удалить правило" });
    for (const token of SHARED_HOVER) {
      expect(remove.className).toContain(token);
    }
    expect(remove.className).not.toContain("hover:text-destructive");
    await user.click(remove);
    expect(onDelete).toHaveBeenCalledOnce();

    const present = screen.getByRole("button", { name: "Автоправило есть" });
    const absent = screen.getByRole("button", { name: "Автоправила нет" });
    expect(present.className).toContain("hover:bg-muted/60");
    expect(present.className).toContain("hover:text-foreground");
    expect(present.className).not.toContain("hover:bg-violet-500/20");
    expect(absent.className).toContain("hover:bg-muted/60");
    await user.hover(present);
    expect(await screen.findAllByText("Автоправило есть — открыть")).toHaveLength(1);
  });
});
