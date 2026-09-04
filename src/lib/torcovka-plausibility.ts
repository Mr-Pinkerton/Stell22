import { D, type Num } from "@/lib/cost";
import { wasteLengthM, wastePercent } from "@/lib/waste";
import type { Decimal } from "decimal.js";

/** Temporary business policy — not Setting.wasteThresholdPct. */
export const TORCOVKA_WASTE_SUSPICIOUS_PCT = 20;
export const TORCOVKA_WASTE_EXTREME_PCT = 50;

export type TorcovkaWasteBand = "NORMAL" | "SUSPICIOUS" | "EXTREME";
export type PlausibilityAckKind = "SUSPICIOUS" | "HIGH_WASTE";
export type TorcovkaAckBand = "SUSPICIOUS" | "HIGH_WASTE";

export type TorcovkaWasteReason =
  | "CURVATURE"
  | "CRACKS"
  | "KNOTS"
  | "MATERIAL_DEFECT"
  | "COLOR_TEXTURE"
  | "WRONG_SIZE"
  | "OTHER";

export const TORCOVKA_WASTE_REASONS: readonly TorcovkaWasteReason[] = [
  "CURVATURE",
  "CRACKS",
  "KNOTS",
  "MATERIAL_DEFECT",
  "COLOR_TEXTURE",
  "WRONG_SIZE",
  "OTHER",
] as const;

export const TORCOVKA_WASTE_REASON_LABEL: Record<TorcovkaWasteReason, string> = {
  CURVATURE: "кривизна",
  CRACKS: "трещины",
  KNOTS: "сучки",
  MATERIAL_DEFECT: "дефект материала",
  COLOR_TEXTURE: "подбор цвета/текстуры",
  WRONG_SIZE: "неверный размер",
  OTHER: "другое",
};

export interface TorcovkaPlausibilityAck {
  kind: PlausibilityAckKind;
  railsTaken: number;
  takenM: string;
  producedM: string;
  wastePct: string;
  reason?: TorcovkaWasteReason;
  reasonNote?: string;
}

export interface TorcovkaWasteMetrics {
  takenM: Decimal;
  producedM: Decimal;
  wasteM: Decimal;
  wastePct: Decimal;
  band: TorcovkaWasteBand;
  canon: {
    takenM: string;
    producedM: string;
    wastePct: string;
  };
}

export type SubmitTorcovkaResult =
  | { status: "CREATED" }
  | Extract<TorcovkaSubmitDecision, { status: "ACK_REQUIRED" }>;

export type TorcovkaSubmitDecision =
  | {
      status: "CREATED";
      persist: {
        torcovkaSubmitAckBand: TorcovkaAckBand | null;
        torcovkaSubmitWasteReason: TorcovkaWasteReason | null;
        torcovkaSubmitWasteNote: string | null;
      };
    }
  | {
      status: "ACK_REQUIRED";
      band: "SUSPICIOUS" | "EXTREME";
      railsTaken: number;
      takenM: string;
      producedM: string;
      wastePct: string;
    };

export function canonicalTakenM(takenM: Num): string {
  return D(takenM).toFixed(4);
}

export function canonicalProducedM(producedM: Num): string {
  return D(producedM).toFixed(4);
}

export function canonicalWastePct(wastePct: Num): string {
  return D(wastePct).toFixed(2);
}

export function bandFromWastePct(wastePct: Num): TorcovkaWasteBand {
  const rounded = D(canonicalWastePct(wastePct));
  if (rounded.lt(TORCOVKA_WASTE_SUSPICIOUS_PCT)) return "NORMAL";
  if (rounded.lt(TORCOVKA_WASTE_EXTREME_PCT)) return "SUSPICIOUS";
  return "EXTREME";
}

