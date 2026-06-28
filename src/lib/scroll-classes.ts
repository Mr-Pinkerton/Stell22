import { cn } from "@/lib/utils";

/**
 * Тонкие скроллбары — утилиты `scrollbar-thin-y` / `scrollbar-thin-x` в `globals.css`.
 * Использовать на любом контейнере с overflow-y-auto / overflow-x-auto.
 */

export const scrollThinY = "scrollbar-thin-y overflow-y-auto";

export const scrollThinX = "scrollbar-thin-x overflow-x-auto";

export const scrollThinBoth = "scrollbar-thin-y scrollbar-thin-x overflow-auto";

/** Скролл таблиц/списков в карточках (как ДДС, отчёты). */
export const scrollTableYClass = cn(scrollThinY, "max-h-[min(70vh,40rem)]");
