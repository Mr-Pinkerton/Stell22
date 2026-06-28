"use client";

import { cn } from "@/lib/utils";
import {
  financeCounterparties,
  financeDeals,
  type FinanceArticle,
  type FinanceCashFlowRow,
} from "@/mocks/finance-fixtures";
import { formSelectContentProps } from "@/components/nomenclature/form-shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const inlineSelectTriggerClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring data-[size=default]:h-8 mx-auto h-8 w-full max-w-[12rem] cursor-pointer rounded-lg border px-2 text-xs font-normal";

const inlineSelectTriggerAmberClass = cn(
  inlineSelectTriggerClass,
  "text-amber-700 data-placeholder:text-amber-700",
);

interface CashflowInlineAssignProps {
  row: FinanceCashFlowRow;
  articles: FinanceArticle[];
  onAssign: (patch: Partial<FinanceCashFlowRow>) => void;
}

export function CashflowCounterpartySelect({
  row,
  onAssign,
}: Omit<CashflowInlineAssignProps, "articles">) {
  const counterpartyId =
    financeCounterparties.find((c) => c.name === row.counterpartyName)?.id ?? "";

  return (
    <Select
      value={counterpartyId}
      onValueChange={(v) => {
        const cp = financeCounterparties.find((c) => c.id === v);
        onAssign({ counterpartyName: cp?.name ?? null });
      }}
    >
      <SelectTrigger className={inlineSelectTriggerClass}>
        <SelectValue placeholder="—">{row.counterpartyName ?? "—"}</SelectValue>
      </SelectTrigger>
      <SelectContent {...formSelectContentProps}>
        <SelectItem value="" className="cursor-pointer rounded-lg text-xs">
          —
        </SelectItem>
        {financeCounterparties.map((c) => (
          <SelectItem key={c.id} value={c.id} className="cursor-pointer rounded-lg text-xs">
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CashflowArticleSelect({ row, articles, onAssign }: CashflowInlineAssignProps) {
  const rowArticles = articles.filter((a) => a.flowType === row.flowType);
  const articleId = rowArticles.find((a) => a.name === row.articleName)?.id ?? "";

  return (
    <Select
      value={articleId}
      onValueChange={(v) => {
        const article = rowArticles.find((a) => a.id === v);
        onAssign({
          articleName: article?.name ?? null,
          isAutoAssigned: Boolean(article),
        });
      }}
    >
      <SelectTrigger
        className={row.articleName ? inlineSelectTriggerClass : inlineSelectTriggerAmberClass}
      >
        <SelectValue placeholder="Не разнесено">
          {row.articleName ?? "Не разнесено"}
        </SelectValue>
      </SelectTrigger>
      <SelectContent {...formSelectContentProps}>
        <SelectItem value="" className="cursor-pointer rounded-lg text-xs text-amber-700">
          Не разнесено
        </SelectItem>
        {rowArticles.map((a) => (
          <SelectItem key={a.id} value={a.id} className="cursor-pointer rounded-lg text-xs">
            {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CashflowDealSelect({ row, onAssign }: Omit<CashflowInlineAssignProps, "articles">) {
  const dealId = row.dealId ?? financeDeals.find((d) => d.name === row.dealName)?.id ?? "";

  return (
    <Select
      value={dealId}
      onValueChange={(v) => {
        const deal = financeDeals.find((d) => d.id === v);
        onAssign({
          dealId: deal?.id ?? null,
          dealName: deal?.name ?? null,
        });
      }}
    >
      <SelectTrigger className={inlineSelectTriggerClass}>
        <SelectValue placeholder="—">{row.dealName ?? "—"}</SelectValue>
      </SelectTrigger>
      <SelectContent {...formSelectContentProps}>
        <SelectItem value="" className="cursor-pointer rounded-lg text-xs">
          —
        </SelectItem>
        {financeDeals
          .filter((d) => d.status === "OPEN")
          .map((d) => (
            <SelectItem key={d.id} value={d.id} className="cursor-pointer rounded-lg text-xs">
              {d.name}
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}
