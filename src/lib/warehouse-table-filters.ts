import type {
  Marketplace,
  MpStockRow,
  ShipmentRow,
  ShipmentStatus,
} from "@/mocks/warehouse-fixtures";
import type { DetailStockRow, ProductionStockRow } from "@/lib/warehouse-stock";

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

export interface WarehouseProductionStockSlice {
  products: ProductionStockRow[];
  details: DetailStockRow[];
  fasteners: ProductionStockRow[];
  packaging: ProductionStockRow[];
  other: ProductionStockRow[];
  blanks?: ProductionStockRow[];
}

function matchesProductionName(row: { name?: string | null }, search: string): boolean {
  return (row.name ?? "").toLowerCase().includes(search);
}

function matchesProductRow(row: ProductionStockRow, search: string): boolean {
  if (matchesProductionName(row, search)) return true;
  return (row.sku ?? "").toLowerCase().includes(search);
}

/** Search по пяти видимым коллекциям; `blanks` не фильтруется (нет в UI). */
export function filterWarehouseProductionStock<T extends WarehouseProductionStockSlice>(
  stock: T,
  search: string,
): T {
  const q = search.trim().toLowerCase();
  if (!q) {
    return {
      ...stock,
      products: stock.products.slice(),
      details: stock.details.slice(),
      fasteners: stock.fasteners.slice(),
      packaging: stock.packaging.slice(),
      other: stock.other.slice(),
    };
  }
  return {
    ...stock,
    products: stock.products.filter((row) => matchesProductRow(row, q)),
    details: stock.details.filter((row) => matchesProductionName(row, q)),
    fasteners: stock.fasteners.filter((row) => matchesProductionName(row, q)),
    packaging: stock.packaging.filter((row) => matchesProductionName(row, q)),
    other: stock.other.filter((row) => matchesProductionName(row, q)),
  };
}
