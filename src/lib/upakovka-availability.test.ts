import { describe, expect, it } from "vitest";
import { upakovkaAvailability } from "./upakovka-availability";
import type { TerminalProduct } from "@/components/terminal/types";

function product(partial: Partial<TerminalProduct> & Pick<TerminalProduct, "id" | "name">): TerminalProduct {
  return {
    materialId: "mat-1",
    skuOzon: "",
    skuWb: "",
    packagingId: null,
    status: "ACTIVE",
    details: [],
    fastenerIds: [],
    extraIds: [],
    ...partial,
  };
}

/** Independent one-product demand: same adds as applyUpakovkaPrepared for quantity=1. */
function canonicalOneProductDemand(p: TerminalProduct) {
  const details = new Map<string, number>();
  for (const d of p.details) {
    if (d.quantity <= 0) continue;
    details.set(d.detailId, (details.get(d.detailId) ?? 0) + d.quantity);
  }
  const nomenclature = new Map<string, number>();
  const addNom = (id: string, qty: number) => {
    if (qty <= 0) return;
    nomenclature.set(id, (nomenclature.get(id) ?? 0) + qty);
  };
  for (const f of p.fastenerIds) addNom(f.nomenclatureId, f.quantity);
  if (p.packagingId) addNom(p.packagingId, 1);
  for (const id of p.extraIds) addNom(id, 1);
  return { details, nomenclature };
}

function expectedCanAssemble(
  p: TerminalProduct,
  stock: { detailsReady: Record<string, number>; nomenclature: Record<string, number> },
): number {
  const demand = canonicalOneProductDemand(p);
  const limits: number[] = [];
  for (const [id, required] of demand.details) {
    limits.push(Math.floor((stock.detailsReady[id] ?? 0) / required));
  }
  for (const [id, required] of demand.nomenclature) {
    limits.push(Math.floor((stock.nomenclature[id] ?? 0) / required));
  }
  return limits.length ? Math.max(0, Math.min(...limits)) : 0;
}

