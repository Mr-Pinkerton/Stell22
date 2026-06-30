import { describe, expect, it } from "vitest";
import {
  avgPerUnit,
  hasPieceRates,
  hourlyEarning,
  operationEarning,
  pieceworkEarning,
  salaryPerOperation,
  totalSalary,
  type OperationCounts,
  type OperationRates,
  type PieceRates,
} from "./payroll";

const opRates: OperationRates = {
  hourly: 300,
  torcovkaSort1: 5,
  torcovkaSort2: 4,
  prisadkaTorcev: 3,
  prisadkaPlosk: 3,
  upakovka: 20,
};

const pieceRates: PieceRates = {
  torcovkaSort1: 8,
  torcovkaSort2: 6,
  prisadkaTorcev: 5,
  prisadkaPlosk: 3,
  upakovka: 12,
};

const counts: OperationCounts = {
  torcovkaSort1: 45,
  torcovkaSort2: 200,
  prisadkaTorcev: 100,
  upakovka: 10,
};

describe("hasPieceRates", () => {
  it("true если задана хотя бы одна расценка", () => {
    expect(hasPieceRates({ upakovka: 12 })).toBe(true);
  });
  it("false для окладника (все null/undefined)", () => {
    expect(hasPieceRates({})).toBe(false);
    expect(hasPieceRates({ torcovkaSort1: null, upakovka: null })).toBe(false);
  });
});

describe("pieceworkEarning", () => {
  it("Σ(расценка × кол-во), пропуская не выполненные типы", () => {
    // 8*45 + 6*200 + 5*100 + 0(plosk) + 12*10 = 360+1200+500+120 = 2180
    expect(pieceworkEarning(pieceRates, counts).toNumber()).toBe(2180);
  });
  it("0 без операций", () => {
    expect(pieceworkEarning(pieceRates, {}).toNumber()).toBe(0);
  });
});

describe("hourlyEarning", () => {
  it("часы × ставка", () => {
    expect(hourlyEarning(8, 250).toNumber()).toBe(2000);
  });
  it("0 без ставки", () => {
    expect(hourlyEarning(8, null).toNumber()).toBe(0);
  });
});

describe("totalSalary", () => {
  it("сдельная + почасовая вместе", () => {
    // 2180 (сдельная) + 8*250 (часы) = 4180
    expect(
      totalSalary({ rates: pieceRates, counts, hours: 8, hourlyRate: 250 }).toNumber(),
    ).toBe(4180);
  });
  it("только сдельная, если нет ставки", () => {
    expect(totalSalary({ rates: pieceRates, counts }).toNumber()).toBe(2180);
  });
  it("только почасовая для окладника", () => {
    expect(
      totalSalary({ rates: {}, counts: {}, hours: 10, hourlyRate: 300 }).toNumber(),
    ).toBe(3000);
  });
});

describe("salaryPerOperation", () => {
  it("оклад смены / кол-во операций", () => {
    expect(salaryPerOperation(3000, 25).toNumber()).toBe(120);
  });
  it("0 при отсутствии операций", () => {
    expect(salaryPerOperation(3000, 0).toNumber()).toBe(0);
  });
});

describe("avgPerUnit", () => {
  it("сумма / кол-во произведённого", () => {
    expect(avgPerUnit(2180, 255).toFixed(4)).toBe("8.5490");
  });
  it("0 при нулевом производстве", () => {
    expect(avgPerUnit(2180, 0).toNumber()).toBe(0);
  });
});

describe("operationEarning", () => {
  it("HOURS: часы × ставка", () => {
    expect(operationEarning({ type: "HOURS", rates: opRates, hours: 8 })).toEqual({
      quantity: 8,
      amount: 2400,
    });
  });

  it("UPAKOVKA: изделия × расценка упаковки", () => {
    expect(operationEarning({ type: "UPAKOVKA", rates: opRates, productQty: 15 })).toEqual({
      quantity: 15,
      amount: 300,
    });
  });

  it("TORCOVKA: суммирует по сортам деталей", () => {
    const res = operationEarning({
      type: "TORCOVKA",
      rates: opRates,
      lines: [
        { quantity: 10, sort: "SORT1" },
        { quantity: 5, sort: "SORT2" },
      ],
    });
    // 10*5 + 5*4 = 70
    expect(res).toEqual({ quantity: 15, amount: 70 });
  });

  it("PRISADKA: торцевая и/или плоскостная", () => {
    const res = operationEarning({
      type: "PRISADKA",
      rates: opRates,
      lines: [
        { quantity: 4, prisadkaTorcevaya: true, prisadkaPloskost: true },
        { quantity: 2, prisadkaTorcevaya: true },
      ],
    });
    // 4*(3+3) + 2*3 = 24 + 6 = 30
    expect(res).toEqual({ quantity: 6, amount: 30 });
  });

  it("округляет сумму до 2 знаков", () => {
    // 333.333 × 3 = 999.999 → 1000.00
    const res = operationEarning({ type: "HOURS", rates: { ...opRates, hourly: 333.333 }, hours: 3 });
    expect(res.amount).toBe(1000);
  });
});
