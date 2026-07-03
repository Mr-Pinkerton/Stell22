"use client";

import { cn } from "@/lib/utils";
import type {
  FinanceArticle,
  FinanceCashFlowRow,
  FinanceCounterparty,
  FinanceDeal,
} from "@/mocks/finance-fixtures";
import { formSelectContentProps } from "@/components/nomenclature/form-shared";
import { scrollThinY } from "@/lib/scroll-classes";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const inlineSelectTriggerClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring data-[size=default]:h-8 mx-auto h-8 w-full max-w-[12rem] cursor-pointer rounded-lg border px-2 text-xs font-normal";

/** В ячейке ДДС колонка шире триггера — показываем имя целиком. */
const inlineCounterpartyTriggerClass = cn(inlineSelectTriggerClass, "max-w-full");

/** Список контрагентов: шире ячейки, выше — длинные названия и длинный справочник. */
const counterpartySelectContentProps = {
  ...formSelectContentProps,
  className: cn(
    formSelectContentProps.className,
    scrollThinY,
    "!w-auto min-w-[20rem] max-w-[min(32rem,92vw)] max-h-[min(24rem,var(--available-height))]",
  ),
};

const counterpartySelectItemClass =
  "cursor-pointer rounded-lg text-xs [&_span]:whitespace-normal [&_span]:break-words";

const inlineSelectTriggerAmberClass = cn(
  inlineSelectTriggerClass,
  "text-amber-700 data-placeholder:text-amber-700",
);

/** Патч разнесения по id (резолв на сервере). */
export interface CashflowAssignPatch {
  counterpartyId?: string | null;
  articleId?: string | null;
  dealId?: string | null;
}

export function CashflowCounterpartySelect({
  row,
  counterparties,
  onAssign,
}: {
  row: FinanceCashFlowRow;
  counterparties: FinanceCounterparty[];
  onAssign: (patch: CashflowAssignPatch) => void;
}) {
  const counterpartyId = counterparties.find((c) => c.name === row.counterpartyName)?.id ?? "";

  return (
    <Select
      value={counterpartyId}
      onValueChange={(v) => onAssign({ counterpartyId: v || null })}
    >
      <SelectTrigger className={inlineCounterpartyTriggerClass}>
        <SelectValue placeholder="—">{row.counterpartyName ?? "—"}</SelectValue>
      </SelectTrigger>
      <SelectContent {...counterpartySelectContentProps}>
        <SelectItem value="" className={counterpartySelectItemClass}>
          —
        </SelectItem>
        {counterparties.map((c) => (
          <SelectItem key={c.id} value={c.id} className={counterpartySelectItemClass}>
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function CashflowArticleSelect({
  row,
  articles,
  onAssign,
}: {
  row: FinanceCashFlowRow;
  articles: FinanceArticle[];
  onAssign: (patch: CashflowAssignPatch) => void;
}) {
  const rowArticles = articles.filter((a) => a.flowType === row.flowType);
  const articleId = rowArticles.find((a) => a.name === row.articleName)?.id ?? "";

  return (
    <Select
      value={articleId}
      onValueChange={(v) => onAssign({ articleId: v || null })}
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

export function CashflowDealSelect({
  row,
  deals,
  onAssign,
}: {
  row: FinanceCashFlowRow;
  deals: FinanceDeal[];
  onAssign: (patch: CashflowAssignPatch) => void;
}) {
  const dealId = row.dealId ?? deals.find((d) => d.name === row.dealName)?.id ?? "";

  return (
    <Select value={dealId} onValueChange={(v) => onAssign({ dealId: v || null })}>
      <SelectTrigger className={inlineSelectTriggerClass}>
        <SelectValue placeholder="—">{row.dealName ?? "—"}</SelectValue>
      </SelectTrigger>
      <SelectContent {...formSelectContentProps}>
        <SelectItem value="" className="cursor-pointer rounded-lg text-xs">
          —
        </SelectItem>
        {deals
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
