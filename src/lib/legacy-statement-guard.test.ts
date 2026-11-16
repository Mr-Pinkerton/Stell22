import { describe, expect, it } from "vitest";
import {
  findLegacyImportCollision,
  incomingKeysAlreadyStored,
  legacyImportCollisionMessage,
} from "@/lib/legacy-statement-guard";

const period = { periodStart: "2026-10-01", periodEnd: "2026-10-31" };

describe("legacy import collision", () => {
  it("refuses when a stored historical statement date falls inside the new period", () => {
    const collision = findLegacyImportCollision({
      ...period,
      incomingImportKeys: ["new|2026-10-20|10.00|4070|4060"],
      legacyStatements: [{ id: "st-old", date: "2026-10-15" }],
      legacyCashFlows: [],
    });
    expect(collision?.statementDates).toEqual([{ id: "st-old", date: "2026-10-15" }]);
    expect(collision?.periodStart).toBe("2026-10-01");
    expect(collision?.periodEnd).toBe("2026-10-31");
  });

  it("does not turn one stored statement date into a verified period", () => {
    const collision = findLegacyImportCollision({
      ...period,
      incomingImportKeys: [],
      legacyStatements: [{ id: "st-old", date: "2026-10-15" }],
      legacyCashFlows: [],
    });
    expect(collision).not.toHaveProperty("verifiedPeriodStart");
    expect(collision?.statementDates[0]?.date).toBe("2026-10-15");
    expect(legacyImportCollisionMessage(collision!)).not.toMatch(/потер/);
    expect(legacyImportCollisionMessage(collision!)).toContain("не создана");
    expect(legacyImportCollisionMessage(collision!)).toContain("2026-10-15");
  });

  it("refuses when a linked historical operation date is inside the period even if the statement date is outside", () => {
    const collision = findLegacyImportCollision({
      ...period,
      incomingImportKeys: [],
      legacyStatements: [{ id: "st-old", date: "2026-09-01" }],
      legacyCashFlows: [{ id: "cf-old", date: "2026-10-20", importKey: null }],
    });
    expect(collision?.statementDates).toEqual([]);
    expect(collision?.cashFlowDates).toEqual([{ id: "cf-old", date: "2026-10-20" }]);
  });

  it("refuses the whole import when one account-scoped legacy import key matches", () => {
    const key = "77|2026-12-02|10.00|40702810|40602810";
    const collision = findLegacyImportCollision({
      periodStart: "2026-12-01",
      periodEnd: "2026-12-05",
      incomingImportKeys: [key, "78|2026-12-03|5.00|40702810|40602810"],
      legacyStatements: [{ id: "st-old", date: "2026-10-01" }],
      legacyCashFlows: [{ id: "cf-key", date: "2026-10-01", importKey: key }],
    });
    expect(collision?.importKeys).toEqual([{ id: "cf-key", importKey: key }]);
    expect(collision?.cashFlowDates).toEqual([]);
    expect(legacyImportCollisionMessage(collision!)).toContain("не доказывает");
  });

  it("allows a period that misses this account's historical dates and keys", () => {
    expect(
      findLegacyImportCollision({
        periodStart: "2026-12-01",
        periodEnd: "2026-12-05",
        incomingImportKeys: ["90|2026-12-02|10.00|4070|4060"],
        legacyStatements: [{ id: "st-old", date: "2026-10-27" }],
        legacyCashFlows: [{ id: "cf-old", date: "2026-10-27", importKey: "1|2026-10-27|10.00|4070|4060" }],
      }),
    ).toBeNull();
  });

  it("does not treat a period with no operations as an empty duplicate", () => {
    expect(incomingKeysAlreadyStored([], ["1|2026-10-27|10.00|4070|4060"])).toBe(false);
  });

  it("detects that every incoming key is already stored on the account", () => {
    const key = "1|2026-10-27|10.00|4070|4060";
    expect(incomingKeysAlreadyStored([key], [key])).toBe(true);
    expect(incomingKeysAlreadyStored([key, "2|2026-10-28|3.00|4070|4060"], [key])).toBe(false);
  });
});
