import { TIME_ZONE } from "@/lib/format";

/** DDMM в зоне проекта, напр. 30 июня → «3006». */
export function packageDatePart(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
  }).formatToParts(date);
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  return `${day}${month}`;
}

/** Длина реек в пакете — целые метры (округление), 2 цифры: 3.0 м → «03». */
export function packageLengthPart(lengthM: number): string {
  const m = Math.min(99, Math.max(0, Math.round(lengthM)));
  return String(m).padStart(2, "0");
}

/** Базовый код пакета: ПАК-3006-03. */
export function packageCodeBase(lengthM: number, purchaseDate: Date): string {
  return `ПАК-${packageDatePart(purchaseDate)}-${packageLengthPart(lengthM)}`;
}

/** Уникальный код с учётом уже занятых (в партии или в БД). */
export function allocatePackageCode(
  lengthM: number,
  purchaseDate: Date,
  usedCodes: Set<string>,
): string {
  const base = packageCodeBase(lengthM, purchaseDate);
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
