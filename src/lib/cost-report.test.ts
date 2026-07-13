import { describe, expect, it } from "vitest";
import {
  averageRates,
  blendedCostPerMeter,
  blendedCostPerMeterByMaterial,
  buildBatchSnapshots,
  buildCostDetailRows,
  buildCostProductRows,
  declaredSortShares,
  detailMaterialCost,
  detailWorkCost,
  factSortShares,
  periodOverheadFromCashFlows,
  producedLinesFromOperations,
  producedProductQtyFromOperations,
  sortSharesToPercents,
  type ProducedLine,
} from "./cost-report";
import type { Batch, Detail, Employee, NomenclatureItem, Product, RailLot } from "@/types/domain";

const employees: Employee[] = [
  {
    id: "e1",
    fullName: "A",
    pin: "1",
    status: "ACTIVE",
    rateTorcovkaSort1: 5,
    rateTorcovkaSort2: 4,
    ratePrisadkaTorcev: 3,
    ratePrisadkaPloskt: 3,
    rateUpakovka: 20,
  },
  {
    id: "e2",
    fullName: "B",
    pin: "2",
    status: "ACTIVE",
    rateTorcovkaSort1: 4,
    rateTorcovkaSort2: 2,
    ratePrisadkaTorcev: 1,
    ratePrisadkaPloskt: 1,
    rateUpakovka: 10,
  },
  // архивный — не учитывается в средних
  { id: "e3", fullName: "C", pin: "3", status: "ARCHIVED", rateTorcovkaSort1: 100 },
];

const detail = (over: Partial<Detail> & Pick<Detail, "id" | "lengthM" | "sort">): Detail => ({
  name: over.id,
  materialId: "mat-1",
  detailNumber: 1,
  detailType: "POLKA",
  prisadkaTorcevaya: false,
  prisadkaPloskost: false,
  status: "ACTIVE",
  ...over,
});

const dA = detail({ id: "dA", lengthM: 0.6, sort: "SORT1", prisadkaTorcevaya: true });
const dB = detail({ id: "dB", lengthM: 0.4, sort: "SORT1" });
const dC = detail({ id: "dC", lengthM: 0.8, sort: "SORT2", prisadkaPloskost: true });
const details = [dA, dB, dC];

const batch: Batch = {
  id: "bX",
  name: "Тест",
  materialId: "mat-1",
  sectionWidthMm: 50,
  sectionHeightMm: 50,
  purchaseCost: 1000,
  totalCost: 1000,
  priceSort1: 1,
  priceSort2: 1,
  status: "IN_WORK",
  purchaseDate: "2026-06-01",
};

// Произведённые заготовки: S1 итого 100 м (60 + 40), S2 итого 40 м.
const lines: ProducedLine[] = [
  { batchId: "bX", lengthM: 0.6, sort: "SORT1", quantity: 100 }, // 60 м S1
  { batchId: "bX", lengthM: 0.4, sort: "SORT1", quantity: 100 }, // 40 м S1
  { batchId: "bX", lengthM: 0.8, sort: "SORT2", quantity: 50 }, // 40 м S2
];

describe("averageRates", () => {
  it("усредняет только активных", () => {
    const r = averageRates(employees);
    expect(r.torcovkaSort1.toNumber()).toBe(4.5); // (5+4)/2, архивный 100 не в счёт
    expect(r.torcovkaSort2.toNumber()).toBe(3);
    expect(r.prisadkaTorcev.toNumber()).toBe(2);
    expect(r.prisadkaPlosk.toNumber()).toBe(2);
    expect(r.upakovka.toNumber()).toBe(15);
  });
});

describe("detailWorkCost", () => {
  it("торцовка по сорту + требуемые присадки", () => {
    const r = averageRates(employees);
    expect(detailWorkCost(dA, r).toNumber()).toBe(6.5); // 4.5 + 2 (торцевая)
    expect(detailWorkCost(dB, r).toNumber()).toBe(4.5); // только торцовка S1
    expect(detailWorkCost(dC, r).toNumber()).toBe(5); // 3 (S2) + 2 (плоскость)
  });
});

