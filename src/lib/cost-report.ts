// =============================================================================
// Сборка отчёта «Себестоимость» (детали/изделия) движком расчёта.
// Этап 9: первое оживление движка на доменных данных (пока — моки, в Части B
// те же входы придут из БД/терминала).
//
// Деньги/измерения — Decimal внутри (cost.ts), на выходе строк отчёта —
// number (как и остальной UI-прототип; формат — formatMoney на выводе).
// =============================================================================

import { Decimal } from "decimal.js";
import {
  D,
  directProductCost,
  distributeBatchCost,
  fullProductCost,
  overheadForProduct,
  sectionAreaM2,
  type Num,
} from "@/lib/cost";
import { formatProductSku } from "@/lib/format";
import type { Batch, Detail, Employee, NomenclatureItem, Product, RailLot, Sort } from "@/types/domain";

/**
 * Произведённая по партии заготовка (нарезанная рейка). Ключ материала —
 * длина+сорт: материальная стоимость зависит только от них (и партии), а не
 * от того, какой конкретной деталью станет заготовка на присадке.
 */
export interface ProducedLine {
  batchId: string;
  lengthM: number;
  sort: Sort;
  quantity: number;
}

const ZERO = D(0);

// --------------------- производственные факты из операций -------------------

/** Минимальное представление операции для расчёта произведённого. */
export interface OperationForCost {
  type: "TORCOVKA" | "PRISADKA" | "UPAKOVKA" | "HOURS";
  batchId: string | null;
  productId: string | null;
  productQty: number | null;
  /** Для ТОРЦОВКИ — спецификация заготовки (длина+сорт). */
  lines: { lengthM: number | null; sort: Sort | null; quantity: number }[];
}

/**
 * Произведённые заготовки по партиям — из операций ТОРЦОВКИ.
 * Учёт строго по партии-источнику (cost-integrity). Дубликаты
 * (партия × длина × сорт) суммируются.
 */
export function producedLinesFromOperations(ops: OperationForCost[]): ProducedLine[] {
  const acc = new Map<string, ProducedLine>();
  for (const op of ops) {
    if (op.type !== "TORCOVKA" || !op.batchId) continue;
    for (const line of op.lines) {
      if (line.lengthM == null || line.sort == null) continue;
      const key = `${op.batchId}::${line.lengthM}::${line.sort}`;
      const existing = acc.get(key);
      if (existing) existing.quantity += line.quantity;
      else
        acc.set(key, {
          batchId: op.batchId,
          lengthM: line.lengthM,
          sort: line.sort,
          quantity: line.quantity,
        });
    }
  }
  return [...acc.values()];
}

/** Произведено готовых изделий за период — из операций УПАКОВКИ (productQty). */
export function producedProductQtyFromOperations(ops: OperationForCost[]): Record<string, number> {
  const qty: Record<string, number> = {};
  for (const op of ops) {
    if (op.type !== "UPAKOVKA" || !op.productId) continue;
    qty[op.productId] = (qty[op.productId] ?? 0) + (op.productQty ?? 0);
  }
  return qty;
}

// --------------------------- средние расценки -------------------------------

export interface AvgRates {
  torcovkaSort1: Decimal;
  torcovkaSort2: Decimal;
  prisadkaTorcev: Decimal;
  prisadkaPlosk: Decimal;
  upakovka: Decimal;
}

function avg(values: (number | null | undefined)[]): Decimal {
  const present = values.filter((v): v is number => v != null);
  if (present.length === 0) return ZERO;
  return present.reduce<Decimal>((s, v) => s.plus(D(v)), ZERO).div(present.length);
}

/** Средние сдельные расценки по активным работникам (фактическая средняя по производству). */
export function averageRates(employees: Employee[]): AvgRates {
  const active = employees.filter((e) => e.status === "ACTIVE");
  return {
    torcovkaSort1: avg(active.map((e) => e.rateTorcovkaSort1)),
    torcovkaSort2: avg(active.map((e) => e.rateTorcovkaSort2)),
    prisadkaTorcev: avg(active.map((e) => e.ratePrisadkaTorcev)),
    prisadkaPlosk: avg(active.map((e) => e.ratePrisadkaPloskt)),
    upakovka: avg(active.map((e) => e.rateUpakovka)),
  };
}

