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
