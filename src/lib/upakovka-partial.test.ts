import { describe, expect, it } from "vitest";
import {
  confirmedRecoveryPicks,
  UPAKOVKA_PARTIAL_BODY,
  UPAKOVKA_PARTIAL_TITLE,
  unrecordedCandidates,
} from "@/lib/upakovka-partial";

describe("upakovka partial recovery", () => {
  it("does not present a partial save as a completed pack", () => {
    expect(UPAKOVKA_PARTIAL_TITLE).toContain("уже записана");
    expect(UPAKOVKA_PARTIAL_BODY).not.toContain("Ошибка внесения");
    expect(UPAKOVKA_PARTIAL_BODY).toContain("журнал");
    expect(UPAKOVKA_PARTIAL_BODY).not.toMatch(/успешно сохранена вся/i);
  });

  it("does not copy draft quantities into the new request", () => {
    const candidates = unrecordedCandidates({
      draftPicks: [
        { productId: "saved", quantity: 4 },
        { productId: "open", quantity: 3 },
      ],
      savedProductIds: ["saved"],
    });
    expect(candidates).toEqual(["open"]);
    expect(
      confirmedRecoveryPicks({
        candidates,
        confirmedQuantities: {},
        savedProductIds: ["saved"],
      }),
    ).toEqual([]);
    expect(
      confirmedRecoveryPicks({
        candidates,
        confirmedQuantities: { open: 1, saved: 4 },
        savedProductIds: ["saved"],
      }),
    ).toEqual([{ productId: "open", quantity: 1 }]);
  });
});
