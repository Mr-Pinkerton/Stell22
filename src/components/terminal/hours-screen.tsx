"use client";

import { useRef, useState } from "react";
import { newRequestId } from "@/lib/request-id";
import { toast } from "@/components/terminal/toast";
import { Button } from "@/components/ui/button";
import { KeypadDisplay, KEYPAD_PANEL } from "@/components/terminal/keypad-panel";
import { NumericKeypad } from "@/components/terminal/numeric-keypad";
import { formatMoney } from "@/lib/format";
import { submitHours } from "@/server/terminal";
import type { Employee } from "@/types/domain";

interface HoursScreenProps {
  employee: Employee;
  onDone: () => void;
}

export function HoursScreen({ employee, onDone }: HoursScreenProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const requestId = useRef(newRequestId()); // ключ идемпотентности (A21)
  const hours = Number(value || 0);
  const rate = employee.hourlyRate ?? 0;

  const submit = async () => {
    if (hours <= 0 || submitting) return;
    setSubmitting(true);
    try {
      await submitHours(employee.id, hours, requestId.current);
      toast.success(`Внесено ${hours} ч`);
      requestId.current = newRequestId();
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка внесения");
      setSubmitting(false);
    }
  };

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 p-6">
      <div className={KEYPAD_PANEL}>
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Рабочие часы</h1>
          <p className="text-muted-foreground text-base">
            {rate > 0 ? `Ставка ${formatMoney(rate)}/ч` : "Почасовая ставка не задана"}
          </p>
        </div>

        <KeypadDisplay
          footerMessage={
            rate > 0 ? `К начислению: ${formatMoney(hours * rate)}` : undefined
          }
          showFooterMessage={hours > 0 && rate > 0}
          footerTone="muted"
        >
          {value || "0"} <span className="text-muted-foreground ml-2 text-xl">ч</span>
        </KeypadDisplay>

        <NumericKeypad value={value} onChange={setValue} />

        <Button
          className="h-14 w-full rounded-xl text-lg"
          disabled={hours <= 0 || submitting}
          onClick={submit}
        >
          Внести
        </Button>
      </div>
    </main>
  );
}
