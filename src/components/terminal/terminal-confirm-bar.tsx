"use client";

import { Button } from "@/components/ui/button";

interface TerminalConfirmBarProps {
  summary: React.ReactNode;
  disabled?: boolean;
  onConfirm: () => void;
  label?: string;
}

/** Липкая панель подтверждения внизу экрана операции. */
export function TerminalConfirmBar({
  summary,
  disabled,
  onConfirm,
  label = "Подтвердить",
}: TerminalConfirmBarProps) {
  return (
    <div className="surface-card sticky bottom-4 mt-auto flex items-center justify-between gap-4 px-5 py-3 ring-0">
      <div className="text-sm">{summary}</div>
      <Button
        className="h-14 rounded-xl px-10 text-lg font-semibold"
        disabled={disabled}
        onClick={onConfirm}
      >
        {label}
      </Button>
    </div>
  );
}
