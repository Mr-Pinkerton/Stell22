import { newRequestId } from "@/lib/request-id";

/** Command-defining fields for UI requestId reuse. */
export function quantityEditCommandKey(input: {
  operationId: string;
  targetLineId: string | null;
  expectedOldQuantity: number;
  newQuantity: number;
  expectedStateFingerprint: string;
}): string {
  return [
    input.operationId,
    input.targetLineId ?? "",
    String(input.expectedOldQuantity),
    String(input.newQuantity),
    input.expectedStateFingerprint,
  ].join("\0");
}

export function retainOrMintQuantityEditRequestId(state: {
  requestId: string | null;
  boundKey: string | null;
  commandKey: string;
}): { requestId: string; boundKey: string } {
  if (state.requestId && state.boundKey === state.commandKey) {
    return { requestId: state.requestId, boundKey: state.boundKey };
  }
  return { requestId: newRequestId(), boundKey: state.commandKey };
}

export function shouldRotateQuantityEditRequestId(errorMessage: string): boolean {
  return (
    errorMessage.startsWith("STALE_QUANTITY_EDIT") || errorMessage.startsWith("REQUEST_ID_REUSE")
  );
}
