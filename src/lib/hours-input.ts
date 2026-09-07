import { D, type Num } from "@/lib/cost";

export const HOURS_NO_RATE_MESSAGE = "Почасовая ставка не задана";
export const HOURS_STEP_MESSAGE = "Часы — кратно 0,5";

/** hours > 0 and hours × 2 is an integer (0.5 step), Decimal-safe. */
export function isValidHoursStep(hours: Num): boolean {
  try {
    const d = D(hours);
    if (!d.isFinite() || d.lte(0)) return false;
    return d.times(2).isInteger();
  } catch {
    return false;
  }
}

export function assertValidHours(hours: unknown): void {
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) {
    throw new Error("Укажите количество часов");
  }
  if (!isValidHoursStep(hours)) {
    throw new Error(HOURS_STEP_MESSAGE);
  }
}

function decimalFromRate(value: unknown) {
  if (value == null) return null;
  try {
    if (typeof value === "object" && value !== null && "toNumber" in value) {
      const n = (value as { toNumber: () => number }).toNumber();
      if (!Number.isFinite(n)) return null;
      return D(n);
    }
    const d = D(value as Num);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

/** No valid payable hourly rate: null, 0, negative, or non-finite. Does not coerce to 0. */
export function isHourlyRateUnavailable(value: unknown): boolean {
  const d = decimalFromRate(value);
  return d == null || d.lte(0);
}

/** C clears the entire hours input; remaining digits keep the half-hour toggle. */
export function applyHoursKeypadChange(
  current: { whole: number; half: boolean },
  next: string,
): { whole: number; half: boolean } {
  const digits = next.replace(/\D/g, "");
  if (digits === "") return { whole: 0, half: false };
  return { whole: Number(digits), half: current.half };
}

export function formatHoursRu(hours: number): string {
  return hours.toLocaleString("ru-RU", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
}
