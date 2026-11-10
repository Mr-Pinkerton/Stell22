import { describe, expect, it } from "vitest";
import {
  buildDetailStockRows,
  buildNomenclatureStockRows,
  buildPhysicalDetailStockRows,
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
      blanks: {},
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

function stockDetail(
  id: string,
  name: string,
  prisadkaTorcevaya: boolean,
  prisadkaPloskost: boolean,
) {
  return { id, name, prisadkaTorcevaya, prisadkaPloskost };
}

describe("buildPhysicalDetailStockRows", () => {
  it("не копирует общий пул заготовок на каждую подходящую деталь", () => {
    const rows = buildPhysicalDetailStockRows(
      [
        stockDetail("plain-a", "Полка без присадки", false, false),
        stockDetail("plain-b", "Канавка без присадки", false, false),
        stockDetail("both", "Полка с двумя присадками", true, true),
      ],
      [],
    );
    expect(rows).toEqual([]);
  });

  it("считает неготовые детали один раз", () => {
    const rows = buildPhysicalDetailStockRows(
      [stockDetail("both", "Полка с двумя присадками", true, true)],
      [{ detailId: "both", torcevayaDone: false, ploskostDone: false, quantity: 10 }],
    );
    expect(rows).toEqual([
      {
        id: "both",
        name: "Полка с двумя присадками",
        ready: 0,
        pendingPrisadka: 10,
        quantity: 10,
      },
    ]);
  });

  it("складывает готовые и частично обработанные по штукам", () => {
    const rows = buildPhysicalDetailStockRows(
      [stockDetail("both", "Полка с двумя присадками", true, true)],
      [
        { detailId: "both", torcevayaDone: true, ploskostDone: false, quantity: 4 },
        { detailId: "both", torcevayaDone: true, ploskostDone: true, quantity: 3 },
      ],
    );
    expect(rows).toEqual([
      {
        id: "both",
        name: "Полка с двумя присадками",
        ready: 3,
        pendingPrisadka: 4,
        quantity: 7,
      },
    ]);
  });
});

describe("buildNomenclatureStockRows", () => {
  it("фильтрует по типу номенклатуры", () => {
    const rows = buildNomenclatureStockRows("FASTENER", {
      blanks: {},
      detailsReady: {},
      nomenclature: { "nom-1": 100 },
      prisadkaPending: {},
    });
    expect(rows.some((r) => r.id === "nom-1")).toBe(true);
    expect(rows.every((r) => r.name.length > 0)).toBe(true);
  });
});
