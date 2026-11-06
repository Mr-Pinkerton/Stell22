import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

/**
 * Заголовок, утверждённый на «Закупках»:
 * высота обычной строки 49px, светлая заливка #F0F2F5, тёмная #2A3648.
 */
export const tableHeaderClassName = "h-[49px] bg-[#F0F2F5] dark:bg-[#2A3648]";

export const tableHeadClass = cn(
  tableHeaderClassName,
  "text-base font-semibold align-middle",
);

/**
 * Минимальная высота обычной строки. В таблице CSS height — это минимум:
 * многострочное содержимое может сделать строку выше.
 */
export const tableBodyRowClass = "h-[49px]";

/** Липкая строка заголовка. Фон непрозрачный, чтобы строки не просвечивали. */
export const tableStickyHeadRowClass =
  "sticky top-0 z-20 bg-[#F0F2F5] shadow-[0_1px_0_0_var(--border)] hover:bg-[#F0F2F5] dark:bg-[#2A3648] dark:hover:bg-[#2A3648]";

/** Карточка таблицы: один радиус и одна тень, без верхнего поля Card. */
export const tableSurfaceCardClass = "surface-card ring-0 !pt-0";

/**
 * Пустая полоса над серым заголовком. Высота совпадает с нижним полем
 * карточки (`--spacing(4)` = 16px). Нижняя граница — верхняя линия серого
 * заголовка. Фильтры эту полосу заменяют.
 */
export function TableFilterSlot({ filters }: { filters?: ReactNode }) {
  if (!filters) {
    return (
      <div
        data-slot="table-top-gap"
        aria-hidden="true"
        className="h-[16px] shrink-0 border-b border-border bg-card"
      />
    );
  }
  return (
    <>
      {filters}
      <Separator />
    </>
  );
}

/** Фильтры и таблица на одной поверхности, как на «Закупках». */
export function TableSurface({
  filters,
  children,
  className,
}: {
  filters?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn(tableSurfaceCardClass, className)}>
      <CardContent className="p-0">
        <TableFilterSlot filters={filters} />
        {children}
      </CardContent>
    </Card>
  );
}
