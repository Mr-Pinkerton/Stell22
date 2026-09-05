import type { TerminalDraftV1 } from "@/lib/terminal-draft-storage";
import type { TorcovkaPick } from "@/lib/torcovka";
import {
  computeTorcovkaWasteMetrics,
  type SubmitTorcovkaResult,
} from "@/lib/torcovka-plausibility";

export type RestoredPendingAck = (
  | Extract<SubmitTorcovkaResult, { status: "ACK_REQUIRED" }>
  | Extract<SubmitTorcovkaResult, { status: "APPROVAL_REQUIRED" }>
) & {
  picks: TorcovkaPick[];
  clientRequestId: string;
  batchId: string;
  railLotId: string;
};

/**
 * Reconstruct ACK / approval dialog state from a hydrated TORCOVKA draft.
 * Current waste metrics choose the band; saved phase decides whether a dialog
 * may open. Only saved phase "approval" may restore APPROVAL_REQUIRED — that
 * phase means the client already received a server APPROVAL_REQUIRED.
 * Saved "suspicious" never created TorcovkaApproval / Notification, so EXTREME
 * returns null and the next ordinary submit bootstraps approval on the server.
 * Synchronous: used as useState initializer, not an effect.
 */
export function restorePendingAck(opts: {
  draft: TerminalDraftV1 | null;
  railLots: readonly { id: string; lengthM: number }[];
}): RestoredPendingAck | null {
  const { draft, railLots } = opts;
  if (!draft || draft.operationType !== "TORCOVKA") return null;
  const savedPhase = draft.payload.ackUi.phase;
  if (savedPhase === "none") return null;
  const { batchId, lotId, railsTaken, picks } = draft.payload;
  if (!batchId || !lotId || railsTaken <= 0) return null;
  const lot = railLots.find((l) => l.id === lotId);
  if (!lot) return null;

  const metrics = computeTorcovkaWasteMetrics(railsTaken, lot.lengthM, picks);
  if (metrics.band === "NORMAL") return null;

  const shared = {
    picks: picks.map((p) => ({ lengthM: p.lengthM, sort: p.sort, quantity: p.quantity })),
    clientRequestId: draft.clientRequestId,
    batchId,
    railLotId: lot.id,
  };

  if (metrics.band === "EXTREME") {
    if (savedPhase !== "approval") return null;
    return {
      status: "APPROVAL_REQUIRED",
      band: "EXTREME",
      railsTaken,
      takenM: metrics.canon.takenM,
      producedM: metrics.canon.producedM,
      wasteM: metrics.canon.wasteM,
      wastePct: metrics.canon.wastePct,
      expiresAt: "",
      ...shared,
    };
  }

  return {
    status: "ACK_REQUIRED",
    band: "SUSPICIOUS",
    railsTaken,
    takenM: metrics.canon.takenM,
    producedM: metrics.canon.producedM,
    wastePct: metrics.canon.wastePct,
    ...shared,
  };
}
