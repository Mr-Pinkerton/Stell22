import { Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import { D } from "@/lib/cost";
import type { Sort } from "@/types/domain";

export type CanonicalTorcovkaPick = {
  lengthM: number;
  lengthMFixed4: string;
  sort: Sort;
  quantity: number;
};

export type RawTorcovkaPick = {
  lengthM: number;
  sort: Sort;
  quantity: number;
};

const INVALID_BLANK_LENGTH = "Некорректная длина заготовки";

function formatFixed4(raw: string): string {
  const d = D(raw);
  if (!d.isFinite() || d.lte(0)) {
    throw new Error(INVALID_BLANK_LENGTH);
  }
  const rounded = d.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  if (rounded.lte(0)) {
    throw new Error(INVALID_BLANK_LENGTH);
  }
  return rounded.toFixed(4);
}

/** Canonical BlankStock / numeric(12,4) identity string. */
export function canonicalLengthFixed4(value: number | string | { toString(): string }): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(INVALID_BLANK_LENGTH);
    }
    return formatFixed4(value.toString());
  }
  const raw = typeof value === "string" ? value : value.toString();
  return formatFixed4(raw);
}

export function canonicalLengthDecimal(value: number | string | { toString(): string }): Prisma.Decimal {
  return new Prisma.Decimal(canonicalLengthFixed4(value));
}

export function canonicalizeTorcovkaPicks(
  rawPicks: readonly RawTorcovkaPick[],
): CanonicalTorcovkaPick[] {
  const merged = new Map<string, CanonicalTorcovkaPick>();
  for (const p of rawPicks) {
    if (!(p.quantity > 0)) continue;
    const lengthMFixed4 = canonicalLengthFixed4(p.lengthM);
    const key = `${lengthMFixed4}|${p.sort}`;
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += p.quantity;
    } else {
      merged.set(key, {
        lengthM: Number(lengthMFixed4),
        lengthMFixed4,
        sort: p.sort,
        quantity: p.quantity,
      });
    }
  }
  return [...merged.values()];
}

export function torcovkaPicksForLog(
  picks: readonly CanonicalTorcovkaPick[],
): RawTorcovkaPick[] {
  return picks.map((p) => ({
    lengthM: p.lengthM,
    sort: p.sort,
    quantity: p.quantity,
  }));
}