/** Работа на одну деталь = торцовка (по сорту) + требуемые присадки. */
export function detailWorkCost(detail: Detail, rates: AvgRates): Decimal {
  let sum = detail.sort === "SORT1" ? rates.torcovkaSort1 : rates.torcovkaSort2;
  if (detail.prisadkaTorcevaya) sum = sum.plus(rates.prisadkaTorcev);
  if (detail.prisadkaPloskost) sum = sum.plus(rates.prisadkaPlosk);
  return sum;
}

/** Работа на одну заготовку = только торцовка по сорту (присадок ещё нет). */
export function blankWorkCost(sort: Sort, rates: AvgRates): Decimal {
  return sort === "SORT1" ? rates.torcovkaSort1 : rates.torcovkaSort2;
}

// --------------------------- распределение партий ---------------------------

export interface BatchCostSnapshot {
  batchId: string;
  areaM2: Decimal;
  /** Цена за м³ с учётом отхода по сорту детали. */
  pricePerM3Sort1: Decimal;
  pricePerM3Sort2: Decimal;
  /** Стоимость и произведённая длина по сорту (для блендинга по изделиям). */
  costSort1: Decimal;
  costSort2: Decimal;
  lengthSort1: Decimal;
  lengthSort2: Decimal;
}

function lengthsBySort(lines: ProducedLine[]): { sort1: Decimal; sort2: Decimal } {
  let sort1 = ZERO;
  let sort2 = ZERO;
  for (const line of lines) {
    const len = D(line.lengthM).times(line.quantity);
    if (line.sort === "SORT1") sort1 = sort1.plus(len);
    else sort2 = sort2.plus(len);
  }
  return { sort1, sort2 };
}

/** Снапшоты распределения стоимости по каждой партии с производством. */
export function buildBatchSnapshots(params: {
  batches: Batch[];
  lines: ProducedLine[];
}): Map<string, BatchCostSnapshot> {
  const byBatch = new Map<string, ProducedLine[]>();
  for (const line of params.lines) {
    const list = byBatch.get(line.batchId) ?? [];
    list.push(line);
    byBatch.set(line.batchId, list);
  }

  const result = new Map<string, BatchCostSnapshot>();
  for (const batch of params.batches) {
    const lines = byBatch.get(batch.id);
    if (!lines || lines.length === 0) continue;

    const area = sectionAreaM2(batch.sectionWidthMm, batch.sectionHeightMm);
    const { sort1, sort2 } = lengthsBySort(lines);

    const dist = distributeBatchCost({
      totalCost: batch.totalCost,
      priceSort1: batch.priceSort1,
      priceSort2: batch.priceSort2,
      sectionAreaM2: area,
      producedLengthSort1: sort1,
      producedLengthSort2: sort2,
    });

    result.set(batch.id, {
      batchId: batch.id,
      areaM2: area,
      pricePerM3Sort1: dist.pricePerM3Sort1,
      pricePerM3Sort2: dist.pricePerM3Sort2,
      costSort1: dist.costSort1,
      costSort2: dist.costSort2,
      lengthSort1: sort1,
      lengthSort2: sort2,
    });
  }
  return result;
}

// --------------------------- соотношение сортов -----------------------------

export interface SortShares {
  sort1: Decimal;
  sort2: Decimal;
}

/** Заявленное соотношение сортов партии — по закупленным рейкам (сечение в доле сокращается). */
export function declaredSortShares(lots: RailLot[]): SortShares {
  let s1 = ZERO;
  let s2 = ZERO;
  for (const lot of lots) {
    const len = D(lot.quantity).times(lot.lengthM);
    if (lot.sort === "SORT1") s1 = s1.plus(len);
    else s2 = s2.plus(len);
  }
  const total = s1.plus(s2);
  return total.isZero() ? { sort1: ZERO, sort2: ZERO } : { sort1: s1.div(total), sort2: s2.div(total) };
}

