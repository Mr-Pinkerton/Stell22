import type { DateFilterValue } from "@/components/date-filter";
import { matchesDateFilter } from "@/lib/match-date-filter";
import type { ProductionEntryRow } from "@/mocks/production-fixtures";
import type { OperationType } from "@/types/domain";

const TIME_ZONE = "Europe/Moscow";

export const OPERATION_TYPE_LABEL: Record<OperationType, string> = {
  TORCOVKA: "Торцовка",
  PRISADKA: "Присадка",
  UPAKOVKA: "Упаковка",
  HOURS: "Часы",
};

export const OPERATION_TYPE_UNIT: Record<OperationType, string> = {
  TORCOVKA: "дет",
  PRISADKA: "присадк.",
  UPAKOVKA: "шт",
  HOURS: "ч",
};

/** Фильтр по дате операции (workDate). */
export function filterProductionEntries(
  rows: ProductionEntryRow[],
  filter: DateFilterValue,
): ProductionEntryRow[] {
  return rows.filter((row) => matchesDateFilter(row.workDate, filter));
}

/** Свежие внесения сверху. */
export function sortProductionEntries(rows: ProductionEntryRow[]): ProductionEntryRow[] {
  return [...rows].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

/** Время внесения в зоне проекта, напр. «14:30». */
export function formatEntryTime(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Дата/время для журнала изменений. */
export function formatChangeLogWhen(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}