describe("buildBatchSnapshots / detailMaterialCost", () => {
  const snapshots = buildBatchSnapshots({ batches: [batch], lines });

  it("распределяет стоимость партии по сортам", () => {
    const s = snapshots.get("bX")!;
    // share1 = 100/140; costSort1 = 1000 × 5/7
    expect(s.costSort1.toNumber()).toBeCloseTo(714.2857, 3);
    expect(s.costSort2.toNumber()).toBeCloseTo(285.7143, 3);
    expect(s.lengthSort1.toNumber()).toBe(100);
    expect(s.lengthSort2.toNumber()).toBe(40);
  });

  it("материал на деталь = costSort × длина / Σдлина сорта (сечение сокращается)", () => {
    const s = snapshots.get("bX")!;
    expect(detailMaterialCost(s, dA).toNumber()).toBeCloseTo(4.2857, 3); // 714.2857×0.6/100
    expect(detailMaterialCost(s, dB).toNumber()).toBeCloseTo(2.8571, 3);
  });

  it("инвариант: сумма материала по сорту сходится к costSort", () => {
    const s = snapshots.get("bX")!;
    const sumS1 = detailMaterialCost(s, dA)
      .times(100)
      .plus(detailMaterialCost(s, dB).times(100));
    expect(sumS1.toNumber()).toBeCloseTo(s.costSort1.toNumber(), 6);
  });
});

describe("blendedCostPerMeter", () => {
  it("Σстоимость / Σдлина по сорту", () => {
    const snapshots = buildBatchSnapshots({ batches: [batch], lines });
    const pm = blendedCostPerMeter(snapshots);
    expect(pm.sort1.toNumber()).toBeCloseTo(7.142857, 5); // 714.2857/100
  });
});

describe("buildBatchSnapshots — заморозка (A3)", () => {
  it("для замороженной партии берёт FINAL из frozen, а не live-пересчёт", () => {
    // Live дал бы costSort1≈714.28. Замороженные значения намеренно другие.
    const area = 0.0025; // 50×50 мм
    const frozen = new Map([
      [
        "bX",
        {
          volumeSort1: 100 * area, // 0.25 → длина 100 м
          volumeSort2: 40 * area, // 0.10 → длина 40 м
          costSort1: 600,
          costSort2: 400,
          pricePerM3Sort1: 2400,
          pricePerM3Sort2: 4000,
        },
      ],
    ]);
    const snapshots = buildBatchSnapshots({ batches: [batch], lines, frozen });
    const s = snapshots.get("bX")!;
    expect(s.costSort1.toNumber()).toBe(600);
    expect(s.costSort2.toNumber()).toBe(400);
    expect(s.pricePerM3Sort1.toNumber()).toBe(2400);
    expect(s.lengthSort1.toNumber()).toBeCloseTo(100, 6);
    expect(s.lengthSort2.toNumber()).toBeCloseTo(40, 6);
  });

  it("незамороженные партии считаются live как раньше", () => {
    const snapshots = buildBatchSnapshots({ batches: [batch], lines, frozen: new Map() });
    const s = snapshots.get("bX")!;
    expect(s.costSort1.toNumber()).toBeCloseTo(714.2857, 3);
  });
});

describe("buildCostDetailRows", () => {
  it("строка на каждую произведённую заготовку (партия×длина×сорт)", () => {
    const rows = buildCostDetailRows({ batches: [batch], employees, lines });
    expect(rows).toHaveLength(3);
    const a = rows.find((r) => r.id === "bX-0.6-SORT1")!;
    expect(a.batchName).toBe("Тест");
    expect(a.workCost).toBe(4.5); // торцовка S1, присадок у заготовки нет
    expect(a.materialCost).toBeCloseTo(4.29, 2);
    expect(a.costStatus).toBe("PRELIMINARY");
  });

  it("замороженная партия (frozenAt) → FINAL", () => {
    const frozen = { ...batch, frozenAt: "2026-06-10T00:00:00.000Z" };
    const rows = buildCostDetailRows({
      batches: [frozen],
      employees,
      lines,
    });
    expect(rows[0]!.costStatus).toBe("FINAL");
  });

  it("архив без заморозки (frozenAt=null) остаётся PRELIMINARY", () => {
    const archived = { ...batch, status: "ARCHIVED" as const, frozenAt: null };
    const rows = buildCostDetailRows({
      batches: [archived],
      employees,
      lines,
    });
    expect(rows[0]!.costStatus).toBe("PRELIMINARY");
  });
});

