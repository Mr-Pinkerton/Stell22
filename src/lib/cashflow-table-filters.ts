import type { FlowType } from "@/types/domain";

export type CashFlowTableFlowType = "ALL" | FlowType;

export interface CashFlowTableFilters {
  search: string;
  flowType: CashFlowTableFlowType;
  unassignedOnly: boolean;
}

export interface CashFlowTableRow {
  description?: string | null;
  counterpartyName?: string | null;
  flowType: FlowType;
  isAutoAssigned: boolean;
}

export function getDefaultCashFlowTableFilters(): CashFlowTableFilters {
  return { search: "", flowType: "ALL", unassignedOnly: false };
}

/** Select/checkbox ДДС (поиск — встроенный FiltersBar). */
export function isCashFlowExtraFiltersDefault(
  input: Pick<CashFlowTableFilters, "flowType" | "unassignedOnly">,
): boolean {
  return input.flowType === "ALL" && !input.unassignedOnly;
}

function matchesSearch(row: CashFlowTableRow, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const description = (row.description ?? "").toLowerCase();
  const counterparty = (row.counterpartyName ?? "").toLowerCase();
  return description.includes(q) || counterparty.includes(q);
}

/** Локальные фильтры таблицы ДДС поверх уже отрезанного периода. */
export function filterCashFlowTableRows<T extends CashFlowTableRow>(
  rows: T[],
  filters: CashFlowTableFilters,
): T[] {
  return rows.filter((row) => {
    if (!matchesSearch(row, filters.search)) return false;
    if (filters.flowType !== "ALL" && row.flowType !== filters.flowType) return false;
    if (filters.unassignedOnly && row.isAutoAssigned !== false) return false;
    return true;
  });
}
