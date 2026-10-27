"use client";

import { useState, type ComponentProps } from "react";

import { Input } from "@/components/ui/input";
import { precisionMessage, type DecimalDraft } from "@/lib/decimal-input";
import { formatGroupedDecimal, formatGroupedInteger, parseGroupedMoney } from "@/lib/format";
import { cn } from "@/lib/utils";

function suffixPadding(suffix: string): string {
  if (suffix.length <= 2) return "pr-8";
  if (suffix.length <= 5) return "pr-12";
  if (suffix.length <= 9) return "pr-16";
  return "pr-20";
}

function formatMoneyFieldValue(value: number | null | undefined, decimals: number): string {
  if (value == null) return "";
  return decimals > 0 ? formatGroupedDecimal(value, decimals) : formatGroupedInteger(value);
}

function draftMatchesExternal(draft: DecimalDraft, external: number | null): boolean {
  if (draft.empty) return external == null;
  return draft.complete && draft.error == null && draft.value === external;
}

type MoneyInputProps = Omit<
  ComponentProps<typeof Input>,
  "value" | "onChange" | "defaultValue" | "type" | "inputMode"
> & {
  defaultValue?: number | null;
  value?: number | null;
  onValueChange?: (value: number | null) => void;
  onDraftChange?: (draft: DecimalDraft) => void;
  /** Суффикс справа: ₽, ₽/ч, ₽/м³ и т.п. */
  suffix?: string;
  /**
   * Знаков после запятой. По умолчанию 2: форма показывает точные копейки.
   * 0 — только целые. Лишние знаки не обрезаются и не округляются.
   */
  decimals?: number;
};

function MoneyInput({
  defaultValue = null,
  value: valueProp,
  onValueChange,
  onDraftChange,
  suffix = "₽",
  decimals = 2,
  className,
  placeholder,
  onBlur,
  ...props
}: MoneyInputProps) {
  const controlled = valueProp !== undefined;
  const [internal, setInternal] = useState<number | null>(defaultValue ?? null);
  const numeric = controlled ? (valueProp ?? null) : internal;
  const externalValue = controlled ? numeric : (defaultValue ?? null);

  const [text, setText] = useState(() =>
    formatMoneyFieldValue(controlled ? (valueProp ?? null) : defaultValue, decimals),
  );
  const [draftError, setDraftError] = useState<DecimalDraft["error"]>(null);
  const [prevExternal, setPrevExternal] = useState(externalValue);

  if (externalValue !== prevExternal) {
    setPrevExternal(externalValue);
    const current = parseGroupedMoney(text, decimals);
    if (!draftMatchesExternal(current, externalValue)) {
      setText(formatMoneyFieldValue(externalValue, decimals));
      setDraftError(null);
    }
    if (!controlled) setInternal(externalValue);
  }

  const publish = (draft: DecimalDraft) => {
    setText(draft.text);
    setDraftError(draft.error);
    onDraftChange?.(draft);
    if (draft.empty) {
      if (!controlled) setInternal(null);
      onValueChange?.(null);
      return;
    }
    if (draft.complete && draft.error == null) {
      if (!controlled) setInternal(draft.value);
      onValueChange?.(draft.value);
    }
  };

  return (
    <div className="relative">
      <Input
        {...props}
        type="text"
        inputMode={decimals > 0 ? "decimal" : "numeric"}
        className={cn(suffixPadding(suffix), className)}
        value={text}
        aria-invalid={draftError ? true : undefined}
        onChange={(event) => publish(parseGroupedMoney(event.target.value, decimals))}
        onBlur={(event) => {
          const draft = parseGroupedMoney(text, decimals);
          if (draft.complete && draft.value != null && draft.error == null) {
            setText(formatMoneyFieldValue(draft.value, decimals));
          }
          onBlur?.(event);
        }}
        placeholder={placeholder ?? suffix}
      />
      <span
        className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm"
        aria-hidden
      >
        {suffix}
      </span>
      {draftError === "precision" ? (
        <p className="text-destructive mt-1 text-xs">{precisionMessage(decimals)}</p>
      ) : null}
    </div>
  );
}

export { MoneyInput };
