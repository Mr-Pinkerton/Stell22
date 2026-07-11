import { describe, expect, it } from "vitest";
import { computeBatchStats, resolveRailQuantity, sectionAreaM2 } from "./batch-stats";
import type { Batch, RailLot } from "@/types/domain";

const batch: Batch = {
  id: "b1",
  name: "Test",
  materialId: "mat-1",
  sectionWidthMm: 20,
  sectionHeightMm: 40,
  purchaseCost: 100000,
  totalCost: 100000,
  priceSort1: 20000,
  priceSort2: 15000,
  status: "IN_WORK",
  purchaseDate: "2026-06-01",
};

describe("sectionAreaM2", () => {
  it("переводит мм в м²", () => {
    expect(sectionAreaM2(20, 40)).toBe(0.0008);
  });
});

describe("resolveRailQuantity", () => {
  it("берёт количество из поля, если ряды/слои не заданы", () => {
    expect(resolveRailQuantity({ quantity: 50 })).toBe(50);
  });

  it("считает ряды × слои, если оба заданы", () => {
    expect(resolveRailQuantity({ quantity: 10, rows: 24, layers: 34 })).toBe(816);
  });

  it("приоритет у рядов×слоёв над ручным количеством", () => {
    expect(resolveRailQuantity({ quantity: 100, rows: 5, layers: 4 })).toBe(20);
  });

  it("null, если количество не определено", () => {
    expect(resolveRailQuantity({})).toBeNull();
    expect(resolveRailQuantity({ rows: 5 })).toBeNull();
    expect(resolveRailQuantity({ layers: 4 })).toBeNull();
  });
});

describe("computeBatchStats", () => {
  const lots: RailLot[] = [
    {
      id: "l1",
      batchId: "b1",
      lengthM: 2.4,
      railType: "POLKA",
      sort: "SORT1",
      isPackage: true,
      quantity: 10,
      remainingQuantity: 10,
    },
    {
      id: "l2",
      batchId: "b1",
      lengthM: 3,
      railType: "KANAVKA",
      sort: "SORT2",
      isPackage: false,
      quantity: 5,
      remainingQuantity: 5,
    },
  ];

  it("считает кол-во, длину и объём", () => {
    const stats = computeBatchStats(batch, lots);
    expect(stats.railCount).toBe(15);
    expect(stats.totalLengthM).toBe(10 * 2.4 + 5 * 3);
    expect(stats.volumeM3).toBeCloseTo(0.0008 * (10 * 2.4 + 5 * 3));
    expect(stats.packageCount).toBe(1);
  });
});
