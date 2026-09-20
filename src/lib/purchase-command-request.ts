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

export interface PurchaseRequestIdentitySlot {
  requestId: string | null;
  boundKey: string | null;
}

export function createPurchaseRequestIdentityOwner() {
  const slot: PurchaseRequestIdentitySlot = { requestId: null, boundKey: null };
  return {
    acquire(commandKey: string): string {
      const minted = retainOrMintPurchaseRequestId({
        requestId: slot.requestId,
        boundKey: slot.boundKey,
        commandKey,
      });
      slot.requestId = minted.requestId;
      slot.boundKey = minted.boundKey;
      return minted.requestId;
    },
    clear(): void {
      slot.requestId = null;
      slot.boundKey = null;
    },
    current(): PurchaseRequestIdentitySlot {
      return { requestId: slot.requestId, boundKey: slot.boundKey };
    },
  };
}

export function createKeyedPurchaseRequestIdentityOwner() {
  const slots = new Map<string, { requestId: string; boundKey: string }>();
  return {
    acquire(key: string, commandKey: string): string {
      const current = slots.get(key);
      const minted = retainOrMintPurchaseRequestId({
        requestId: current?.requestId ?? null,
        boundKey: current?.boundKey ?? null,
        commandKey,
      });
      slots.set(key, minted);
      return minted.requestId;
    },
    clear(key: string): void {
      slots.delete(key);
    },
  };
}
