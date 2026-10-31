"use client";

import type { ReactNode } from "react";
import type { DateFilterValue } from "@/components/date-filter";
import { FiltersBar } from "@/components/filters-bar";

/** Общий период финансов. Несколько карточек показывают одно и то же значение. */
export function FinancePeriodFilters({
  idPrefix = "",
  dateFilter,
  onDateFilterChange,
  search = false,
  searchValue,
  onSearchChange,
  extraFilters,
  extraFiltersDirty = false,
  onResetExtraFilters,
}: {
  idPrefix?: string;
  dateFilter: DateFilterValue;
  onDateFilterChange: (value: DateFilterValue) => void;
  search?: boolean;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  extraFilters?: ReactNode;
  extraFiltersDirty?: boolean;
  onResetExtraFilters?: () => void;
}) {
  return (
    <FiltersBar
      embedded
      idPrefix={idPrefix}
      date
      dateAllTime
      dateFilterValue={dateFilter}
      onDateFilterChange={onDateFilterChange}
      search={search}
      searchPlaceholder="Описание или контрагент"
      searchValue={searchValue}
      onSearchChange={onSearchChange}
      extraFilters={extraFilters}
      extraFiltersDirty={extraFiltersDirty}
      onResetExtraFilters={onResetExtraFilters}
    />
  );
}
