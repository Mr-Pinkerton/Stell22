import { describe, expect, it } from "vitest";
import { D } from "@/lib/cost";
import { allocatePersistenceShares } from "@/lib/cost-foundation";
import { operationEarning } from "@/lib/payroll";
import {
  assignCanonicalTorcovkaLineIds,
  torcovkaLinePieceEarning,
  torcovkaPieceLaborCost,
} from "@/lib/torcovka-cost";

const snapshots = {
  rateTorcovkaSort1Snapshot: 12,
  rateTorcovkaSort2Snapshot: 8,
};

describe("torcovka piece labor (DI-015 snapshots)", () => {
  it("NULL snapshot is zero pay for that sort", () => {
    expect(
      torcovkaLinePieceEarning({
        quantity: 10,
        sort: "SORT1",
        snapshots: { rateTorcovkaSort1Snapshot: null, rateTorcovkaSort2Snapshot: 8 },
      }).equals(D(0)),
    ).toBe(true);
  });

  it("uses Decimal qty × sort snapshot, not JS number", () => {
    const labor = torcovkaPieceLaborCost(
      [
        { quantity: 3, sort: "SORT1" },
        { quantity: 2, sort: "SORT2" },
      ],
      snapshots,
    );
    expect(labor.equals(D(3 * 12 + 2 * 8))).toBe(true);
  });

  it("agrees with payroll operationEarning on representative integer rates", () => {
    const lines = [
      { quantity: 4, sort: "SORT1" as const },
      { quantity: 5, sort: "SORT2" as const },
    ];
    const cost = torcovkaPieceLaborCost(lines, snapshots);
    const payroll = operationEarning({
      type: "TORCOVKA",
      rates: { hourly: 0, torcovkaSort1: 12, torcovkaSort2: 8, prisadkaTorcev: 0, prisadkaPlosk: 0, upakovka: 0 },
      lines: lines.map((l) => ({ quantity: l.quantity, sort: l.sort })),
    });
    expect(cost.equals(D(payroll.amount))).toBe(true);
  });
});

describe("canonical TORCOVKA material line ids", () => {
  const materialId = "mat-a";
  const picks = [
    { materialId, lengthM: 0.9, detailType: "POLKA", sort: "SORT1" as const, quantity: 1 },
    { materialId, lengthM: 0.9, detailType: "POLKA", sort: "SORT2" as const, quantity: 1 },
    { materialId, lengthM: 0, detailType: "POLKA", sort: "SORT1" as const, quantity: 1 },
  ];

  it("same semantic picks in different array order allocate the same spec money", () => {
    const reversed = [...picks].reverse();
    const ids = assignCanonicalTorcovkaLineIds(picks);
    const idsRev = assignCanonicalTorcovkaLineIds(reversed);
    const total = D("100.000003");
    const alloc = allocatePersistenceShares({
      total,
      items: picks.map((p, i) => ({ id: ids[i]!, shareBase: D(p.lengthM).times(p.quantity) })),
    });
    const allocRev = allocatePersistenceShares({
      total,
      items: reversed.map((p, i) => ({
        id: idsRev[i]!,
        shareBase: D(p.lengthM).times(p.quantity),
      })),
    });
    const bySpec = (
      rows: { id: string; value: ReturnType<typeof D> }[],
      source: typeof picks,
      sourceIds: string[],
    ) => {
      const map = new Map<string, ReturnType<typeof D>>();
      for (let i = 0; i < source.length; i++) {
        const key = `${source[i]!.sort}|${source[i]!.lengthM}`;
        const value = rows.find((r) => r.id === sourceIds[i]!)!.value;
        map.set(key, (map.get(key) ?? D(0)).plus(value));
      }
      return map;
    };
    const a = bySpec(alloc, picks, ids);
    const b = bySpec(allocRev, reversed, idsRev);
    expect(a.get("SORT1|0.9")!.equals(b.get("SORT1|0.9")!)).toBe(true);
    expect(a.get("SORT2|0.9")!.equals(b.get("SORT2|0.9")!)).toBe(true);
    expect(alloc.find((r) => r.id === ids[2]!)!.value.equals(D(0))).toBe(true);
    expect(allocRev.find((r) => r.id === idsRev[reversed.findIndex((p) => D(p.lengthM).isZero())]!)!.value.equals(D(0))).toBe(true);
    expect(alloc.reduce((s, r) => s.plus(r.value), D(0)).equals(total)).toBe(true);
  });
});
