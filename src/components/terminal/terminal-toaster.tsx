"use client";

import { Toaster } from "@/components/ui/sonner";

/** Уведомления терминала: справа, сразу под хедером (v2). */
export function TerminalToaster() {
  return (
    <Toaster
      id="terminal"
      position="top-right"
      offset={{ top: 100, right: 24 }}
      visibleToasts={4}
      expand
    />
  );
}
