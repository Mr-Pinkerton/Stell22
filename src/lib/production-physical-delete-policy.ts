import {
  TORCOVKA_GENERIC_DELETE_BLOCKED,
  assertTorcovkaGenericDeleteAllowed,
} from "@/lib/torcovka-delete-policy";

export { TORCOVKA_GENERIC_DELETE_BLOCKED, assertTorcovkaGenericDeleteAllowed };

export const PRISADKA_PHYSICAL_DELETE_BLOCKED =
  "Удаление присадки запрещено: физический сток не отменяется. Исправьте количество вместо удаления.";

export const UPAKOVKA_PHYSICAL_DELETE_BLOCKED =
  "Удаление упаковки запрещено: физический сток не отменяется. Исправьте количество вместо удаления.";

/** Stock-changing production types. HOURS is not physical. */
export function isPhysicalProductionOperationType(type: string): boolean {
  return type === "TORCOVKA" || type === "PRISADKA" || type === "UPAKOVKA";
}

export function physicalProductionDeleteBlockedMessage(type: string): string | null {
  if (type === "TORCOVKA") return TORCOVKA_GENERIC_DELETE_BLOCKED;
  if (type === "PRISADKA") return PRISADKA_PHYSICAL_DELETE_BLOCKED;
  if (type === "UPAKOVKA") return UPAKOVKA_PHYSICAL_DELETE_BLOCKED;
  return null;
}

/**
 * After the operation row is locked and loaded, reject physical deletes
 * before any reverse. HOURS remains allowed.
 */
export function assertPhysicalProductionDeleteAllowed(type: string): void {
  assertTorcovkaGenericDeleteAllowed(type);
  if (type === "PRISADKA") {
    throw new Error(PRISADKA_PHYSICAL_DELETE_BLOCKED);
  }
  if (type === "UPAKOVKA") {
    throw new Error(UPAKOVKA_PHYSICAL_DELETE_BLOCKED);
  }
}
