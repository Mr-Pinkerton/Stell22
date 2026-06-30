"use client";

import { cn } from "@/lib/utils";
import type {
  AutoRuleLogic,
  FinanceArticle,
  FinanceAutoRule,
  FinanceCounterparty,
} from "@/mocks/finance-fixtures";
import { fieldClass, formSelectContentProps, selectTriggerClass } from "@/components/nomenclature/form-shared";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const autoRuleLabelClass = "text-muted-foreground shrink-0 text-sm font-medium";

export const autoRuleCompactSelectClass = cn(
  selectTriggerClass,
  "data-[size=default]:h-9 h-9 min-w-[8.5rem] max-w-[11rem] text-sm",
);

export const autoRuleKeywordsInputClass = cn(fieldClass, "h-9 min-w-[9rem] flex-1 text-sm");

export function AutoRuleLogicToggle({
  value,
  onChange,
}: {
  value: AutoRuleLogic;
  onChange: (value: AutoRuleLogic) => void;
}) {
  return (
    <div
      className="bg-muted inline-flex shrink-0 gap-1 rounded-xl p-1"
      role="group"
      aria-label="Связь условий"
    >
      {(
        [
          ["AND", "и"],
          ["OR", "или"],
        ] as const
      ).map(([op, label]) => (
        <button
          key={op}
          type="button"
          onClick={() => onChange(op)}
          className={cn(
            "h-8 cursor-pointer rounded-lg px-3 text-xs font-semibold transition-colors",
            value === op
              ? "bg-card text-foreground shadow-soft"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export type AutoRuleEditorState = Pick<
  FinanceAutoRule,
  "flowType" | "counterpartyName" | "logicOperator" | "descriptionKeywords" | "articleName"
>;

interface AutoRuleEditorProps {
  value: AutoRuleEditorState;
  articles: FinanceArticle[];
  counterparties: FinanceCounterparty[];
  onChange: (patch: Partial<AutoRuleEditorState>) => void;
  className?: string;
  /** Поле ключевых слов — id для связи с label в модалке. */
  keywordsInputId?: string;
}

export function AutoRuleEditor({
  value,
  articles,
  counterparties,
  onChange,
  className,
  keywordsInputId = "auto-rule-keywords",
}: AutoRuleEditorProps) {
  const rowArticles = articles.filter((a) => a.flowType === value.flowType);

  const counterpartyId =
    counterparties.find((c) => c.name === value.counterpartyName)?.id ?? "";
  const articleId = rowArticles.find((a) => a.name === value.articleName)?.id ?? "";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-3 md:gap-x-3",
        className,
      )}
    >
      <span className={autoRuleLabelClass}>Если</span>

      <Select
        value={value.flowType}
        onValueChange={(v) => {
          if (v !== "INCOME" && v !== "EXPENSE") return;
          onChange({ flowType: v, articleName: null });
        }}
      >
        <SelectTrigger className={autoRuleCompactSelectClass}>
          <SelectValue>
            {value.flowType === "INCOME" ? "Поступление" : "Списание"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent {...formSelectContentProps}>
          <SelectItem value="EXPENSE" className="cursor-pointer rounded-lg text-sm">
            Списание
          </SelectItem>
          <SelectItem value="INCOME" className="cursor-pointer rounded-lg text-sm">
            Поступление
          </SelectItem>
        </SelectContent>
      </Select>

      <span className={autoRuleLabelClass}>И</span>

      <Select
        value={counterpartyId}
        onValueChange={(v) => {
          const cp = counterparties.find((c) => c.id === v);
          onChange({ counterpartyName: cp?.name ?? null });
        }}
      >
        <SelectTrigger className={cn(autoRuleCompactSelectClass, "max-w-[13rem]")}>
          <SelectValue placeholder="Контрагент">
            {value.counterpartyName ?? "Любой"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent {...formSelectContentProps}>
          <SelectItem value="" className="cursor-pointer rounded-lg text-sm">
            Любой
          </SelectItem>
          {counterparties.map((c) => (
            <SelectItem key={c.id} value={c.id} className="cursor-pointer rounded-lg text-sm">
              {c.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <AutoRuleLogicToggle
        value={value.logicOperator}
        onChange={(logicOperator) => onChange({ logicOperator })}
      />

      <span className={cn(autoRuleLabelClass, "whitespace-nowrap")}>
        Описание содержит ключевые слова
      </span>

      <Input
        id={keywordsInputId}
        value={value.descriptionKeywords ?? ""}
        onChange={(e) => onChange({ descriptionKeywords: e.target.value || null })}
        className={autoRuleKeywordsInputClass}
        placeholder="Ввести"
      />

      <span className={autoRuleLabelClass}>то статья</span>

      <Select
        value={articleId}
        onValueChange={(v) => {
          const article = rowArticles.find((a) => a.id === v);
          onChange({ articleName: article?.name ?? null });
        }}
      >
        <SelectTrigger className={autoRuleCompactSelectClass}>
          <SelectValue placeholder="Выберите">
            {value.articleName ?? "Выберите"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent {...formSelectContentProps}>
          <SelectItem value="" className="cursor-pointer rounded-lg text-sm">
            Не выбрана
          </SelectItem>
          {rowArticles.map((a) => (
            <SelectItem key={a.id} value={a.id} className="cursor-pointer rounded-lg text-sm">
              {a.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function autoRuleEditorToRule(
  value: AutoRuleEditorState,
  id?: string,
): FinanceAutoRule {
  return {
    id: id ?? `rule-${Date.now()}`,
    flowType: value.flowType,
    counterpartyName: value.counterpartyName,
    logicOperator: value.logicOperator,
    descriptionKeywords: value.descriptionKeywords?.trim() || null,
    articleName: value.articleName,
    dealName: null,
  };
}

export function cashflowSeedToEditorState(
  seed: { flowType: FinanceAutoRule["flowType"]; counterpartyName: string | null },
): AutoRuleEditorState {
  return {
    flowType: seed.flowType,
    counterpartyName: seed.counterpartyName,
    logicOperator: "AND",
    descriptionKeywords: null,
    articleName: null,
  };
}

export function emptyAutoRuleEditorState(): AutoRuleEditorState {
  return {
    flowType: "EXPENSE",
    counterpartyName: null,
    logicOperator: "AND",
    descriptionKeywords: null,
    articleName: null,
  };
}
