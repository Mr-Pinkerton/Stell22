import { describe, expect, it } from "vitest";
import {
  buildJournal,
  dayKey,
  filterEntriesByPeriod,
  groupEntriesByDay,
  journalTotal,
} from "./entries";
import type { TerminalEntry } from "@/types/domain";

// Фиксированная точка отсчёта: 15.06.2026 12:00 UTC = 15:00 МСК.
const NOW = new Date("2026-06-15T12:00:00.000Z");

function e(
  id: string,
  type: TerminalEntry["type"],
  occurredAt: string,
  quantity: number,
  amount: number,
): TerminalEntry {
  return { id, employeeId: "emp-1", type, occurredAt, quantity, amount };
}

describe("dayKey", () => {
  it("отдаёт день в зоне UTC+3", () => {
    // 22:30 UTC = 01:30 МСК следующих суток.
    expect(dayKey("2026-06-15T22:30:00.000Z")).toBe("2026-06-16");
    expect(dayKey("2026-06-15T12:00:00.000Z")).toBe("2026-06-15");
  });
});

describe("filterEntriesByPeriod", () => {
  const entries = [
    e("a", "TORCOVKA", "2026-06-15T08:00:00.000Z", 10, 50), // сегодня
    e("b", "TORCOVKA", "2026-06-10T08:00:00.000Z", 10, 50), // 5 дней назад
    e("c", "TORCOVKA", "2026-06-01T08:00:00.000Z", 10, 50), // 14 дней назад
    e("d", "TORCOVKA", "2026-06-20T08:00:00.000Z", 10, 50), // в будущем
  ];

  it("неделя — только последние 7 дней, без будущего", () => {
    const got = filterEntriesByPeriod(entries, "week", NOW).map((x) => x.id);
    expect(got.sort()).toEqual(["a", "b"]);
  });

  it("месяц — последние 30 дней", () => {
    const got = filterEntriesByPeriod(entries, "month", NOW).map((x) => x.id);
    expect(got.sort()).toEqual(["a", "b", "c"]);
  });

  it("граница окна включительна", () => {
    const edge = e("edge", "TORCOVKA", "2026-06-08T12:00:00.000Z", 1, 1); // ровно -7 дней
    const got = filterEntriesByPeriod([edge], "week", NOW).map((x) => x.id);
    expect(got).toEqual(["edge"]);
  });
});

describe("groupEntriesByDay", () => {
  const entries = [
    e("a", "TORCOVKA", "2026-06-15T05:00:00.000Z", 100, 500),
    e("b", "PRISADKA", "2026-06-15T09:00:00.000Z", 40, 120),
    e("c", "TORCOVKA", "2026-06-15T07:00:00.000Z", 50, 250),
    e("d", "HOURS", "2026-06-14T06:00:00.000Z", 8, 2400),
  ];

  it("группирует по дням, свежие сверху", () => {
    const groups = groupEntriesByDay(entries);
    expect(groups.map((g) => g.date)).toEqual(["2026-06-15", "2026-06-14"]);
  });

  it("суммирует количество и заработок по типам", () => {
    const [today] = groupEntriesByDay(entries);
    expect(today.byType.TORCOVKA).toEqual({ quantity: 150, amount: 750 });
    expect(today.byType.PRISADKA).toEqual({ quantity: 40, amount: 120 });
    expect(today.totalAmount).toBe(870);
  });

  it("внутри дня — свежие сверху", () => {
    const [today] = groupEntriesByDay(entries);
    expect(today.entries.map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});

describe("buildJournal + journalTotal", () => {
  const entries = [
    e("a", "TORCOVKA", "2026-06-15T08:00:00.000Z", 10, 500),
    e("b", "PRISADKA", "2026-06-12T08:00:00.000Z", 10, 300),
    e("c", "HOURS", "2026-06-01T08:00:00.000Z", 8, 2400), // вне недели
  ];

  it("неделя: только дни в окне, итог корректен", () => {
    const groups = buildJournal(entries, "week", NOW);
    expect(groups.map((g) => g.date)).toEqual(["2026-06-15", "2026-06-12"]);
    expect(journalTotal(groups)).toBe(800);
  });

  it("месяц: добавляется старое внесение", () => {
    const groups = buildJournal(entries, "month", NOW);
    expect(journalTotal(groups)).toBe(3200);
  });

  it("пустой журнал — пустой массив, итог 0", () => {
    expect(buildJournal([], "week", NOW)).toEqual([]);
    expect(journalTotal([])).toBe(0);
  });
});
