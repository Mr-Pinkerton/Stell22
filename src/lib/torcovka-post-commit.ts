export type TorcovkaMaintenanceKind = "cost-recalc" | "page-refresh";

export type TorcovkaCommitAck = {
  status: "CREATED";
  costRecalc?: "FAILED";
  pageRefresh?: "FAILED";
};

/**
 * After the torcovka transaction has committed, maintenance must not turn
 * the saved operation into a submit failure.
 */
export async function settleTorcovkaAfterCommit(opts: {
  recalc: (() => Promise<void>) | null;
  refreshPages: () => void | Promise<void>;
  recordFailure: (kind: TorcovkaMaintenanceKind, error: unknown) => Promise<void>;
}): Promise<TorcovkaCommitAck> {
  let costRecalcFailed = false;
  let pageRefreshFailed = false;
  if (opts.recalc) {
    try {
      await opts.recalc();
    } catch (error) {
      costRecalcFailed = true;
      await recordQuietly(opts.recordFailure, "cost-recalc", error);
    }
  }
  try {
    await opts.refreshPages();
  } catch (error) {
    pageRefreshFailed = true;
    await recordQuietly(opts.recordFailure, "page-refresh", error);
  }
  const ack: TorcovkaCommitAck = { status: "CREATED" };
  if (costRecalcFailed) ack.costRecalc = "FAILED";
  if (pageRefreshFailed) ack.pageRefresh = "FAILED";
  return ack;
}

async function recordQuietly(
  recordFailure: (kind: TorcovkaMaintenanceKind, error: unknown) => Promise<void>,
  kind: TorcovkaMaintenanceKind,
  error: unknown,
): Promise<void> {
  try {
    await recordFailure(kind, error);
  } catch (logError) {
    console.error("[terminal] post-commit diagnostic was not stored", logError);
  }
}
