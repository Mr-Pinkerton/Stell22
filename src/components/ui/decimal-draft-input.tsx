"use client";

import { useState, type ComponentProps } from "react";
import { Input } from "@/components/ui/input";
import {
  formatMeasured,
  parseDecimalText,
  precisionMessage,
  type DecimalDraft,
} from "@/lib/decimal-input";

function draftProblem(draft: DecimalDraft, scale: number, requireComplete: boolean): string | null {
  if (draft.error === "precision") return precisionMessage(scale);
  if (draft.error === "negative" || draft.error === "invalid") return "Некорректное число";
  if (requireComplete && (draft.empty || !draft.complete || draft.value == null || draft.value <= 0)) {
    return "Укажите число больше нуля";
  }
  return null;
}

type DraftInputProps = Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type"> & {
  value: string;
  scale: number;
  onDraftChange: (draft: DecimalDraft) => void;
};

/** Raw decimal text. The parent keeps the draft; this does not store a number. */
export function DecimalDraftInput({ value, scale, onDraftChange, ...props }: DraftInputProps) {
  const draft = parseDecimalText(value, scale);
  const problem = draftProblem(draft, scale, false);
  return (
    <div>
      <Input
        {...props}
        type="text"
        inputMode="decimal"
        value={value}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => onDraftChange(parseDecimalText(event.target.value, scale))}
      />
      {problem ? <p className="text-destructive mt-1 text-xs">{problem}</p> : null}
    </div>
  );
}

type CommitProps = Omit<ComponentProps<typeof Input>, "value" | "onChange" | "type" | "defaultValue"> & {
  value: number;
  scale: number;
  onCommit: (value: number) => void;
  onUncommittedChange?: (uncommitted: boolean) => void;
};

/**
 * Edits a saved decimal without writing it on every key.
 * A valid value is committed on blur. Invalid text leaves the saved number.
 */
export function MeasuredCommitInput({
  value,
  scale,
  onCommit,
  onUncommittedChange,
  disabled,
  ...props
}: CommitProps) {
  const [text, setText] = useState(() => formatMeasured(value, scale));
  const [problem, setProblem] = useState<string | null>(null);

  if (disabled) {
    return (
      <Input
        {...props}
        type="text"
        inputMode="decimal"
        disabled
        value={formatMeasured(value, scale)}
        readOnly
      />
    );
  }

  return (
    <div>
      <Input
        {...props}
        type="text"
        inputMode="decimal"
        value={text}
        aria-invalid={problem ? true : undefined}
        onChange={(event) => {
          const draft = parseDecimalText(event.target.value, scale);
          setText(draft.text);
          const nextProblem = draftProblem(draft, scale, false);
          setProblem(nextProblem);
          const committed =
            draft.complete && draft.value != null && draft.value > 0 && draft.error == null && draft.value === value;
          onUncommittedChange?.(!committed);
        }}
        onBlur={() => {
          const draft = parseDecimalText(text, scale);
          if (draft.complete && draft.value != null && draft.value > 0 && draft.error == null) {
            onCommit(draft.value);
            setText(formatMeasured(draft.value, scale));
            setProblem(null);
            onUncommittedChange?.(false);
            return;
          }
          setProblem(draftProblem(draft, scale, true));
          onUncommittedChange?.(true);
        }}
      />
      {problem ? <p className="text-destructive mt-1 text-xs">{problem}</p> : null}
    </div>
  );
}
