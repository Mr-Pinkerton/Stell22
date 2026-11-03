export type MarketplaceSyncFeedbackInput = {
  ok: boolean;
  salesAdded: number;
  suppliesAdded: number;
  stockUpdated: number;
  error?: string;
  warnings?: string[];
  sources?: { wb: "api" | "stub"; ozon: "api" | "stub" };
};

export type MarketplaceSyncFeedback =
  | { kind: "success"; message: string; warnings?: string[] }
  | { kind: "error"; message: string };

const REFUSAL = "Синхронизация отклонена: демонстрационные данные не записываются.";

/** Успех показывается только когда оба контура пришли из API. */
export function marketplaceSyncFeedback(result: MarketplaceSyncFeedbackInput): MarketplaceSyncFeedback {
  const live = result.ok && result.sources?.wb === "api" && result.sources.ozon === "api";
  if (!live) {
    return { kind: "error", message: result.error ?? REFUSAL };
  }
  return {
    kind: "success",
    message: `Синхронизация: +${result.salesAdded} продаж, +${result.suppliesAdded} поставок, остатки обновлены [WB: API, Ozon: API]`,
    warnings: result.warnings,
  };
}
