// Сквозной тест инвариантов движка себестоимости: реалистичный сценарий
// «партия → произведённые детали → материал/работа → прямая → накладные →
// полная». Проверяем НЕ отдельные формулы (они в cost.test.ts), а целостность
// расчёта по правилу cost-integrity: уплаченная сумма сходится к деталям,
// накладные распределяются полностью без потерь и двойного счёта.

import { describe, expect, it } from "vitest";
import {
  D,
  detailLaborCost,
  directProductCost,
  distributeBatchCost,
  fullProductCost,
  materialPerDetail,
  overheadForProduct,
  productLaborCost,
  productMaterialsCost,
  sectionAreaM2,
} from "./cost";

// --- Исходные данные сценария --------------------------------------------

const area = sectionAreaM2(40, 20); // 0.0008 м²

const BATCH_COST = 120_000; // C — вся уплаченная сумма партии
const PRICE_SORT1 = 30_000; // ₽/м³
const PRICE_SORT2 = 20_000;

// Деталь A (1 сорт, 0.6 м, требует торцевую присадку), деталь B (2 сорт, 0.4 м).
const detailA = { lengthM: 0.6, sort: "SORT1" as const };
const detailB = { lengthM: 0.4, sort: "SORT2" as const };

// Изделия и состав: X = 4×A + 2×B, Y = 2×A. Всего из партии: A=6, B=2.
const productX = { a: 4, b: 2 };
const productY = { a: 2, b: 0 };

const producedA = productX.a + productY.a; // 6
const producedB = productX.b + productY.b; // 2

// Расценки работы (₽/деталь) и упаковки изделия.
const RATE_TORCOVKA = 12;
const RATE_PRISADKA_TORCEV = 5;
const RATE_PACKAGING = 20;

// Накладные периода и материальная добавка изделия.
const PERIOD_OVERHEAD = 5_000;
const PACKAGING_PRICE = 15;

// --- Расчёт ----------------------------------------------------------------

const batch = distributeBatchCost({
  totalCost: BATCH_COST,
  priceSort1: PRICE_SORT1,
  priceSort2: PRICE_SORT2,
  sectionAreaM2: area,
  // Длины считаем в Decimal (не float): иначе 6×0.6 даст 3.5999… и шум ~1e-11.
  producedLengthSort1: D(producedA).times(detailA.lengthM),
  producedLengthSort2: D(producedB).times(detailB.lengthM),
});

const matA = materialPerDetail(batch.pricePerM3Sort1, detailA.lengthM, area);
const matB = materialPerDetail(batch.pricePerM3Sort2, detailB.lengthM, area);

const laborA = detailLaborCost({
  torcovkaRate: RATE_TORCOVKA,
  requiresTorcevPrisadka: true,
  prisadkaTorcevRate: RATE_PRISADKA_TORCEV,
});
const laborB = detailLaborCost({ torcovkaRate: RATE_TORCOVKA });

function productDirect(comp: { a: number; b: number }) {
  const material = matA.times(comp.a).plus(matB.times(comp.b));
  const labor = productLaborCost(
    [
      { laborPerUnit: laborA, quantity: comp.a },
      { laborPerUnit: laborB, quantity: comp.b },
    ],
    RATE_PACKAGING,
  );
  const materialsExtra = productMaterialsCost({ packagingPrice: PACKAGING_PRICE });
  return directProductCost({ material, labor, materialsExtra });
}

const directX = productDirect(productX);
const directY = productDirect(productY);
const periodTotalDirect = directX.plus(directY);

const overheadX = overheadForProduct({
  directCost: directX,
  periodOverhead: PERIOD_OVERHEAD,
  periodTotalDirect,
});
const overheadY = overheadForProduct({
  directCost: directY,
  periodOverhead: PERIOD_OVERHEAD,
  periodTotalDirect,
});

const fullX = fullProductCost(directX, overheadX);
const fullY = fullProductCost(directY, overheadY);

// Допуск на остаток деления (precision 40): на выводе округляется до рубля.
const EPS = D("1e-18");

// --- Инварианты ------------------------------------------------------------

describe("сквозной расчёт себестоимости — инварианты", () => {
  it("стоимости сортов точно сходятся к уплаченной сумме партии (C)", () => {
    expect(batch.costSort1.plus(batch.costSort2).equals(D(BATCH_COST))).toBe(true);
  });

  it("материал всех произведённых деталей в сумме равен C (отход зашит)", () => {
    const totalMaterial = matA.times(producedA).plus(matB.times(producedB));
    // Вся уплаченная сумма распределена на детали без потерь и без излишка.
    expect(totalMaterial.minus(D(BATCH_COST)).abs().lt(EPS)).toBe(true);
  });

  it("накладные распределяются полностью, без потерь и двойного счёта", () => {
    // Остаток деления на сумму прямых — на уровне 1e-20, на выводе исчезает.
    expect(overheadX.plus(overheadY).minus(D(PERIOD_OVERHEAD)).abs().lt(EPS)).toBe(true);
  });

  it("полная = прямая + накладные для каждого изделия", () => {
    expect(fullX.equals(directX.plus(overheadX))).toBe(true);
    expect(fullY.equals(directY.plus(overheadY))).toBe(true);
  });

  it("сумма полных = сумма прямых + накладные периода (баланс периода)", () => {
    expect(fullX.plus(fullY).minus(periodTotalDirect.plus(D(PERIOD_OVERHEAD))).abs().lt(EPS)).toBe(
      true,
    );
  });

  it("ЗП производства входит в прямую, а не в накладные (нет двойного счёта)", () => {
    // Работа учтена в прямой себестоимости; накладные — независимый вход,
    // не содержащий ЗП. Прямая строго больше чистого материала на сумму труда.
    const materialOnlyX = matA.times(productX.a).plus(matB.times(productX.b));
    const laborOnlyX = productLaborCost(
      [
        { laborPerUnit: laborA, quantity: productX.a },
        { laborPerUnit: laborB, quantity: productX.b },
      ],
      RATE_PACKAGING,
    );
    expect(directX.gt(materialOnlyX)).toBe(true);
    expect(directX.minus(materialOnlyX).gt(laborOnlyX.minus(D("0.0001")))).toBe(true);
  });
});
