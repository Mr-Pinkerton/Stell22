import { describe, expect, it } from "vitest";
import {
  batchWaste,
  employeeWaste,
  isWasteOverThreshold,
  wasteLengthM,
  wastePercent,
} from "./waste";

describe("wasteLengthM", () => {
  it("взято − произведено", () => {
    expect(wasteLengthM(1420, 1180).toNumber()).toBe(240);
  });
  it("не уходит ниже нуля", () => {
    expect(wasteLengthM(100, 120).toNumber()).toBe(0);
  });
});

describe("wastePercent", () => {
  it("отход / база × 100", () => {
    // 240 / 1420 × 100 = 16.9014...
    expect(wastePercent(240, 1420).toFixed(2)).toBe("16.90");
  });
  it("0 при нулевой базе", () => {
    expect(wastePercent(10, 0).toNumber()).toBe(0);
  });
});

describe("employeeWaste", () => {
  it("отход и процент по работнику (как в моках)", () => {
    const r = employeeWaste(1420, 1180);
    expect(r.wasteM.toNumber()).toBe(240);
    expect(Math.round(r.wastePct.toNumber())).toBe(17);
  });
  it("второй работник: 980 → 720", () => {
    const r = employeeWaste(980, 720);
    expect(r.wasteM.toNumber()).toBe(260);
    expect(Math.round(r.wastePct.toNumber())).toBe(27);
  });
  it("нулевая активность — без отхода", () => {
    const r = employeeWaste(0, 0);
    expect(r.wasteM.toNumber()).toBe(0);
    expect(r.wastePct.toNumber()).toBe(0);
  });
});

describe("batchWaste", () => {
  it("остаток, торцовочный отход и процент по израсходованному", () => {
    const r = batchWaste({
      purchasedM: 1000,
      takenM: 800,
      producedM: 740,
      writtenOffM: 50,
    });
    expect(r.remainingM.toNumber()).toBe(150); // 1000 − 800 − 50
    expect(r.wasteTorcovkaM.toNumber()).toBe(60); // 800 − 740
    expect(r.consumedM.toNumber()).toBe(850); // 800 + 50
    expect(r.totalWasteM.toNumber()).toBe(110); // 60 + 50
    // 110 / 850 × 100 = 12.94...
    expect(r.wastePct.toFixed(2)).toBe("12.94");
  });

  it("без списания остаток = закуплено − взято", () => {
    const r = batchWaste({ purchasedM: 600, takenM: 600, producedM: 540 });
    expect(r.remainingM.toNumber()).toBe(0);
    expect(r.writtenOffM.toNumber()).toBe(0);
    expect(r.wasteTorcovkaM.toNumber()).toBe(60);
    expect(r.wastePct.toFixed(2)).toBe("10.00"); // 60 / 600
  });

  it("остаток не уходит в минус при перерасчёте", () => {
    const r = batchWaste({ purchasedM: 500, takenM: 480, producedM: 460, writtenOffM: 40 });
    expect(r.remainingM.toNumber()).toBe(0); // 500 − 480 − 40 = −20 → 0
  });
});

describe("isWasteOverThreshold", () => {
  it("true выше порога", () => {
    expect(isWasteOverThreshold(31)).toBe(true);
  });
  it("false на пороге и ниже", () => {
    expect(isWasteOverThreshold(30)).toBe(false);
    expect(isWasteOverThreshold(29.9)).toBe(false);
  });
  it("учитывает кастомный порог", () => {
    expect(isWasteOverThreshold(11, 10)).toBe(true);
  });
});
