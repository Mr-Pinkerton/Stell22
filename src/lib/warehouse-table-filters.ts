import type {
  Marketplace,
  MpStockRow,
  ShipmentRow,
  ShipmentStatus,
} from "@/mocks/warehouse-fixtures";

export const WAREHOUSE_FILTER_ALL = "ALL";

export type WarehouseMarketplaceFilter = "ALL" | Marketplace;
export type WarehouseShipmentStatusFilter = "ALL" | ShipmentStatus;

export interface MpTableFilters {
  search: string;
  marketplace: WarehouseMarketplaceFilter;
}

export interface ShipmentTableFilters {
  search: string;
  marketplace: WarehouseMarketplaceFilter;
  status: WarehouseShipmentStatusFilter;
}

export function getDefaultMpTableFilters(): MpTableFilters {
  return { search: "", marketplace: WAREHOUSE_FILTER_ALL };
}

export function getDefaultShipmentTableFilters(): ShipmentTableFilters {
  return {
    search: "",
    marketplace: WAREHOUSE_FILTER_ALL,
    status: WAREHOUSE_FILTER_ALL,
  };
}

/** Marketplace extra (поиск — встроенный FiltersBar). */
export function isMpExtraFiltersDefault(input: MpTableFilters): boolean {
  return input.marketplace === WAREHOUSE_FILTER_ALL;
}

export function isShipmentExtraFiltersDefault(input: ShipmentTableFilters): boolean {
  return input.marketplace === WAREHOUSE_FILTER_ALL && input.status === WAREHOUSE_FILTER_ALL;
}

function matchesSkuOrProductName(
  row: { sku?: string | null; productName?: string | null },
  search: string,
): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const sku = (row.sku ?? "").toLowerCase();
  const name = (row.productName ?? "").toLowerCase();
  return sku.includes(q) || name.includes(q);
}

export function filterMpStockRows<T extends MpStockRow>(rows: T[], filters: MpTableFilters): T[] {
  return rows.filter((row) => {
    if (!matchesSkuOrProductName(row, filters.search)) return false;
    if (filters.marketplace !== WAREHOUSE_FILTER_ALL && row.marketplace !== filters.marketplace) {
      return false;
    }
    return true;
  });
}

export function filterShipmentRows<T extends ShipmentRow>(
  rows: T[],
  filters: ShipmentTableFilters,
): T[] {
  return rows.filter((row) => {
    if (!matchesSkuOrProductName(row, filters.search)) return false;
    if (filters.marketplace !== WAREHOUSE_FILTER_ALL && row.marketplace !== filters.marketplace) {
      return false;
    }
    if (filters.status !== WAREHOUSE_FILTER_ALL && row.status !== filters.status) return false;
    return true;
  });
}
