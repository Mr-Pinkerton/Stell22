"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useJustOpened } from "@/hooks/use-just-opened";
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
  onSubmit?: (name: string, inn: string) => void;
}

export function CounterpartyFormDialog({
  open,
  counterparty,
  onOpenChange,
  onSubmit,
}: CounterpartyFormDialogProps) {
  const [name, setName] = useState("");
  const [inn, setInn] = useState("");

  if (useJustOpened(open)) {
    setName(counterparty?.name ?? "");
    setInn(counterparty?.inn ?? "");
  }

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit?.(trimmed, inn.trim());
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

      <Field id="cp-inn" label="ИНН">
        <Input
          id="cp-inn"
          value={inn}
          onChange={(e) => setInn(e.target.value.replace(/\D/g, ""))}
          className={cn(fieldClass)}
          placeholder="7700000000"
          inputMode="numeric"
        />
      </Field>
    </FinanceFormDialog>
  );
}
