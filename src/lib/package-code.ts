import type { Sort } from "@/types/domain";

/** Длина реек в дециметрах (десятых метра), 2 цифры: 2.4 м → «24», 3 м → «30». */
export function packageLengthPart(lengthM: number): string {
  const dm = Math.max(0, Math.round(lengthM * 10));
  return String(dm).padStart(2, "0");
}

/** Номер сорта 2 цифры: SORT1 → «01», SORT2 → «02». */
export function packageSortPart(sort: Sort): string {
  return sort === "SORT2" ? "02" : "01";
}

/**
 * Базовый код пакета: ПАК-24-569-01, где
 * 24 — длина реек (2.4 м), 569 — количество реек, 01 — сорт.
 */
export function packageCodeBase(lengthM: number, quantity: number, sort: Sort): string {
  return `ПАК-${packageLengthPart(lengthM)}-${quantity}-${packageSortPart(sort)}`;
}

/** Уникальный код с учётом уже занятых (в партии или в БД). */
export function allocatePackageCode(
  lengthM: number,
  quantity: number,
  sort: Sort,
  usedCodes: Set<string>,
): string {
  const base = packageCodeBase(lengthM, quantity, sort);
  if (!usedCodes.has(base)) {
    usedCodes.add(base);
    return base;
  }
  let n = 2;
  while (usedCodes.has(`${base}-${n}`)) n += 1;
  const code = `${base}-${n}`;
  usedCodes.add(code);
  return code;
}
