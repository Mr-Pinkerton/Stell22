import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
  allocateWritableDealExtras,
  assertDealExtraAllocatable,
  DEAL_EXTRA_FROZEN_MIX,
  batchExtraShare,
  batchTotalCost,
  dealDeliveryExtra,
  sumConfirmedExpense,
} from "./deal-cost";

describe("sumConfirmedExpense (A13 карантин)", () => {
  it("считает расходы только по подтверждённым счетам", () => {
    const sum = sumConfirmedExpense([
      { flowType: "EXPENSE", amount: 100_000, accountConfirmed: true },
      { flowType: "EXPENSE", amount: 50_000, accountConfirmed: false }, // карантин
      { flowType: "INCOME", amount: 999, accountConfirmed: true }, // не расход
    ]);
    expect(sum.toNumber()).toBe(100_000);
  });

  it("неподтверждённый счёт не меняет себестоимость (все в карантине → 0)", () => {
    const sum = sumConfirmedExpense([
      { flowType: "EXPENSE", amount: 10_500, accountConfirmed: false },
    ]);
    expect(sum.toNumber()).toBe(0);
  });

  it("сохраняет точность Decimal", () => {
    const sum = sumConfirmedExpense([
      { flowType: "EXPENSE", amount: "0.1", accountConfirmed: true },
      { flowType: "EXPENSE", amount: "0.2", accountConfirmed: true },
    ]);
    expect(sum.toNumber()).toBe(0.3);
  });

  it("не считает перевод расходом, даже если на нём остались статья и сделка", () => {
    const sum = sumConfirmedExpense([
      { flowType: "EXPENSE", amount: 2_000, accountConfirmed: true, isTransfer: false },
      { flowType: "EXPENSE", amount: 1_500, accountConfirmed: true, isTransfer: true },
      { flowType: "INCOME", amount: 1_500, accountConfirmed: true, isTransfer: true },
    ]);
    expect(sum.toNumber()).toBe(2_000);
  });

  it("обычный подтверждённый расход без флага перевода по-прежнему входит в сумму", () => {
    const sum = sumConfirmedExpense([
      { flowType: "EXPENSE", amount: 2_000, accountConfirmed: true },
      { flowType: "EXPENSE", amount: 300, accountConfirmed: true, isTransfer: false },
    ]);
    expect(sum.toNumber()).toBe(2_300);
  });
});

describe("dealDeliveryExtra", () => {
  it("доставка = расходы сверх закупки", () => {
    // Волочек: закупка 150 000, оплачено 150 000 + доставка 10 500.
    expect(dealDeliveryExtra(160_500, 150_000).toNumber()).toBe(10_500);
  });

  it("нет доставки, если оплачено ровно закупку", () => {
    expect(dealDeliveryExtra(98_000, 98_000).toNumber()).toBe(0);
  });

  it("не уходит в минус при частичной оплате", () => {
    expect(dealDeliveryExtra(50_000, 98_000).toNumber()).toBe(0);
  });
});

describe("batchExtraShare", () => {
  it("распределяет доставку пропорционально закупке", () => {
    // Сделка: доставка 12 000; две партии 90 000 и 30 000 (итого 120 000).
    expect(batchExtraShare(12_000, 90_000, 120_000, 2).toNumber()).toBe(9_000);
    expect(batchExtraShare(12_000, 30_000, 120_000, 2).toNumber()).toBe(3_000);
  });

  it("делит поровну при нулевой сумме закупок", () => {
    expect(batchExtraShare(10_000, 0, 0, 2).toNumber()).toBe(5_000);
  });

  it("одна партия получает всю доставку", () => {
    expect(batchExtraShare(10_500, 150_000, 150_000, 1).toNumber()).toBe(10_500);
  });
});

