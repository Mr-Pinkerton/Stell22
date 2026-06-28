"use client";

import { cn } from "@/lib/utils";
import { DateFilter, type DateFilterValue } from "@/components/date-filter";
import { getCurrentMonth } from "@/lib/dates";
import type { DashboardPeriodMode } from "@/lib/dashboard-period";

const tabsListClass = "bg-muted inline-flex gap-1 rounded-2xl p-1";
const tabClass =
  "h-10 cursor-pointer rounded-xl px-4 text-sm font-semibold transition-colors";

interface DashboardPeriodFilterProps {
  mode: DashboardPeriodMode;
  onModeChange: (mode: DashboardPeriodMode) => void;
  customRange: DateFilterValue;
  onCustomRangeChange: (value: DateFilterValue) => void;
}

const MODES: { key: DashboardPeriodMode; label: string }[] = [
  { key: "month", label: "Текущий месяц" },
  { key: "week", label: "Текущая неделя" },
  { key: "custom", label: "Произвольный период" },
];

export function DashboardPeriodFilter({
  mode,
  onModeChange,
  customRange,
  onCustomRangeChange,
}: DashboardPeriodFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className={tabsListClass} role="tablist" aria-label="Период дашборда">
        {MODES.map(({ key, label }) => {
          const active = mode === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onModeChange(key)}
              className={cn(
                tabClass,
                active
                  ? "bg-card text-foreground shadow-soft"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          );
        })}
      </div>

      {mode === "custom" && (
        <DateFilter value={customRange} onChange={onCustomRangeChange} />
      )}
    </div>
  );
}

export function getDefaultDashboardCustomRange(): DateFilterValue {
  const month = getCurrentMonth();
  return { month, rangeStart: null, rangeEnd: null, allTime: false };
}
