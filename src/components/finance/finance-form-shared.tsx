"use client";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  fieldClass,
  narrowFieldClass,
  selectTriggerClass,
  formSelectContentProps,
  Field,
  FormSection,
} from "@/components/nomenclature/form-shared";

export {
  fieldClass,
  narrowFieldClass,
  selectTriggerClass,
  formSelectContentProps,
  Field,
  FormSection,
};

export { FormDialog, FormDialog as FinanceFormDialog } from "@/components/form-dialog-shared";

export function isoToDisplayDate(iso?: string | null): string {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return "";
  return `${d.padStart(2, "0")}.${m.padStart(2, "0")}.${y}`;
}

/** DD.MM.YYYY по мере ввода цифр. */
export function formatDisplayDateInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
  return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4)}`;
}

export function parseDisplayDate(value: string): string | null {
  const match = value.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  return `${y}-${m}-${d}`;
}

export function DateFieldInput({
  id,
  value,
  onChange,
  placeholder = "ДД.ММ.ГГГГ",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <Input
      id={id}
      value={value}
      onChange={(e) => onChange(formatDisplayDateInput(e.target.value))}
      className={cn(fieldClass, "tabular-nums")}
      placeholder={placeholder}
      inputMode="numeric"
      maxLength={10}
    />
  );
}
