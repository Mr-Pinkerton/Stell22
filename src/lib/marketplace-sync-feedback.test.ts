import { describe, expect, it } from "vitest";
import { marketplaceSyncFeedback } from "@/lib/marketplace-sync-feedback";

describe("marketplaceSyncFeedback", () => {
  it("shows an error when a stub source is marked successful", () => {
    const feedback = marketplaceSyncFeedback({
      ok: true,
      salesAdded: 6,
      suppliesAdded: 2,
      stockUpdated: 4,
      sources: { wb: "api", ozon: "stub" },
    });
    expect(feedback.kind).toBe("error");
    if (feedback.kind === "error") expect(feedback.message).toContain("отклонена");
  });

  it("shows the server refusal text", () => {
    const feedback = marketplaceSyncFeedback({
      ok: false,
      salesAdded: 0,
      suppliesAdded: 0,
      stockUpdated: 0,
      error: "Синхронизация отклонена: нужны ключи и Ozon, и Wildberries. Демонстрационные данные не записываются.",
    });
    expect(feedback).toEqual({
      kind: "error",
      message: "Синхронизация отклонена: нужны ключи и Ozon, и Wildberries. Демонстрационные данные не записываются.",
    });
  });

  it("shows a success only for two live API sources", () => {
    const feedback = marketplaceSyncFeedback({
      ok: true,
      salesAdded: 1,
      suppliesAdded: 0,
      stockUpdated: 0,
      sources: { wb: "api", ozon: "api" },
    });
    expect(feedback.kind).toBe("success");
    if (feedback.kind === "success") expect(feedback.message).not.toContain("демо");
  });
});
