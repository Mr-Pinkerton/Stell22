"use client";

import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  terminalConfirmBarClass,
  type TerminalConfirmBarLayout,
} from "@/lib/scroll-classes";

interface TerminalConfirmBarProps {
  summary: React.ReactNode;
  disabled?: boolean;
  onConfirm: () => void;
  label?: string;
  /** sticky — поверх контента (PRISADKA/UPAKOVKA/HOURS). docked — отдельный футер (TORCOVKA). */
  layout?: TerminalConfirmBarLayout;
}

/** Белая полоса подтверждения на всю ширину низа экрана. */
export function TerminalConfirmBar({
  summary,
  disabled,
  onConfirm,
  label = "Подтвердить",
  layout = "sticky",
}: TerminalConfirmBarProps) {
  return (
    <div className={terminalConfirmBarClass(layout)}>
      <div className="min-w-0 flex-1">{summary}</div>
      <Button
        variant="brand"
        className="h-14 rounded-xl px-10 text-lg font-semibold"
        disabled={disabled}
        onClick={onConfirm}
      >
        {label}
        <ChevronRight className="size-5" />
      </Button>
    </div>
  );
}
