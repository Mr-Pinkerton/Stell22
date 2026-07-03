"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { useJustOpened } from "@/hooks/use-just-opened";
import type { FinanceCategory } from "@/mocks/finance-fixtures";
import { Field, FinanceFormDialog, fieldClass } from "@/components/finance/finance-form-shared";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";

export interface CategoryFormValues {
  name: string;
  isOverhead: boolean;
}

interface CategoryFormDialogProps {
  open: boolean;
  category?: FinanceCategory | null;
  onOpenChange: (open: boolean) => void;
  onSubmit?: (values: CategoryFormValues) => void;
}

export function CategoryFormDialog({
  open,
  category,
  onOpenChange,
  onSubmit,
}: CategoryFormDialogProps) {
  const [name, setName] = useState("");
  const [isOverhead, setIsOverhead] = useState(false);

  if (useJustOpened(open)) {
    setName(category?.name ?? "");
    setIsOverhead(category?.isOverhead ?? false);
  }

  const handleSubmit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit?.({ name: trimmed, isOverhead });
    onOpenChange(false);
  };

  return (
    <FinanceFormDialog
      open={open}
      title={category ? "Редактировать категорию" : "Добавить категорию"}
      onOpenChange={onOpenChange}
      onSubmit={handleSubmit}
      submitLabel={category ? "Сохранить" : "Добавить"}
      submitDisabled={!name.trim()}
      maxWidth="sm:max-w-md"
    >
      <Field id="cat-name" label="Название" required>
        <Input
          id="cat-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(fieldClass)}
          placeholder="Материалы"
        />
      </Field>

      <label
        htmlFor="cat-overhead"
        className="border-border flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3"
      >
        <Checkbox
          id="cat-overhead"
          checked={isOverhead}
          onCheckedChange={(v) => setIsOverhead(v === true)}
          className="mt-0.5"
        />
        <span className="space-y-0.5">
          <span className="block text-sm font-medium">Производственные (накладные)</span>
          <span className="text-muted-foreground block text-xs leading-relaxed">
            Статьи такой категории участвуют в распределении накладных расходов
            по себестоимости.
          </span>
        </span>
      </label>
    </FinanceFormDialog>
  );
}
