import { D, type Num } from "@/lib/cost";
import { q6 } from "@/lib/cost-foundation";
import type { Decimal } from "decimal.js";

export type TorcovkaPieceSnapshots = {
  rateTorcovkaSort1Snapshot: Num | null;
  rateTorcovkaSort2Snapshot: Num | null;
};

/** NULL snapshot = zero piece pay for that sort. Decimal SoT — not JS number. */
export function torcovkaLinePieceEarning(args: {
  quantity: number;
  sort: "SORT1" | "SORT2";
  snapshots: TorcovkaPieceSnapshots;
}): Decimal {
  const rate =
    args.sort === "SORT2" ? args.snapshots.rateTorcovkaSort2Snapshot : args.snapshots.rateTorcovkaSort1Snapshot;
  if (rate == null) return D(0);
  return D(args.quantity).times(D(rate));
}

export function torcovkaPieceLaborCost(
  lines: { quantity: number; sort: "SORT1" | "SORT2" }[],
  snapshots: TorcovkaPieceSnapshots,
): Decimal {
  const exact = lines.reduce(
    (acc, line) => acc.plus(torcovkaLinePieceEarning({ ...line, snapshots })),
    D(0),
  );
  return q6(exact);
}

export function torcovkaBlankSpecKey(args: {
  materialId: string;
  lengthM: Num;
  detailType: string;
  sort: string;
}): string {
  return `${args.materialId}|${D(args.lengthM).toFixed(4)}|${args.detailType}|${args.sort}`;
}

export type TorcovkaAllocPick = {
  materialId: string;
  lengthM: Num;
  detailType: string;
  sort: "SORT1" | "SORT2";
  quantity: number;
};

/**
 * Stable line allocation ids: spec + quantity + occurrence in that spec+qty group.
 * Independent of client input array order.
 */
export function assignCanonicalTorcovkaLineIds(picks: TorcovkaAllocPick[]): string[] {
  const groupKeys = picks.map((p) => `${torcovkaBlankSpecKey(p)}#q${p.quantity}`);
  const groups = new Map<string, number[]>();
  for (let i = 0; i < picks.length; i++) {
    const key = groupKeys[i]!;
    const arr = groups.get(key) ?? [];
    arr.push(i);
    groups.set(key, arr);
  }
  const ids = new Array<string>(picks.length);
  for (const [groupKey, indices] of groups) {
    indices.forEach((pickIndex, occ) => {
      ids[pickIndex] = `${groupKey}#${occ}`;
    });
  }
  return ids;
}
