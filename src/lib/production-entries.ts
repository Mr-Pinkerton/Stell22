import type { DateFilterValue } from "@/components/date-filter";
import { matchesDateFilter } from "@/lib/match-date-filter";
import type { ProductionEntryRow } from "@/mocks/production-fixtures";
import type { OperationType } from "@/types/domain";
import { TIME_ZONE } from "@/lib/format";

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

export const PRODUCTION_FILTER_ALL = "ALL";

export type ProductionOperationFilter = "ALL" | OperationType;
export type ProductionPaymentFilter = "ALL" | "PAID" | "UNPAID";

export interface ProductionTableFilters {
  employeeId: typeof PRODUCTION_FILTER_ALL | (string & {});
  operation: ProductionOperationFilter;
  payment: ProductionPaymentFilter;
}

export function getDefaultProductionTableFilters(): ProductionTableFilters {
  return {
    employeeId: PRODUCTION_FILTER_ALL,
    operation: PRODUCTION_FILTER_ALL,
    payment: PRODUCTION_FILTER_ALL,
  };
}

export function isProductionExtraFiltersDefault(input: ProductionTableFilters): boolean {
  return (
    input.employeeId === PRODUCTION_FILTER_ALL &&
    input.operation === PRODUCTION_FILTER_ALL &&
    input.payment === PRODUCTION_FILTER_ALL
  );
}

export interface ProductionEmployeeOption {
  id: string;
  label: string;
}

/** Уникальные сотрудники журнала (по employeeId). Label — первое встреченное ФИО. */
export function productionEmployeeOptions(
  rows: Pick<ProductionEntryRow, "employeeId" | "employeeName">[],
): ProductionEmployeeOption[] {
  const byId = new Map<string, string>();
  for (const row of rows) {
    if (!byId.has(row.employeeId)) byId.set(row.employeeId, row.employeeName);
  }
  return [...byId.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort(
      (a, b) => a.label.localeCompare(b.label, "ru") || a.id.localeCompare(b.id),
    );
}

/** Фильтр по дате операции (workDate). */
export function filterProductionEntries(
  rows: ProductionEntryRow[],
  filter: DateFilterValue,
): ProductionEntryRow[] {
  return rows.filter((row) => matchesDateFilter(row.workDate, filter));
}

/** Локальные фильтры журнала поверх уже отрезанного периода. */
export function filterProductionTableRows<T extends ProductionEntryRow>(
  rows: T[],
  filters: ProductionTableFilters,
): T[] {
  return rows.filter((row) => {
    if (filters.employeeId !== PRODUCTION_FILTER_ALL && row.employeeId !== filters.employeeId) {
      return false;
    }
    if (filters.operation !== PRODUCTION_FILTER_ALL && row.type !== filters.operation) {
      return false;
    }
    if (filters.payment === "PAID" && row.isPaid !== true) return false;
    if (filters.payment === "UNPAID" && row.isPaid !== false) return false;
    return true;
  });
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
