"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useJustOpened } from "@/hooks/use-just-opened";
import {
  financeAccounts,
  financeArticles,
  financeCounterparties,
  financeDeals,
  type FinanceCashFlowRow,
} from "@/mocks/finance-fixtures";
import {
  DateFieldInput,
  Field,
  FinanceFormDialog,
  isoToDisplayDate,
  parseDisplayDate,
  selectTriggerClass,
  formSelectContentProps,
  fieldClass,
  narrowFieldClass,
} from "@/components/finance/finance-form-shared";
import { MoneyInput } from "@/components/ui/money-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";

export interface CashflowFormValues {
  date: string;
  amount: number;
  flowType: "INCOME" | "EXPENSE";
  accountName: string;
  counterpartyName: string | null;
  description: string;
  articleName: string | null;
  dealId: string | null;
  dealName: string | null;
}

interface CashflowFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: CashflowFormValues) => void;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

const amountFieldClass = cn(
  narrowFieldClass,
  "border-tag-blue hover:border-tag-blue focus-visible:border-tag-blue",
);

export function CashflowFormDialog({ open, onOpenChange, onSubmit }: CashflowFormDialogProps) {
  const [dateText, setDateText] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [flowType, setFlowType] = useState<"INCOME" | "EXPENSE">("EXPENSE");
  const [accountId, setAccountId] = useState("");
  const [counterpartyId, setCounterpartyId] = useState("");
  const [description, setDescription] = useState("");
  const [articleId, setArticleId] = useState("");
  const [dealId, setDealId] = useState("");

  if (useJustOpened(open)) {
    setDateText(isoToDisplayDate(todayIso()));
    setAmount(null);
    setFlowType("EXPENSE");
    setAccountId(financeAccounts[0]?.id ?? "");
    setCounterpartyId("");
    setDescription("");
    setArticleId("");
    setDealId("");
  }

  const articles = useMemo(
    () => financeArticles.filter((a) => a.flowType === flowType),
    [flowType],
  );

  const canSubmit =
    parseDisplayDate(dateText) != null &&
    amount != null &&
    amount > 0 &&
    accountId.length > 0 &&
    description.trim().length > 0;

  const handleSubmit = () => {
    const iso = parseDisplayDate(dateText);
    if (!iso || amount == null || amount <= 0) return;

    const account = financeAccounts.find((a) => a.id === accountId);
    const counterparty = financeCounterparties.find((c) => c.id === counterpartyId);
    const article = articles.find((a) => a.id === articleId);
    const deal = financeDeals.find((d) => d.id === dealId);

    onSubmit?.({
      date: iso,
      amount,
      flowType,
      accountName: account?.name ?? "",
      counterpartyName: counterparty?.name ?? null,
      description: description.trim(),
      articleName: article?.name ?? null,
      dealId: deal?.id ?? null,
      dealName: deal?.name ?? null,
    });
    onOpenChange(false);
  };

  return (
    <FinanceFormDialog
      open={open}
      title="Добавить операцию"
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      submitLabel="Добавить"
      submitDisabled={!canSubmit}
      maxWidth="sm:max-w-lg"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cf-date" label="Дата" required>
          <DateFieldInput id="cf-date" value={dateText} onChange={setDateText} />
        </Field>

        <Field id="cf-type" label="Тип" required>
          <Select
            value={flowType}
            onValueChange={(v) => {
              if (v === "INCOME" || v === "EXPENSE") {
                setFlowType(v);
                setArticleId("");
              }
            }}
          >
            <SelectTrigger className={selectTriggerClass}>
              <SelectValue>
                {flowType === "INCOME" ? "Поступление" : "Списание"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent {...formSelectContentProps}>
              <SelectItem value="EXPENSE" className="cursor-pointer rounded-lg">
                Списание
              </SelectItem>
              <SelectItem value="INCOME" className="cursor-pointer rounded-lg">
                Поступление
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cf-amount" label="Сумма" required>
          <MoneyInput
            id="cf-amount"
            value={amount}
            onValueChange={setAmount}
            className={amountFieldClass}
          />
        </Field>

        <Field id="cf-account" label="Счёт" required>
          <Select value={accountId} onValueChange={(v) => setAccountId(v ?? "")}>
            <SelectTrigger className={selectTriggerClass}>
              <SelectValue placeholder="Выберите счёт">
                {financeAccounts.find((a) => a.id === accountId)?.name}
              </SelectValue>
            </SelectTrigger>
            <SelectContent {...formSelectContentProps}>
              {financeAccounts.map((a) => (
                <SelectItem key={a.id} value={a.id} className="cursor-pointer rounded-lg">
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="cf-counterparty" label="Контрагент">
          <Select value={counterpartyId} onValueChange={(v) => setCounterpartyId(v ?? "")}>
            <SelectTrigger className={selectTriggerClass}>
              <SelectValue placeholder="Не указан">
                {counterpartyId
                  ? financeCounterparties.find((c) => c.id === counterpartyId)?.name
                  : "Не указан"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent {...formSelectContentProps}>
              <SelectItem value="" className="cursor-pointer rounded-lg">
                Не указан
              </SelectItem>
              {financeCounterparties.map((c) => (
                <SelectItem key={c.id} value={c.id} className="cursor-pointer rounded-lg">
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field id="cf-article" label="Статья">
          <Select value={articleId} onValueChange={(v) => setArticleId(v ?? "")}>
            <SelectTrigger className={selectTriggerClass}>
              <SelectValue placeholder="Не разнесено">
                {articleId
                  ? articles.find((a) => a.id === articleId)?.name
                  : "Не разнесено"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent {...formSelectContentProps}>
              <SelectItem value="" className="cursor-pointer rounded-lg">
                Не разнесено
              </SelectItem>
              {articles.map((a) => (
                <SelectItem key={a.id} value={a.id} className="cursor-pointer rounded-lg">
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field id="cf-description" label="Назначение" required>
        <Input
          id="cf-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={cn(fieldClass)}
          placeholder="Назначение платежа"
        />
      </Field>

      <Field id="cf-deal" label="Сделка">
        <Select value={dealId} onValueChange={(v) => setDealId(v ?? "")}>
          <SelectTrigger className={selectTriggerClass}>
            <SelectValue placeholder="Без сделки">
              {dealId
                ? financeDeals.find((d) => d.id === dealId)?.name
                : "Без сделки"}
            </SelectValue>
          </SelectTrigger>
          <SelectContent {...formSelectContentProps}>
            <SelectItem value="" className="cursor-pointer rounded-lg">
              Без сделки
            </SelectItem>
            {financeDeals
              .filter((d) => d.status === "OPEN")
              .map((d) => (
                <SelectItem key={d.id} value={d.id} className="cursor-pointer rounded-lg">
                  {d.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      </Field>
    </FinanceFormDialog>
  );
}

export function cashflowValuesToRow(values: CashflowFormValues): FinanceCashFlowRow {
  return {
    id: `cf-${Date.now()}`,
    date: values.date,
    amount: values.amount,
    flowType: values.flowType,
    accountName: values.accountName,
    counterpartyName: values.counterpartyName,
    description: values.description,
    articleName: values.articleName,
    dealName: values.dealName,
    dealId: values.dealId,
    isAutoAssigned: values.articleName != null,
  };
}