/** Фактическое соотношение сортов — по сортам произведённых заготовок. */
export function factSortShares(lines: ProducedLine[]): SortShares {
  const { sort1, sort2 } = lengthsBySort(lines);
  const total = sort1.plus(sort2);
  return total.isZero() ? { sort1: ZERO, sort2: ZERO } : { sort1: sort1.div(total), sort2: sort2.div(total) };
}

/** Доли → проценты (целые, сумма = 100 при ненулевой базе). */
export function sortSharesToPercents(shares: SortShares): { sort1: number; sort2: number } {
  if (shares.sort1.isZero() && shares.sort2.isZero()) return { sort1: 0, sort2: 0 };
  const s1 = shares.sort1.times(100).toDecimalPlaces(0).toNumber();
  return { sort1: s1, sort2: 100 - s1 };
}

/** Материал на одну деталь по конкретной партии (цена м³ с отходом × длина × сечение). */
export function detailMaterialCost(snapshot: BatchCostSnapshot, detail: Detail): Decimal {
  const price = detail.sort === "SORT1" ? snapshot.pricePerM3Sort1 : snapshot.pricePerM3Sort2;
  return price.times(D(detail.lengthM)).times(snapshot.areaM2);
}

/** Материал на одну заготовку по партии (цена м³ с отходом × длина × сечение). */
export function blankMaterialCost(snapshot: BatchCostSnapshot, lengthM: number, sort: Sort): Decimal {
  const price = sort === "SORT1" ? snapshot.pricePerM3Sort1 : snapshot.pricePerM3Sort2;
  return price.times(D(lengthM)).times(snapshot.areaM2);
}

export interface CostPerMeter {
  sort1: Decimal;
  sort2: Decimal;
}

const ZERO_PER_METER: CostPerMeter = { sort1: ZERO, sort2: ZERO };

/** Блендированная ₽/м по сорту детали (Σстоимость / Σдлина по всем партиям). */
export function blendedCostPerMeter(snapshots: Map<string, BatchCostSnapshot>): CostPerMeter {
  let cost1 = ZERO;
  let len1 = ZERO;
  let cost2 = ZERO;
  let len2 = ZERO;
  for (const s of snapshots.values()) {
    cost1 = cost1.plus(s.costSort1);
    len1 = len1.plus(s.lengthSort1);
    cost2 = cost2.plus(s.costSort2);
    len2 = len2.plus(s.lengthSort2);
  }
  return {
    sort1: len1.isZero() ? ZERO : cost1.div(len1),
    sort2: len2.isZero() ? ZERO : cost2.div(len2),
  };
}

/**
 * Блендированная ₽/м по сорту, раздельно по каждому материалу. Изделие однородно
 * по материалу, поэтому его материальная себестоимость считается только по
 * партиям своей породы (смешивать хвою и берёзу нельзя — цены за м³ разные).
 */
export function blendedCostPerMeterByMaterial(
  snapshots: Map<string, BatchCostSnapshot>,
  batchMaterial: Map<string, string>,
): Map<string, CostPerMeter> {
  const acc = new Map<string, { cost1: Decimal; len1: Decimal; cost2: Decimal; len2: Decimal }>();
  for (const [batchId, s] of snapshots) {
    const materialId = batchMaterial.get(batchId);
    if (!materialId) continue;
    const cur = acc.get(materialId) ?? { cost1: ZERO, len1: ZERO, cost2: ZERO, len2: ZERO };
    cur.cost1 = cur.cost1.plus(s.costSort1);
    cur.len1 = cur.len1.plus(s.lengthSort1);
    cur.cost2 = cur.cost2.plus(s.costSort2);
    cur.len2 = cur.len2.plus(s.lengthSort2);
    acc.set(materialId, cur);
  }
  const result = new Map<string, CostPerMeter>();
  for (const [materialId, v] of acc) {
    result.set(materialId, {
      sort1: v.len1.isZero() ? ZERO : v.cost1.div(v.len1),
      sort2: v.len2.isZero() ? ZERO : v.cost2.div(v.len2),
    });
  }
  return result;
}

