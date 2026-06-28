// =============================================================================
// Движок себестоимости — чистые функции по разделу «МОДЕЛЬ СЕБЕСТОИМОСТИ»
// (Описание проекта v2). Источник истины для всех денежных расчётов.
//
// ВАЖНО (правило cost-integrity): деньги и измерения считаем ТОЛЬКО в Decimal,
// точность внутри расчётов не теряем. Округление — на выводе (см. format.ts).
// =============================================================================

import { Decimal } from "decimal.js";

// Половинное округление вверх — как для денег, так и для долей.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** Любое значение, приводимое к Decimal. */
export type Num = number | string | Decimal;

/** Привести к Decimal (единая точка коэрсии). */
export function D(value: Num): Decimal {
  return value instanceof Decimal ? value : new Decimal(value);
}

const ZERO = new Decimal(0);

/** Площадь сечения рейки/детали, м² (вход — мм). */
export function sectionAreaM2(widthMm: Num, heightMm: Num): Decimal {
  return D(widthMm).div(1000).times(D(heightMm).div(1000));
}

/** Объём по длине и площади сечения, м³. */
export function volumeM3(lengthM: Num, areaM2: Num): Decimal {
  return D(lengthM).times(areaM2);
}

// ============================= 1. МАТЕРИАЛ ==================================

export interface BatchCostInput {
  /** C — стоимость партии (истина: закупочная + доставка из Сделок). */
  totalCost: Num;
  /** P1 — цена поставщика ₽/м³, сорт 1. */
  priceSort1: Num;
  /** P2 — цена поставщика ₽/м³, сорт 2. */
  priceSort2: Num;
  /** Площадь сечения партии, м² (одно сечение на партию). */
  sectionAreaM2: Num;
  /** Сумма длин фактически произведённых деталей 1 сорта, м. */
  producedLengthSort1: Num;
  /** Сумма длин фактически произведённых деталей 2 сорта, м. */
  producedLengthSort2: Num;
}

export interface BatchCostResult {
  /** V1ф — фактический объём 1 сорта, м³. */
  volumeSort1: Decimal;
  /** V2ф — фактический объём 2 сорта, м³. */
  volumeSort2: Decimal;
  /** Доля стоимости, приходящаяся на сорт 1 (0..1). */
  share1: Decimal;
  share2: Decimal;
  /** Стоимость сорта = C × доля. */
  costSort1: Decimal;
  costSort2: Decimal;
  /** Цена за м³ с учётом отхода = costSort / Vф. */
  pricePerM3Sort1: Decimal;
  pricePerM3Sort2: Decimal;
}

/**
 * Распределение стоимости партии по сортам по факту произведённых деталей.
 *
 *   V1ф = ΣL1 × Сечение,  V2ф = ΣL2 × Сечение
 *   Доля_1 = P1·V1ф / (P1·V1ф + P2·V2ф),  Доля_2 — симметрично
 *   Стоимость сорта = C × Доля
 *   Цена за м³ (с отходом) = Стоимость сорта / Vф
 *
 * Вся уплаченная C ложится на произведённые детали → отход зашит в
 * себестоимость, сумма costSort1 + costSort2 === C (без потери точности).
 * Граничные случаи (нет производства / один сорт) — деления на ноль нет.
 */
export function distributeBatchCost(input: BatchCostInput): BatchCostResult {
  const area = D(input.sectionAreaM2);
  const C = D(input.totalCost);
  const p1 = D(input.priceSort1);
  const p2 = D(input.priceSort2);

  const v1 = D(input.producedLengthSort1).times(area);
  const v2 = D(input.producedLengthSort2).times(area);

  const weighted1 = p1.times(v1);
  const weighted2 = p2.times(v2);
  const denom = weighted1.plus(weighted2);

  // Нет произведённых деталей (или нулевые цены) — распределять нечего.
  if (denom.isZero()) {
    return {
      volumeSort1: v1,
      volumeSort2: v2,
      share1: ZERO,
      share2: ZERO,
      costSort1: ZERO,
      costSort2: ZERO,
      pricePerM3Sort1: ZERO,
      pricePerM3Sort2: ZERO,
    };
  }

  const share1 = weighted1.div(denom);
  // share2 = остаток, чтобы share1 + share2 === 1 и costSort1 + costSort2 === C.
  const share2 = D(1).minus(share1);

  const costSort1 = C.times(share1);
  const costSort2 = C.minus(costSort1);

  return {
    volumeSort1: v1,
    volumeSort2: v2,
    share1,
    share2,
    costSort1,
    costSort2,
    pricePerM3Sort1: v1.isZero() ? ZERO : costSort1.div(v1),
    pricePerM3Sort2: v2.isZero() ? ZERO : costSort2.div(v2),
  };
}

/**
 * Себестоимость материала на одну деталь.
 *   Материал = Цена за м³ (по сорту детали) × Длина детали × Сечение
 */
export function materialPerDetail(pricePerM3: Num, lengthM: Num, areaM2: Num): Decimal {
  return D(pricePerM3).times(D(lengthM)).times(D(areaM2));
}

/**
 * Доля 2 сорта по суммарной длине (0..1). Используется и для «заявленного»
 * (по закупленным рейкам), и для «фактического» (по произведённым деталям).
 */
export function sortShare2ByLength(lengthSort1: Num, lengthSort2: Num): Decimal {
  const l1 = D(lengthSort1);
  const l2 = D(lengthSort2);
  const total = l1.plus(l2);
  return total.isZero() ? ZERO : l2.div(total);
}

