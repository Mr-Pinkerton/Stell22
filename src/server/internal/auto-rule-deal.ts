import type { DealStatus } from "@/types/domain";

/**
 * Идентичность сделки в автоправиле — только id.
 * undefined сохраняет текущее значение, null снимает назначение.
 * Имя не участвует: у Deal.name нет уникальности.
 */
export function resolveAutoRuleDealAssignment(
  dealId: string | null | undefined,
  deal: { id: string; status: DealStatus } | null,
): string | null | undefined {
  if (dealId === undefined) return undefined;
  if (dealId === null) return null;
  if (!deal || deal.id !== dealId) {
    throw new Error("Сделка не найдена");
  }
  if (deal.status !== "OPEN") {
    throw new Error("Автоправилу можно назначить только открытую сделку");
  }
  return deal.id;
}
