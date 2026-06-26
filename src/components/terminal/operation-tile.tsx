"use client";

import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

/** Горизонтальный ряд: N плиток на экран, остальные — скролл. */
export function OperationTileRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-full gap-3 overflow-x-auto pb-2 [-ms-overflow-style:none] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-1.5">
      {children}
    </div>
  );
}

/** 5 плиток в ряд (разделы). gap-3 × 4 = 3rem */
const TILE_WIDTH_SECTION = "w-[calc((100%-3rem)/5)] min-w-[calc((100%-3rem)/5)]";
/** 3 плитки в ряд (выбор сотрудника). gap-3 × 2 = 1.5rem */
const TILE_WIDTH_PERSON = "w-[calc((100%-1.5rem)/3)] min-w-[calc((100%-1.5rem)/3)]";

interface OperationTileProps {
  active?: boolean;
  disabled?: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  /** Крупная строка в шапке плитки, напр. «Взято 5 реек». */
  highlight?: { prefix?: string; value: number | string; label?: string };
  onClick?: () => void;
  /** section — 5 в ряд; person — крупнее, 3 в ряд (вход). */
  layout?: "section" | "person";
}

function formatHighlight({ prefix, value, label }: NonNullable<OperationTileProps["highlight"]>) {
  const core = label ? `${value} ${label}` : String(value);
  return prefix ? `${prefix} ${core}` : core;
}

/** Прямоугольная плитка раздела терминала (не главный экран). */
export function OperationTile({
  active,
  disabled,
  icon,
  title,
  subtitle,
  badge,
  highlight,
  onClick,
  layout = "section",
}: OperationTileProps) {
  const isPerson = layout === "person";

  return (
    <Card
      className={cn(
        "surface-card shrink-0 ring-0",
        isPerson ? "h-44" : "h-40",
        isPerson ? TILE_WIDTH_PERSON : TILE_WIDTH_SECTION,
        active && "border-brand bg-brand/5 border-2",
        !disabled && onClick && "cursor-pointer active:scale-[0.98] active:opacity-90",
        disabled && "opacity-60",
      )}
    >
      <CardContent
        className={cn(
          "flex h-full flex-col",
          isPerson ? "items-center justify-center gap-4 px-5 py-6 text-center" : "gap-2 px-4 py-4",
        )}
        onClick={disabled ? undefined : onClick}
      >
        {isPerson ? (
          <>
            <span className="bg-muted text-muted-foreground flex size-16 items-center justify-center rounded-2xl [&_svg]:size-8 [&_svg]:stroke-[1.75]">
              {icon}
            </span>
            <span className="line-clamp-3 text-lg leading-snug font-semibold">{title}</span>
          </>
        ) : (
          <>
            <div className="flex shrink-0 items-center justify-between gap-2">
              <span className="bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-2xl [&_svg]:size-5 [&_svg]:stroke-[1.75]">
                {icon}
              </span>
              {highlight != null ? (
                <p className="text-brand min-w-0 truncate text-right text-lg leading-tight font-bold tabular-nums">
                  {formatHighlight(highlight)}
                </p>
              ) : (
                badge && (
                  <Badge variant={disabled ? "outline" : "default"} className="text-sm">
                    {badge}
                  </Badge>
                )
              )}
            </div>

            <div className="min-h-0 flex-1">
              <span className="block truncate text-lg leading-tight font-semibold">{title}</span>
              {subtitle && (
                <span className="text-muted-foreground mt-1 block truncate text-base leading-snug">
                  {subtitle}
                </span>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