/**
 * Сигнал «Расхождение сортности»: фактическая доля 2 сорта превысила
 * заявленную более чем на порог (по умолчанию 10 п.п.).
 */
export function isSortRatioMismatch(
  declaredShare2: Num,
  actualShare2: Num,
  thresholdPoints: Num = 0.1,
): boolean {
  return D(actualShare2).minus(D(declaredShare2)).gt(D(thresholdPoints));
}

/**
 * Сигнал «Расхождение стоимости партии»: введённая C не совпала с расчётной
 * (P1·V1зак + P2·V2зак) сверх допуска. Объёмы — закупленные (по рейкам).
 */
export function isBatchCostMismatch(input: {
  totalCost: Num;
  priceSort1: Num;
  priceSort2: Num;
  volumeSort1: Num;
  volumeSort2: Num;
  tolerance?: Num;
}): boolean {
  const computed = D(input.priceSort1)
    .times(D(input.volumeSort1))
    .plus(D(input.priceSort2).times(D(input.volumeSort2)));
  const tolerance = D(input.tolerance ?? 1);
  return computed.minus(D(input.totalCost)).abs().gt(tolerance);
}

// ============================= 2. РАБОТА ====================================

export interface DetailLaborInput {
  /** Расценка торцовки по сорту детали, ₽/деталь. */
  torcovkaRate: Num;
  /** Требуется торцевая присадка. */
  requiresTorcevPrisadka?: boolean;
  prisadkaTorcevRate?: Num;
  /** Требуется присадка по плоскости. */
  requiresPloskPrisadka?: boolean;
  prisadkaPloskRate?: Num;
}

/**
 * Стоимость работы на ОДНУ деталь = торцовка + требуемые присадки.
 * Присадка учитывается, только если деталь её требует.
 */
export function detailLaborCost(input: DetailLaborInput): Decimal {
  let sum = D(input.torcovkaRate);
  if (input.requiresTorcevPrisadka) sum = sum.plus(D(input.prisadkaTorcevRate ?? 0));
  if (input.requiresPloskPrisadka) sum = sum.plus(D(input.prisadkaPloskRate ?? 0));
  return sum;
}

export interface ProductLaborLine {
  /** Стоимость работы на одну деталь (см. detailLaborCost). */
  laborPerUnit: Num;
  /** Кол-во таких деталей в изделии. */
  quantity: Num;
}

/**
 * Работа на изделие = Σ(работа на деталь × кол-во) + расценка упаковки.
 */
export function productLaborCost(lines: ProductLaborLine[], packagingRate: Num = 0): Decimal {
  const details = lines.reduce(
    (sum, line) => sum.plus(D(line.laborPerUnit).times(D(line.quantity))),
    ZERO,
  );
  return details.plus(D(packagingRate));
}

// ===================== 3. КРЕПЁЖ / УПАКОВКА / РАЗНОЕ ========================

export interface ProductMaterialsInput {
  /** Крепёж: цена за единицу × количество. */
  fasteners?: { unitPrice: Num; quantity: Num }[];
  /** Цена упаковки изделия. */
  packagingPrice?: Num;
  /** Чекбоксы «Разное»: цены выбранных позиций. */
  extras?: Num[];
}

/**
 * Материальная добавка изделия (помимо рейки): крепёж + упаковка + «Разное».
 */
export function productMaterialsCost(input: ProductMaterialsInput): Decimal {
  const fasteners = (input.fasteners ?? []).reduce(
    (sum, f) => sum.plus(D(f.unitPrice).times(D(f.quantity))),
    ZERO,
  );
  const extras = (input.extras ?? []).reduce<Decimal>((sum, e) => sum.plus(D(e)), ZERO);
  return fasteners.plus(D(input.packagingPrice ?? 0)).plus(extras);
}

// ===================== 4. ПРЯМАЯ СЕБЕСТОИМОСТЬ =============================

export interface DirectCostInput {
  /** Материал по всем деталям изделия (рейка). */
  material: Num;
  /** Работа по всем деталям + упаковка (труд). */
  labor: Num;
  /** Крепёж + упаковка (материал) + «Разное». */
  materialsExtra: Num;
}

/** Прямая = материал + работа + крепёж/упаковка/разное. */
export function directProductCost(input: DirectCostInput): Decimal {
  return D(input.material).plus(D(input.labor)).plus(D(input.materialsExtra));
}

// ===================== 5. НАКЛАДНЫЕ (производственные) ======================

/**
 * Накладные изделия = Прямая × (Накладные периода / Сумма прямых за период).
 * Если сумма прямых за период нулевая — накладных нет.
 */
export function overheadForProduct(input: {
  directCost: Num;
  periodOverhead: Num;
  periodTotalDirect: Num;
}): Decimal {
  const total = D(input.periodTotalDirect);
  if (total.isZero()) return ZERO;
  return D(input.directCost).times(D(input.periodOverhead)).div(total);
}

// ===================== 6. ПОЛНАЯ СЕБЕСТОИМОСТЬ =============================

/** Полная = прямая + накладные. */
export function fullProductCost(direct: Num, overhead: Num): Decimal {
  return D(direct).plus(D(overhead));
}

// ===================== ВЫВОД =================================================

/** Округление денег до целых рублей (вывод). Внутри расчётов не применять. */
export function roundRubles(value: Num): Decimal {
  return D(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
}
