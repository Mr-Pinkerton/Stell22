"use client";

import { useEffect, useMemo, useState } from "react";
import { buildPayWeeksForMonth } from "@/lib/pay-weeks";
import { FILTER_SELECT_WIDTH, filterSelectTriggerClass } from "@/components/filter-fields";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

const ALL_WEEKS = "all";

const triggerClass = cn(filterSelectTriggerClass, FILTER_SELECT_WIDTH);

const contentClass = "rounded-xl shadow-balanced ring-0 p-1.5";

interface WeekFilterProps {
  month: Date;
  value?: string;
  onChange?: (value: string) => void;
}

export function WeekFilter({ month, value, onChange }: WeekFilterProps) {
  const [internal, setInternal] = useState("");
  const selected = value ?? internal;
  const weeks = useMemo(() => buildPayWeeksForMonth(month), [month]);

  useEffect(() => {
    if (value === undefined) setInternal("");
  }, [month, value]);

  const setSelected = (next: string) => {
    const normalized = next === ALL_WEEKS ? "" : next;
    if (value === undefined) setInternal(normalized);
    onChange?.(normalized);
  };

  const display =
    selected && weeks.find((w) => w.id === selected)?.label
      ? weeks.find((w) => w.id === selected)!.label
      : "Все недели";

  return (
    <Select
      value={selected || ALL_WEEKS}
      onValueChange={(v) => setSelected(v ?? ALL_WEEKS)}
    >
      <SelectTrigger className={triggerClass}>
        <SelectValue placeholder="Все недели">{display}</SelectValue>
      </SelectTrigger>
      <SelectContent className={contentClass} side="bottom" sideOffset={8} alignItemWithTrigger={false}>
        <SelectItem value={ALL_WEEKS} className="cursor-pointer rounded-lg">
          Все недели
        </SelectItem>
        {weeks.map((week) => (
          <SelectItem key={week.id} value={week.id} className="cursor-pointer rounded-lg">
            {week.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function getDefaultWeekFilterValue(): string {
  return "";
}