describe("buildCostDetailRows — оценка по полному производству, охват по периоду (A11)", () => {
  // Снапшоты по ПОЛНОМУ производству партии фиксируют ₽/м³ (отход зашит в цену).
  const snapshots = buildBatchSnapshots({ batches: [batch], lines });
  const periodLines: ProducedLine[] = [
    { batchId: "bX", lengthM: 0.6, sort: "SORT1", quantity: 100 },
  ];

  it("строки только по заготовкам периода, но материал по полной ₽/м³", () => {
    const rows = buildCostDetailRows({ batches: [batch], employees, lines: periodLines, snapshots });
    expect(rows).toHaveLength(1); // охват периода — одна заготовка
    const full = buildCostDetailRows({ batches: [batch], employees, lines });
    const same = full.find((r) => r.id === "bX-0.6-SORT1")!;
    expect(rows[0]!.materialCost).toBeCloseTo(same.materialCost, 6);
  });

  it("контраст: без snapshots узкий период завысил бы ₽/м³ (вся C на 60 м)", () => {
    const periodOnly = buildCostDetailRows({ batches: [batch], employees, lines: periodLines });
    const withFull = buildCostDetailRows({ batches: [batch], employees, lines: periodLines, snapshots });
    expect(periodOnly[0]!.materialCost).toBeGreaterThan(withFull[0]!.materialCost);
  });
});

describe("blendedCostPerMeterByMaterial", () => {
  it("считает ₽/м раздельно по материалам, не смешивая породы", () => {
    // Две партии разных материалов, обе только 1 сорт: 1000₽ / 100м = 10 против
    // 2000₽ / 100м = 20. Общий блендинг дал бы 15 для обеих — это неверно.
    const b1: Batch = { ...batch, id: "bH", materialId: "mat-hvoya", totalCost: 1000, priceSort1: 1, priceSort2: 0 };
    const b2: Batch = { ...batch, id: "bB", materialId: "mat-bereza", totalCost: 2000, priceSort1: 1, priceSort2: 0 };
    const lines: ProducedLine[] = [
      { batchId: "bH", lengthM: 1, sort: "SORT1", quantity: 100 },
      { batchId: "bB", lengthM: 1, sort: "SORT1", quantity: 100 },
    ];
    const snapshots = buildBatchSnapshots({ batches: [b1, b2], lines });
    const byMat = blendedCostPerMeterByMaterial(
      snapshots,
      new Map([
        ["bH", "mat-hvoya"],
        ["bB", "mat-bereza"],
      ]),
    );
    expect(byMat.get("mat-hvoya")!.sort1.toNumber()).toBe(10);
    expect(byMat.get("mat-bereza")!.sort1.toNumber()).toBe(20);
  });
});

