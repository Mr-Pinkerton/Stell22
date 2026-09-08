import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { D } from "@/lib/cost";
import { q6 } from "@/lib/cost-foundation";
import { operationEarning, operationRatesFromSnapshots } from "@/lib/payroll";
import {
  COST_FLOW_EMPTY_SURPLUS_VALUATION,
  COST_FLOW_QTY_ONLY_WRITER,
  prisadkaLinePieceLabor,
  upakovkaPieceLabor,
} from "@/server/internal/cost-flow-downstream";

describe("Package 3 piece labor snapshots", () => {
  it("uses DI-015 prisadka snapshots and treats null as 0", () => {
    const torcev = prisadkaLinePieceLabor({
      quantity: 3,
      torcevaya: true,
      ploskost: false,
      ratePrisadkaTorcevSnapshot: new Prisma.Decimal("12.5"),
      ratePrisadkaPlosktSnapshot: new Prisma.Decimal("9"),
    });
    expect(torcev.equals(q6(D(3).times(D("12.5"))))).toBe(true);

    const nullRate = prisadkaLinePieceLabor({
      quantity: 4,
      torcevaya: true,
      ploskost: false,
      ratePrisadkaTorcevSnapshot: null,
      ratePrisadkaPlosktSnapshot: new Prisma.Decimal("9"),
    });
    expect(nullRate.equals(0)).toBe(true);
  });

  it("cross-checks PRISADKA piece sum against payroll operationEarning", () => {
    const snapshots = {
      hourlyRateSnapshot: null,
      rateTorcovkaSort1Snapshot: null,
      rateTorcovkaSort2Snapshot: null,
      ratePrisadkaTorcevSnapshot: new Prisma.Decimal("10"),
      ratePrisadkaPlosktSnapshot: new Prisma.Decimal("7"),
      rateUpakovkaSnapshot: null,
    };
    const lines = [
      { quantity: 2, prisadkaTorcevaya: true, prisadkaPloskost: false },
      { quantity: 3, prisadkaTorcevaya: false, prisadkaPloskost: true },
    ];
    const q6Sum = q6(
      lines.reduce(
        (sum, l) =>
          sum.plus(
            prisadkaLinePieceLabor({
              quantity: l.quantity,
              torcevaya: l.prisadkaTorcevaya,
              ploskost: l.prisadkaPloskost,
              ratePrisadkaTorcevSnapshot: snapshots.ratePrisadkaTorcevSnapshot,
              ratePrisadkaPlosktSnapshot: snapshots.ratePrisadkaPlosktSnapshot,
            }),
          ),
        D(0),
      ),
    );
    const earning = operationEarning({
      type: "PRISADKA",
      rates: operationRatesFromSnapshots(snapshots),
      lines,
    });
    expect(q6Sum.equals(D("41"))).toBe(true);
    expect(earning.amount).toBe(41);
  });

  it("uses historical UPAKOVKA snapshot and null as 0", () => {
    expect(
      upakovkaPieceLabor({
        productQty: 5,
        rateUpakovkaSnapshot: new Prisma.Decimal("8"),
      }).equals(q6(40)),
    ).toBe(true);
    expect(
      upakovkaPieceLabor({ productQty: 5, rateUpakovkaSnapshot: null }).equals(0),
    ).toBe(true);
  });

  it("exports fail-closed inventory and qty-only messages", () => {
    expect(COST_FLOW_EMPTY_SURPLUS_VALUATION).toMatch(/ручная оценка/);
    expect(COST_FLOW_QTY_ONLY_WRITER).toMatch(/без движения стоимости/);
  });
});
