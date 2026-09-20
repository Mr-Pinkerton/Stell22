import { describe, expect, it } from "vitest";
import {
  batchCreateCommandKey,
  retainOrMintPurchaseRequestId,
  shouldRotatePurchaseRequestId,
  simplePurchaseCommandKey,
  writeOffCommandKey,
} from "./purchase-command-request";

describe("purchase command keys", () => {
  it("rebinds when command-defining payload changes", () => {
    const a = batchCreateCommandKey({
      name: "A",
      materialId: "m",
      purchaseDate: null,
      sectionWidthMm: 40,
      sectionHeightMm: 20,
      purchaseCost: 1,
      priceSort1: 1,
      priceSort2: 1,
      note: "",
      rails: [],
    });
    const b = batchCreateCommandKey({
      name: "B",
      materialId: "m",
      purchaseDate: null,
      sectionWidthMm: 40,
      sectionHeightMm: 20,
      purchaseCost: 1,
      priceSort1: 1,
      priceSort2: 1,
      note: "",
      rails: [],
    });
    expect(a).not.toBe(b);
    expect(simplePurchaseCommandKey({
      nomenclatureId: "n",
      quantity: 1,
      unitPrice: 2,
      purchaseDate: null,
    })).not.toBe(
      simplePurchaseCommandKey({
        nomenclatureId: "n",
        quantity: 2,
        unitPrice: 2,
        purchaseDate: null,
      }),
    );
    expect(writeOffCommandKey("b1")).toBe("writeoff:b1");
  });
});

describe("retainOrMintPurchaseRequestId", () => {
  it("reuses the id for the same pending command (retry / lost response)", () => {
    const first = retainOrMintPurchaseRequestId({
      requestId: null,
      boundKey: null,
      commandKey: "k",
    });
    const retry = retainOrMintPurchaseRequestId({
      requestId: first.requestId,
      boundKey: first.boundKey,
      commandKey: "k",
    });
    expect(retry.requestId).toBe(first.requestId);
  });

  it("mints a new id when the command fields change", () => {
    const first = retainOrMintPurchaseRequestId({
      requestId: "keep-me",
      boundKey: "old",
      commandKey: "new",
    });
    expect(first.requestId).not.toBe("keep-me");
    expect(first.boundKey).toBe("new");
  });
});

describe("shouldRotatePurchaseRequestId", () => {
  it("rotates after requestId reuse, not after generic errors", () => {
    expect(shouldRotatePurchaseRequestId("PURCHASE_REQUEST_ID_REUSE")).toBe(true);
    expect(shouldRotatePurchaseRequestId("PURCHASE_REQUEST_ID_REUSE: extra")).toBe(true);
    expect(shouldRotatePurchaseRequestId("Остаток уже нулевой")).toBe(false);
  });
});
