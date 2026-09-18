import { newRequestId } from "@/lib/request-id";

/** Command-defining fields for UI requestId reuse. Reason is bound only to prevent reuse. */
export function correctionCommandKey(input: {
  expectedOldRailsTaken: number;
  newRailsTaken: number;
  reason: string;
}): string {
  return `${input.expectedOldRailsTaken}\0${input.newRailsTaken}\0${input.reason.trim()}`;
}

export function retainOrMintCorrectionRequestId(state: {
  requestId: string | null;
  boundKey: string | null;
  commandKey: string;
}): { requestId: string; boundKey: string } {
  if (state.requestId && state.boundKey === state.commandKey) {
    return { requestId: state.requestId, boundKey: state.boundKey };
  }
  return { requestId: newRequestId(), boundKey: state.commandKey };
}

export function shouldRotateCorrectionRequestId(errorMessage: string): boolean {
  return errorMessage.startsWith("STALE_CORRECTION") || errorMessage.startsWith("REQUEST_ID_REUSE");
}
