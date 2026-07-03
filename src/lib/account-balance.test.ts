import { describe, expect, it } from "vitest";
import {
  computeAccountBalance,
  computeAccountBalances,
  isAccountConfirmed,
  shouldAdvanceAnchor,
  signedFlow,
  totalAccountBalance,
  type BalanceFlow,
} from "@/lib/account-balance";

const flow = (over: Partial<BalanceFlow>): BalanceFlow => ({
  accountId: "a",
  date: "2026-06-10",
  flowType: "INCOME",
  amount: 100,
  ...over,
});

describe("signedFlow", () => {
  it("приход положителен, расход отрицателен", () => {
    expect(signedFlow("INCOME", 100)).toBe(100);
    expect(signedFlow("EXPENSE", 100)).toBe(-100);
  });
});

describe("computeAccountBalance", () => {
  it("якорь + приход − расход с даты (включительно)", () => {
    const flows = [
      flow({ date: "2026-06-10", flowType: "INCOME", amount: 500 }),
      flow({ date: "2026-06-11", flowType: "EXPENSE", amount: 200 }),
    ];
    expect(
      computeAccountBalance({ openingBalance: 1000, balanceAsOf: "2026-06-10" }, flows),
    ).toBe(1300);
  });

  it("операции строго раньше даты якоря не учитываются", () => {
    const flows = [
      flow({ date: "2026-06-09", flowType: "INCOME", amount: 999 }), // до якоря
      flow({ date: "2026-06-10", flowType: "INCOME", amount: 500 }), // в дату якоря — учитывается
    ];
    expect(
      computeAccountBalance({ openingBalance: 1000, balanceAsOf: "2026-06-10" }, flows),
    ).toBe(1500);
  });

  it("balanceAsOf = null → учитываются все операции", () => {
    const flows = [
      flow({ date: "2020-01-01", flowType: "INCOME", amount: 300 }),
      flow({ date: "2026-06-10", flowType: "EXPENSE", amount: 100 }),
    ];
    expect(computeAccountBalance({ openingBalance: 0, balanceAsOf: null }, flows)).toBe(200);
  });

  it("переводы (isTransfer) двигают остаток счёта наравне с обычными", () => {
    const flows = [flow({ flowType: "EXPENSE", amount: 400 })];
    expect(
      computeAccountBalance({ openingBalance: 1000, balanceAsOf: "2026-06-01" }, flows),
    ).toBe(600);
  });
});

describe("computeAccountBalances / totalAccountBalance", () => {
  const accounts = [
    { id: "a", openingBalance: 1000, balanceAsOf: "2026-06-10" },
    { id: "b", openingBalance: 500, balanceAsOf: null },
  ];
  const flows: BalanceFlow[] = [
    flow({ accountId: "a", date: "2026-06-11", flowType: "INCOME", amount: 200 }),
    flow({ accountId: "a", date: "2026-06-09", flowType: "INCOME", amount: 999 }), // до якоря a
    flow({ accountId: "b", date: "2026-06-11", flowType: "EXPENSE", amount: 100 }),
  ];

  it("остатки считаются по каждому счёту отдельно", () => {
    const map = computeAccountBalances(accounts, flows);
    expect(map.get("a")).toBe(1200);
    expect(map.get("b")).toBe(400);
  });

  it("суммарный остаток по всем счетам", () => {
    expect(totalAccountBalance(accounts, flows)).toBe(1600);
  });

  it("счёт без операций = его начальный остаток", () => {
    expect(totalAccountBalance([{ id: "x", openingBalance: 777, balanceAsOf: "2026-01-01" }], [])).toBe(
      777,
    );
  });
});

describe("shouldAdvanceAnchor", () => {
  it("якоря ещё нет → двигаем", () => {
    expect(shouldAdvanceAnchor(null, "2026-06-15")).toBe(true);
  });

  it("выписка новее или за тот же день → двигаем (повторная загрузка/корректировка)", () => {
    expect(shouldAdvanceAnchor("2026-06-10", "2026-06-15")).toBe(true);
    expect(shouldAdvanceAnchor("2026-06-10", "2026-06-10")).toBe(true);
  });

  it("старая выписка → якорь не трогаем (иначе откат остатка назад)", () => {
    expect(shouldAdvanceAnchor("2026-06-15", "2026-06-10")).toBe(false);
  });
});

describe("isAccountConfirmed", () => {
  it("true и undefined считаются подтверждёнными (обратная совместимость)", () => {
    expect(isAccountConfirmed(true)).toBe(true);
    expect(isAccountConfirmed(undefined)).toBe(true);
  });

  it("false — счёт в карантине (скрыт из ДДС/KPI)", () => {
    expect(isAccountConfirmed(false)).toBe(false);
  });
});
