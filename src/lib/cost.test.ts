import { describe, expect, it } from "vitest";
import {
  canFreezeBatch,
  D,
  detailLaborCost,
  directProductCost,
  distributeBatchCost,
  persistSortCosts,
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

describe("persistSortCosts", () => {
  it("не округляет 1.005 и 8.995 независимо", () => {
    const stored = persistSortCosts({
      totalCost: "10.00",
      costSort1: "1.005",
      costSort2: "8.995",
      volumeSort1: "201",
      volumeSort2: "1799",
    });
    expect(stored.costSort1.toFixed(2)).toBe("1.01");
    expect(stored.costSort2.toFixed(2)).toBe("8.99");
    expect(stored.costSort1.plus(stored.costSort2).toFixed(2)).toBe("10.00");
  });

  it("метры 201 и 1799 при C = 10.00 сходятся в хранимой сумме", () => {
    const area = sectionAreaM2(1000, 1000);
    const raw = distributeBatchCost({
      totalCost: "10.00",
      priceSort1: "1.00",
      priceSort2: "1.00",
      sectionAreaM2: area,
      producedLengthSort1: 201,
      producedLengthSort2: 1799,
    });
    const stored = persistSortCosts({
      totalCost: "10.00",
      costSort1: raw.costSort1,
      costSort2: raw.costSort2,
      volumeSort1: raw.volumeSort1,
      volumeSort2: raw.volumeSort2,
    });
    expect(raw.costSort1.toFixed(3)).toBe("1.005");
    expect(raw.costSort2.toFixed(3)).toBe("8.995");
    expect(stored.costSort1.plus(stored.costSort2).toFixed(2)).toBe("10.00");
    expect(stored.pricePerM3Sort1.toFixed(2)).toBe(stored.costSort1.div(raw.volumeSort1).toFixed(2));
    expect(stored.pricePerM3Sort2.toFixed(2)).toBe(stored.costSort2.div(raw.volumeSort2).toFixed(2));
  });

  it("один сорт получает весь сохранённый C", () => {
    const stored = persistSortCosts({
      totalCost: "10.00",
      costSort1: "10.00",
      costSort2: "0",
      volumeSort1: "4",
      volumeSort2: "0",
    });
    expect(stored.costSort1.toFixed(2)).toBe("10.00");
    expect(stored.costSort2.toFixed(2)).toBe("0.00");
  });

  it("оба сорта сохраняют пропорцию и остаток", () => {
    const stored = persistSortCosts({
      totalCost: "100.00",
      costSort1: "33.333333",
      costSort2: "66.666667",
      volumeSort1: "1",
      volumeSort2: "2",
    });
    expect(stored.costSort1.toFixed(2)).toBe("33.33");
    expect(stored.costSort2.toFixed(2)).toBe("66.67");
    expect(stored.costSort1.plus(stored.costSort2).toFixed(2)).toBe("100.00");
  });

  it("границы половины копейки не увеличивают сумму сверх C", () => {
    const up = persistSortCosts({
      totalCost: "10.00",
      costSort1: "1.005",
      costSort2: "8.995",
      volumeSort1: "1",
      volumeSort2: "1",
    });
    const down = persistSortCosts({
      totalCost: "10.00",
      costSort1: "1.004",
      costSort2: "8.996",
      volumeSort1: "1",
      volumeSort2: "1",
    });
    expect(up.costSort1.plus(up.costSort2).toFixed(2)).toBe("10.00");
    expect(down.costSort1.toFixed(2)).toBe("1.00");
    expect(down.costSort2.toFixed(2)).toBe("9.00");
  });

  it("нулевой выпуск не распределяет C", () => {
    const stored = persistSortCosts({
      totalCost: "10.00",
      costSort1: "0",
      costSort2: "0",
      volumeSort1: "0",
      volumeSort2: "0",
    });
    expect(stored.costSort1.toFixed(2)).toBe("0.00");
    expect(stored.costSort2.toFixed(2)).toBe("0.00");
    expect(stored.pricePerM3Sort1.toFixed(2)).toBe("0.00");
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

  // A2: цены сортов не заданы (0), но детали произведены — C НЕ должна теряться.
  // Пропорция по деньгам не определена → fallback по объёму (равные цены).
  it("нулевые цены обоих сортов: C распределяется по объёму, сумма сходится к C", () => {
    const r = distributeBatchCost({
      totalCost: 60_000,
      priceSort1: 0,
      priceSort2: 0,
      sectionAreaM2: area,
      producedLengthSort1: 1000, // V1 = 0.8
      producedLengthSort2: 500, // V2 = 0.4  → доля 2/3 и 1/3
    });
    expect(r.share1.toNumber()).toBeCloseTo(2 / 3, 10);
    expect(r.share2.toNumber()).toBeCloseTo(1 / 3, 10);
    expect(r.costSort1.toNumber()).toBe(40_000);
    expect(r.costSort2.toNumber()).toBe(20_000);
    expect(r.costSort1.plus(r.costSort2).equals(D(60_000))).toBe(true);
    expect(r.pricePerM3Sort1.toNumber()).toBe(50_000);
    expect(r.pricePerM3Sort2.toNumber()).toBe(50_000);
  });

  // A2 (граница): один сорт бесплатен по прайсу — пропорция по деньгам валидна,
  // вся C ложится на платный сорт, ничего не теряется.
  it("P1=0, P2>0: вся C уходит на сорт 2, сумма сходится к C", () => {
    const r = distributeBatchCost({
      totalCost: 50_000,
      priceSort1: 0,
      priceSort2: 20_000,
      sectionAreaM2: area,
      producedLengthSort1: 1000,
      producedLengthSort2: 500,
    });
    expect(r.costSort1.toNumber()).toBe(0);
    expect(r.costSort2.toNumber()).toBe(50_000);
    expect(r.costSort1.plus(r.costSort2).equals(D(50_000))).toBe(true);
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

describe("canFreezeBatch — заморозка только при closedAt + все выплаты (A5)", () => {
  const closed = "2026-06-10T00:00:00.000Z";

  it("выработана и всё выплачено → можно", () => {
    expect(canFreezeBatch({ frozenAt: null, closedAt: closed, unpaidTorcovkaCount: 0 })).toBe(true);
  });

  it("есть невыплаченные операции → нельзя", () => {
    expect(canFreezeBatch({ frozenAt: null, closedAt: closed, unpaidTorcovkaCount: 1 })).toBe(false);
  });

  it("не выработана (нет closedAt) → нельзя, даже если всё выплачено", () => {
    expect(canFreezeBatch({ frozenAt: null, closedAt: null, unpaidTorcovkaCount: 0 })).toBe(false);
  });

  it("уже заморожена → нельзя повторно", () => {
    expect(canFreezeBatch({ frozenAt: closed, closedAt: closed, unpaidTorcovkaCount: 0 })).toBe(false);
  });
});
