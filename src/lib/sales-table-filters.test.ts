import { describe, expect, it } from "vitest";
import { filterSalesRows } from "@/lib/sales-table-filters";
import type { SalesReportRow } from "@/mocks/report-fixtures";

const rows: SalesReportRow[] = [
  { id: "OZ-001", productName: "Полка настенная", sku: "OZ-001", soldQty: 75, revenue: 90_000 },
  { id: "WB-001", productName: "Полка настенная", sku: "WB-001", soldQty: 31, revenue: 37_200 },
  { id: "OZ-002", productName: "Ящик", sku: "OZ-002", soldQty: 22, revenue: 33_000 },
];

describe("filterSalesRows", () => {
  it("empty query → все rows", () => {
    expect(filterSalesRows(rows, "")).toEqual(rows);
  });

  it("whitespace query → все", () => {
    expect(filterSalesRows(rows, "   ")).toEqual(rows);
  });

  it("поиск по exact SKU", () => {
    expect(filterSalesRows(rows, "OZ-002").map((r) => r.sku)).toEqual(["OZ-002"]);
  });

  it("partial SKU", () => {
    expect(filterSalesRows(rows, "WB-").map((r) => r.sku)).toEqual(["WB-001"]);
  });

  it("SKU case-insensitive", () => {
    expect(filterSalesRows(rows, "oz-001").map((r) => r.sku)).toEqual(["OZ-001"]);
  });

  it("productName", () => {
    expect(filterSalesRows(rows, "Ящик").map((r) => r.sku)).toEqual(["OZ-002"]);
  });

  it("productName case-insensitive", () => {
    expect(filterSalesRows(rows, "полка").map((r) => r.sku)).toEqual(["OZ-001", "WB-001"]);
  });

  it("trim query", () => {
    expect(filterSalesRows(rows, "  Ящик  ").map((r) => r.sku)).toEqual(["OZ-002"]);
  });

  it("no match → []", () => {
    expect(filterSalesRows(rows, "нет-такого")).toEqual([]);
  });

  it("исходный порядок сохраняется", () => {
    expect(filterSalesRows(rows, "полка").map((r) => r.sku)).toEqual(["OZ-001", "WB-001"]);
  });

  it("source array не мутируется", () => {
    const snapshot = rows.map((r) => r.sku);
    const next = filterSalesRows(rows, "");
    next.push({ id: "x", productName: "X", sku: "X", soldQty: 1, revenue: 1 });
    expect(rows.map((r) => r.sku)).toEqual(snapshot);
  });

  it("search не меняет исходные totals SalesData", () => {
    const data = {
      rows,
      totalQty: 128,
      totalRevenue: 160_200,
      lastSyncedAt: null,
    };
    filterSalesRows(data.rows, "Ящик");
    expect(data.totalQty).toBe(128);
    expect(data.totalRevenue).toBe(160_200);
    expect(data.rows).toBe(rows);
  });
});
