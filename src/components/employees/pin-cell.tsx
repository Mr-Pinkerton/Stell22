"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface PinCellProps {
  pin: string;
}

/** PIN в таблице: размыт, показывается по клику. */
export function PinCell({ pin }: PinCellProps) {
  const [visible, setVisible] = useState(false);

  return (
    <button
      type="button"
      onClick={() => setVisible((v) => !v)}
      className="text-foreground hover:text-brand inline-flex cursor-pointer items-center gap-2 rounded-lg px-1 py-0.5 font-mono text-sm tabular-nums transition-colors hover:bg-muted/60"
      aria-label={visible ? "Скрыть PIN" : "Показать PIN"}
    >
      <span className={cn(!visible && "blur-sm select-none")}>{pin}</span>
      {visible ? <EyeOff className="size-4 opacity-60" /> : <Eye className="size-4 opacity-60" />}
    </button>
  );
}
