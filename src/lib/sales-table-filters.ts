import type { SalesReportRow } from "@/mocks/report-fixtures";

function matchesSkuOrProductName(
  row: Pick<SalesReportRow, "sku" | "productName">,
  search: string,
): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  const sku = (row.sku ?? "").toLowerCase();
  const name = (row.productName ?? "").toLowerCase();
  return sku.includes(q) || name.includes(q);
}

/** Instant search по агрегированной таблице продаж. KPI не затрагивает. */
export function filterSalesRows<T extends Pick<SalesReportRow, "sku" | "productName">>(
  rows: T[],
  search: string,
): T[] {
  const q = search.trim();
  if (!q) return rows.slice();
  return rows.filter((row) => matchesSkuOrProductName(row, q));
}
