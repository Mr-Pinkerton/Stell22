"use client";

import { Delete } from "lucide-react";
import { cn } from "@/lib/utils";

interface NumericKeypadProps {
  value: string;
  onChange: (next: string) => void;
  /** Максимум цифр (напр. 4 для PIN). */
  maxLength?: number;
  className?: string;
}

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "back"] as const;

/** Цифровая клавиатура терминала: 123 / 456 / 789 / C 0 ⌫. */
export function NumericKeypad({ value, onChange, maxLength, className }: NumericKeypadProps) {
  const press = (key: (typeof KEYS)[number]) => {
    if (key === "C") return onChange("");
    if (key === "back") return onChange(value.slice(0, -1));
    if (maxLength && value.length >= maxLength) return;
    if (value === "0") return onChange(key); // не копим ведущие нули
    onChange(value + key);
  };

  return (
    <div className={cn("grid grid-cols-3 gap-2", className)}>
      {KEYS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => press(key)}
          className={cn(
            "flex h-16 items-center justify-center rounded-2xl text-2xl font-semibold transition-all select-none active:translate-y-px",
            key === "C" || key === "back"
              ? "bg-muted text-muted-foreground hover:bg-muted/70"
              : "surface-card hover:shadow-soft ring-0",
          )}
        >
          {key === "back" ? <Delete className="size-6" /> : key}
        </button>
      ))}
    </div>
  );
}
