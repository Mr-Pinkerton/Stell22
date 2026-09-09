/** INC-001 containment: generic TORCOVKA delete does not restore RailLot remaining. */
export const TORCOVKA_GENERIC_DELETE_BLOCKED =
  "Удаление торцовки временно запрещено: оно не возвращает рейки в пакет. Исправьте операцию вместо удаления.";

export function assertTorcovkaGenericDeleteAllowed(type: string): void {
  if (type === "TORCOVKA") {
    throw new Error(TORCOVKA_GENERIC_DELETE_BLOCKED);
  }
}
