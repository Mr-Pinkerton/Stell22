"use client";

import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useJustOpened } from "@/hooks/use-just-opened";
import type { FinanceAccount } from "@/mocks/finance-fixtures";
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

export interface TransferFormValues {
  date: string;
  amount: number;
  fromAccountId: string;
  toAccountId: string;
  description: string;
}

interface TransferFormDialogProps {
  open: boolean;
  accounts: FinanceAccount[];
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: TransferFormValues) => void;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

const amountFieldClass = cn(
  narrowFieldClass,
  "border-tag-blue hover:border-tag-blue focus-visible:border-tag-blue",
);

function AccountSelect({
  value,
  onChange,
  accounts,
  disabledId,
  placeholder,
}: {
  value: string;
  onChange: (id: string) => void;
  accounts: FinanceAccount[];
  disabledId?: string;
  placeholder: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v ?? "")}>
      <SelectTrigger className={selectTriggerClass}>
        <SelectValue placeholder={placeholder}>
          {accounts.find((a) => a.id === value)?.name}
        </SelectValue>
      </SelectTrigger>
      <SelectContent {...formSelectContentProps}>
        {accounts.map((a) => (
          <SelectItem
            key={a.id}
            value={a.id}
            disabled={a.id === disabledId}
            className="cursor-pointer rounded-lg"
          >
            {a.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function TransferFormDialog({
  open,
  accounts,
  onOpenChange,
  onSubmit,
}: TransferFormDialogProps) {
  const [dateText, setDateText] = useState("");
  const [amount, setAmount] = useState<number | null>(null);
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [description, setDescription] = useState("");

  if (useJustOpened(open)) {
    setDateText(isoToDisplayDate(todayIso()));
    setAmount(null);
    setFromId(accounts[0]?.id ?? "");
    setToId(accounts[1]?.id ?? "");
    setDescription("");
  }

  const canSubmit =
    parseDisplayDate(dateText) != null &&
    amount != null &&
    amount > 0 &&
    fromId.length > 0 &&
    toId.length > 0 &&
    fromId !== toId;

  const handleSubmit = () => {
    const iso = parseDisplayDate(dateText);
    if (!iso || amount == null || amount <= 0 || fromId === toId) return;

    onSubmit?.({
      date: iso,
      amount,
      fromAccountId: fromId,
      toAccountId: toId,
      description: description.trim(),
    });
    onOpenChange(false);
  };

  return (
    <FinanceFormDialog
      open={open}
      title="Перевод между счетами"
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      submitLabel="Перевести"
      submitDisabled={!canSubmit}
      maxWidth="sm:max-w-lg"
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="tr-date" label="Дата" required>
          <DateFieldInput id="tr-date" value={dateText} onChange={setDateText} />
        </Field>

        <Field id="tr-amount" label="Сумма" required>
          <MoneyInput
            id="tr-amount"
            value={amount}
            onValueChange={setAmount}
            className={amountFieldClass}
          />
        </Field>
      </div>

      <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
        <Field id="tr-from" label="Со счёта" required>
          <AccountSelect
            value={fromId}
            onChange={setFromId}
            accounts={accounts}
            disabledId={toId}
            placeholder="Счёт списания"
          />
        </Field>

        <div className="text-muted-foreground hidden pb-2.5 sm:block">
          <ArrowRight className="size-5" />
        </div>

        <Field id="tr-to" label="На счёт" required>
          <AccountSelect
            value={toId}
            onChange={setToId}
            accounts={accounts}
            disabledId={fromId}
            placeholder="Счёт зачисления"
          />
        </Field>
      </div>

      <Field id="tr-description" label="Назначение">
        <Input
          id="tr-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={cn(fieldClass)}
          placeholder="Например: пополнение расчётного счёта"
        />
      </Field>
    </FinanceFormDialog>
  );
}
