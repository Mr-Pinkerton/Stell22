"use client";

import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const DRAG_THRESHOLD_PX = 6;

/** Горизонтальный ряд: N плиток на экран, остальные — скролл. */
export function OperationTileRow({
  children,
  rowRef,
}: {
  children: React.ReactNode;
  rowRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<{ cleanup: () => void } | null>(null);

  useEffect(() => () => sessionRef.current?.cleanup(), []);

  const blockClickIfScrolled = useCallback((scrolled: boolean) => {
    const el = ref.current;
    if (!el || !scrolled) return;
    const block = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("click", block, { capture: true, once: true });
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const el = ref.current;
    if (!el) return;

    sessionRef.current?.cleanup();

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startScroll = el.scrollLeft;
    const session = { dragging: false };

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      if (!session.dragging && Math.abs(dx) > DRAG_THRESHOLD_PX) {
        session.dragging = true;
      }
      if (session.dragging && ev.pointerType === "mouse") {
        ev.preventDefault();
        el.scrollLeft = startScroll - dx;
      }
    };

    const onEnd = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      if (ev.type === "pointerup" && session.dragging) {
        blockClickIfScrolled(true);
      }
      cleanup();
    };

    const cleanup = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onEnd);
      document.removeEventListener("pointercancel", onEnd);
      sessionRef.current = null;
    };

    sessionRef.current = { cleanup };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onEnd);
    document.addEventListener("pointercancel", onEnd);
  };

  return (
    <div
      ref={(node) => {
        ref.current = node;
        if (rowRef) rowRef.current = node;
      }}
      className="scrollbar-thin-x flex w-full touch-pan-x cursor-grab gap-3 overflow-x-auto pb-2 select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
    >
      {children}
    </div>
  );
}

/** Сетка 5×N — все плитки на экране, без горизонтального скролла. */
export function OperationTileGrid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-5 gap-3">{children}</div>;
}

/** 5 плиток в ряд (разделы). gap-3 × 4 = 3rem */
const TILE_WIDTH_SECTION = "w-[calc((100%-3rem)/5)] min-w-[calc((100%-3rem)/5)]";
/** 3 плитки в ряд (выбор сотрудника). gap-3 × 2 = 1.5rem */
const TILE_WIDTH_PERSON = "w-[calc((100%-1.5rem)/3)] min-w-[calc((100%-1.5rem)/3)]";
/** Ячейка сетки деталей — на всю ширину колонки. */
const TILE_WIDTH_GRID = "min-w-0 w-full";

