import { describe, expect, it } from "vitest";
import {
  INVENTORY_MOVEMENT_EFFECTIVE_AT_INVALID,
  toUtcNaiveDate,
  utcNaiveTimestampString,
} from "@/server/internal/inventory-movement-time";

describe("utc-naive effectiveAt helpers", () => {
  it("keeps the UTC instant and formats naive UTC fields", () => {
    const instant = new Date("2026-09-18T16:05:06.123Z");
    expect(toUtcNaiveDate(instant).getTime()).toBe(instant.getTime());
    expect(utcNaiveTimestampString(instant)).toBe("2026-09-18T16:05:06.123");
    expect(utcNaiveTimestampString(instant)).not.toMatch(/Z|[+-]\d{2}:\d{2}$/);
  });

  it("rejects an invalid Date", () => {
    expect(() => toUtcNaiveDate(new Date("not-a-date"))).toThrow(
      INVENTORY_MOVEMENT_EFFECTIVE_AT_INVALID,
    );
  });
});
