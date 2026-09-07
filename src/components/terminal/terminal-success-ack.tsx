"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { OPERATION_SAVED_TITLE, SUCCESS_ACK_TIMEOUT_MS } from "@/lib/torcovka-terminal-flow";

export function useTerminalSuccessAck(timeoutMs = SUCCESS_ACK_TIMEOUT_MS) {
  const [ack, setAck] = useState<{ title: string; detail?: string } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setAck(null);
  }, []);

  const show = useCallback(
    (detail?: string) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setAck({ title: OPERATION_SAVED_TITLE, detail });
      timerRef.current = setTimeout(() => {
        setAck(null);
        timerRef.current = null;
      }, timeoutMs);
    },
    [timeoutMs],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return { ack, show, dismiss };
}

export function TerminalSuccessAck({
  ack,
}: {
  ack: { title: string; detail?: string } | null;
}) {
  if (!ack) return null;
  return (
    <div
      role="status"
      className="border-brand/40 bg-brand/10 flex items-center gap-3 rounded-2xl border px-4 py-4"
    >
      <span className="bg-brand/15 text-brand flex size-12 shrink-0 items-center justify-center rounded-full">
        <Check className="size-7 stroke-[2.5]" aria-hidden />
      </span>
      <div className="min-w-0">
        <div className="text-lg font-semibold tracking-tight">✓ {ack.title}</div>
        {ack.detail ? (
          <div className="text-muted-foreground text-base leading-snug">{ack.detail}</div>
        ) : null}
      </div>
    </div>
  );
}
