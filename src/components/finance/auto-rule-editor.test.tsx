/** @vitest-environment happy-dom */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinanceCashflowTab } from "@/components/finance/finance-cashflow-tab";
import { cashflowSeedToEditorState } from "@/components/finance/auto-rule-editor";
import type {
  FinanceArticle,
  FinanceAutoRule,
  FinanceCashFlowRow,
  FinanceCounterparty,
  FinanceDeal,
} from "@/mocks/finance-fixtures";

afterEach(() => cleanup());

const articles: FinanceArticle[] = [
  {
    id: "art-exp",
    name: "Материалы",
    flowType: "EXPENSE",
    categoryName: "Закупки",
    isOverhead: false,
    parentId: null,
  },
  {
    id: "art-inc",
    name: "Продажи",
    flowType: "INCOME",
    categoryName: "Выручка",
    isOverhead: false,
    parentId: null,
  },
];

const counterparties: FinanceCounterparty[] = [{ id: "cp", name: "ООО Проверка" }];

const deals: FinanceDeal[] = [
  {
    id: "deal-1",
    name: "Поставка",
    status: "OPEN",
    total: 1,
    batchNames: [],
    deliveryExtra: 0,
  },
];

const directories = { articles, counterparties, deals };

function row(patch: Partial<FinanceCashFlowRow> & Pick<FinanceCashFlowRow, "id">): FinanceCashFlowRow {
  return {
    date: "2026-10-02",
    amount: 100,
    flowType: "EXPENSE",
    accountName: "Касса",
    counterpartyName: null,
    description: "",
    articleName: null,
    dealName: null,
    dealId: null,
    isAutoAssigned: false,
    source: "MANUAL",
    ...patch,
  };
}

describe("cashflow seed for a new auto rule", () => {
  it("copies conditions and actions that exist in the directories", () => {
    const state = cashflowSeedToEditorState(
      {
        flowType: "EXPENSE",
        counterpartyName: "ООО Проверка",
        description: "  Оплата поставки  ",
        articleName: "Материалы",
        dealName: "Поставка",
      },
      directories,
    );
    expect(state).toMatchObject({
      flowType: "EXPENSE",
      counterpartyName: "ООО Проверка",
      logicOperator: "AND",
      descriptionKeywords: "Оплата поставки",
      articleName: "Материалы",
      dealName: "Поставка",
    });
  });

  it("leaves missing operation fields empty and does not invent directory entries", () => {
    const state = cashflowSeedToEditorState(
      {
        flowType: "INCOME",
        counterpartyName: null,
        description: "   ",
        articleName: "Материалы",
        dealName: "Чужая сделка",
      },
      directories,
    );
    expect(state.counterpartyName).toBeNull();
    expect(state.descriptionKeywords).toBeNull();
    expect(state.articleName).toBeNull();
    expect(state.dealName).toBeNull();
    expect(articles.map((article) => article.name)).not.toContain("Чужая сделка");
  });
});

