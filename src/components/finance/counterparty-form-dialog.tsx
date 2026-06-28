"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { FinanceCounterparty } from "@/mocks/finance-fixtures";
import {
  Field,
  FinanceFormDialog,
  fieldClass,
} from "@/components/finance/finance-form-shared";
import { Input } from "@/components/ui/input";

interface CounterpartyFormDialogProps {
  open: boolean;
  counterparty?: FinanceCounterparty | null;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (name: string) => void;
}

export function CounterpartyFormDialog({
  open,
  counterparty,
  onOpenChange,
  onSubmit,
}: CounterpartyFormDialogProps) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (open) setName(counterparty?.name ?? "");
  }, [open, counterparty]);

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit?.(trimmed);
    onOpenChange(false);
  };

  return (
    <FinanceFormDialog
      open={open}
      title={counterparty ? "Редактировать контрагента" : "Добавить контрагента"}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      submitLabel={counterparty ? "Сохранить" : "Добавить"}
      submitDisabled={!name.trim()}
      maxWidth="sm:max-w-md"
    >
      <Field id="cp-name" label="Название" required>
        <Input
          id="cp-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(fieldClass)}
          placeholder="ООО «Пример»"
        />
      </Field>
    </FinanceFormDialog>
  );
}
