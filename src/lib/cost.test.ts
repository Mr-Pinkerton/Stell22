import { describe, expect, it } from "vitest";
import {
  D,
  detailLaborCost,
  directProductCost,
  distributeBatchCost,
  fullProductCost,
  isBatchCostMismatch,
  isSortRatioMismatch,
  materialPerDetail,
  overheadForProduct,
  productLaborCost,
  productMaterialsCost,
  roundRubles,
  sectionAreaM2,
  sortShare2ByLength,
} from "./cost";

const area = sectionAreaM2(40, 20); // 0.0008 м²

describe("sectionAreaM2", () => {
  it("переводит мм в м² (40×20 = 0.0008)", () => {
    expect(area.toNumber()).toBe(0.0008);
  });
});

describe("distributeBatchCost", () => {
  it("распределяет C по сортам пропорционально P·V", () => {
    const r = distributeBatchCost({
      totalCost: 100_000,
      priceSort1: 30_000,
      priceSort2: 20_000,
      sectionAreaM2: area,
      producedLengthSort1: 1000,
      producedLengthSort2: 500,
    });

    expect(r.volumeSort1.toNumber()).toBe(0.8);
    expect(r.volumeSort2.toNumber()).toBe(0.4);
    expect(r.share1.toNumber()).toBe(0.75);
    expect(r.share2.toNumber()).toBe(0.25);
    expect(r.costSort1.toNumber()).toBe(75_000);
    expect(r.costSort2.toNumber()).toBe(25_000);
    expect(r.pricePerM3Sort1.toNumber()).toBe(93_750);
    expect(r.pricePerM3Sort2.toNumber()).toBe(62_500);
  });

  it("сумма стоимостей сортов точно сходится к C (Decimal, без дрейфа)", () => {
    const r = distributeBatchCost({
      totalCost: 100,
      priceSort1: 1,
      priceSort2: 1,
      sectionAreaM2: 1,
      producedLengthSort1: 1, // доля 1/3 — бесконечная дробь
      producedLengthSort2: 2,
    });
    expect(r.costSort1.plus(r.costSort2).equals(D(100))).toBe(true);
    expect(r.share1.plus(r.share2).equals(D(1))).toBe(true);
  });

  it("один сорт: вся стоимость на него, без деления на ноль", () => {
    const r = distributeBatchCost({
      totalCost: 50_000,
      priceSort1: 30_000,
      priceSort2: 20_000,
      sectionAreaM2: area,
      producedLengthSort1: 1000,
      producedLengthSort2: 0,
    });
    expect(r.costSort1.toNumber()).toBe(50_000);
    expect(r.costSort2.toNumber()).toBe(0);
    expect(r.pricePerM3Sort2.toNumber()).toBe(0);
  });

  it("нет производства — всё по нулям", () => {
    const r = distributeBatchCost({
      totalCost: 50_000,
      priceSort1: 30_000,
      priceSort2: 20_000,
      sectionAreaM2: area,
      producedLengthSort1: 0,
      producedLengthSort2: 0,
    });
    expect(r.costSort1.toNumber()).toBe(0);
    expect(r.costSort2.toNumber()).toBe(0);
    expect(r.pricePerM3Sort1.toNumber()).toBe(0);
  });
});

describe("materialPerDetail", () => {
  it("цена м³ × длина × сечение", () => {
    expect(materialPerDetail(93_750, 0.6, area).toNumber()).toBe(45);
  });
});

describe("sortShare2ByLength", () => {
  it("доля 2 сорта по длине", () => {
    expect(sortShare2ByLength(1000, 500).toFixed(4)).toBe("0.3333");
  });
  it("0 при нулевой длине", () => {
    expect(sortShare2ByLength(0, 0).toNumber()).toBe(0);
  });
});

describe("isSortRatioMismatch", () => {
  it("true когда факт превышает заявленное более чем на 10 п.п.", () => {
    expect(isSortRatioMismatch(0.2, 0.31)).toBe(true);
  });
  it("false на границе и ниже", () => {
    expect(isSortRatioMismatch(0.2, 0.3)).toBe(false);
    expect(isSortRatioMismatch(0.2, 0.29)).toBe(false);
  });
});

describe("isBatchCostMismatch", () => {
  const base = {
    priceSort1: 30_000,
    priceSort2: 20_000,
    volumeSort1: 0.8,
    volumeSort2: 0.4,
  }; // расчётная = 24000 + 8000 = 32000

  it("false когда введённая совпадает в пределах допуска", () => {
    expect(isBatchCostMismatch({ ...base, totalCost: 32_000 })).toBe(false);
    expect(isBatchCostMismatch({ ...base, totalCost: 32_000.5 })).toBe(false);
  });
  it("true при заметном расхождении", () => {
    expect(isBatchCostMismatch({ ...base, totalCost: 33_000 })).toBe(true);
  });
});

describe("detailLaborCost", () => {
  it("торцовка + обе присадки", () => {
    expect(
      detailLaborCost({
        torcovkaRate: 10,
        requiresTorcevPrisadka: true,
        prisadkaTorcevRate: 5,
        requiresPloskPrisadka: true,
        prisadkaPloskRate: 3,
      }).toNumber(),
    ).toBe(18);
  });
  it("только требуемая присадка добавляется", () => {
    expect(
      detailLaborCost({
        torcovkaRate: 10,
        requiresTorcevPrisadka: true,
        prisadkaTorcevRate: 5,
        prisadkaPloskRate: 3, // не требуется — не учитывается
      }).toNumber(),
    ).toBe(15);
  });
  it("без присадок — только торцовка", () => {
    expect(detailLaborCost({ torcovkaRate: 10 }).toNumber()).toBe(10);
  });
});

describe("productLaborCost", () => {
  it("Σ(работа × кол-во) + упаковка", () => {
    expect(
      productLaborCost(
        [
          { laborPerUnit: 18, quantity: 2 },
          { laborPerUnit: 10, quantity: 1 },
        ],
        7,
      ).toNumber(),
    ).toBe(53);
  });
});

describe("productMaterialsCost", () => {
  it("крепёж + упаковка + разное", () => {
    expect(
      productMaterialsCost({
        fasteners: [{ unitPrice: 2, quantity: 4 }],
        packagingPrice: 15,
        extras: [3, 5],
      }).toNumber(),
    ).toBe(31);
  });
});

describe("directProductCost", () => {
  it("материал + работа + крепёж/упаковка/разное", () => {
    expect(
      directProductCost({ material: 45, labor: 53, materialsExtra: 31 }).toNumber(),
    ).toBe(129);
  });
});

describe("overheadForProduct", () => {
  it("распределение пропорционально прямой", () => {
    expect(
      overheadForProduct({
        directCost: 129,
        periodOverhead: 10_000,
        periodTotalDirect: 50_000,
      }).toNumber(),
    ).toBe(25.8);
  });
  it("0 при нулевой сумме прямых за период", () => {
    expect(
      overheadForProduct({
        directCost: 129,
        periodOverhead: 10_000,
        periodTotalDirect: 0,
      }).toNumber(),
    ).toBe(0);
  });
});

describe("fullProductCost", () => {
  it("прямая + накладные", () => {
    expect(fullProductCost(129, 25.8).toNumber()).toBe(154.8);
  });
});

describe("roundRubles", () => {
  it("половинное округление вверх до целых рублей", () => {
    expect(roundRubles(154.5).toNumber()).toBe(155);
    expect(roundRubles(154.4).toNumber()).toBe(154);
    expect(roundRubles(154.8).toNumber()).toBe(155);
  });
});