describe("DDS auto-rule create form", () => {
  function renderTab(
    rows: FinanceCashFlowRow[],
    handlers?: {
      onAutoRuleCreated?: (values: unknown) => void;
      onGoToRule?: (id: string) => void;
      autoRules?: FinanceAutoRule[];
    },
  ) {
    return render(
      <FinanceCashflowTab
        rows={rows}
        articles={articles}
        counterparties={counterparties}
        deals={deals}
        autoRules={handlers?.autoRules ?? []}
        onEdit={() => {}}
        onDelete={() => {}}
        onAutoRuleCreated={handlers?.onAutoRuleCreated}
        onGoToRule={handlers?.onGoToRule}
      />,
    );
  }

  async function openCreate(description: string) {
    const user = userEvent.setup();
    const line = screen.getByText(description).closest("tr");
    await user.click(line!.querySelector('[aria-label="Автоправила нет"]')!);
    return { user, dialog: screen.getByRole("dialog") };
  }

  it("prefills a bank operation and submits article and deal as actions", async () => {
    const onAutoRuleCreated = vi.fn();
    renderTab(
      [
        row({
          id: "bank",
          source: "BANK",
          bankDocument: true,
          flowType: "EXPENSE",
          counterpartyName: "ООО Проверка",
          description: "Оплата поставки",
          articleName: "Материалы",
          dealName: "Поставка",
        }),
      ],
      { onAutoRuleCreated },
    );
    const { user, dialog } = await openCreate("Оплата поставки");
    expect(onAutoRuleCreated).not.toHaveBeenCalled();
    expect(within(dialog).getByLabelText("Тип операции").textContent).toContain("Списание");
    expect(within(dialog).getByLabelText("Контрагент правила").textContent).toContain("ООО Проверка");
    expect(within(dialog).getByRole("button", { name: "и", pressed: true })).toBeTruthy();
    expect((dialog.querySelector("#auto-rule-dialog-keywords") as HTMLInputElement).value).toBe(
      "Оплата поставки",
    );
    expect(within(dialog).getByLabelText("Статья правила").textContent).toContain("Материалы");
    expect(within(dialog).getByLabelText("Сделка правила").textContent).toContain("Поставка");
    expect(dialog.textContent).toContain("то статья");
    expect(dialog.textContent).toContain("то сделка");
    await user.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    expect(onAutoRuleCreated).toHaveBeenCalledWith({
      flowType: "EXPENSE",
      counterpartyName: "ООО Проверка",
      logicOperator: "AND",
      descriptionKeywords: "Оплата поставки",
      articleName: "Материалы",
      dealName: "Поставка",
    });
  });

  it("prefills a manual operation the same way", async () => {
    renderTab([
      row({
        id: "manual",
        source: "MANUAL",
        flowType: "INCOME",
        counterpartyName: "ООО Проверка",
        description: "Оплата от клиента",
        articleName: "Продажи",
        dealName: "Поставка",
      }),
    ]);
    const { dialog } = await openCreate("Оплата от клиента");
    expect(within(dialog).getByLabelText("Тип операции").textContent).toContain("Поступление");
    expect(within(dialog).getByLabelText("Статья правила").textContent).toContain("Продажи");
    expect(within(dialog).getByLabelText("Сделка правила").textContent).toContain("Поставка");
  });

  it("keeps article, deal, counterparty and keywords empty when the operation has none", async () => {
    renderTab([
      row({
        id: "empty",
        accountName: "Пустой счёт",
        description: "",
        counterpartyName: null,
        articleName: null,
        dealName: null,
      }),
    ]);
    const user = userEvent.setup();
    const line = screen.getByText("Пустой счёт").closest("tr");
    await user.click(line!.querySelector('[aria-label="Автоправила нет"]')!);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("Контрагент правила").textContent).toContain("Любой");
    expect((dialog.querySelector("#auto-rule-dialog-keywords") as HTMLInputElement).value).toBe("");
    expect(within(dialog).getByLabelText("Статья правила").textContent).toContain("Выберите");
    expect(within(dialog).getByLabelText("Сделка правила").textContent).toContain("Не выбрана");
  });

  it("shows an unavailable state instead of a missing article or deal", async () => {
    renderTab([
      row({
        id: "gone",
        description: "Без справочника",
        articleName: "Удалённая статья",
        dealName: "Удалённая сделка",
      }),
    ]);
    const { dialog } = await openCreate("Без справочника");
    expect(dialog.textContent).toContain("Статья из операции недоступна в справочнике");
    expect(dialog.textContent).toContain("Сделка из операции недоступна в справочнике");
    expect(within(dialog).getByLabelText("Статья правила").textContent).not.toContain("Удалённая статья");
    expect(within(dialog).getByLabelText("Сделка правила").textContent).not.toContain("Удалённая сделка");
    expect(dialog.textContent).not.toContain("Удалённая статья");
  });

  it("navigates to an existing rule and does not open a second create form", async () => {
    const user = userEvent.setup();
    const onGoToRule = vi.fn();
    const onAutoRuleCreated = vi.fn();
    renderTab(
      [row({ id: "matched", description: "Канцтовары офиса" })],
      {
        onGoToRule,
        onAutoRuleCreated,
        autoRules: [
          {
            id: "rule-1",
            flowType: "EXPENSE",
            counterpartyName: null,
            logicOperator: "AND",
            descriptionKeywords: "Канцтовары",
            articleName: "Материалы",
            dealName: null,
          },
        ],
      },
    );
    await user.click(screen.getByLabelText("Автоправило есть"));
    expect(onGoToRule).toHaveBeenCalledWith("rule-1");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onAutoRuleCreated).not.toHaveBeenCalled();
  });

  it("resets the draft when the dialog opens for another operation", async () => {
    renderTab([
      row({
        id: "first",
        description: "Первая операция",
        counterpartyName: "ООО Проверка",
        articleName: "Материалы",
        dealName: "Поставка",
      }),
      row({
        id: "second",
        description: "Вторая операция",
        flowType: "INCOME",
        articleName: "Продажи",
        dealName: null,
      }),
    ]);
    const first = await openCreate("Первая операция");
    await first.user.click(within(first.dialog).getByRole("button", { name: "Отмена" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    const second = await openCreate("Вторая операция");
    expect((second.dialog.querySelector("#auto-rule-dialog-keywords") as HTMLInputElement).value).toBe(
      "Вторая операция",
    );
    expect(within(second.dialog).getByLabelText("Тип операции").textContent).toContain("Поступление");
    expect(within(second.dialog).getByLabelText("Статья правила").textContent).toContain("Продажи");
    expect(within(second.dialog).getByLabelText("Сделка правила").textContent).toContain("Не выбрана");
    expect(within(second.dialog).getByLabelText("Контрагент правила").textContent).not.toContain("ООО Проверка");
  });

  it("keeps a manual edit until save and drops an incompatible article when the flow type changes", async () => {
    const onAutoRuleCreated = vi.fn();
    renderTab(
      [
        row({
          id: "edit",
          description: "Исходное назначение",
          counterpartyName: "ООО Проверка",
          articleName: "Материалы",
          dealName: "Поставка",
        }),
      ],
      { onAutoRuleCreated },
    );
    const { user, dialog } = await openCreate("Исходное назначение");
    const input = dialog.querySelector("#auto-rule-dialog-keywords") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "Новые слова");
    expect(input.value).toBe("Новые слова");
    await user.click(within(dialog).getByLabelText("Тип операции"));
    await user.click(await screen.findByRole("option", { name: "Поступление" }));
    expect(within(dialog).getByLabelText("Статья правила").textContent).not.toContain("Материалы");
    expect(within(dialog).getByLabelText("Сделка правила").textContent).toContain("Поставка");
    await user.click(within(dialog).getByRole("button", { name: "Сохранить" }));
    expect(onAutoRuleCreated).not.toHaveBeenCalled();
  });
});
