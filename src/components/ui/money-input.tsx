"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { formatGroupedInteger, parseGroupedInteger } from "@/lib/format";
import { cn } from "@/lib/utils";

function suffixPadding(suffix: string): string {
  if (suffix.length <= 2) return "pr-8";
  if (suffix.length <= 5) return "pr-12";
  if (suffix.length <= 9) return "pr-16";
  return "pr-20";
}

function formatMoneyFieldValue(value: number | null | undefined): string {
  if (value == null || value === 0) return "";
  return formatGroupedInteger(value);
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
};

function MoneyInput({
  defaultValue = null,
  value: valueProp,
  onValueChange,
  suffix = "₽",
  className,
  placeholder,
  ...props
}: MoneyInputProps) {
  const controlled = valueProp !== undefined;
  const [internal, setInternal] = React.useState<number | null>(defaultValue ?? null);
  const numeric = controlled ? (valueProp ?? null) : internal;

  const [text, setText] = React.useState(() => formatMoneyFieldValue(defaultValue));

  React.useEffect(() => {
    if (!controlled) {
      const next = defaultValue ?? null;
      setInternal(next);
      setText(formatMoneyFieldValue(next));
    }
  }, [defaultValue, controlled]);

  React.useEffect(() => {
    if (controlled) {
      setText(formatMoneyFieldValue(numeric));
    }
  }, [controlled, numeric]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const parsed = parseGroupedInteger(e.target.value);
    const display = parsed != null ? formatGroupedInteger(parsed) : "";
    setText(display);
    if (!controlled) setInternal(parsed);
    onValueChange?.(parsed);
  };

  return (
    <div className="relative">
      <Input
        {...props}
        type="text"
        inputMode="numeric"
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
