import { describe, expect, it } from "vitest";
import { createLocalDate, endOfDay, getMonthPeriod } from "./dates";

describe("endOfDay", () => {
  it("возвращает конец дня 23:59:59.999 того же дня", () => {
    const d = endOfDay(createLocalDate(2026, 6, 12)); // 12 июля 2026
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(6);
    expect(d.getDate()).toBe(12);
    expect(d.getHours()).toBe(23);
    expect(d.getMinutes()).toBe(59);
    expect(d.getSeconds()).toBe(59);
    expect(d.getMilliseconds()).toBe(999);
  });
});

describe("getMonthPeriod", () => {
  it("границы месяца: 1-е 00:00 … последний день 23:59:59.999", () => {
    const p = getMonthPeriod(createLocalDate(2026, 6, 15)); // июль 2026 (31 день)
    expect(p.start).toEqual(createLocalDate(2026, 6, 1));
    expect(p.start.getHours()).toBe(0);
    expect(p.end.getDate()).toBe(31);
    expect(p.end.getMonth()).toBe(6);
    expect(p.end.getHours()).toBe(23);
    expect(p.end.getMilliseconds()).toBe(999);
  });

  it("февраль невисокосного года заканчивается 28-м", () => {
    const p = getMonthPeriod(createLocalDate(2026, 1, 10)); // февраль 2026
    expect(p.end.getDate()).toBe(28);
    expect(p.end.getMonth()).toBe(1);
  });

  it("включает последний день целиком (граница > любого момента дня)", () => {
    const p = getMonthPeriod(createLocalDate(2026, 6, 1));
    const lastDayEvening = new Date(2026, 6, 31, 20, 0, 0);
    expect(lastDayEvening <= p.end).toBe(true);
    expect(lastDayEvening >= p.start).toBe(true);
  });
});
