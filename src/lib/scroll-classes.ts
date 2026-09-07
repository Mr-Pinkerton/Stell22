import { cn } from "@/lib/utils";

/**
 * Тонкие скроллбары — утилиты `scrollbar-thin-y` / `scrollbar-thin-x` в `globals.css`.
 * Использовать на любом контейнере с overflow-y-auto / overflow-x-auto.
 */

export const scrollThinY = "scrollbar-thin-y overflow-y-auto";

export const scrollThinX = "scrollbar-thin-x overflow-x-auto";

export const scrollThinBoth = "scrollbar-thin-y scrollbar-thin-x overflow-auto";

/** Широкий вертикальный скролл — палец на терминале. */
export const scrollTouchY = "scrollbar-touch-y overflow-y-auto";

/**
 * Оболочка terminal-модалки: fixed+transform остаются на DialogContent,
 * overflow-y-auto сюда не ставить.
 */
export const terminalDialogShellClass =
  "flex max-h-[min(90vh,40rem)] min-h-0 flex-col overflow-hidden";

/** Короткие модалки терминала без внутреннего скролла. */
export const terminalDialogContentClass = "gap-5 px-8 py-6 sm:max-w-[32rem]";

/**
 * Внутренний native vertical scroll. `touch-pan-y` пересекается с UA
 * `manipulation` на button → свайп с кнопки может стать pan-y.
 */
export const terminalDialogScrollBodyClass = cn(
  scrollTouchY,
  "flex min-h-0 flex-1 flex-col gap-5 overscroll-contain touch-pan-y",
);

/** Скролл таблиц/списков в карточках (как ДДС, отчёты). */
export const scrollTableYClass = cn(scrollThinY, "max-h-[min(70vh,40rem)]");

/** Оболочка терминала: высота = viewport, чтобы футер операции стыковался, а не наезжал. */
export const terminalAppShellClass =
  "bg-background flex h-dvh min-h-0 flex-col overflow-hidden touch-manipulation";

/** Экран операции: колонка с прокручиваемым телом и flex-none футером. */
export const terminalOperationScreenClass = "flex min-h-0 flex-1 flex-col";

/** Прокручиваемое тело операции (торцовка и др. с docked-футером). */
export const terminalOperationBodyClass = cn(
  scrollTouchY,
  "flex min-h-0 flex-1 flex-col gap-5 p-6",
);

/** PRISADKA/UPAKOVKA/HOURS: тот же viewport-bound, sticky-футер без overlay-колонки. */
export const terminalStickyOperationClass = cn(
  scrollTouchY,
  "flex min-h-0 flex-1 flex-col gap-5 p-6",
);

export type TerminalConfirmBarLayout = "sticky" | "docked";

export function terminalConfirmBarClass(layout: TerminalConfirmBarLayout = "sticky"): string {
  const base = "bg-card flex items-center justify-between gap-4 border-t px-6 py-4";
  if (layout === "docked") return cn(base, "flex-none");
  return cn(base, "sticky bottom-0 z-10 -mx-6 -mb-6 mt-auto");
}
