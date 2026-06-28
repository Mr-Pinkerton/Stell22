"use client";

import { useEffect, useState } from "react";
import { FormDialog } from "@/components/form-dialog-shared";
import { Field, fieldClass } from "@/components/nomenclature/form-shared";
import { Input } from "@/components/ui/input";
import { MoneyInput } from "@/components/ui/money-input";
import type { FinanceAccount } from "@/mocks/finance-fixtures";

export interface AccountFormValues {
  name: string;
  balance: number;
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
  const [balance, setBalance] = useState(0);

  useEffect(() => {
    if (!open) return;
    setName(account?.name ?? "");
    setBalance(account?.balance ?? 0);
  }, [open, account]);

  const canSubmit = name.trim().length > 0;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={account ? "Редактировать счёт" : "Добавить счёт"}
      submitLabel={account ? "Сохранить" : "Добавить"}
      submitDisabled={!canSubmit}
      onSubmit={() => {
        if (!canSubmit) return;
        onSubmit({ name: name.trim(), balance });
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

      <Field id="acc-balance" label="Текущий остаток, ₽">
        <MoneyInput
          id="acc-balance"
          value={balance}
          onValueChange={(v) => setBalance(v ?? 0)}
          className={fieldClass}
          placeholder="0"
        />
      </Field>
    </FormDialog>
  );
}