interface OperationTileProps {
  active?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  badge?: string;
  /** Квадратный бейдж с номером детали (1–9) — после названия. */
  numberBadge?: number | null;
  /** Строка материала под названием: порода + пилюля-сечение (напр. «Хвоя» + «40×20»). */
  material?: { name: string; section?: string | null };
  /** Бледная приписка после названия и бейджа (напр. сорт детали). */
  titleNote?: string;
  /** Крупная строка в шапке плитки, напр. «Взято 5 реек». */
  highlight?: { prefix?: string; value: number | string; label?: string };
  onClick?: () => void;
  /** Сброс выбора (кнопка «Сбросить» на активной плитке). */
  onClear?: () => void;
  /** Нижняя подпись и полоса остатка (compact). value 0–1. */
  meter?: { caption: string; value: number };
  /** section — 5 в ряд со скроллом; grid — 5 колонок без скролла; person — вход; compact — иконка слева, текст справа; blank — заготовки торцовки: длина по центру, сорт бейджем. */
  layout?: "section" | "person" | "grid" | "compact" | "blank";
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
  numberBadge,
  material,
  titleNote,
  highlight,
  onClick,
  onClear,
  meter,
  layout = "section",
}: OperationTileProps) {
  const isPerson = layout === "person";
  const isGrid = layout === "grid";
  const isCompact = layout === "compact";
  const isBlank = layout === "blank";
  const showClear = active && onClear != null;

  return (
    <Card
      className={cn(
        "surface-card ring-0 !py-0",
        !isGrid && !isBlank && "shrink-0",
        isPerson
          ? "h-44"
          : isBlank
            ? "h-24"
            : isGrid
              ? "h-48"
              : isCompact && !meter
                ? "h-20"
                : "h-40",
        isPerson ? TILE_WIDTH_PERSON : isGrid || isBlank ? TILE_WIDTH_GRID : TILE_WIDTH_SECTION,
        active && "border-brand bg-brand/5 border-2",
        !disabled && onClick && "cursor-pointer active:scale-[0.98] active:opacity-90",
        disabled && "opacity-60",
      )}
    >
      <CardContent
        className={cn(
          "flex h-full",
          isPerson
            ? "flex-col items-center justify-center gap-4 px-5 py-6 text-center"
            : isBlank
              ? "relative w-full min-w-0 flex-col items-center justify-center gap-1 px-2 py-2 text-center"
              : isCompact
                ? "w-full min-w-0 flex-col px-4 py-4"
                : "flex-col gap-2 px-4 py-4",
        )}
        onClick={disabled ? undefined : isPerson || isCompact || isBlank ? onClick : undefined}
      >
        {isBlank ? (
          <>
            <p
              className={cn(
                "absolute top-1.5 right-3 text-sm leading-none font-bold tabular-nums",
                highlight != null && Number(highlight.value) > 0
                  ? "text-brand"
                  : "text-muted-foreground",
              )}
            >
              {formatHighlight(highlight ?? { value: 0, label: "шт" })}
            </p>
            <span className="text-lg leading-tight font-semibold">{title}</span>
            {subtitle && (
              <Badge variant="outline" className="text-muted-foreground font-medium">
                {subtitle}
              </Badge>
            )}
          </>
        ) : isPerson ? (
          <>
            <span className="bg-muted text-muted-foreground flex size-16 items-center justify-center rounded-2xl [&_svg]:size-8 [&_svg]:stroke-[1.75]">
              {icon}
            </span>
            <span className="line-clamp-3 text-lg leading-snug font-semibold">{title}</span>
          </>
        ) : isCompact ? (
          <div
            className={cn(
              "flex h-full w-full min-w-0 flex-col",
              meter ? "justify-between" : "justify-center gap-1.5",
            )}
          >
            <div className="flex min-w-0 items-center gap-3">
              <span className="bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-2xl [&_svg]:size-5 [&_svg]:stroke-[1.75]">
                {icon}
              </span>
              <div className="min-w-0 flex-1">
                <span className="block truncate text-lg leading-tight font-semibold">{title}</span>
                {material && (
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <span className="text-muted-foreground min-w-0 truncate text-sm">
                      {material.name}
                    </span>
                    {material.section && (
                      <Badge
                        variant="outline"
                        className="text-muted-foreground shrink-0 tabular-nums"
                      >
                        {material.section}
                      </Badge>
                    )}
                  </span>
                )}
                {subtitle && (
                  <span className="text-muted-foreground mt-0.5 block truncate text-sm leading-snug">
                    {subtitle}
                  </span>
                )}
              </div>
            </div>
            {meter && (
              <div className="mt-auto w-full min-w-0">
                <p className="text-muted-foreground mb-1 truncate text-[11px] leading-none">
                  {meter.caption}
                </p>
                <div className="flex h-0.5 w-full overflow-hidden rounded-full">
                  <div
                    className="bg-brand/60 h-full"
                    style={{
                      width: `${Math.min(100, Math.max(0, meter.value * 100))}%`,
                    }}
                  />
                  <div
                    className="bg-muted-foreground/40 h-full"
                    style={{
                      width: `${Math.min(100, Math.max(0, (1 - meter.value) * 100))}%`,
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            <div
              className={cn(
                "flex shrink-0 items-center justify-between gap-2",
                onClick && "cursor-pointer active:opacity-90",
              )}
              onClick={disabled ? undefined : onClick}
            >
              <span className="bg-muted text-muted-foreground flex size-11 shrink-0 items-center justify-center rounded-2xl [&_svg]:size-5 [&_svg]:stroke-[1.75]">
                {icon}
              </span>
              {highlight != null ? (
                <p className="text-brand min-w-0 truncate text-right text-2xl leading-none font-bold tabular-nums">
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

            <div className="flex min-h-0 flex-1 items-start justify-between gap-2">
              <div
                className={cn("min-w-0 flex-1", onClick && "cursor-pointer active:opacity-90")}
                onClick={disabled ? undefined : onClick}
              >
                <span className="flex items-center gap-1.5">
                  <span className="min-w-0 truncate text-lg leading-tight font-semibold">
                    {title}
                  </span>
                  {numberBadge != null && (
                    <span className="bg-brand/10 text-brand flex size-6 shrink-0 items-center justify-center rounded-md text-sm font-bold tabular-nums">
                      {numberBadge}
                    </span>
                  )}
                  {titleNote && (
                    <span className="text-muted-foreground/70 shrink-0 text-sm">{titleNote}</span>
                  )}
                </span>
                {material && (
                  <span className="mt-1 flex items-center gap-1.5">
                    <span className="text-muted-foreground min-w-0 truncate text-sm">
                      {material.name}
                    </span>
                    {material.section && (
                      <Badge
                        variant="outline"
                        className="text-muted-foreground shrink-0 tabular-nums"
                      >
                        {material.section}
                      </Badge>
                    )}
                  </span>
                )}
                {subtitle && (
                  <span className="text-muted-foreground mt-1 block truncate text-base leading-snug">
                    {subtitle}
                  </span>
                )}
              </div>
              {showClear && (
                <button
                  type="button"
                  className="text-muted-foreground shrink-0 self-start text-base font-semibold active:opacity-60"
                  onClick={(e) => {
                    e.stopPropagation();
                    onClear();
                  }}
                >
                  Сбросить
                </button>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
