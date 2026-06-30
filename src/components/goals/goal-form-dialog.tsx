"use client";

import { useMemo, useState } from "react";
import type { GoalProductOption } from "@/server/goals";
import { useJustOpened } from "@/hooks/use-just-opened";
import {
  FormDialog,
} from "@/components/form-dialog-shared";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Field,
  fieldClass,
  formSelectContentProps,
  selectTriggerClass,
} from "@/components/nomenclature/form-shared";

export interface GoalFormValues {
  name: string;
  productId: string;
  quantity: number;
}

interface GoalFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: GoalFormValues) => void;
  products: GoalProductOption[];
  submitDisabled?: boolean;
}

export function GoalFormDialog({
  open,
  onOpenChange,
  onSubmit,
  products: activeProducts,
  submitDisabled,
}: GoalFormDialogProps) {
  const [name, setName] = useState("");
  const [productId, setProductId] = useState(activeProducts[0]?.id ?? "");
  const [quantityRaw, setQuantityRaw] = useState("");

  if (useJustOpened(open)) {
    setName("");
    setProductId(activeProducts[0]?.id ?? "");
    setQuantityRaw("");
  }

  const quantity = Number(quantityRaw);
  const canSubmit =
    name.trim().length > 0 && productId.length > 0 && Number.isFinite(quantity) && quantity > 0;

  const monthNote = useMemo(() => {
    const now = new Date();
    const months = [
      "января",
      "февраля",
      "марта",
      "апреля",
      "мая",
      "июня",
      "июля",
      "августа",
      "сентября",
      "октября",
      "ноября",
      "декабря",
    ];
    return `Цель будет выставлена на ${months[now.getMonth()]} ${now.getFullYear()} г.`;
  }, []);

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({ name: name.trim(), productId, quantity });
    onOpenChange(false);
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Создать цель"
      submitLabel="Добавить цель"
      submitDisabled={!canSubmit || submitDisabled}
      onSubmit={handleSubmit}
    >
      <Field id="goal-name" label="Название цели" required>
          <Input
            id="goal-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={fieldClass}
            placeholder="Напр. Июнь — полки"
          />
        </Field>

        <Field id="goal-product" label="Изделие" required>
          <Select
            value={productId}
            onValueChange={(v) => {
              if (v) setProductId(v);
            }}
          >
            <SelectTrigger id="goal-product" className={selectTriggerClass}>
              <SelectValue placeholder="Выберите изделие" />
            </SelectTrigger>
            <SelectContent {...formSelectContentProps}>
              {activeProducts.map((p) => (
                <SelectItem key={p.id} value={p.id} className="cursor-pointer rounded-lg">
                  {p.name} ({p.sku})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field id="goal-qty" label="Кол-во" required>
          <Input
            id="goal-qty"
            type="number"
            min={1}
            value={quantityRaw}
            onChange={(e) => setQuantityRaw(e.target.value)}
            className={fieldClass}
            placeholder="шт"
          />
        </Field>

      <p className="text-muted-foreground text-sm">{monthNote}</p>
    </FormDialog>
  );
}