// --------------------------- строки отчёта ----------------------------------

export interface CostDetailRow {
  id: string;
  name: string;
  batchName: string;
  workCost: number;
  materialCost: number;
  costStatus: "PRELIMINARY" | "FINAL";
}

/**
 * Строки таба «Детали»: одна строка на произведённую заготовку
 * (партия × длина × сорт). Конкретная деталь определяется на присадке, поэтому
 * материальная себестоимость учитывается на уровне заготовки (длина+сорт).
 */
export function buildCostDetailRows(params: {
  batches: Batch[];
  employees: Employee[];
  lines: ProducedLine[];
}): CostDetailRow[] {
  const batchesById = new Map(params.batches.map((b) => [b.id, b]));
  const rates = averageRates(params.employees);
  const snapshots = buildBatchSnapshots(params);

  const rows: CostDetailRow[] = [];
  for (const line of params.lines) {
    const batch = batchesById.get(line.batchId);
    const snapshot = snapshots.get(line.batchId);
    if (!batch || !snapshot) continue;

    const sortLabel = line.sort === "SORT1" ? "1 сорт" : "2 сорт";
    rows.push({
      id: `${line.batchId}-${line.lengthM}-${line.sort}`,
      name: `Заготовка ${line.lengthM} м, ${sortLabel}`,
      batchName: batch.name,
      workCost: blankWorkCost(line.sort, rates).toDecimalPlaces(2).toNumber(),
      materialCost: blankMaterialCost(snapshot, line.lengthM, line.sort)
        .toDecimalPlaces(2)
        .toNumber(),
      costStatus: batch.status === "ARCHIVED" ? "FINAL" : "PRELIMINARY",
    });
  }
  return rows;
}

export interface CostProductDetailLine {
  detailName: string;
  lengthM: number;
  quantity: number;
  materialCost: number;
  workCost: number;
}

export interface CostProductRow {
  id: string;
  name: string;
  sku: string;
  material: number;
  materialPct: number;
  work: number;
  workPct: number;
  direct: number;
  directPct: number;
  overhead: number;
  overheadPct: number;
  full: number;
  details: CostProductDetailLine[];
}

interface ProductDirect {
  product: Product;
  material: Decimal;
  work: Decimal;
  materialsExtra: Decimal;
  direct: Decimal;
  lines: { detail: Detail; quantity: number; material: Decimal; work: Decimal }[];
}

function computeProductDirect(
  product: Product,
  detailsById: Map<string, Detail>,
  nomenclatureById: Map<string, NomenclatureItem>,
  perMeter: { sort1: Decimal; sort2: Decimal },
  rates: AvgRates,
): ProductDirect {
  let material = ZERO;
  let work = ZERO;

  // Суммарное количество по детали: у одной детали в изделии может быть
  // несколько номеров-строк (номер важен для упаковки, не для себестоимости).
  const qtyByDetail = new Map<string, number>();
  for (const pd of product.details) {
    qtyByDetail.set(pd.detailId, (qtyByDetail.get(pd.detailId) ?? 0) + pd.quantity);
  }

  const lines: ProductDirect["lines"] = [];
  for (const [detailId, quantity] of qtyByDetail) {
    const detail = detailsById.get(detailId);
    if (!detail) continue;
    const perM = detail.sort === "SORT1" ? perMeter.sort1 : perMeter.sort2;
    const unitMaterial = perM.times(D(detail.lengthM));
    const unitWork = detailWorkCost(detail, rates);
    material = material.plus(unitMaterial.times(quantity));
    work = work.plus(unitWork.times(quantity));
    lines.push({ detail, quantity, material: unitMaterial, work: unitWork });
  }

  // Упаковка как работа — расценка упаковки за изделие.
  work = work.plus(rates.upakovka);

  // Крепёж + упаковка (материал) + «Разное».
  let materialsExtra = ZERO;
  for (const f of product.fastenerIds) {
    const nom = nomenclatureById.get(f.nomenclatureId);
    if (nom) materialsExtra = materialsExtra.plus(D(nom.unitPrice).times(f.quantity));
  }
  if (product.packagingId) {
    const pack = nomenclatureById.get(product.packagingId);
    if (pack) materialsExtra = materialsExtra.plus(D(pack.unitPrice));
  }
  for (const extraId of product.extraIds) {
    const extra = nomenclatureById.get(extraId);
    if (extra) materialsExtra = materialsExtra.plus(D(extra.unitPrice));
  }

  const direct = directProductCost({ material, labor: work, materialsExtra });
  return { product, material, work, materialsExtra, direct, lines };
}

