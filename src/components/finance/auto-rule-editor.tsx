"use client";

import { cn } from "@/lib/utils";
import type {
  AutoRuleLogic,
  FinanceArticle,
  FinanceAutoRule,
  FinanceCounterparty,
  FinanceDeal,
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
          aria-pressed={value === op}
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
  | "flowType"
  | "counterpartyName"
  | "logicOperator"
  | "descriptionKeywords"
  | "articleName"
  | "dealId"
  | "dealName"
>;

interface AutoRuleEditorProps {
  value: AutoRuleEditorState;
  articles: FinanceArticle[];
  counterparties: FinanceCounterparty[];
  /** Справочник сделок для результата правила. Без него поле сделки не показывается. */
  deals?: FinanceDeal[];
  onChange: (patch: Partial<AutoRuleEditorState>) => void;
  className?: string;
  /** Поле ключевых слов — id для связи с label в модалке. */
  keywordsInputId?: string;
  /** Подсветить обязательное поле «статья» оранжевым. */
  articleInvalid?: boolean;
  /** В операции была статья, которой нет в справочнике этого типа. */
  articleUnavailable?: boolean;
  /** Почему сделку операции нельзя назначить новому правилу. */
  dealNotice?: string | null;
}

export function AutoRuleEditor({
  value,
  articles,
  counterparties,
  deals,
  onChange,
  className,
  keywordsInputId = "auto-rule-keywords",
  articleInvalid,
  articleUnavailable,
  dealNotice,
}: AutoRuleEditorProps) {
  const rowArticles = articles.filter((a) => a.flowType === value.flowType);

  const counterpartyId =
    counterparties.find((c) => c.name === value.counterpartyName)?.id ?? "";
  const articleId = rowArticles.find((a) => a.name === value.articleName)?.id ?? "";
  const openDeals = deals?.filter((deal) => deal.status === "OPEN") ?? [];
  const assignedDeal = deals?.find((deal) => deal.id === value.dealId) ?? null;
  const assignedClosedDeal = assignedDeal && assignedDeal.status !== "OPEN" ? assignedDeal : null;
  const dealLabel = assignedDeal?.name ?? (value.dealId ? value.dealName : null);

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
        <SelectTrigger aria-label="Тип операции" className={autoRuleCompactSelectClass}>
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
        <SelectTrigger
          aria-label="Контрагент правила"
          className={cn(autoRuleCompactSelectClass, "max-w-[13rem]")}
        >
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
        <SelectTrigger
          aria-label="Статья правила"
          className={cn(
            autoRuleCompactSelectClass,
            articleInvalid && "border-amber-400 bg-amber-50",
          )}
        >
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

      {articleUnavailable ? (
        <p className="text-muted-foreground basis-full text-xs">
          Статья из операции недоступна в справочнике
        </p>
      ) : null}

      {deals ? (
        <>
          <span className={autoRuleLabelClass}>то сделка</span>
          <Select
            value={value.dealId ?? ""}
            onValueChange={(v) => {
              if (assignedClosedDeal && v === assignedClosedDeal.id) return;
              if (!v) {
                onChange({ dealId: null, dealName: null });
                return;
              }
              const deal = openDeals.find((item) => item.id === v);
              if (!deal) return;
              onChange({ dealId: deal.id, dealName: deal.name });
            }}
          >
            <SelectTrigger
              aria-label="Сделка правила"
              data-deal-id={value.dealId ?? ""}
              className={autoRuleCompactSelectClass}
            >
              <SelectValue placeholder="Не выбрана">{dealLabel ?? "Не выбрана"}</SelectValue>
            </SelectTrigger>
            <SelectContent {...formSelectContentProps}>
              <SelectItem value="" className="cursor-pointer rounded-lg text-sm">
                Не выбрана
              </SelectItem>
              {assignedClosedDeal ? (
                <SelectItem
                  value={assignedClosedDeal.id}
                  disabled
                  className="cursor-pointer rounded-lg text-sm"
                >
                  {assignedClosedDeal.name}
                </SelectItem>
              ) : null}
              {openDeals.map((deal) => (
                <SelectItem
                  key={deal.id}
                  value={deal.id}
                  className="cursor-pointer rounded-lg text-sm"
                >
                  {deal.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {dealNotice ? (
            <p className="text-muted-foreground basis-full text-xs">{dealNotice}</p>
          ) : null}
        </>
      ) : null}
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
    dealId: value.dealId,
    dealName: value.dealName,
  };
}

export function cashflowSeedToEditorState(
  seed: {
    flowType: FinanceAutoRule["flowType"];
    counterpartyName: string | null;
    description?: string | null;
    articleName?: string | null;
    dealId?: string | null;
    dealName?: string | null;
  },
  directories: {
    articles: Pick<FinanceArticle, "name" | "flowType">[];
    counterparties: Pick<FinanceCounterparty, "name">[];
    deals: Pick<FinanceDeal, "id" | "name" | "status">[];
  },
): AutoRuleEditorState {
  const counterpartyName = seed.counterpartyName?.trim() || null;
  const articleName = seed.articleName?.trim() || null;
  const deal = seed.dealId
    ? directories.deals.find((item) => item.id === seed.dealId)
    : undefined;
  const openDeal = deal?.status === "OPEN" ? deal : null;
  return {
    flowType: seed.flowType,
    counterpartyName:
      counterpartyName &&
      directories.counterparties.some((item) => item.name === counterpartyName)
        ? counterpartyName
        : null,
    logicOperator: "AND",
    descriptionKeywords: seed.description?.trim() || null,
    articleName:
      articleName &&
      directories.articles.some(
        (item) => item.name === articleName && item.flowType === seed.flowType,
      )
        ? articleName
        : null,
    dealId: openDeal?.id ?? null,
    dealName: openDeal?.name ?? null,
  };
}

export function emptyAutoRuleEditorState(): AutoRuleEditorState {
  return {
    flowType: "EXPENSE",
    counterpartyName: null,
    logicOperator: "AND",
    descriptionKeywords: null,
    articleName: null,
    dealId: null,
    dealName: null,
  };
}