describe("детали строго по партии, без блендинга (A1)", () => {
  // Две партии ОДНОГО материала, но разная ₽/м (1000₽ vs 2000₽ на те же 100 м).
  // Блендинг дал бы 15 обеим; правильный расчёт деталей — по своей партии.
  const bCheap: Batch = { ...batch, id: "bCheap", name: "Дешёвая", totalCost: 1000, priceSort1: 1, priceSort2: 0 };
  const bPricey: Batch = { ...batch, id: "bPricey", name: "Дорогая", totalCost: 2000, priceSort1: 1, priceSort2: 0 };
  const twoLines: ProducedLine[] = [
    { batchId: "bCheap", lengthM: 1, sort: "SORT1", quantity: 100 },
    { batchId: "bPricey", lengthM: 1, sort: "SORT1", quantity: 100 },
  ];

  it("у деталей материал = своя партия (10 vs 20), не средняя 15", () => {
    const rows = buildCostDetailRows({ batches: [bCheap, bPricey], employees, lines: twoLines });
    const cheap = rows.find((r) => r.id.startsWith("bCheap"))!;
    const pricey = rows.find((r) => r.id.startsWith("bPricey"))!;
    expect(cheap.materialCost).toBeCloseTo(10, 6);
    expect(pricey.materialCost).toBeCloseTo(20, 6);
    // блендинг схлопнул бы обе в 15 — убеждаемся, что этого нет
    expect(cheap.materialCost).not.toBeCloseTo(pricey.materialCost, 6);
  });

  it("одна партия: деталь = её собственная ₽/м, без усреднения", () => {
    const rows = buildCostDetailRows({ batches: [bCheap], employees, lines: [twoLines[0]!] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.materialCost).toBeCloseTo(10, 6);
  });
});

describe("buildCostProductRows", () => {
  const products: Product[] = [
    {
      id: "p1",
      name: "Изделие 1",
      materialId: "mat-1",
      skuOzon: "OZ-1",
      skuWb: "WB-1",
      sort: "SORT1",
      packagingId: "n-pack",
      status: "ACTIVE",
      details: [{ detailId: "dA", quantity: 2 }],
      fastenerIds: [{ nomenclatureId: "n-screw", quantity: 4 }],
      extraIds: [],
    },
  ];
  const nomenclature: NomenclatureItem[] = [
    { id: "n-pack", name: "Коробка", type: "PACKAGING", unitPrice: 35, status: "ACTIVE" },
    { id: "n-screw", name: "Саморез", type: "FASTENER", unitPrice: 1.5, status: "ACTIVE" },
  ];

  const rows = buildCostProductRows({
    products,
    batches: [batch],
    details,
    employees,
    nomenclature,
    lines,
    producedProductQty: { p1: 10 },
    periodOverhead: 100,
  });

  it("материал/работа/прямая по составу", () => {
    const r = rows[0]!;
    // материал = 7.142857 × 0.6 × 2 = 8.5714
    expect(r.material).toBeCloseTo(8.57, 2);
    // работа = dA(6.5) × 2 + упаковка(15) = 28
    expect(r.work).toBeCloseTo(28, 2);
    // прямая = 8.5714 + 28 + крепёж(1.5×4=6) + упаковка-материал(35) = 77.5714
    expect(r.direct).toBeCloseTo(77.57, 2);
  });

  it("накладные: вся сумма периода раскладывается (единственное изделие → /кол-во)", () => {
    const r = rows[0]!;
    expect(r.overhead).toBeCloseTo(10, 2); // 100 / 10 шт
    expect(r.full).toBeCloseTo(r.direct + 10, 2);
    expect(r.directPct).toBe(100);
  });
});

describe("declaredSortShares / factSortShares / sortSharesToPercents", () => {
  const lot = (over: Partial<RailLot> & Pick<RailLot, "id" | "sort" | "quantity" | "lengthM">): RailLot => ({
    batchId: "bX",
    railType: "POLKA",
    isPackage: true,
    remainingQuantity: over.quantity,
    ...over,
  });

  it("заявленное — по длине реек каждого сорта", () => {
    const lots = [
      lot({ id: "l1", sort: "SORT1", quantity: 100, lengthM: 2 }), // 200 м
      lot({ id: "l2", sort: "SORT2", quantity: 100, lengthM: 1 }), // 100 м
    ];
    const shares = declaredSortShares(lots);
    expect(shares.sort1.toFixed(4)).toBe("0.6667");
    expect(sortSharesToPercents(shares)).toEqual({ sort1: 67, sort2: 33 });
  });

  it("факт — по сортам произведённых заготовок", () => {
    const shares = factSortShares(lines); // S1 100м, S2 40м
    expect(sortSharesToPercents(shares)).toEqual({ sort1: 71, sort2: 29 });
  });

  it("нет данных → нули", () => {
    expect(sortSharesToPercents(factSortShares([]))).toEqual({ sort1: 0, sort2: 0 });
  });
});

describe("producedLinesFromOperations", () => {
  it("берёт заготовки только из ТОРЦОВКИ и привязывает к партии", () => {
    const rows = producedLinesFromOperations([
      {
        type: "TORCOVKA",
        batchId: "bX",
        productId: null,
        productQty: null,
        lines: [
          { lengthM: 0.6, sort: "SORT1", quantity: 100 },
          { lengthM: 0.4, sort: "SORT1", quantity: 50 },
        ],
      },
      // присадка/упаковка/часы не дают произведённых заготовок по партии
      {
        type: "PRISADKA",
        batchId: null,
        productId: null,
        productQty: null,
        lines: [{ lengthM: 0.6, sort: "SORT1", quantity: 999 }],
      },
      {
        type: "UPAKOVKA",
        batchId: null,
        productId: "p1",
        productQty: 7,
        lines: [],
      },
    ]);
    expect(rows).toEqual([
      { batchId: "bX", lengthM: 0.6, sort: "SORT1", quantity: 100 },
      { batchId: "bX", lengthM: 0.4, sort: "SORT1", quantity: 50 },
    ]);
  });

  it("суммирует дубликаты (партия × длина × сорт) из разных операций", () => {
    const rows = producedLinesFromOperations([
      { type: "TORCOVKA", batchId: "bX", productId: null, productQty: null, lines: [{ lengthM: 0.6, sort: "SORT1", quantity: 30 }] },
      { type: "TORCOVKA", batchId: "bX", productId: null, productQty: null, lines: [{ lengthM: 0.6, sort: "SORT1", quantity: 20 }] },
      { type: "TORCOVKA", batchId: "bY", productId: null, productQty: null, lines: [{ lengthM: 0.6, sort: "SORT1", quantity: 5 }] },
    ]);
    expect(rows).toEqual([
      { batchId: "bX", lengthM: 0.6, sort: "SORT1", quantity: 50 },
      { batchId: "bY", lengthM: 0.6, sort: "SORT1", quantity: 5 },
    ]);
  });

  it("игнорирует ТОРЦОВКУ без партии", () => {
    const rows = producedLinesFromOperations([
      { type: "TORCOVKA", batchId: null, productId: null, productQty: null, lines: [{ lengthM: 0.6, sort: "SORT1", quantity: 10 }] },
    ]);
    expect(rows).toEqual([]);
  });
});

describe("producedProductQtyFromOperations", () => {
  it("суммирует productQty по УПАКОВКЕ", () => {
    const qty = producedProductQtyFromOperations([
      { type: "UPAKOVKA", batchId: null, productId: "p1", productQty: 10, lines: [] },
      { type: "UPAKOVKA", batchId: null, productId: "p1", productQty: 5, lines: [] },
      { type: "UPAKOVKA", batchId: null, productId: "p2", productQty: 3, lines: [] },
      { type: "TORCOVKA", batchId: "bX", productId: null, productQty: null, lines: [] },
    ]);
    expect(qty).toEqual({ p1: 15, p2: 3 });
  });
});

describe("periodOverheadFromCashFlows", () => {
  it("суммирует только накладные расходы", () => {
    const overhead = periodOverheadFromCashFlows(
      [
        { flowType: "EXPENSE", amount: 18200, articleName: "Электроэнергия" },
        { flowType: "EXPENSE", amount: 5000, articleName: "Аренда цеха" },
        { flowType: "EXPENSE", amount: 99999, articleName: "Закупка сырья" },
        { flowType: "INCOME", amount: 50000, articleName: "Электроэнергия" },
        { flowType: "EXPENSE", amount: 1000, articleName: null },
      ],
      new Set(["Электроэнергия", "Аренда цеха"]),
    );
    expect(overhead).toBe(23200);
  });
});