function pct(part: Decimal, base: Decimal): number {
  if (base.isZero()) return 0;
  return part.div(base).times(100).toDecimalPlaces(0).toNumber();
}

/** Строки таба «Изделия»: материал/работа/прямая/накладные/полная по артикулу. */
export function buildCostProductRows(params: {
  products: Product[];
  batches: Batch[];
  details: Detail[];
  employees: Employee[];
  nomenclature: NomenclatureItem[];
  lines: ProducedLine[];
  producedProductQty: Record<string, number>;
  periodOverhead: Num;
}): CostProductRow[] {
  const detailsById = new Map(params.details.map((d) => [d.id, d]));
  const nomenclatureById = new Map(params.nomenclature.map((n) => [n.id, n]));
  const rates = averageRates(params.employees);
  const snapshots = buildBatchSnapshots(params);
  // ₽/м считаем раздельно по материалам — изделие берёт per-meter своей породы.
  const batchMaterial = new Map(params.batches.map((b) => [b.id, b.materialId]));
  const perMeterByMaterial = blendedCostPerMeterByMaterial(snapshots, batchMaterial);

  const active = params.products.filter((p) => p.status === "ACTIVE");
  const directs = active.map((p) =>
    computeProductDirect(
      p,
      detailsById,
      nomenclatureById,
      perMeterByMaterial.get(p.materialId) ?? ZERO_PER_METER,
      rates,
    ),
  );

  // Σ прямых затрат периода = Σ(прямая_ед × произведено_ед).
  const totalDirect = directs.reduce<Decimal>(
    (s, d) => s.plus(d.direct.times(params.producedProductQty[d.product.id] ?? 0)),
    ZERO,
  );

  return directs.map((pd) => {
    const overhead = overheadForProduct({
      directCost: pd.direct,
      periodOverhead: params.periodOverhead,
      periodTotalDirect: totalDirect,
    });
    const full = fullProductCost(pd.direct, overhead);

    return {
      id: pd.product.id,
      name: pd.product.name,
      sku: formatProductSku(pd.product.skuOzon, pd.product.skuWb),
      material: pd.material.toDecimalPlaces(2).toNumber(),
      materialPct: pct(pd.material, pd.direct),
      work: pd.work.toDecimalPlaces(2).toNumber(),
      workPct: pct(pd.work, pd.direct),
      direct: pd.direct.toDecimalPlaces(2).toNumber(),
      directPct: 100,
      overhead: overhead.toDecimalPlaces(2).toNumber(),
      overheadPct: pct(overhead, pd.direct),
      full: full.toDecimalPlaces(2).toNumber(),
      details: pd.lines.map((l) => ({
        detailName: l.detail.name,
        lengthM: l.detail.lengthM,
        quantity: l.quantity,
        materialCost: l.material.toDecimalPlaces(2).toNumber(),
        workCost: l.work.toDecimalPlaces(2).toNumber(),
      })),
    };
  });
}

/** Сумма накладных периода = расходы по статьям категории «Производственные (накладные)». */
export function periodOverheadFromCashFlows(
  rows: { flowType: "INCOME" | "EXPENSE"; amount: number; articleName: string | null }[],
  overheadArticleNames: Set<string>,
): number {
  return rows
    .filter((r) => r.flowType === "EXPENSE" && r.articleName && overheadArticleNames.has(r.articleName))
    .reduce((s, r) => s + r.amount, 0);
}
