import type { Sort } from "@/types/domain";

/** Строка нарезки: длина заготовки, м + фактический сорт + количество. */
export type TorcovkaPick = {
  lengthM: number;
  sort: Sort;
  quantity: number;
};

/** Суммарная длина нарезанных заготовок, м (по всем сортам — материал общий). */
export function sumDetailLengthM(picks: TorcovkaPick[]): number {
  return picks.reduce((sum, p) => sum + p.lengthM * p.quantity, 0);
}

/**
 * Макс. кол-во заготовок данной длины и сорта с учётом уже выбранных (кроме
 * текущей комбинации длина+сорт). Материал общий на все сорта, поэтому взятая
 * длина реек `takenLengthM` делится между всеми выбранными заготовками.
 */
export function maxDetailQuantity(params: {
  takenLengthM: number;
  picks: TorcovkaPick[];
  lengthM: number;
  sort: Sort;
}): number {
  const { takenLengthM, picks, lengthM, sort } = params;
  if (lengthM <= 0 || takenLengthM <= 0) return 0;

  const usedByOthers = sumDetailLengthM(
    picks.filter((p) => !(p.lengthM === lengthM && p.sort === sort)),
  );
  const remainingM = takenLengthM - usedByOthers;
  if (remainingM <= 0) return 0;

  return Math.floor(remainingM / lengthM);
}

export function isOverRailLength(takenLengthM: number, usedLengthM: number): boolean {
  return usedLengthM > takenLengthM;
}
