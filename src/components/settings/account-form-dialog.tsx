"use client";

import { useState } from "react";
import { FormDialog } from "@/components/form-dialog-shared";
import { useJustOpened } from "@/hooks/use-just-opened";
import {
  DateFieldInput,
  Field,
  fieldClass,
  isoToDisplayDate,
  narrowFieldClass,
  parseDisplayDate,
} from "@/components/finance/finance-form-shared";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import type { AccountFormValues } from "@/server/finance";
import type { FinanceAccount } from "@/mocks/finance-fixtures";

function todayDisplay(): string {
  return isoToDisplayDate(new Date().toISOString().slice(0, 10));
}

interface AccountFormDialogProps {
  open: boolean;
  account?: FinanceAccount | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: AccountFormValues) => void;
}

export function AccountFormDialog({
  open,
  account,
  onOpenChange,
  onSubmit,
}: AccountFormDialogProps) {
  const [name, setName] = useState("");
  const [openingBalance, setOpeningBalance] = useState(0);
  const [openingDate, setOpeningDate] = useState("");

  if (useJustOpened(open)) {
    setName(account?.name ?? "");
    setOpeningBalance(account?.openingBalance ?? account?.balance ?? 0);
    setOpeningDate(isoToDisplayDate(account?.openingDate) || todayDisplay());
  }

  const isoDate = parseDisplayDate(openingDate);
  const canSubmit = name.trim().length > 0 && Boolean(isoDate);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={account ? "Редактировать счёт" : "Добавить счёт"}
      submitLabel={account ? "Сохранить" : "Добавить"}
      submitDisabled={!canSubmit}
      onSubmit={() => {
        if (!canSubmit || !isoDate) return;
        onSubmit({ name: name.trim(), openingBalance, openingDate: isoDate });
        onOpenChange(false);
      }}
    >
      <Field id="acc-name" label="Название" required>
        <Input
          id="acc-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={fieldClass}
          placeholder="Расчётный (Тинькофф)"
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="acc-opening" label="Остаток на дату, ₽" required>
          <MoneyInput
            id="acc-opening"
            value={openingBalance}
            onValueChange={(v) => setOpeningBalance(v ?? 0)}
            className={narrowFieldClass}
            placeholder="0"
          />
        </Field>

        <Field id="acc-date" label="На дату" required>
          <DateFieldInput id="acc-date" value={openingDate} onChange={setOpeningDate} />
        </Field>
      </div>

      <p className="text-muted-foreground text-xs">
        Начальный остаток фиксируется на указанную дату. Дальше он изменяется
        операциями ДДС; при импорте выписки остаток берётся из «конечного остатка».
      </p>
    </FormDialog>
  );
}