describe("upakovkaAvailability", () => {
  const names = {
    details: { "det-1": "Боковина", "det-2": "Полка" },
    nomenclature: {
      "nom-hinge": { name: "Петля", type: "FASTENER" as const },
      "nom-box": { name: "Коробка", type: "PACKAGING" as const },
      "nom-extra": { name: "Инструкция", type: "OTHER" as const },
    },
  };

  it("returns canAssemble from the tightest BOM line", () => {
    const result = upakovkaAvailability(
      product({
        id: "p1",
        name: "Изделие",
        details: [{ detailId: "det-1", quantity: 2 }],
        fastenerIds: [{ nomenclatureId: "nom-hinge", quantity: 4 }],
      }),
      { detailsReady: { "det-1": 10 }, nomenclature: { "nom-hinge": 12 } },
      names,
    );
    expect(result.canAssemble).toBe(3);
    expect(result.shortages).toEqual([]);
  });

  it("lists every one-unit shortage when nothing can be assembled", () => {
    const result = upakovkaAvailability(
      product({
        id: "p1",
        name: "Изделие",
        details: [{ detailId: "det-1", quantity: 2 }],
        fastenerIds: [{ nomenclatureId: "nom-hinge", quantity: 4 }],
        packagingId: "nom-box",
        extraIds: ["nom-extra"],
      }),
      {
        detailsReady: { "det-1": 10 },
        nomenclature: { "nom-hinge": 2, "nom-box": 0, "nom-extra": 0 },
      },
      names,
    );
    expect(result.canAssemble).toBe(0);
    expect(result.shortages).toEqual([
      { name: "Петля", kind: "fastener", required: 4, available: 2, shortage: 2 },
      { name: "Коробка", kind: "packaging", required: 1, available: 0, shortage: 1 },
      { name: "Инструкция", kind: "extra", required: 1, available: 0, shortage: 1 },
    ]);
  });

  it("uses the detail name for manufactured shortages", () => {
    const result = upakovkaAvailability(
      product({
        id: "p1",
        name: "Изделие",
        details: [{ detailId: "det-2", quantity: 3 }],
      }),
      { detailsReady: { "det-2": 1 }, nomenclature: {} },
      names,
    );
    expect(result.canAssemble).toBe(0);
    expect(result.shortages).toEqual([
      { name: "Полка", kind: "detail", required: 3, available: 1, shortage: 2 },
    ]);
  });

  it("U-D1: duplicate fastener demand 4+4 against 6 cannot assemble", () => {
    const result = upakovkaAvailability(
      product({
        id: "p1",
        name: "Изделие",
        fastenerIds: [
          { nomenclatureId: "nom-hinge", quantity: 4 },
          { nomenclatureId: "nom-hinge", quantity: 4 },
        ],
      }),
      { detailsReady: {}, nomenclature: { "nom-hinge": 6 } },
      names,
    );
    expect(result.canAssemble).toBe(0);
    expect(result.shortages).toEqual([
      { name: "Петля", kind: "fastener", required: 8, available: 6, shortage: 2 },
    ]);
  });

  it("U-D2: duplicate fastener demand 4+4 against 16 assembles 2", () => {
    const result = upakovkaAvailability(
      product({
        id: "p1",
        name: "Изделие",
        fastenerIds: [
          { nomenclatureId: "nom-hinge", quantity: 4 },
          { nomenclatureId: "nom-hinge", quantity: 4 },
        ],
      }),
      { detailsReady: {}, nomenclature: { "nom-hinge": 16 } },
      names,
    );
    expect(result.canAssemble).toBe(2);
    expect(result.shortages).toEqual([]);
  });

  it("U-D3: packaging+extra overlap demand 2 against 1 cannot assemble", () => {
    const result = upakovkaAvailability(
      product({
        id: "p1",
        name: "Изделие",
        packagingId: "nom-box",
        extraIds: ["nom-box"],
      }),
      { detailsReady: {}, nomenclature: { "nom-box": 1 } },
      names,
    );
    expect(result.canAssemble).toBe(0);
    expect(result.shortages).toEqual([
      { name: "Коробка", kind: "packaging", required: 2, available: 1, shortage: 1 },
    ]);
  });

  it("U-D4: packaging+extra overlap demand 2 against 4 assembles 2", () => {
    const result = upakovkaAvailability(
      product({
        id: "p1",
        name: "Изделие",
        packagingId: "nom-box",
        extraIds: ["nom-box"],
      }),
      { detailsReady: {}, nomenclature: { "nom-box": 4 } },
      names,
    );
    expect(result.canAssemble).toBe(2);
    expect(result.shortages).toEqual([]);
  });

  it("aggregates duplicate detailId demand before the limit", () => {
    const result = upakovkaAvailability(
      product({
        id: "p1",
        name: "Изделие",
        details: [
          { detailId: "det-1", quantity: 2 },
          { detailId: "det-1", quantity: 3 },
        ],
      }),
      { detailsReady: { "det-1": 4 }, nomenclature: {} },
      names,
    );
    expect(result.canAssemble).toBe(0);
    expect(result.shortages).toEqual([
      { name: "Боковина", kind: "detail", required: 5, available: 4, shortage: 1 },
    ]);
  });

  it("kind follows NomenclatureItem.type, not BOM role order", () => {
    const result = upakovkaAvailability(
      product({
        id: "p1",
        name: "Изделие",
        extraIds: ["nom-hinge"],
        fastenerIds: [{ nomenclatureId: "nom-hinge", quantity: 1 }],
      }),
      { detailsReady: {}, nomenclature: { "nom-hinge": 1 } },
      names,
    );
    expect(result.canAssemble).toBe(0);
    expect(result.shortages).toEqual([
      { name: "Петля", kind: "fastener", required: 2, available: 1, shortage: 1 },
    ]);
  });

  it("canAssemble equals min floor(stock / summed one-product canonical demand)", () => {
    const cases: {
      p: TerminalProduct;
      stock: { detailsReady: Record<string, number>; nomenclature: Record<string, number> };
    }[] = [
      {
        p: product({
          id: "a",
          name: "A",
          details: [{ detailId: "det-1", quantity: 2 }],
          fastenerIds: [{ nomenclatureId: "nom-hinge", quantity: 4 }],
        }),
        stock: { detailsReady: { "det-1": 10 }, nomenclature: { "nom-hinge": 12 } },
      },
      {
        p: product({
          id: "b",
          name: "B",
          fastenerIds: [
            { nomenclatureId: "nom-hinge", quantity: 4 },
            { nomenclatureId: "nom-hinge", quantity: 4 },
          ],
        }),
        stock: { detailsReady: {}, nomenclature: { "nom-hinge": 6 } },
      },
      {
        p: product({
          id: "c",
          name: "C",
          fastenerIds: [
            { nomenclatureId: "nom-hinge", quantity: 4 },
            { nomenclatureId: "nom-hinge", quantity: 4 },
          ],
        }),
        stock: { detailsReady: {}, nomenclature: { "nom-hinge": 16 } },
      },
      {
        p: product({
          id: "d",
          name: "D",
          packagingId: "nom-box",
          extraIds: ["nom-box"],
        }),
        stock: { detailsReady: {}, nomenclature: { "nom-box": 1 } },
      },
      {
        p: product({
          id: "e",
          name: "E",
          packagingId: "nom-box",
          extraIds: ["nom-box"],
        }),
        stock: { detailsReady: {}, nomenclature: { "nom-box": 4 } },
      },
      {
        p: product({
          id: "f",
          name: "F",
          details: [
            { detailId: "det-1", quantity: 2 },
            { detailId: "det-1", quantity: 3 },
          ],
        }),
        stock: { detailsReady: { "det-1": 4 }, nomenclature: {} },
      },
    ];
    for (const { p, stock } of cases) {
      expect(upakovkaAvailability(p, stock, names).canAssemble).toBe(
        expectedCanAssemble(p, stock),
      );
    }
  });
});
