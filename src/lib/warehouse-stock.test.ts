import { describe, expect, it } from "vitest";
import {
  buildDetailStockRows,
  buildNomenclatureStockRows,
  buildProductStockRows,
  inventoryDeviation,
  inventoryDeviationSum,
} from "@/lib/warehouse-stock";
import type { StockSnapshot } from "@/types/domain";

describe("inventoryDeviation", () => {
  it("считает факт минус учёт", () => {
    expect(inventoryDeviation(100, 95)).toBe(-5);
    expect(inventoryDeviation(40, 42)).toBe(2);
  });
});

describe("inventoryDeviationSum", () => {
  it("умножает отклонение на себестоимость единицы", () => {
    expect(inventoryDeviationSum(-2, 52)).toBe(-104);
    expect(inventoryDeviationSum(3, 1.5)).toBe(4.5);
  });
});

describe("buildProductStockRows", () => {
  it("возвращает активные изделия с остатками", () => {
    const rows = buildProductStockRows({ "prod-1": 10, "prod-2": 5 });
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "prod-1")?.quantity).toBe(10);
  });
});

describe("buildDetailStockRows", () => {
  it("суммирует готовые и ожидающие присадку", () => {
    const snapshot: StockSnapshot = {
      detailsReady: { "det-1": 10 },
      nomenclature: {},
      prisadkaPending: { "det-1": { torcev: 5, plosk: 3 } },
    };
    const row = buildDetailStockRows(snapshot).find((r) => r.id === "det-1");
    expect(row?.ready).toBe(10);
    expect(row?.pendingPrisadka).toBe(8);
    expect(row?.quantity).toBe(18);
  });
});

describe("buildNomenclatureStockRows", () => {
  it("фильтрует по типу номенклатуры", () => {
    const rows = buildNomenclatureStockRows("FASTENER", {
      detailsReady: {},
      nomenclature: { "nom-1": 100 },
      prisadkaPending: {},
    });
    expect(rows.some((r) => r.id === "nom-1")).toBe(true);
    expect(rows.every((r) => r.name.length > 0)).toBe(true);
  });
});
