"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { terminalDialogScrollBodyClass } from "@/lib/scroll-classes";

/**
 * Native vertical scroll внутри terminal DialogContent.
 * Не вешает touch/pointer listeners — только CSS overflow + touch-action.
 */
export function TerminalDialogScrollBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const body = ref.current;
    if (!body) return;
    const shell = body.closest("[data-slot='dialog-content']");
    const probe = () => {
      const bodyCs = getComputedStyle(body);
      const shellCs = shell instanceof HTMLElement ? getComputedStyle(shell) : null;
      const button = body.querySelector("button");
      const buttonCs = button ? getComputedStyle(button) : null;
      return {
        DialogContent: shellCs
          ? {
              "touch-action": shellCs.touchAction,
              overflow: shellCs.overflow,
              position: shellCs.position,
            }
          : null,
        ScrollBody: {
          "touch-action": bodyCs.touchAction,
          "overflow-y": bodyCs.overflowY,
          scrollHeight: body.scrollHeight,
          clientHeight: body.clientHeight,
        },
        "NumericKeypad button": buttonCs ? { "touch-action": buttonCs.touchAction } : null,
      };
    };
    Object.defineProperty(window, "__terminalTouchScrollProbe", {
      configurable: true,
      value: probe,
    });
    return () => {
      const w = window as Window & { __terminalTouchScrollProbe?: unknown };
      if (w.__terminalTouchScrollProbe === probe) {
        delete w.__terminalTouchScrollProbe;
      }
    };
  }, []);

  return (
    <div
      ref={ref}
      data-terminal-scroll-body=""
      className={cn(terminalDialogScrollBodyClass, className)}
    >
      {children}
    </div>
  );
}
