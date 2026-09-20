import { describe, expect, it } from "vitest";
import type { BatchFormValues, SimplePurchaseFormValues } from "@/server/purchases";
import {
  PURCHASE_COMMAND_REQUEST_LOCK_NAMESPACE,
  PURCHASE_REQUEST_ID_REUSE,
  assertPurchaseCommandMatch,
  canonicalBatchCreateSnapshot,
  canonicalSimplePurchaseSnapshot,
  canonicalWriteOffEffectSnapshot,
  exactFixedDecimal,
  lengthSnapshotString,
  moneySnapshotString,
  purchaseCommandLockKey,
  writeOffTotalQuantity,
} from "./purchase-command-identity";

const batchValues: BatchFormValues = {
  name: "  партия-а  ",
  materialId: "mat-1",
  purchaseDate: "2026-01-15",
  sectionWidthMm: 40,
  sectionHeightMm: 20,
  purchaseCost: 10000,
  priceSort1: 30000,
  priceSort2: 20000.5,
  note: "  заметка  ",
  rails: [
    {
      mode: "package",
      lengthM: 2,
      railType: "POLKA",
      sort: "SORT1",
      quantity: 6,
      rows: 2,
      layers: 3,
    },
    {
      mode: "piece",
      lengthM: 1.5,
      railType: "KANAVKA",
      sort: "SORT2",
      quantity: 1,
    },
  ],
};

describe("purchase command lock protocol", () => {
  it("uses namespace 8326 and kind-prefixed request keys", () => {
    expect(PURCHASE_COMMAND_REQUEST_LOCK_NAMESPACE).toBe(8326);
    expect(purchaseCommandLockKey("batch-create", "r1")).toBe("batch-create:r1");
    expect(purchaseCommandLockKey("batch-writeoff", "r1")).toBe("batch-writeoff:r1");
    expect(purchaseCommandLockKey("simple-purchase", "r1")).toBe("simple-purchase:r1");
  });

  it("issues transaction-scoped pg_advisory_xact_lock(hashtext(kind:requestId))", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("./purchase-command-identity.ts", import.meta.url), "utf8"),
    );
    expect(src).toContain("pg_advisory_xact_lock");
    expect(src).toContain("hashtext(${lockKey})");
    expect(src).toContain("PURCHASE_COMMAND_REQUEST_LOCK_NAMESPACE");
  });
});

describe("canonicalBatchCreateSnapshot", () => {
  it("pins v1 shape: trimmed name/note, money/length strings, no section or package code", () => {
    expect(canonicalBatchCreateSnapshot(batchValues)).toEqual({
      v: 1,
      d: "BATCH_CREATE",
      name: "партия-а",
      materialId: "mat-1",
      purchaseDateInput: "2026-01-15",
      purchaseCost: "10000.00",
      priceSort1: "30000.00",
      priceSort2: "20000.50",
      note: "заметка",
      rails: [
        {
          mode: "package",
          lengthM: "2.0000",
          railType: "POLKA",
          sort: "SORT1",
          quantity: 6,
          rows: 2,
          layers: 3,
        },
        {
          mode: "piece",
          lengthM: "1.5000",
          railType: "KANAVKA",
          sort: "SORT2",
          quantity: 1,
          rows: null,
          layers: null,
        },
      ],
    });
  });

  it("preserves null purchaseDateInput and empty note as null; rail order is significant", () => {
    const snap = canonicalBatchCreateSnapshot({
      ...batchValues,
      purchaseDate: null,
      note: "   ",
    });
    expect(snap.purchaseDateInput).toBeNull();
    expect(snap.note).toBeNull();
    const original = canonicalBatchCreateSnapshot(batchValues);
    const reversed = canonicalBatchCreateSnapshot({
      ...batchValues,
      rails: [...batchValues.rails].reverse(),
    });
    expect(JSON.stringify(reversed.rails)).not.toBe(JSON.stringify(original.rails));
    expect(reversed.rails[0]?.mode).toBe("piece");
  });

  it("does not include client section millimeters", () => {
    const json = JSON.stringify(canonicalBatchCreateSnapshot(batchValues));
    expect(json).not.toContain("sectionWidthMm");
    expect(json).not.toContain("sectionHeightMm");
  });
});

describe("canonicalSimplePurchaseSnapshot", () => {
  it("pins v1 shape without nomenclature name", () => {
    const values: SimplePurchaseFormValues = {
      nomenclatureId: "nom-1",
      quantity: 4,
      unitPrice: 12.5,
      purchaseDate: null,
    };
    expect(canonicalSimplePurchaseSnapshot(values)).toEqual({
      v: 1,
      d: "SIMPLE_PURCHASE_CREATE",
      nomenclatureId: "nom-1",
      quantity: 4,
      unitPrice: "12.50",
      purchaseDateInput: null,
    });
    expect(JSON.stringify(canonicalSimplePurchaseSnapshot(values))).not.toContain("name");
  });
});

describe("canonicalWriteOffEffectSnapshot", () => {
  it("keeps only positive lots, sorts by railLotId, and totals quantityBefore", () => {
    const snap = canonicalWriteOffEffectSnapshot({
      batchId: "batch-1",
      lots: [
        { id: "lot-b", remainingQuantity: 3 },
        { id: "lot-a", remainingQuantity: 2 },
        { id: "lot-z", remainingQuantity: 0 },
      ],
    });
    expect(snap).toEqual({
      v: 1,
      d: "BATCH_REMAINDER_WRITEOFF",
      batchId: "batch-1",
      effects: [
        { railLotId: "lot-a", quantityBefore: 2, quantityDelta: -2 },
        { railLotId: "lot-b", quantityBefore: 3, quantityDelta: -3 },
      ],
    });
    expect(writeOffTotalQuantity(snap)).toBe(5);
  });
});

describe("assertPurchaseCommandMatch", () => {
  it("fails closed on admin, snapshot, or batch mismatch", () => {
    expect(() =>
      assertPurchaseCommandMatch({
        storedAdminUserId: "a",
        incomingAdminUserId: "b",
      }),
    ).toThrow(PURCHASE_REQUEST_ID_REUSE);
    expect(() =>
      assertPurchaseCommandMatch({
        storedAdminUserId: "a",
        incomingAdminUserId: "a",
        storedSnapshot: { v: 1 },
        incomingSnapshot: { v: 2 },
      }),
    ).toThrow(PURCHASE_REQUEST_ID_REUSE);
    expect(() =>
      assertPurchaseCommandMatch({
        storedAdminUserId: "a",
        incomingAdminUserId: "a",
        storedBatchId: "b1",
        incomingBatchId: "b2",
      }),
    ).toThrow(PURCHASE_REQUEST_ID_REUSE);
  });

  it("accepts identical admin + snapshot even when JSON object key order differs", () => {
    const snap = canonicalBatchCreateSnapshot(batchValues);
    const reordered = JSON.parse(JSON.stringify(snap)) as typeof snap;
    expect(() =>
      assertPurchaseCommandMatch({
        storedAdminUserId: "a",
        incomingAdminUserId: "a",
        storedSnapshot: { note: reordered.note, v: reordered.v, d: reordered.d, ...reordered },
        incomingSnapshot: snap,
      }),
    ).not.toThrow();
  });
});

describe("exact fixed decimal strings", () => {
  it("formats money to 2 and length to 4", () => {
    expect(moneySnapshotString(10)).toBe("10.00");
    expect(lengthSnapshotString(2)).toBe("2.0000");
    expect(exactFixedDecimal(1.5, 4)).toBe("1.5000");
  });
});
