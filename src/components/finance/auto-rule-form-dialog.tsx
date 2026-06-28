"use client";

import { useState } from "react";
import {
  financeArticles,
  type FinanceAutoRule,
  type FinanceCashFlowRow,
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
  dealName: string | null;
}

interface AutoRuleFormDialogProps {
  open: boolean;
  seed?: FinanceCashFlowRow | null;
  articles?: typeof financeArticles;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: AutoRuleFormValues) => void;
}

export function AutoRuleFormDialog({
  open,
  seed,
  articles = financeArticles,
  onOpenChange,
  onSubmit,
}: AutoRuleFormDialogProps) {
  const [draft, setDraft] = useState<AutoRuleEditorState>(emptyAutoRuleEditorState);

  if (useJustOpened(open)) {
    setDraft(seed ? cashflowSeedToEditorState(seed) : emptyAutoRuleEditorState());
  }

  const handleSubmit = () => {
    const rule = autoRuleEditorToRule(draft);
    onSubmit?.({
      flowType: rule.flowType,
      counterpartyName: rule.counterpartyName,
      logicOperator: rule.logicOperator,
      descriptionKeywords: rule.descriptionKeywords,
      articleName: rule.articleName,
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
      submitDisabled={!canSubmit}
      maxWidth="sm:max-w-3xl"
    >
      <p className="text-muted-foreground text-sm leading-relaxed">
        Правило сработает при совпадении условий и назначит статью операции.
      </p>
      <AutoRuleEditor
        value={draft}
        articles={articles}
        onChange={(patch) => setDraft((prev) => ({ ...prev, ...patch }))}
        keywordsInputId="auto-rule-dialog-keywords"
      />
    </FinanceFormDialog>
  );
}

export function autoRuleValuesToRow(values: AutoRuleFormValues): FinanceAutoRule {
  return autoRuleEditorToRule(values);
}
