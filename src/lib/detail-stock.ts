// Чистые функции склада деталей по стадиям присадки.
// Деталь «готова» только когда выполнены ВСЕ требуемые ей присадки
// (cost-integrity.mdc). Остаток деталей хранится строками по комбинации
// выполненных присадок (DetailStock), здесь сводим это в StockSnapshot.

import type { Detail, StockSnapshot } from "@/types/domain";

export interface DetailStockRow {
  detailId: string;
  torcevayaDone: boolean;
  ploskostDone: boolean;
  quantity: number;
}

type PrisadkaFlags = Pick<Detail, "prisadkaTorcevaya" | "prisadkaPloskost">;

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
 * Свод остатков деталей в снимок для терминала:
 *  - detailsReady — сумма ГОТОВЫХ (все присадки выполнены) по detailId;
 *  - prisadkaPending — сколько деталей ждёт каждого ещё не выполненного типа.
 * `nomenclatureStock` (крепёж/упаковка/разное) передаётся отдельно (не зависит
 * от стадий присадки).
 */
export function buildStockSnapshot(
  details: Detail[],
  rows: DetailStockRow[],
  nomenclatureStock: Record<string, number> = {},
): StockSnapshot {
  const byId = new Map(details.map((d) => [d.id, d]));
  const detailsReady: Record<string, number> = {};
  const prisadkaPending: Record<string, { torcev: number; plosk: number }> = {};

  for (const row of rows) {
    if (row.quantity <= 0) continue;
    const detail = byId.get(row.detailId);
    if (!detail) continue;
    const req = requiredPrisadki(detail);

    if (isReady(detail, row.torcevayaDone, row.ploskostDone)) {
      detailsReady[row.detailId] = (detailsReady[row.detailId] ?? 0) + row.quantity;
      continue;
    }

    const pend = prisadkaPending[row.detailId] ?? { torcev: 0, plosk: 0 };
    if (req.torcev && !row.torcevayaDone) pend.torcev += row.quantity;
    if (req.plosk && !row.ploskostDone) pend.plosk += row.quantity;
    prisadkaPending[row.detailId] = pend;
  }

  return { detailsReady, nomenclature: nomenclatureStock, prisadkaPending };
}
