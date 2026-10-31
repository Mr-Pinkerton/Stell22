"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  applyDelayMs,
  navigationHrefIfNeeded,
  type PeriodCommitKind,
} from "@/lib/period-auto-apply";

/** Заменяет URL периода, когда черновик завершён и ещё не совпадает с адресом. */
export function useAutoApplyPeriod(
  draftHref: string | null,
  appliedHref: string,
  kind: PeriodCommitKind,
): boolean {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const target = navigationHrefIfNeeded(draftHref, appliedHref);
    if (!target) return;
    const timer = window.setTimeout(() => {
      startTransition(() => {
        router.replace(target);
      });
    }, applyDelayMs(kind));
    return () => window.clearTimeout(timer);
  }, [draftHref, appliedHref, kind, router]);

  return pending;
}
