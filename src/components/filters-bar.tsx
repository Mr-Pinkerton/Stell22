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

const filterInputClass =
  "border-border bg-card hover:border-[#98a2b3] focus-visible:border-ring focus-visible:bg-card h-10 min-h-10 cursor-text rounded-xl border px-4";

const filterActionClass = "h-10 cursor-pointer rounded-xl px-4";

export function FiltersBar({ search, date, weeks, archive }: SectionFilters) {
  const hasAny = search || date || weeks || archive;
  const [dateFilter, setDateFilter] = useState<DateFilterValue>(getDefaultDateFilterValue);

  if (!hasAny) return null;

  const handleReset = () => {
    setDateFilter(getDefaultDateFilterValue());
  };

  return (
    <div className="surface-card flex flex-wrap items-end gap-4 p-4 md:p-5">
      {search && (
        <div className="grid gap-1.5">
          <Label htmlFor="f-search" className="cursor-default">
            Поиск
          </Label>
          <Input id="f-search" placeholder="Название / имя" className={cn("w-56", filterInputClass)} />
        </div>
      )}
      {date && (
        <div className="grid gap-1.5">
          <DateFilter value={dateFilter} onChange={setDateFilter} />
        </div>
      )}
      {weeks && (
        <div className="grid gap-1.5">
          <Label htmlFor="f-week" className="cursor-default">
            Неделя
          </Label>
          <Input id="f-week" placeholder="Неделя месяца" className={cn("w-40", filterInputClass)} />
        </div>
      )}
      {archive && (
        <label className="border-border bg-card hover:border-[#98a2b3] hover:bg-muted/40 flex h-10 cursor-pointer items-center gap-2.5 self-end rounded-xl border px-3.5 text-sm font-medium transition-colors">
          <Checkbox
            id="f-archive"
            className="border-[#98a2b3] bg-card size-[18px] cursor-pointer"
          />
          Показать архив
        </label>
      )}
      <div className="ml-auto flex gap-2">
        <Button variant="ghost" className={filterActionClass} onClick={handleReset}>
          Сбросить
        </Button>
        <Button className={filterActionClass}>Показать</Button>
      </div>
    </div>
  );
}
