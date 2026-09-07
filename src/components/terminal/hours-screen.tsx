"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/terminal/toast";
import { KeypadDisplay, KEYPAD_PANEL } from "@/components/terminal/keypad-panel";
import { NumericKeypad } from "@/components/terminal/numeric-keypad";
import { TerminalConfirmBar } from "@/components/terminal/terminal-confirm-bar";
import { TerminalSuccessAck, useTerminalSuccessAck } from "@/components/terminal/terminal-success-ack";
import { useTerminalDraft } from "@/components/terminal/use-terminal-draft";
import { cn } from "@/lib/utils";
import { formatMoney, formatMoneyDecimal } from "@/lib/format";
import { terminalStickyOperationClass } from "@/lib/scroll-classes";
import { submitHours } from "@/server/terminal";
import type { TerminalEmployee } from "@/components/terminal/types";

interface HoursScreenProps {
  employee: TerminalEmployee;
  onDone: () => void | Promise<void>;
}

export function HoursScreen({ employee, onDone }: HoursScreenProps) {
  const {
    draft: storedDraft,
    clientRequestId,
    save: saveDraft,
    clear: clearDraft,
  } = useTerminalDraft({ employeeId: employee.id });
  const [value, setValue] = useState(() =>
    storedDraft?.operationType === "HOURS" ? storedDraft.payload.hoursInput : "",
  );
  const [submitting, setSubmitting] = useState(false);
  const successAck = useTerminalSuccessAck();
  const hours = Number(value || 0);
  const rate = employee.hourlyRate ?? 0;

  useEffect(() => {
    saveDraft({ operationType: "HOURS", payload: { hoursInput: value } });
  }, [value, saveDraft]);

  const submit = async () => {
    if (hours <= 0 || submitting) return;
    setSubmitting(true);
    try {
      await submitHours(employee.id, hours, clientRequestId);
      toast.success(`Внесено ${hours} ч`);
      clearDraft();
      setValue("");
      successAck.show(`Часы сохранены: ${hours} ч`);
      await onDone();
      setSubmitting(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка внесения");
      setSubmitting(false);
    }
  };

  return (
    <main className={terminalStickyOperationClass}>
      <TerminalSuccessAck ack={successAck.ack} />
      <div className={cn(KEYPAD_PANEL, "flex flex-1 flex-col justify-center")}>
        <div className="space-y-1 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Рабочие часы</h1>
          <p className="text-muted-foreground text-base">
            {rate > 0 ? `Ставка ${formatMoneyDecimal(rate)}/ч` : "Почасовая ставка не задана"}
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

        <NumericKeypad
          value={value}
          onChange={(next) => {
            successAck.dismiss();
            setValue(next);
          }}
        />
      </div>

      <TerminalConfirmBar
        summary={
          <>
            <span className="font-medium">{hours > 0 ? `${hours} ч` : "0 ч"}</span>
            <span className="text-muted-foreground ml-3">
              {rate > 0 && hours > 0 ? formatMoney(hours * rate) : "укажите часы"}
            </span>
          </>
        }
        label="Внести"
        disabled={hours <= 0 || submitting}
        onConfirm={submit}
      />
    </main>
  );
}
