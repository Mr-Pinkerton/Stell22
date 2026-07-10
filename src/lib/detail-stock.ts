// Чистые функции склада деталей по стадиям присадки.
// Деталь «готова» только когда выполнены ВСЕ требуемые ей присадки
// (cost-integrity.mdc). Поток: торцовка → заготовка (BlankStock, по длине/типу/
// сорту, конкретная деталь ещё не определена) → присадка (первая присадка
// превращает заготовку в конкретную деталь) → DetailStock по комбинации
// выполненных присадок → упаковка. Здесь сводим заготовки и детали в StockSnapshot.

import type { Detail, RailType, Sort, StockSnapshot } from "@/types/domain";

export interface DetailStockRow {
  detailId: string;
  torcevayaDone: boolean;
  ploskostDone: boolean;
  quantity: number;
}

export interface BlankStockRow {
  lengthM: number;
  detailType: RailType;
  sort: Sort;
  quantity: number;
}

type PrisadkaFlags = Pick<Detail, "prisadkaTorcevaya" | "prisadkaPloskost">;

/** Ключ заготовки: длина (4 знака) | тип | сорт. */
export function blankKey(lengthM: number, detailType: RailType, sort: Sort): string {
  return `${lengthM.toFixed(4)}|${detailType}|${sort}`;
}

/** Ключ заготовки, соответствующей спецификации детали. */
export function blankKeyForDetail(detail: Pick<Detail, "lengthM" | "detailType" | "sort">): string {
  return blankKey(detail.lengthM, detail.detailType, detail.sort);
}

/** Требуемые детали типы присадки. */
export function requiredPrisadki(detail: PrisadkaFlags): { torcev: boolean; plosk: boolean } {
  return { torcev: detail.prisadkaTorcevaya, plosk: detail.prisadkaPloskost };
}

/**
 * Жадно распределяет списание `needed` по строкам остатка (по порядку).
 * Возвращает массив «сколько взять из каждой строки». Бросает, если суммарного
 * остатка не хватает (защита от ухода в минус — cost-integrity).
 */
export function allocate(quantities: number[], needed: number): number[] {
  if (needed < 0) throw new Error("Отрицательное количество");
  const total = quantities.reduce((s, q) => s + Math.max(0, q), 0);
  if (total < needed) throw new Error("Недостаточно остатка");

  let left = needed;
  return quantities.map((q) => {
    if (left <= 0) return 0;
    const take = Math.min(Math.max(0, q), left);
    left -= take;
    return take;
  });
}

/** Строка склада «готова», если выполнены все требуемые присадки детали. */
export function isReady(detail: PrisadkaFlags, torcevDone: boolean, ploskDone: boolean): boolean {
  const req = requiredPrisadki(detail);
  return (!req.torcev || torcevDone) && (!req.plosk || ploskDone);
}

/**
 * Свод заготовок и деталей в снимок для терминала:
 *  - blanks — заготовки по ключу (длина|тип|сорт);
 *  - detailsReady — сумма ГОТОВЫХ деталей (все требуемые присадки выполнены);
 *    для деталей без присадок годной сразу считается заготовка её спецификации;
 *  - prisadkaPending — сколько пригодных к каждому ещё не выполненному типу
 *    присадки: заготовки соответствующей спецификации (первая присадка) плюс
 *    частично присаженные детали (вторая присадка). Заготовки общие для всех
 *    деталей одной спецификации, поэтому попадают в pending каждой такой детали
 *    (какой именно деталью станет заготовка — решает работник на присадке).
 * `nomenclatureStock` (крепёж/упаковка/разное) передаётся отдельно.
 */
export function buildStockSnapshot(
  details: Detail[],
  detailRows: DetailStockRow[],
  blankRows: BlankStockRow[] = [],
  nomenclatureStock: Record<string, number> = {},
): StockSnapshot {
  const blanks: Record<string, number> = {};
  for (const b of blankRows) {
    if (b.quantity <= 0) continue;
    const key = blankKey(b.lengthM, b.detailType, b.sort);
    blanks[key] = (blanks[key] ?? 0) + b.quantity;
  }

  const detailsReady: Record<string, number> = {};
  const prisadkaPending: Record<string, { torcev: number; plosk: number }> = {};

  const rowsByDetail = new Map<string, DetailStockRow[]>();
  for (const row of detailRows) {
    if (row.quantity <= 0) continue;
    const list = rowsByDetail.get(row.detailId) ?? [];
    list.push(row);
    rowsByDetail.set(row.detailId, list);
  }

  for (const detail of details) {
    const req = requiredPrisadki(detail);
    const blanksQty = blanks[blankKeyForDetail(detail)] ?? 0;

    // Деталь без присадок: заготовка её спецификации сразу годна на упаковку.
    if (!req.torcev && !req.plosk) {
      if (blanksQty > 0) {
        detailsReady[detail.id] = (detailsReady[detail.id] ?? 0) + blanksQty;
      }
      continue;
    }

    const pend = { torcev: 0, plosk: 0 };
    if (req.torcev) pend.torcev += blanksQty;
    if (req.plosk) pend.plosk += blanksQty;

    for (const row of rowsByDetail.get(detail.id) ?? []) {
      if (isReady(detail, row.torcevayaDone, row.ploskostDone)) {
        detailsReady[detail.id] = (detailsReady[detail.id] ?? 0) + row.quantity;
        continue;
      }
      if (req.torcev && !row.torcevayaDone) pend.torcev += row.quantity;
      if (req.plosk && !row.ploskostDone) pend.plosk += row.quantity;
    }

    if (pend.torcev > 0 || pend.plosk > 0) prisadkaPending[detail.id] = pend;
  }

  return { blanks, detailsReady, nomenclature: nomenclatureStock, prisadkaPending };
}
