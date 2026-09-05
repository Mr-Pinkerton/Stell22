import type { TerminalDraftV1 } from "@/lib/terminal-draft-storage";
import type { TorcovkaPick } from "@/lib/torcovka";
import {
  computeTorcovkaWasteMetrics,
  type SubmitTorcovkaResult,
} from "@/lib/torcovka-plausibility";

export type RestoredPendingAck = Extract<SubmitTorcovkaResult, { status: "ACK_REQUIRED" }> & {
  picks: TorcovkaPick[];
  clientRequestId: string;
  batchId: string;
  railLotId: string;
};

/**
 * Reconstruct ACK dialog state from a hydrated TORCOVKA draft.
 * Saved phase only means the worker already reached acknowledgement;
 * current waste metrics choose SUSPICIOUS vs EXTREME.
 * Synchronous: used as useState initializer, not an effect.
 */
export function restorePendingAck(opts: {
  draft: TerminalDraftV1 | null;
  railLots: readonly { id: string; lengthM: number }[];
}): RestoredPendingAck | null {
  const { draft, railLots } = opts;
  if (!draft || draft.operationType !== "TORCOVKA") return null;
  if (draft.payload.ackUi.phase === "none") return null;
  const { batchId, lotId, railsTaken, picks } = draft.payload;
  if (!batchId || !lotId || railsTaken <= 0) return null;
  const lot = railLots.find((l) => l.id === lotId);
  if (!lot) return null;

  const metrics = computeTorcovkaWasteMetrics(railsTaken, lot.lengthM, picks);
  if (metrics.band === "NORMAL") return null;

  return {
    status: "ACK_REQUIRED",
    band: metrics.band,
    railsTaken,
    takenM: metrics.canon.takenM,
    producedM: metrics.canon.producedM,
    wastePct: metrics.canon.wastePct,
    picks: picks.map((p) => ({ lengthM: p.lengthM, sort: p.sort, quantity: p.quantity })),
    clientRequestId: draft.clientRequestId,
    batchId,
    railLotId: lot.id,
  };
}
