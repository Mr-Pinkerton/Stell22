import { describe, expect, it } from "vitest";
import type { SalaryDayLine } from "@/mocks/report-fixtures";
import { listSalaryDays, paidHistoryRange } from "@/lib/salary-report";

function day(offset: number): string {
  const date = new Date(Date.UTC(2026, 0, 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

describe("listSalaryDays", () => {
  it("32 дня по 50 ₽ объясняют все 1600 ₽", () => {
    const days: SalaryDayLine[] = Array.from({ length: 32 }, (_, index) => ({
      date: day(index),
      hours: 1,
      torcovka: 0,
      prisadka: 0,
      upakovka: 0,
      total: 50,
    }));

    const listed = listSalaryDays(days);

    expect(listed).toHaveLength(32);
    expect(listed.reduce((sum, line) => sum + line.total, 0)).toBe(1600);
    expect(listed.map((line) => line.date)).toContain(day(0));
    expect(listed[0]?.date).toBe(day(31));
  });
});

describe("paidHistoryRange", () => {
  it("неделя задаёт границы только для истории выплат", () => {
    const start = new Date("2026-09-04T00:00:00.000Z");
    const end = new Date("2026-09-10T00:00:00.000Z");
    expect(paidHistoryRange({ start, end })).toEqual({ gte: start, lte: end });
    expect(paidHistoryRange(null)).toBeUndefined();
    expect(paidHistoryRange(undefined)).toBeUndefined();
  });
});
