import { describe, expect, it } from "vitest";
import { statementImportKey, type StatementDoc } from "./statement-import";

const doc = (over: Partial<StatementDoc> = {}): StatementDoc => ({
  docNumber: "123",
  date: "2026-06-01",
  amount: 1500,
  payerAccount: "40702810000000000001",
  payeeAccount: "40702810000000000002",
  ...over,
});

describe("statementImportKey — идемпотентность импорта выписки", () => {
  it("одинаковый документ → одинаковый ключ (повтор пропустится)", () => {
    expect(statementImportKey(doc())).toBe(statementImportKey(doc()));
  });

  it("сумма нормализуется до 2 знаков (100 == 100.00)", () => {
    expect(statementImportKey(doc({ amount: 100 }))).toBe(
      statementImportKey(doc({ amount: 100.0 })),
    );
  });

  it("разная сумма → разный ключ", () => {
    expect(statementImportKey(doc({ amount: 1500 }))).not.toBe(
      statementImportKey(doc({ amount: 1501 })),
    );
  });

  it("разный номер/дата/счета → разные ключи", () => {
    const base = statementImportKey(doc());
    expect(statementImportKey(doc({ docNumber: "124" }))).not.toBe(base);
    expect(statementImportKey(doc({ date: "2026-06-02" }))).not.toBe(base);
    expect(statementImportKey(doc({ payerAccount: "x" }))).not.toBe(base);
    expect(statementImportKey(doc({ payeeAccount: "y" }))).not.toBe(base);
  });

  it("null-поля не роняют и стабильны", () => {
    const k = statementImportKey(doc({ docNumber: null, payerAccount: null, payeeAccount: null }));
    expect(k).toBe("|2026-06-01|1500.00||");
  });
});
