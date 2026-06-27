/** Строка нарезки: деталь + количество + длина одной штуки, м. */
export type TorcovkaPick = {
  detailId: string;
  quantity: number;
  lengthM: number;
};

/** Суммарная длина нарезанных деталей, м. */
export function sumDetailLengthM(picks: TorcovkaPick[]): number {
  return picks.reduce((sum, p) => sum + p.lengthM * p.quantity, 0);
}

/**
 * Макс. кол-во данной детали с учётом уже выбранных (кроме текущей).
 * Взятая длина реек = takenLengthM.
 */
export function maxDetailQuantity(params: {
  takenLengthM: number;
  picks: TorcovkaPick[];
  detailId: string;
  detailLengthM: number;
}): number {
  const { takenLengthM, picks, detailId, detailLengthM } = params;
  if (detailLengthM <= 0 || takenLengthM <= 0) return 0;

  const usedByOthers = sumDetailLengthM(picks.filter((p) => p.detailId !== detailId));
  const remainingM = takenLengthM - usedByOthers;
  if (remainingM <= 0) return 0;

  return Math.floor(remainingM / detailLengthM);
}

export function isOverRailLength(takenLengthM: number, usedLengthM: number): boolean {
  return usedLengthM > takenLengthM;
}
