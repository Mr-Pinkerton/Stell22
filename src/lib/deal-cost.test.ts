import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";
import {
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
