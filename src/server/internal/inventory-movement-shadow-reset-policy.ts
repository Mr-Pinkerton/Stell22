export const INVENTORY_MOVEMENT_SHADOW_RESET_CONFIRM = "INVENTORY_MOVEMENT_SHADOW_RESET";

export type ShadowResetDecision =
  | { allowed: true }
  | { allowed: false; code: "CONFIRM_REQUIRED" | "SHADOW_WRITE_ACTIVE" | "AUTHORITATIVE_PRESENT"; message: string };

export function evaluateInventoryMovementShadowReset(input: {
  confirm: string | undefined;
  shadowWriteActive: boolean;
  authoritativeCount: number;
}): ShadowResetDecision {
  if (input.confirm !== INVENTORY_MOVEMENT_SHADOW_RESET_CONFIRM) {
    return {
      allowed: false,
      code: "CONFIRM_REQUIRED",
      message:
        "Отказ: нужен явный флаг --confirm=INVENTORY_MOVEMENT_SHADOW_RESET. Сброс SHADOW не выполнен.",
    };
  }
  if (input.shadowWriteActive) {
    return {
      allowed: false,
      code: "SHADOW_WRITE_ACTIVE",
      message:
        "Отказ: inventory_movement_shadow_write активен. Сначала выключите SHADOW-запись. Сброс не выполнен.",
    };
  }
  if (input.authoritativeCount > 0) {
    return {
      allowed: false,
      code: "AUTHORITATIVE_PRESENT",
      message: "Отказ: в InventoryMovement есть AUTHORITATIVE-строки. Сброс SHADOW не выполнен.",
    };
  }
  return { allowed: true };
}
