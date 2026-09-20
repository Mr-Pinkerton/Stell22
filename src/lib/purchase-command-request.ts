import { newRequestId } from "@/lib/request-id";
import type { BatchFormValues, SimplePurchaseFormValues } from "@/server/purchases";

export function batchCreateCommandKey(values: BatchFormValues): string {
  return JSON.stringify({
    name: values.name.trim(),
    materialId: values.materialId,
    purchaseDate: values.purchaseDate,
    purchaseCost: values.purchaseCost,
    priceSort1: values.priceSort1,
    priceSort2: values.priceSort2,
    note: values.note.trim(),
    rails: values.rails.map((r) => ({
      mode: r.mode,
      lengthM: r.lengthM,
      railType: r.railType,
      sort: r.sort,
      quantity: r.quantity,
      rows: r.rows ?? null,
      layers: r.layers ?? null,
    })),
  });
}

export function simplePurchaseCommandKey(values: SimplePurchaseFormValues): string {
  return JSON.stringify({
    nomenclatureId: values.nomenclatureId,
    quantity: values.quantity,
    unitPrice: values.unitPrice,
    purchaseDate: values.purchaseDate,
  });
}

export function writeOffCommandKey(batchId: string): string {
  return `writeoff:${batchId}`;
}

export function retainOrMintPurchaseRequestId(state: {
  requestId: string | null;
  boundKey: string | null;
  commandKey: string;
}): { requestId: string; boundKey: string } {
  if (state.requestId && state.boundKey === state.commandKey) {
    return { requestId: state.requestId, boundKey: state.boundKey };
  }
  return { requestId: newRequestId(), boundKey: state.commandKey };
}

export function shouldRotatePurchaseRequestId(errorMessage: string): boolean {
  return errorMessage.startsWith("PURCHASE_REQUEST_ID_REUSE");
}
