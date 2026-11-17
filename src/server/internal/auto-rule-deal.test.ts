import { describe, expect, it } from "vitest";
import { resolveAutoRuleDealAssignment } from "@/server/internal/auto-rule-deal";

const deals = [
  { id: "deal-a", name: "Поставка", status: "OPEN" as const },
  { id: "deal-b", name: "Поставка", status: "OPEN" as const },
  { id: "deal-c", name: "Поставка", status: "ARCHIVED" as const },
];

function byId(id: string) {
  return deals.find((deal) => deal.id === id) ?? null;
}

describe("auto rule deal identity", () => {
  it("persists the requested open deal id when another open deal has the same name", () => {
    expect(resolveAutoRuleDealAssignment("deal-b", byId("deal-b"))).toBe("deal-b");
    expect(resolveAutoRuleDealAssignment("deal-a", byId("deal-a"))).toBe("deal-a");
  });

  it("rejects a missing deal and an archived deal", () => {
    expect(() => resolveAutoRuleDealAssignment("missing", null)).toThrow(/не найдена/);
    expect(() => resolveAutoRuleDealAssignment("deal-c", byId("deal-c"))).toThrow(/открытую/);
  });

  it("clears an explicit null and preserves an omitted assignment", () => {
    expect(resolveAutoRuleDealAssignment(null, null)).toBeNull();
    expect(resolveAutoRuleDealAssignment(undefined, byId("deal-c"))).toBeUndefined();
  });
});
