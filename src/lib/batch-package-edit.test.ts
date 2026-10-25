import { describe, expect, it } from "vitest";
import {
  PACKAGE_DELETE_BLOCKED,
  PACKAGE_IDENTITY_AFTER_USE,
  PACKAGE_QUANTITY_BELOW_CONSUMED,
  PACKAGE_REALLOCATE_BLOCKED,
  PACKAGE_STRUCTURE_WHILE_FROZEN,
  STALE_PACKAGE_EDIT,
  packageSetFingerprint,
  planBatchPackageEdit,
  type PackageLotSnapshot,
} from "./batch-package-edit";

function lot(over: Partial<PackageLotSnapshot> = {}): PackageLotSnapshot {
  return {
    id: "lot-1",
    lengthM: "2.4000",
    railType: "POLKA",
    sort: "SORT1",
    isPackage: true,
    quantity: 10,
    remainingQuantity: 10,
    rows: 2,
    layers: 5,
    operationCount: 0,
    activeOperationCount: 0,
    ...over,
  };
}

const draft = {
  id: "lot-1",
  mode: "package" as const,
  lengthM: 2.4,
  railType: "POLKA" as const,
  sort: "SORT1" as const,
  quantity: 10,
  rows: 2,
  layers: 5,
};

describe("planBatchPackageEdit", () => {
  it("edits an untouched package and asks to reallocate when cost flow is on", () => {
    const plan = planBatchPackageEdit({
      frozen: false,
      costFlowActive: true,
      lots: [lot()],
      drafts: [{ ...draft, lengthM: 3, quantity: 12, railType: "KANAVKA", sort: "SORT2", rows: 3, layers: 4 }],
    });
    expect(plan.reallocate).toBe(true);
    expect(plan.updates[0]).toMatchObject({
      lengthM: "3.0000",
      quantity: 12,
      remainingQuantity: 12,
      railType: "KANAVKA",
      sort: "SORT2",
      rows: 3,
      layers: 4,
      preserveMoney: false,
    });
  });

  it("changes quantity of an untouched package without cost flow", () => {
    const plan = planBatchPackageEdit({
      frozen: false,
      costFlowActive: false,
      lots: [lot()],
      drafts: [{ ...draft, quantity: 8 }],
    });
    expect(plan.reallocate).toBe(false);
    expect(plan.updates[0]?.remainingQuantity).toBe(8);
  });

  it("keeps consumed quantity and monetary opening on a started package", () => {
    const plan = planBatchPackageEdit({
      frozen: false,
      costFlowActive: true,
      lots: [lot({ quantity: 10, remainingQuantity: 6 })],
      drafts: [{ ...draft, quantity: 8, rows: 4, layers: 2 }],
    });
    expect(plan.reallocate).toBe(false);
    expect(plan.updates[0]).toMatchObject({
      quantity: 8,
      remainingQuantity: 4,
      preserveMoney: true,
      rows: 4,
      layers: 2,
    });
  });

  it("rejects a quantity cut below what was already consumed", () => {
    expect(() =>
      planBatchPackageEdit({
        frozen: false,
        costFlowActive: false,
        lots: [lot({ quantity: 10, remainingQuantity: 6 })],
        drafts: [{ ...draft, quantity: 3 }],
      }),
    ).toThrow(PACKAGE_QUANTITY_BELOW_CONSUMED);
  });

  it("rejects length, type and sort changes after consumption", () => {
    expect(() =>
      planBatchPackageEdit({
        frozen: false,
        costFlowActive: false,
        lots: [lot({ remainingQuantity: 6, activeOperationCount: 1, operationCount: 1 })],
        drafts: [{ ...draft, lengthM: 3 }],
      }),
    ).toThrow(PACKAGE_IDENTITY_AFTER_USE);
  });

  it("rejects reallocating untouched siblings after any consumption when cost flow is on", () => {
    expect(() =>
      planBatchPackageEdit({
        frozen: false,
        costFlowActive: true,
        lots: [
          lot({ id: "used", remainingQuantity: 4 }),
          lot({ id: "free", remainingQuantity: 10 }),
        ],
        drafts: [
          { ...draft, id: "used", quantity: 10 },
          { ...draft, id: "free", quantity: 9 },
        ],
      }),
    ).toThrow(PACKAGE_REALLOCATE_BLOCKED);
  });

  it("rejects deleting a package that has history", () => {
    expect(() =>
      planBatchPackageEdit({
        frozen: false,
        costFlowActive: false,
        lots: [lot({ operationCount: 1, activeOperationCount: 0, remainingQuantity: 10 })],
        drafts: [],
      }),
    ).toThrow(PACKAGE_DELETE_BLOCKED);
  });

  it("rejects structural edits of a frozen batch", () => {
    expect(() =>
      planBatchPackageEdit({
        frozen: true,
        costFlowActive: false,
        lots: [lot()],
        drafts: [{ ...draft, quantity: 11 }],
      }),
    ).toThrow(PACKAGE_STRUCTURE_WHILE_FROZEN);
  });

  it("allows rows and layers on a frozen started package", () => {
    const plan = planBatchPackageEdit({
      frozen: true,
      costFlowActive: true,
      lots: [lot({ remainingQuantity: 4 })],
      drafts: [{ ...draft, rows: 1, layers: 1 }],
    });
    expect(plan.reallocate).toBe(false);
    expect(plan.updates[0]).toMatchObject({ rows: 1, layers: 1, quantity: 10, remainingQuantity: 4 });
  });

  it("detects a stale fingerprint after a concurrent quantity change", () => {
    const before = packageSetFingerprint([lot()]);
    const after = packageSetFingerprint([lot({ remainingQuantity: 7 })]);
    expect(before).not.toBe(after);
    expect(STALE_PACKAGE_EDIT).toMatch(/Обновите страницу/);
  });
});
