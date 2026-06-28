"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  addMonths,
  buildCalendarMonth,
  getCurrentMonth,
  isDayInRange,
  isSameDay,
  normalizeRange,
  startOfMonth,
} from "@/lib/dates";
import { formatFilterDateRange, formatFilterMonth } from "@/lib/format";

export const DATE_FILTER_WIDTH = "w-[280px]";

const WEEKDAY_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

const triggerClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring focus-visible:bg-card h-10 min-h-10 cursor-pointer rounded-xl border px-4 text-left text-sm font-normal";

export interface DateFilterValue {
  month: Date;
  rangeStart: Date | null;
  rangeEnd: Date | null;
  allTime?: boolean;
}

interface DateFilterProps {
  value?: DateFilterValue;
  onChange?: (value: DateFilterValue) => void;
}

function getDefaultValue(): DateFilterValue {
  const month = getCurrentMonth();
  return { month, rangeStart: null, rangeEnd: null, allTime: false };
}

function getDisplayLabel(value: DateFilterValue): string {
  if (value.allTime) return "За всё время";
  if (value.rangeStart && value.rangeEnd) {
    return formatFilterDateRange(value.rangeStart, value.rangeEnd);
  }
  return formatFilterMonth(value.month);
}

export function DateFilter({ value, onChange }: DateFilterProps) {
  const [internalValue, setInternalValue] = useState<DateFilterValue>(getDefaultValue);
  const current = value ?? internalValue;

  const setValue = (next: DateFilterValue) => {
    if (value === undefined) setInternalValue(next);
    onChange?.(next);
  };

  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => current.month);
  const [hoverDay, setHoverDay] = useState<Date | null>(null);

  const displayLabel = getDisplayLabel(current);
  const calendarDays = useMemo(() => buildCalendarMonth(viewMonth), [viewMonth]);

  const updateValue = (patch: Partial<DateFilterValue>) => {
    const next = { ...current, ...patch };
    if (patch.allTime !== true && (patch.rangeStart !== undefined || patch.rangeEnd !== undefined || patch.month !== undefined)) {
      next.allTime = false;
    }
    setValue(next);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setHoverDay(null);
    if (nextOpen) {
      setViewMonth(current.rangeStart ? startOfMonth(current.rangeStart) : current.month);
    }
  };

  const handlePrevMonth = () => {
    const nextMonth = addMonths(viewMonth, -1);
    setViewMonth(nextMonth);
    if (!current.rangeStart && !current.rangeEnd) {
      updateValue({ month: nextMonth });
    }
  };

  const handleNextMonth = () => {
    const nextMonth = addMonths(viewMonth, 1);
    setViewMonth(nextMonth);
    if (!current.rangeStart && !current.rangeEnd) {
      updateValue({ month: nextMonth });
    }
  };

  const handleDayClick = (day: Date) => {
    setHoverDay(null);

    if (!current.rangeStart || (current.rangeStart && current.rangeEnd)) {
      updateValue({
        rangeStart: day,
        rangeEnd: null,
        month: startOfMonth(day),
      });
      return;
    }

    const { start, end } = normalizeRange(current.rangeStart, day);
    updateValue({
      rangeStart: start,
      rangeEnd: end,
      month: startOfMonth(start),
    });
  };

  const rangeStart = current.rangeStart;
  const rangeEnd = current.rangeEnd;
  const isSelectingRange = Boolean(rangeStart && !rangeEnd);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        className={cn(
          triggerClass,
          DATE_FILTER_WIDTH,
          "flex items-center justify-between gap-2 font-medium",
        )}
      >
        <span className="truncate">{displayLabel}</span>
        <ChevronDown className="size-4 shrink-0 opacity-50" />
      </PopoverTrigger>

      <PopoverContent align="start" className={cn(DATE_FILTER_WIDTH, "rounded-xl p-3 shadow-soft-lg ring-0")}>
        <div className="mb-3 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full"
            onClick={handlePrevMonth}
            aria-label="Предыдущий месяц"
          >
            <ChevronLeft />
          </Button>
          <span className="text-sm font-semibold">{formatFilterMonth(viewMonth)}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full"
            onClick={handleNextMonth}
            aria-label="Следующий месяц"
          >
            <ChevronRight />
          </Button>
        </div>

        <div className="mb-1 grid grid-cols-7 gap-1">
          {WEEKDAY_LABELS.map((label) => (
            <div
              key={label}
              className="text-muted-foreground flex h-8 items-center justify-center text-xs font-medium"
            >
              {label}
            </div>
          ))}
        </div>

        <div
          className="grid grid-cols-7 gap-1"
          onMouseLeave={() => setHoverDay(null)}
        >
          {calendarDays.map((cell) => {
            const { date, inCurrentMonth } = cell;
            const isStart = rangeStart ? isSameDay(date, rangeStart) : false;
            const isEnd = rangeEnd ? isSameDay(date, rangeEnd) : false;
            const inRange =
              rangeStart && rangeEnd ? isDayInRange(date, rangeStart, rangeEnd) : false;
            const isSinglePending = isSelectingRange && isStart && !hoverDay;

            const inPreviewRange =
              isSelectingRange && hoverDay && rangeStart
                ? isDayInRange(date, rangeStart, hoverDay)
                : false;
            const isPreviewEnd =
              isSelectingRange && hoverDay ? isSameDay(date, hoverDay) : false;
            const isMultiDayPreview =
              isSelectingRange && hoverDay && rangeStart && !isSameDay(rangeStart, hoverDay);

            return (
              <button
                key={date.toISOString()}
                type="button"
                onClick={() => handleDayClick(date)}
                onMouseEnter={() => {
                  if (isSelectingRange) setHoverDay(date);
                }}
                className={cn(
                  "flex h-8 w-full items-center justify-center text-sm transition-colors",
                  !inCurrentMonth && "text-muted-foreground/50",
                  inCurrentMonth && "text-foreground",
                  (isStart || isEnd || isSinglePending) &&
                    "bg-primary text-primary-foreground rounded-full font-medium",
                  inRange && !isStart && !isEnd && "bg-primary/10 rounded-none font-medium",
                  inPreviewRange &&
                    !inRange &&
                    !isStart &&
                    !isPreviewEnd &&
                    "bg-primary/5 rounded-none",
                  isPreviewEnd &&
                    isMultiDayPreview &&
                    !isStart &&
                    "bg-primary/20 text-foreground rounded-full font-medium",
                  isStart &&
                    inPreviewRange &&
                    isMultiDayPreview &&
                    "rounded-r-none",
                  isPreviewEnd &&
                    isMultiDayPreview &&
                    !isSameDay(rangeStart!, hoverDay!) &&
                    "rounded-l-none",
                  isStart && inRange && rangeEnd && !isSameDay(rangeStart!, rangeEnd) && "rounded-r-none",
                  isEnd &&
                    inRange &&
                    rangeStart &&
                    rangeEnd &&
                    !isSameDay(rangeStart, rangeEnd) &&
                    "rounded-l-none",
                  !isStart &&
                    !isEnd &&
                    !inRange &&
                    !isSinglePending &&
                    !inPreviewRange &&
                    "hover:bg-muted rounded-full",
                )}
              >
                {date.getDate()}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function getDefaultDateFilterValue(): DateFilterValue {
  return getDefaultValue();
}
