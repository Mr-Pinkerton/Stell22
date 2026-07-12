"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { SectionFilters } from "@/lib/navigation";
import {
  DateFilter,
  getDefaultDateFilterValue,
  type DateFilterValue,
} from "@/components/date-filter";
import { WeekFilter, getDefaultWeekFilterValue } from "@/components/week-filter";

const filterInputClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring focus-visible:bg-card h-10 min-h-10 cursor-text rounded-xl border px-4";

const filterActionClass = "h-10 cursor-pointer rounded-xl px-4";

export interface FiltersBarProps extends SectionFilters {
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  archiveChecked?: boolean;
  onArchiveChange?: (checked: boolean) => void;
  dateFilterValue?: DateFilterValue;
  onDateFilterChange?: (value: DateFilterValue) => void;
  /** Подпись основной кнопки применения фильтров (по умолчанию «Показать»). */
  actionLabel?: string;
  /** Клик по кнопке применения (например, записать период в URL). */
  onApply?: () => void;
}

export function FiltersBar({
  search,
  date,
  dateAllTime,
  weeks,
  archive,
  searchValue,
  onSearchChange,
  archiveChecked,
  onArchiveChange,
  dateFilterValue,
  onDateFilterChange,
  actionLabel = "Показать",
  onApply,
}: FiltersBarProps) {
  const hasAny = search || date || weeks || archive;
  const [internalDateFilter, setInternalDateFilter] = useState<DateFilterValue>(
    getDefaultDateFilterValue,
  );
  const dateFilter = dateFilterValue ?? internalDateFilter;

  const setDateFilter = (value: DateFilterValue) => {
    if (onDateFilterChange) onDateFilterChange(value);
    else setInternalDateFilter(value);
  };
  const [weekFilter, setWeekFilter] = useState(getDefaultWeekFilterValue);
  const [internalSearch, setInternalSearch] = useState("");
  const [internalArchive, setInternalArchive] = useState(false);

  // Сброс недели при смене месяца фильтра.
  const monthTime = dateFilter.month.getTime();
  const [prevMonthTime, setPrevMonthTime] = useState(monthTime);
  if (monthTime !== prevMonthTime) {
    setPrevMonthTime(monthTime);
    setWeekFilter(getDefaultWeekFilterValue());
  }

  const query = searchValue ?? internalSearch;
  const showArchive = archiveChecked ?? internalArchive;

  const setQuery = (value: string) => {
    if (onSearchChange) onSearchChange(value);
    else setInternalSearch(value);
  };

  const setShowArchive = (checked: boolean) => {
    if (onArchiveChange) onArchiveChange(checked);
    else setInternalArchive(checked);
  };

  if (!hasAny) return null;

  const handleReset = () => {
    setDateFilter(getDefaultDateFilterValue());
    setWeekFilter(getDefaultWeekFilterValue());
    setQuery("");
    setShowArchive(false);
  };

  const selectAllTime = () => {
    setDateFilter({
      month: dateFilter.month,
      rangeStart: null,
      rangeEnd: null,
      allTime: true,
    });
  };

  const handleDateChange = (value: DateFilterValue) => {
    setDateFilter({ ...value, allTime: false });
  };

  return (
    <div className="surface-card-elevated flex flex-wrap items-end gap-4 p-4 md:p-5">
      {search && (
        <div className="grid gap-1.5">
          <Label htmlFor="f-search" className="cursor-default">
            Поиск
          </Label>
          <Input
            id="f-search"
            placeholder="Название / имя"
            className={cn("w-56", filterInputClass)}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      {date && (
        <div className="grid gap-1.5">
          <Label className="cursor-default">Дата</Label>
          <div className="flex flex-wrap items-center gap-2">
            <DateFilter value={dateFilter} onChange={handleDateChange} />
            {dateAllTime && (
              <Button
                type="button"
                variant={dateFilter.allTime ? "default" : "outline"}
                className={cn(
                  filterActionClass,
                  !dateFilter.allTime && "border-[#D0D5DD] bg-card hover:border-[#98A2B3] hover:bg-muted border",
                )}
                onClick={selectAllTime}
              >
                За всё время
              </Button>
            )}
          </div>
        </div>
      )}
      {weeks && (
        <WeekFilter month={dateFilter.month} value={weekFilter} onChange={setWeekFilter} />
      )}
      {archive && (
        <label className="border-border bg-card hover:border-[#98a2b3] hover:bg-muted/40 flex h-10 cursor-pointer items-center gap-2.5 self-end rounded-xl border px-3.5 text-sm font-medium transition-colors">
          <Checkbox
            id="f-archive"
            className="border-[#98a2b3] bg-card size-[18px] cursor-pointer"
            checked={showArchive}
            onCheckedChange={(v) => setShowArchive(v === true)}
          />
          Показать архив
        </label>
      )}
      <div className="ml-auto flex gap-2">
        <Button variant="ghost" className={filterActionClass} onClick={handleReset}>
          Сбросить
        </Button>
        <Button className={filterActionClass} onClick={onApply}>
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
