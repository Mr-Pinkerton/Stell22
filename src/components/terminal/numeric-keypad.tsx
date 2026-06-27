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
    <div className={cn("grid grid-cols-3 gap-4 p-2", className)}>
      {KEYS.map((key) => {
        const isDigit = key !== "C" && key !== "back";
        return (
          <button
            key={key}
            type="button"
            onClick={() => press(key)}
            className={cn(
              "flex h-20 items-center justify-center rounded-2xl px-4 py-3 text-3xl font-semibold select-none active:scale-[0.97] active:opacity-90",
              isDigit
                ? "border-border bg-card surface-card border ring-0"
                : "bg-muted text-muted-foreground active:bg-muted/80",
            )}
          >
            {key === "back" ? <Delete className="size-7" /> : key}
          </button>
        );
      })}
    </div>
  );
}
