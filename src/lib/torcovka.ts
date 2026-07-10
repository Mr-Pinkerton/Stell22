/** Строка нарезки: длина заготовки, м + количество. */
export type TorcovkaPick = {
  lengthM: number;
  quantity: number;
};

/** Суммарная длина нарезанных заготовок, м. */
export function sumDetailLengthM(picks: TorcovkaPick[]): number {
  return picks.reduce((sum, p) => sum + p.lengthM * p.quantity, 0);
}

/**
 * Макс. кол-во заготовок данной длины с учётом уже выбранных (кроме текущей).
 * Взятая длина реек = takenLengthM.
 */
export function maxDetailQuantity(params: {
  takenLengthM: number;
  picks: TorcovkaPick[];
  lengthM: number;
}): number {
  const { takenLengthM, picks, lengthM } = params;
  if (lengthM <= 0 || takenLengthM <= 0) return 0;

  const usedByOthers = sumDetailLengthM(picks.filter((p) => p.lengthM !== lengthM));
  const remainingM = takenLengthM - usedByOthers;
  if (remainingM <= 0) return 0;

  return Math.floor(remainingM / lengthM);
}

export function isOverRailLength(takenLengthM: number, usedLengthM: number): boolean {
  return usedLengthM > takenLengthM;
}