export function computeTorcovkaWasteMetrics(
  railsTaken: number,
  lotLengthM: Num,
  picks: { lengthM: Num; quantity: number }[],
): TorcovkaWasteMetrics {
  const takenM = D(railsTaken).times(D(lotLengthM));
  let producedM = D(0);
  for (const p of picks) {
    producedM = producedM.plus(D(p.lengthM).times(p.quantity));
  }
  const wasteM = wasteLengthM(takenM, producedM);
  const wastePct = wastePercent(wasteM, takenM);
  const canon = {
    takenM: canonicalTakenM(takenM),
    producedM: canonicalProducedM(producedM),
    wastePct: canonicalWastePct(wastePct),
  };
  return {
    takenM,
    producedM,
    wasteM,
    wastePct,
    band: bandFromWastePct(wastePct),
    canon,
  };
}

const ACK_MISMATCH = "Подтверждение отхода не совпадает с пересчитанными метриками";
const ACK_WRONG_KIND = "Неверный тип подтверждения отхода";
const ACK_REASON_REQUIRED = "Укажите причину высокого отхода";
const ACK_NOTE_REQUIRED = "Укажите примечание для причины «другое»";
const ACK_NOT_NEEDED = "Подтверждение отхода не требуется";

function isWasteReason(value: unknown): value is TorcovkaWasteReason {
  return typeof value === "string" && (TORCOVKA_WASTE_REASONS as readonly string[]).includes(value);
}

function assertCanonicalEcho(
  ack: TorcovkaPlausibilityAck,
  railsTaken: number,
  canon: TorcovkaWasteMetrics["canon"],
): void {
  if (ack.railsTaken !== railsTaken) throw new Error(ACK_MISMATCH);
  if (typeof ack.takenM !== "string" || ack.takenM !== canon.takenM) throw new Error(ACK_MISMATCH);
  if (typeof ack.producedM !== "string" || ack.producedM !== canon.producedM) {
    throw new Error(ACK_MISMATCH);
  }
  if (typeof ack.wastePct !== "string" || ack.wastePct !== canon.wastePct) {
    throw new Error(ACK_MISMATCH);
  }
}

export function decideTorcovkaSubmit(input: {
  railsTaken: number;
  metrics: TorcovkaWasteMetrics;
  ack?: TorcovkaPlausibilityAck | null;
}): TorcovkaSubmitDecision {
  const { railsTaken, metrics, ack } = input;
  const { band, canon } = metrics;

  if (band === "NORMAL") {
    if (ack) throw new Error(ACK_NOT_NEEDED);
    return {
      status: "CREATED",
      persist: {
        torcovkaSubmitAckBand: null,
        torcovkaSubmitWasteReason: null,
        torcovkaSubmitWasteNote: null,
      },
    };
  }

  if (!ack || typeof ack !== "object") {
    return {
      status: "ACK_REQUIRED",
      band,
      railsTaken,
      takenM: canon.takenM,
      producedM: canon.producedM,
      wastePct: canon.wastePct,
    };
  }

  if (band === "SUSPICIOUS") {
    if (ack.kind !== "SUSPICIOUS") throw new Error(ACK_WRONG_KIND);
    assertCanonicalEcho(ack, railsTaken, canon);
    return {
      status: "CREATED",
      persist: {
        torcovkaSubmitAckBand: "SUSPICIOUS",
        torcovkaSubmitWasteReason: null,
        torcovkaSubmitWasteNote: null,
      },
    };
  }

  if (ack.kind !== "HIGH_WASTE") throw new Error(ACK_WRONG_KIND);
  assertCanonicalEcho(ack, railsTaken, canon);
  if (!isWasteReason(ack.reason)) throw new Error(ACK_REASON_REQUIRED);
  let note: string | null = null;
  if (ack.reason === "OTHER") {
    const trimmed = ack.reasonNote?.trim() ?? "";
    if (!trimmed) throw new Error(ACK_NOTE_REQUIRED);
    note = trimmed;
  }
  return {
    status: "CREATED",
    persist: {
      torcovkaSubmitAckBand: "HIGH_WASTE",
      torcovkaSubmitWasteReason: ack.reason,
      torcovkaSubmitWasteNote: note,
    },
  };
}