describe("allocateWritableDealExtras", () => {
  function extras(dealExtra: string, batches: { id: string; purchaseCost: string; frozen?: boolean }[]) {
    return allocateWritableDealExtras(
      dealExtra,
      batches.map((batch) => ({ ...batch, frozen: batch.frozen ?? false })),
    );
  }

  function sumExtras(rows: { extra: Decimal }[]) {
    return rows.reduce((sum, row) => sum.plus(row.extra), new Decimal(0)).toFixed(2);
  }

  it("три равные закупки сохраняют доплату 100.00", () => {
    const rows = extras("100.00", [
      { id: "b", purchaseCost: "10.00" },
      { id: "a", purchaseCost: "10.00" },
      { id: "c", purchaseCost: "10.00" },
    ]);
    expect(rows.map((row) => `${row.id}:${row.extra.toFixed(2)}`)).toEqual([
      "a:33.33",
      "b:33.33",
      "c:33.34",
    ]);
    expect(sumExtras(rows)).toBe("100.00");
  });

  it("доплата 0.01 на две равные закупки не удваивается", () => {
    const rows = extras("0.01", [
      { id: "b", purchaseCost: "10.00" },
      { id: "a", purchaseCost: "10.00" },
    ]);
    expect(rows.map((row) => row.extra.toFixed(2))).toEqual(["0.00", "0.01"]);
    expect(sumExtras(rows)).toBe("0.01");
  });

  it("одна копейка на две нулевые закупки попадает только в последнюю партию", () => {
    const rows = extras("0.01", [
      { id: "z", purchaseCost: "0.00" },
      { id: "a", purchaseCost: "0.00" },
    ]);
    expect(rows.map((row) => `${row.id}:${row.extra.toFixed(2)}`)).toEqual(["a:0.00", "z:0.01"]);
    expect(sumExtras(rows)).toBe("0.01");
  });

  it("неравные веса 90000 и 30000 сохраняют доплату 100.01", () => {
    const rows = extras("100.01", [
      { id: "small", purchaseCost: "30000.00" },
      { id: "large", purchaseCost: "90000.00" },
    ]);
    expect(sumExtras(rows)).toBe("100.01");
    expect(rows.find((row) => row.id === "large")?.extra.toFixed(2)).toBe("75.00");
    expect(rows.find((row) => row.id === "small")?.extra.toFixed(2)).toBe("25.01");
  });

  it("одна партия получает всю доплату", () => {
    const rows = extras("10.50", [{ id: "only", purchaseCost: "150.00" }]);
    expect(rows.map((row) => row.extra.toFixed(2))).toEqual(["10.50"]);
  });

  it("нулевая доплата даёт нули", () => {
    const rows = extras("0.00", [
      { id: "a", purchaseCost: "10.00" },
      { id: "b", purchaseCost: "20.00" },
    ]);
    expect(rows.map((row) => row.extra.toFixed(2))).toEqual(["0.00", "0.00"]);
  });

  it("порядок входного списка не меняет доли", () => {
    const first = extras("100.00", [
      { id: "c", purchaseCost: "10.00" },
      { id: "a", purchaseCost: "10.00" },
      { id: "b", purchaseCost: "10.00" },
    ]);
    const second = extras("100.00", [
      { id: "b", purchaseCost: "10.00" },
      { id: "c", purchaseCost: "10.00" },
      { id: "a", purchaseCost: "10.00" },
    ]);
    expect(first.map((row) => `${row.id}:${row.extra.toFixed(2)}`)).toEqual(
      second.map((row) => `${row.id}:${row.extra.toFixed(2)}`),
    );
  });

  it("повтор того же входа даёт те же суммы", () => {
    const input = [
      { id: "a", purchaseCost: "10.00" },
      { id: "b", purchaseCost: "10.00" },
    ];
    expect(extras("0.01", input).map((row) => row.extra.toFixed(2))).toEqual(
      extras("0.01", input).map((row) => row.extra.toFixed(2)),
    );
  });

  it("положительная доплата на смесь замороженной и открытой партии отклоняется", () => {
    const batches = [
      { id: "frozen", purchaseCost: "10.00", frozen: true },
      { id: "open", purchaseCost: "10.00" },
    ];
    expect(() => extras("100.00", batches)).toThrow(DEAL_EXTRA_FROZEN_MIX);
    expect(() =>
      assertDealExtraAllocatable("100.00", [
        { id: "frozen", purchaseCost: "10.00", frozen: true },
        { id: "open", purchaseCost: "10.00", frozen: false },
      ]),
    ).toThrow(DEAL_EXTRA_FROZEN_MIX);
  });

  it("нулевая доплата на смешанную сделку не отклоняется", () => {
    const rows = extras("0.00", [
      { id: "frozen", purchaseCost: "10.00", frozen: true },
      { id: "open", purchaseCost: "10.00" },
    ]);
    expect(rows.map((row) => `${row.id}:${row.extra.toFixed(2)}`)).toEqual(["open:0.00"]);
  });

  it("сделка только из замороженных партий не отклоняется", () => {
    const rows = extras("100.00", [
      { id: "a", purchaseCost: "10.00", frozen: true },
      { id: "b", purchaseCost: "10.00", frozen: true },
    ]);
    expect(rows).toEqual([]);
  });

  it("три строки одной партии считаются одним получателем", () => {
    const rows = extras("20.10", [
      { id: "b", purchaseCost: "10.00" },
      { id: "b", purchaseCost: "10.00" },
      { id: "b", purchaseCost: "10.00" },
    ]);
    expect(rows.map((row) => `${row.id}:${row.extra.toFixed(2)}`)).toEqual(["b:20.10"]);
    expect(sumExtras(rows)).toBe("20.10");
  });

  it("нулевая доплата на повторах одной партии остаётся нулём", () => {
    const rows = extras("0.00", [
      { id: "b", purchaseCost: "10.00" },
      { id: "b", purchaseCost: "10.00" },
      { id: "b", purchaseCost: "10.00" },
    ]);
    expect(rows.map((row) => row.extra.toFixed(2))).toEqual(["0.00"]);
  });

  it("порядок повторяющихся строк не меняет доли разных партий", () => {
    const forward = extras("0.01", [
      { id: "b", purchaseCost: "10.00" },
      { id: "a", purchaseCost: "10.00" },
      { id: "b", purchaseCost: "10.00" },
    ]);
    const backward = extras("0.01", [
      { id: "a", purchaseCost: "10.00" },
      { id: "b", purchaseCost: "10.00" },
      { id: "a", purchaseCost: "10.00" },
    ]);
    expect(forward.map((row) => `${row.id}:${row.extra.toFixed(2)}`)).toEqual(["a:0.00", "b:0.01"]);
    expect(backward.map((row) => `${row.id}:${row.extra.toFixed(2)}`)).toEqual(
      forward.map((row) => `${row.id}:${row.extra.toFixed(2)}`),
    );
  });

  it("две сделки на одну партию складывают доли без потери копейки", () => {
    const first = extras("0.01", [
      { id: "shared", purchaseCost: "10.00" },
      { id: "other", purchaseCost: "10.00" },
    ]);
    const second = extras("0.05", [{ id: "shared", purchaseCost: "10.00" }]);
    const shared = first
      .find((row) => row.id === "shared")!
      .extra.plus(second.find((row) => row.id === "shared")!.extra);
    const other = first.find((row) => row.id === "other")!.extra;
    expect(shared.plus(other).toFixed(2)).toBe("0.06");
  });
});

describe("batchTotalCost", () => {
  it("стоимость общая = закупка + доли доставки", () => {
    const extra = batchExtraShare(10_500, 150_000, 150_000, 1);
    expect(batchTotalCost(150_000, extra).toNumber()).toBe(160_500);
  });

  it("точность сохраняется (копейки)", () => {
    // Доставка 100, три равные партии → 33.333... каждая, сумма не теряется.
    const share = batchExtraShare(100, 0, 0, 3);
    expect(new Decimal(share).times(3).toNumber()).toBe(100);
  });
});
