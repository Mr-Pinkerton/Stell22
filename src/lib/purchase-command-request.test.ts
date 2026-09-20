import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  batchCreateCommandKey,
  createKeyedPurchaseRequestIdentityOwner,
  createPurchaseRequestIdentityOwner,
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

describe("synchronous purchase request ownership", () => {
  const batchValues = {
    name: "A",
    materialId: "m",
    purchaseDate: null as string | null,
    sectionWidthMm: 40,
    sectionHeightMm: 20,
    purchaseCost: 1,
    priceSort1: 1,
    priceSort2: 1,
    note: "",
    rails: [],
  };
  const simpleValues = {
    nomenclatureId: "n",
    quantity: 1,
    unitPrice: 2,
    purchaseDate: null as string | null,
  };

  it("same-render Batch duplicate acquire returns the same requestId before any React render", () => {
    const owner = createPurchaseRequestIdentityOwner();
    const key = batchCreateCommandKey(batchValues);
    const first = owner.acquire(key);
    const second = owner.acquire(key);
    expect(first).toBe(second);
  });

  it("same-render SimplePurchase duplicate acquire cannot produce two request IDs", () => {
    const owner = createPurchaseRequestIdentityOwner();
    const key = simplePurchaseCommandKey(simpleValues);
    const first = owner.acquire(key);
    const second = owner.acquire(key);
    expect(first).toBe(second);
    expect(owner.current().requestId).toBe(first);
  });

  it("same-render write-off duplicate acquire for one Batch returns the same requestId", () => {
    const owner = createKeyedPurchaseRequestIdentityOwner();
    const key = writeOffCommandKey("batch-1");
    const first = owner.acquire("batch-1", key);
    const second = owner.acquire("batch-1", key);
    expect(first).toBe(second);
  });

  it("assigns the requestId synchronously before any later async action can run", () => {
    const owner = createPurchaseRequestIdentityOwner();
    const seen: string[] = [];
    const startAsync = (requestId: string) => {
      seen.push(requestId);
    };
    const first = owner.acquire(simplePurchaseCommandKey(simpleValues));
    startAsync(first);
    const second = owner.acquire(simplePurchaseCommandKey(simpleValues));
    startAsync(second);
    expect(seen).toEqual([first, first]);
    expect(owner.current().requestId).toBe(first);
  });

  it("clears on success so the next logical command gets a different id", () => {
    const owner = createPurchaseRequestIdentityOwner();
    const key = simplePurchaseCommandKey(simpleValues);
    const first = owner.acquire(key);
    owner.clear();
    const next = owner.acquire(key);
    expect(next).not.toBe(first);
  });

  it("rebinds a new id when command-defining payload changes", () => {
    const owner = createPurchaseRequestIdentityOwner();
    const first = owner.acquire(simplePurchaseCommandKey(simpleValues));
    const next = owner.acquire(simplePurchaseCommandKey({ ...simpleValues, quantity: 9 }));
    expect(next).not.toBe(first);
  });

  it("REQUEST_ID_REUSE clear/rotation yields a different id on the next attempt", () => {
    const owner = createPurchaseRequestIdentityOwner();
    const key = batchCreateCommandKey(batchValues);
    const first = owner.acquire(key);
    expect(shouldRotatePurchaseRequestId("PURCHASE_REQUEST_ID_REUSE")).toBe(true);
    owner.clear();
    const next = owner.acquire(key);
    expect(next).not.toBe(first);
  });

  it("abandoned create-dialog / new logical command does not inherit the prior id", () => {
    const owner = createPurchaseRequestIdentityOwner();
    const key = batchCreateCommandKey(batchValues);
    const abandoned = owner.acquire(key);
    owner.clear();
    const nextLifecycle = owner.acquire(key);
    expect(nextLifecycle).not.toBe(abandoned);
  });

  it("PurchasesView acquires requestId synchronously before startTransition", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "src/components/purchases/purchases-view.tsx"),
      "utf8",
    );
    expect(src).toContain("batchCreateIdentityRef.current.acquire");
    expect(src).toContain("simplePurchaseIdentityRef.current.acquire");
    expect(src).toContain("writeOffIdentityRef.current.acquire");
    expect(src).not.toContain("setBatchCreateRequest");
    expect(src).not.toContain("setSimplePurchaseRequest");
    expect(src).not.toContain("setWriteOffRequests");
    const batchAcquire = src.indexOf("batchCreateIdentityRef.current.acquire");
    const batchTransition = src.indexOf("startTransition", batchAcquire);
    expect(batchAcquire).toBeGreaterThan(-1);
    expect(batchTransition).toBeGreaterThan(batchAcquire);
    const simpleAcquire = src.indexOf("simplePurchaseIdentityRef.current.acquire");
    const simpleTransition = src.indexOf("startTransition", simpleAcquire);
    expect(simpleAcquire).toBeGreaterThan(-1);
    expect(simpleTransition).toBeGreaterThan(simpleAcquire);
    const writeOffAcquire = src.indexOf("writeOffIdentityRef.current.acquire");
    const writeOffRun = src.indexOf("runRow", writeOffAcquire);
    expect(writeOffRun).toBeGreaterThan(writeOffAcquire);
  });
});
