"use client";

import { useEffect, useState } from "react";
import { toast } from "@/components/terminal/toast";
import { KeypadDisplay, KEYPAD_PANEL } from "@/components/terminal/keypad-panel";
import { NumericKeypad } from "@/components/terminal/numeric-keypad";
import { TerminalConfirmBar } from "@/components/terminal/terminal-confirm-bar";
import { TerminalSuccessAck, useTerminalSuccessAck } from "@/components/terminal/terminal-success-ack";
import { useTerminalDraft } from "@/components/terminal/use-terminal-draft";
import { cn } from "@/lib/utils";
import { applyHoursKeypadChange, formatHoursRu, isHourlyRateUnavailable } from "@/lib/hours-input";
import { formatMoney, formatMoneyDecimal } from "@/lib/format";
import { terminalStickyOperationClass } from "@/lib/scroll-classes";
import { submitHours } from "@/server/terminal";
import type { TerminalEmployee } from "@/components/terminal/types";

interface HoursScreenProps {
  employee: TerminalEmployee;
  onDone: () => void | Promise<void>;
}

function partsFromHoursInput(raw: string): { whole: number; half: boolean } {
  const n = Number(String(raw).replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return { whole: 0, half: false };
  const doubled = Math.round(n * 2);
  return { whole: Math.floor(doubled / 2), half: doubled % 2 === 1 };
}

function hoursInputFromParts(whole: number, half: boolean): string {
  if (whole <= 0 && !half) return "";
  const hours = whole + (half ? 0.5 : 0);
  return Number.isInteger(hours) ? String(hours) : hours.toFixed(1);
}

export function HoursScreen({ employee, onDone }: HoursScreenProps) {
  const {
    draft: storedDraft,
    clientRequestId,
    save: saveDraft,
    clear: clearDraft,
  } = useTerminalDraft({ employeeId: employee.id });
  const initial = partsFromHoursInput(
    storedDraft?.operationType === "HOURS" ? storedDraft.payload.hoursInput : "",
  );
  const [whole, setWhole] = useState(initial.whole);
  const [half, setHalf] = useState(initial.half);
  const [submitting, setSubmitting] = useState(false);
  const successAck = useTerminalSuccessAck();
  const hours = whole + (half ? 0.5 : 0);
  const rate = employee.hourlyRate;
  const rateMissing = isHourlyRateUnavailable(rate);
  const value = hoursInputFromParts(whole, half);
  const keypadValue = whole > 0 ? String(whole) : "";

  useEffect(() => {
    saveDraft({ operationType: "HOURS", payload: { hoursInput: value } });
  }, [value, saveDraft]);

  const submit = async () => {
    if (hours <= 0 || submitting || rateMissing) return;
    setSubmitting(true);
    try {
      await submitHours(employee.id, hours, clientRequestId);
      toast.success(`Внесено ${formatHoursRu(hours)} ч`);
      clearDraft();
      setWhole(0);
      setHalf(false);
      successAck.show(`Часы сохранены: ${formatHoursRu(hours)} ч`);
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
          {rateMissing || rate == null ? (
            <>
              <p className="text-base font-medium">Почасовая ставка не задана</p>
              <p className="text-muted-foreground text-base">Обратитесь к руководителю</p>
            </>
          ) : (
            <p className="text-muted-foreground text-base">
              Ставка {formatMoneyDecimal(rate)}/ч
            </p>
          )}
        </div>

        <KeypadDisplay
          footerMessage={
            !rateMissing && rate != null && rate > 0
              ? `К начислению: ${formatMoney(hours * rate)}`
              : undefined
          }
          showFooterMessage={hours > 0 && !rateMissing && rate != null && rate > 0}
          footerTone="muted"
        >
          {formatHoursRu(hours)} <span className="text-muted-foreground ml-2 text-xl">ч</span>
        </KeypadDisplay>

        <button
          type="button"
          className={cn(
            "flex h-14 items-center justify-center rounded-2xl px-4 text-xl font-semibold select-none active:scale-[0.97] active:opacity-90",
            half
              ? "bg-brand text-brand-foreground"
              : "border-border bg-card surface-card border",
          )}
          disabled={submitting}
          onClick={() => {
            successAck.dismiss();
            setHalf((prev) => !prev);
          }}
        >
          {half ? "− 0,5 ч" : "+ 0,5 ч"}
        </button>

        <NumericKeypad
          value={keypadValue}
          onChange={(next) => {
            successAck.dismiss();
            const nextParts = applyHoursKeypadChange({ whole, half }, next);
            setWhole(nextParts.whole);
            setHalf(nextParts.half);
          }}
        />
      </div>

      <TerminalConfirmBar
        summary={
          <>
            <span className="font-medium">{formatHoursRu(hours)} ч</span>
            <span className="text-muted-foreground ml-3">
              {rateMissing
                ? "Почасовая ставка не задана"
                : hours > 0 && rate != null && rate > 0
                  ? formatMoney(hours * rate)
                  : "укажите часы"}
            </span>
          </>
        }
        label="Внести"
        disabled={hours <= 0 || submitting || rateMissing}
        onConfirm={submit}
      />
    </main>
  );
}
