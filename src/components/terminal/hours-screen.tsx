"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NumericKeypad } from "@/components/terminal/numeric-keypad";
import { formatMoney } from "@/lib/format";
import type { Employee } from "@/types/domain";

interface HoursScreenProps {
  employee: Employee;
  onDone: () => void;
}

export function HoursScreen({ employee, onDone }: HoursScreenProps) {
  const [value, setValue] = useState("");
  const hours = Number(value || 0);
  const rate = employee.hourlyRate ?? 0;

  const submit = () => {
    if (hours <= 0) return;
    toast.success(`Внесено ${hours} ч`);
    onDone();
  };

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <div className="w-full max-w-xs space-y-5">
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold tracking-tight">Рабочие часы</h1>
          <p className="text-muted-foreground text-sm">
            {rate > 0 ? `Ставка ${formatMoney(rate)}/ч` : "Почасовая ставка не задана"}
          </p>
        </div>

        <div className="bg-muted/50 flex h-16 items-center justify-center rounded-2xl text-3xl font-semibold tabular-nums">
          {value || "0"} <span className="text-muted-foreground ml-2 text-lg">ч</span>
        </div>

        {hours > 0 && rate > 0 && (
          <p className="text-muted-foreground text-center text-sm">
            К начислению: {formatMoney(hours * rate)}
          </p>
        )}

        <NumericKeypad value={value} onChange={setValue} />

        <Button className="h-12 w-full rounded-xl text-base" disabled={hours <= 0} onClick={submit}>
          Внести
        </Button>
      </div>
    </main>
  );
}
