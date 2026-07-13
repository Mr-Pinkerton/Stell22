import { describe, expect, it } from "vitest";
import { createLocalDate, endOfDay, getMonthPeriod, startOfBusinessDay } from "./dates";

// Инстанты в UTC — не зависят от локали хоста (важно для CI не в МСК).
describe("границы периода фиксированы в UTC+3", () => {
  it("startOfBusinessDay = 00:00 МСК = 21:00Z предыдущего дня", () => {
    expect(startOfBusinessDay(createLocalDate(2026, 6, 1)).toISOString()).toBe(
      "2026-06-30T21:00:00.000Z",
    );
  });
  it("endOfDay = 23:59:59.999 МСК = 20:59:59.999Z того же дня", () => {
    expect(endOfDay(createLocalDate(2026, 6, 12)).toISOString()).toBe(
      "2026-07-12T20:59:59.999Z",
    );
  });
  it("getMonthPeriod июль 2026 → [30.06 21:00Z … 31.07 20:59:59.999Z]", () => {
    const p = getMonthPeriod(createLocalDate(2026, 6, 15));
    expect(p.start.toISOString()).toBe("2026-06-30T21:00:00.000Z");
    expect(p.end.toISOString()).toBe("2026-07-31T20:59:59.999Z");
  });
});

describe("getMonthPeriod", () => {
  it("февраль невисокосного года заканчивается 28-м (UTC+3)", () => {
    const p = getMonthPeriod(createLocalDate(2026, 1, 10)); // февраль 2026
    expect(p.end.toISOString()).toBe("2026-02-28T20:59:59.999Z");
  });

  it("включает последний день целиком (граница > любого момента дня)", () => {
    const p = getMonthPeriod(createLocalDate(2026, 6, 1));
    // 31.07 23:00 МСК = 20:00Z — внутри периода; 01.08 00:00 МСК = 31.07 21:00Z — вне.
    expect(new Date("2026-07-31T20:00:00.000Z") <= p.end).toBe(true);
    expect(new Date("2026-07-31T21:00:00.000Z") <= p.end).toBe(false);
    expect(new Date("2026-06-30T21:00:00.000Z") >= p.start).toBe(true);
    expect(new Date("2026-06-30T20:59:59.999Z") >= p.start).toBe(false);
  });
});
