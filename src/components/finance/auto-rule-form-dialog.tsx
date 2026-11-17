"use client";

import { useState } from "react";
import type {
  FinanceArticle,
  FinanceAutoRule,
  FinanceCashFlowRow,
  FinanceCounterparty,
  FinanceDeal,
} from "@/mocks/finance-fixtures";
import { useJustOpened } from "@/hooks/use-just-opened";
import {
  AutoRuleEditor,
  autoRuleEditorToRule,
  cashflowSeedToEditorState,
  emptyAutoRuleEditorState,
  type AutoRuleEditorState,
} from "@/components/finance/auto-rule-editor";
import { FinanceFormDialog } from "@/components/finance/finance-form-shared";

export interface AutoRuleFormValues {
  flowType: FinanceAutoRule["flowType"];
  counterpartyName: string | null;
  logicOperator: FinanceAutoRule["logicOperator"];
  descriptionKeywords: string | null;
  articleName: string | null;
  dealId: string | null;
  dealName: string | null;
}

interface AutoRuleFormDialogProps {
  open: boolean;
  seed?: FinanceCashFlowRow | null;
  articles: FinanceArticle[];
  counterparties: FinanceCounterparty[];
  deals: FinanceDeal[];
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: AutoRuleFormValues) => void;
}

function trimmed(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

export function AutoRuleFormDialog({
  open,
  seed,
  articles,
  counterparties,
  deals,
  onOpenChange,
  onSubmit,
}: AutoRuleFormDialogProps) {
  const [draft, setDraft] = useState<AutoRuleEditorState>(emptyAutoRuleEditorState);
  const [showErrors, setShowErrors] = useState(false);
  const directories = { articles, counterparties, deals };

  if (useJustOpened(open)) {
    setDraft(seed ? cashflowSeedToEditorState(seed, directories) : emptyAutoRuleEditorState());
    setShowErrors(false);
  }

  const articleName = trimmed(seed?.articleName);
  const articleUnavailable = Boolean(
    articleName &&
      !articles.some((item) => item.name === articleName && item.flowType === seed?.flowType),
  );
  const matchedDeal = seed?.dealId ? deals.find((item) => item.id === seed.dealId) : undefined;
  const dealNotice =
    matchedDeal && matchedDeal.status !== "OPEN"
      ? "Сделка из операции недоступна для нового правила"
      : null;

  const handleSubmit = () => {
    const rule = autoRuleEditorToRule(draft);
    onSubmit?.({
      flowType: rule.flowType,
      counterpartyName: rule.counterpartyName,
      logicOperator: rule.logicOperator,
      descriptionKeywords: rule.descriptionKeywords,
      articleName: rule.articleName,
      dealId: rule.dealId,
      dealName: rule.dealName,
    });
    onOpenChange(false);
  };

  const canSubmit = Boolean(draft.articleName);

  return (
    <FinanceFormDialog
      open={open}
      title="Добавить автоправило"
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      submitLabel="Сохранить"
      canSubmit={canSubmit}
      onInvalid={() => setShowErrors(true)}
      maxWidth="sm:max-w-3xl"
    >
      <p className="text-muted-foreground text-sm leading-relaxed">
        Правило сработает при совпадении условий и назначит статью и сделку. Статья и сделка —
        результат правила, а не условие отбора.
      </p>
      <AutoRuleEditor
        value={draft}
        articles={articles}
        counterparties={counterparties}
        deals={deals}
        onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
        keywordsInputId="auto-rule-dialog-keywords"
        articleInvalid={showErrors && !draft.articleName}
        articleUnavailable={articleUnavailable && !draft.articleName}
        dealNotice={draft.dealId ? null : dealNotice}
      />
    </FinanceFormDialog>
  );
}

export function autoRuleValuesToRow(values: AutoRuleFormValues): FinanceAutoRule {
  return autoRuleEditorToRule(values);
}
