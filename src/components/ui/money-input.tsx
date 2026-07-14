"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { formatGroupedDecimal, formatGroupedInteger, parseGroupedMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

function suffixPadding(suffix: string): string {
  if (suffix.length <= 2) return "pr-8";
  if (suffix.length <= 5) return "pr-12";
  if (suffix.length <= 9) return "pr-16";
  return "pr-20";
}

function formatMoneyFieldValue(value: number | null | undefined, decimals: number): string {
  if (value == null || value === 0) return "";
  return decimals > 0 ? formatGroupedDecimal(value, decimals) : formatGroupedInteger(value);
}

type MoneyInputProps = Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange" | "defaultValue" | "type" | "inputMode"
> & {
  defaultValue?: number | null;
  value?: number | null;
  onValueChange?: (value: number | null) => void;
  /** Суффикс справа: ₽, ₽/ч, ₽/м³ и т.п. */
  suffix?: string;
  /** Знаков после запятой (копейки). 0 (по умолчанию) — целые рубли, как раньше. */
  decimals?: number;
};

function MoneyInput({
  defaultValue = null,
  value: valueProp,
  onValueChange,
  suffix = "₽",
  decimals = 0,
  className,
  placeholder,
  ...props
}: MoneyInputProps) {
  const controlled = valueProp !== undefined;
  const [internal, setInternal] = React.useState<number | null>(defaultValue ?? null);
  const numeric = controlled ? (valueProp ?? null) : internal;

  const [text, setText] = React.useState(() =>
    formatMoneyFieldValue(controlled ? (valueProp ?? null) : defaultValue, decimals),
  );

  // Источник истины: для controlled — value, для uncontrolled — defaultValue.
  // При его внешней смене переформатируем отображение (без set-state-in-effect).
  const externalValue = controlled ? numeric : (defaultValue ?? null);
  const [prevExternal, setPrevExternal] = React.useState(externalValue);
  if (externalValue !== prevExternal) {
    setPrevExternal(externalValue);
    setText(formatMoneyFieldValue(externalValue, decimals));
    if (!controlled) setInternal(externalValue);
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { text: display, value: parsed } = parseGroupedMoney(e.target.value, decimals);
    setText(display);
    if (!controlled) setInternal(parsed);
    onValueChange?.(parsed);
  };

  return (
    <div className="relative">
      <Input
        {...props}
        type="text"
        inputMode={decimals > 0 ? "decimal" : "numeric"}
        className={cn(suffixPadding(suffix), className)}
        value={text}
        onChange={handleChange}
        placeholder={placeholder ?? suffix}
      />
      <span
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm"
        aria-hidden
      >
        {suffix}
      </span>
    </div>
  );
}

export { MoneyInput };
