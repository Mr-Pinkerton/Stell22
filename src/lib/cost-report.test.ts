import { describe, expect, it } from "vitest";
import {
  averageRates,
  blendedCostPerMeter,
  buildBatchSnapshots,
  buildCostDetailRows,
  buildCostProductRows,
  detailMaterialCost,
  detailWorkCost,
  periodOverheadFromCashFlows,
  type ProducedLine,
} from "./cost-report";
import type { Batch, Detail, Employee, NomenclatureItem, Product } from "@/types/domain";

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
  sectionWidthMm: 50,
  sectionHeightMm: 50,
  purchaseCost: 1000,
  totalCost: 1000,
  priceSort1: 1,
  priceSort2: 1,
  status: "IN_WORK",
  purchaseDate: "2026-06-01",
};

const lines: ProducedLine[] = [
  { batchId: "bX", detailId: "dA", quantity: 100 }, // 60 м S1
  { batchId: "bX", detailId: "dB", quantity: 100 }, // 40 м S1 → S1 итого 100 м
  { batchId: "bX", detailId: "dC", quantity: 50 }, // 40 м S2
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
  const snapshots = buildBatchSnapshots({ batches: [batch], details, lines });

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
    const snapshots = buildBatchSnapshots({ batches: [batch], details, lines });
    const pm = blendedCostPerMeter(snapshots);
    expect(pm.sort1.toNumber()).toBeCloseTo(7.142857, 5); // 714.2857/100
  });
});

describe("buildCostDetailRows", () => {
  it("строка на каждую произведённую (партия×деталь)", () => {
    const rows = buildCostDetailRows({ batches: [batch], details, employees, lines });
    expect(rows).toHaveLength(3);
    const a = rows.find((r) => r.id === "bX-dA")!;
    expect(a.batchName).toBe("Тест");
    expect(a.workCost).toBe(6.5);
    expect(a.materialCost).toBeCloseTo(4.29, 2);
    expect(a.costStatus).toBe("PRELIMINARY");
  });

  it("архивная партия → FINAL", () => {
    const archived = { ...batch, status: "ARCHIVED" as const };
    const rows = buildCostDetailRows({
      batches: [archived],
      details,
      employees,
      lines,
    });
    expect(rows[0]!.costStatus).toBe("FINAL");
  });
});

describe("buildCostProductRows", () => {
  const products: Product[] = [
    {
      id: "p1",
      name: "Изделие 1",
      sku: "ART-1",
      sort: "SORT1",
      salePrice: 100,
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
