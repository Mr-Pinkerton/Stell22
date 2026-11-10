import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  businessDateKey,
  businessMonthIso,
  createLocalDate,
  endOfDay,
  getMonthPeriod,
  startOfBusinessDay,
} from "./dates";

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

  it("октябрь не забирает 1 ноября: накладные октября остаются в октябре", () => {
    const october = getMonthPeriod(createLocalDate(2026, 9, 1));
    expect(october.end.toISOString()).toBe("2026-10-31T20:59:59.999Z");
    const inside = (instant: Date) => instant >= october.start && instant <= october.end;
    expect(inside(new Date("2026-10-31T20:59:59.999Z"))).toBe(true);
    expect(inside(new Date("2026-10-31T21:00:00.000Z"))).toBe(false);
  });
});

describe("хозяйственная дата из абсолютного момента (UTC+3)", () => {
  const late = new Date("2026-10-31T21:30:00.000Z");
  const before = new Date("2026-10-31T20:59:59.999Z");
  const at = new Date("2026-10-31T21:00:00.000Z");

  it("21:30Z 31 октября — это 1 ноября", () => {
    expect(businessDateKey(late)).toBe("2026-11-01");
    expect(businessMonthIso(late)).toBe("2026-11-01");
  });

  it("граница суток: до 21:00Z — октябрь, с 21:00Z — ноябрь", () => {
    expect(businessDateKey(before)).toBe("2026-10-31");
    expect(businessMonthIso(before)).toBe("2026-10-01");
    expect(businessDateKey(at)).toBe("2026-11-01");
    expect(businessMonthIso(at)).toBe("2026-11-01");
  });

  it("сохранённый месяц цели не сдвигается: полночь UTC и полночь UTC+3 — один месяц", () => {
    expect(businessMonthIso(new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-11-01");
    expect(businessMonthIso(new Date("2026-10-31T21:00:00.000Z"))).toBe("2026-11-01");
    expect(businessMonthIso(new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-10-01");
    expect(businessMonthIso(new Date("2026-09-30T21:00:00.000Z"))).toBe("2026-10-01");
  });
});

describe("хозяйственный календарь не зависит от TZ процесса", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const script = `
    import * as datesNs from "./src/lib/dates.ts";
    import * as periodNs from "./src/lib/dashboard-period.ts";
    import * as goalsNs from "./src/lib/goals-view.ts";
    const dates = datesNs.businessDateKey ? datesNs : datesNs.default;
    const period = periodNs.resolveDashboardPeriod ? periodNs : periodNs.default;
    const goals = goalsNs.goalMonthRelation ? goalsNs : goalsNs.default;
    const late = new Date("2026-10-31T21:30:00.000Z");
    const before = new Date("2026-10-31T20:59:59.999Z");
    const at = new Date("2026-10-31T21:00:00.000Z");
    console.log(JSON.stringify({
      lateDate: dates.businessDateKey(late),
      lateMonth: dates.businessMonthIso(late),
      beforeDate: dates.businessDateKey(before),
      atDate: dates.businessDateKey(at),
      dashMonth: period.resolveDashboardPeriod("month", late).start.getMonth(),
      currentMonth: dates.getCurrentMonth(late).getMonth(),
      novemberGoal: goals.goalMonthRelation("2026-11-01", late),
      octoberGoal: goals.goalMonthRelation("2026-10-01", late),
    }));
  `;

  function run(tz: string): {
    lateDate: string;
    lateMonth: string;
    beforeDate: string;
    atDate: string;
    dashMonth: number;
    currentMonth: number;
    novemberGoal: string;
    octoberGoal: string;
  } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { cwd: root, env: { ...process.env, TZ: tz }, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  it.each(["UTC", "Europe/Moscow"])("%s: 21:30Z относится к ноябрю, 20:59Z — к октябрю", (tz) => {
    const out = run(tz);
    expect(out.lateDate).toBe("2026-11-01");
    expect(out.lateMonth).toBe("2026-11-01");
    expect(out.beforeDate).toBe("2026-10-31");
    expect(out.atDate).toBe("2026-11-01");
    expect(out.dashMonth).toBe(10);
    expect(out.currentMonth).toBe(10);
    expect(out.novemberGoal).toBe("current");
    expect(out.octoberGoal).toBe("past");
  });
});
