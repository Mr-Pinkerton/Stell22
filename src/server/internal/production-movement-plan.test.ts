import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
  targetHashV1,
  targetKeyV1,
} from "@/server/internal/inventory-movement-identity";
import {
  PRODUCTION_BLANK_PROVENANCE_MISSING,
  aggregateProductionMovementEffects,
  planProductionShadowMovements,
  type RetainedPrisadkaLine,
  type RetainedTorcovkaOperation,
  type RetainedUpakovkaOperation,
} from "@/server/internal/production-movement-plan";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function torcovkaOp(
  overrides: Partial<RetainedTorcovkaOperation> = {},
): RetainedTorcovkaOperation {
  return {
    id: "op-torc",
    clientRequestId: "req-torc",
    batchId: "batch-1",
    railLotId: "lot-1",
    railsTaken: 4,
    lines: [
      {
        quantity: 2,
        blankMaterialId: "mat-z",
        blankLengthM: "1.8",
        blankType: "POLKA",
        blankSort: "SORT1",
      },
      {
        quantity: 3,
        blankMaterialId: "mat-z",
        blankLengthM: new Prisma.Decimal("1.8000"),
        blankType: "POLKA",
        blankSort: "SORT1",
      },
    ],
    ...overrides,
  };
}

function prisadkaLine(
  overrides: Partial<RetainedPrisadkaLine> = {},
): RetainedPrisadkaLine {
  return {
    quantity: 2,
    detailId: "det-1",
    sourceIsBlank: true,
    sourceTorcevayaDone: false,
    sourcePloskostDone: false,
    prisadkaTorcevaya: true,
    prisadkaPloskost: false,
    blankMaterialId: "mat-z",
    blankLengthM: "0.6000",
    blankType: "POLKA",
    blankSort: "SORT1",
    ...overrides,
  };
}

function upakovkaOp(
  overrides: Partial<RetainedUpakovkaOperation> = {},
): RetainedUpakovkaOperation {
  return {
    id: "op-upak",
    clientRequestId: "req-upak:prod-1",
    productId: "prod-1",
    productQty: 2,
    lines: [
      {
        quantity: 4,
        detailId: "det-blank",
        sourceIsBlank: true,
        sourceTorcevayaDone: false,
        sourcePloskostDone: false,
        blankMaterialId: "mat-z",
        blankLengthM: "0.6000",
        blankType: "POLKA",
        blankSort: "SORT1",
      },
      {
        quantity: 2,
        detailId: "det-ready",
        sourceIsBlank: false,
        sourceTorcevayaDone: true,
        sourcePloskostDone: true,
        blankMaterialId: null,
        blankLengthM: null,
        blankType: null,
        blankSort: null,
      },
    ],
    nomenclatureLines: [
      { nomenclatureId: "nom-fastener", quantity: 8 },
      { nomenclatureId: "nom-pack", quantity: 2 },
      { nomenclatureId: "nom-fastener", quantity: 2 },
    ],
    ...overrides,
  };
}

describe("aggregateProductionMovementEffects", () => {
  it("groups the same role + canonical target and does not net consume against output", () => {
    const blank = {
      stockDomain: "BLANK" as const,
      materialId: "mat-z",
      lengthM: "1.8000",
      detailType: "POLKA" as const,
      sort: "SORT1" as const,
    };
    const aggregated = aggregateProductionMovementEffects([
      { role: "consume", kind: "CONSUMPTION", quantityDelta: -2, target: blank },
      { role: "output", kind: "PRODUCTION_OUTPUT", quantityDelta: 3, target: blank },
      { role: "consume", kind: "CONSUMPTION", quantityDelta: -1, target: blank },
    ]);
    expect(aggregated).toHaveLength(2);
    const consume = aggregated.find((row) => row.role === "consume");
    const produced = aggregated.find((row) => row.role === "output");
    expect(consume?.quantityDelta).toBe(-3);
    expect(produced?.quantityDelta).toBe(3);
  });

  it("canonicalizes BLANK 1.8 and 1.8000 as one target", () => {
    const aggregated = aggregateProductionMovementEffects([
      {
        role: "output",
        kind: "PRODUCTION_OUTPUT",
        quantityDelta: 2,
        target: {
          stockDomain: "BLANK",
          materialId: "mat-z",
          lengthM: 1.8,
          detailType: "POLKA",
          sort: "SORT1",
        },
      },
      {
        role: "output",
        kind: "PRODUCTION_OUTPUT",
        quantityDelta: 3,
        target: {
          stockDomain: "BLANK",
          materialId: "mat-z",
          lengthM: "1.8000",
          detailType: "POLKA",
          sort: "SORT1",
        },
      },
    ]);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]?.quantityDelta).toBe(5);
    expect(canonicalizeMovementTarget(aggregated[0]!.target).lengthMFixed4).toBe("1.8000");
  });

  it("omits zero movements after aggregation", () => {
    const aggregated = aggregateProductionMovementEffects([
      {
        role: "output",
        kind: "PRODUCTION_OUTPUT",
        quantityDelta: 2,
        target: { stockDomain: "PRODUCT", productId: "p1" },
      },
      {
        role: "output",
        kind: "PRODUCTION_OUTPUT",
        quantityDelta: -2,
        target: { stockDomain: "PRODUCT", productId: "p1" },
      },
    ]);
    expect(aggregated).toHaveLength(0);
  });
});

describe("planProductionShadowMovements TORCOVKA", () => {
  it("emits RAIL_LOT consume and grouped BLANK outputs with exact effectKeys", () => {
    const plan = planProductionShadowMovements({ kind: "TORCOVKA", operation: torcovkaOp() });
    expect(plan.effects).toHaveLength(2);
    const consumeRow = plan.effects.find((row) => row.role === "consume");
    const outputRow = plan.effects.find((row) => row.role === "output");
    expect(consumeRow).toMatchObject({
      kind: "CONSUMPTION",
      quantityDelta: -4,
      target: { stockDomain: "RAIL_LOT", railLotId: "lot-1" },
    });
    expect(outputRow).toMatchObject({
      kind: "PRODUCTION_OUTPUT",
      quantityDelta: 5,
    });
    expect(outputRow?.target.stockDomain).toBe("BLANK");
    const consumeHash = canonicalizeMovementTarget(consumeRow!.target).targetHashV1;
    const outputHash = canonicalizeMovementTarget(outputRow!.target).targetHashV1;
    expect(effectKeyV1("consume", consumeHash)).toBe(`imfx1:consume:${consumeHash}`);
    expect(effectKeyV1("output", outputHash)).toBe(`imfx1:output:${outputHash}`);
    expect(outputHash).toBe(
      targetHashV1(
        targetKeyV1({
          stockDomain: "BLANK",
          materialId: "mat-z",
          lengthM: "1.8000",
          detailType: "POLKA",
          sort: "SORT1",
        }),
      ),
    );
  });

  it("reversed retained lines yield the same semantic plan and snapshot", () => {
    const forward = planProductionShadowMovements({ kind: "TORCOVKA", operation: torcovkaOp() });
    const reversed = planProductionShadowMovements({
      kind: "TORCOVKA",
      operation: torcovkaOp({
        lines: [...torcovkaOp().lines].reverse(),
      }),
    });
    expect(reversed.effects).toEqual(forward.effects);
    expect(reversed.causationSnapshot).toEqual(forward.causationSnapshot);
  });

  it("pins the v1 TORCOVKA causationSnapshot without money or line ids", () => {
    const plan = planProductionShadowMovements({ kind: "TORCOVKA", operation: torcovkaOp() });
    expect(plan.causationSnapshot).toEqual({
      v: 1,
      d: "PRODUCTION_OPERATION",
      operationId: "op-torc",
      operationType: "TORCOVKA",
      clientRequestId: "req-torc",
      batchId: "batch-1",
      railLotId: "lot-1",
      railsTaken: 4,
      outputs: [
        {
          materialId: "mat-z",
          lengthM: "1.8000",
          detailType: "POLKA",
          sort: "SORT1",
          quantity: 5,
        },
      ],
    });
    expect(JSON.stringify(plan.causationSnapshot)).not.toMatch(/line-/);
    expect(JSON.stringify(plan.causationSnapshot)).not.toMatch(/Value|cost|money|₽/i);
  });
});

describe("planProductionShadowMovements PRISADKA", () => {
  it("emits mixed DETAIL/BLANK consume and aggregated DETAIL output without netting", () => {
    const plan = planProductionShadowMovements({
      kind: "PRISADKA",
      operation: {
        id: "op-pris",
        clientRequestId: "req-pris",
        lines: [
          prisadkaLine({
            quantity: 1,
            sourceIsBlank: false,
            sourceTorcevayaDone: false,
            sourcePloskostDone: true,
            prisadkaTorcevaya: true,
            blankMaterialId: null,
            blankLengthM: null,
            blankType: null,
            blankSort: null,
          }),
          prisadkaLine({ quantity: 2 }),
          prisadkaLine({ quantity: 1 }),
        ],
      },
    });
    const consumes = plan.effects.filter((row) => row.role === "consume");
    const outputs = plan.effects.filter((row) => row.role === "output");
    expect(consumes).toHaveLength(2);
    expect(outputs).toHaveLength(2);
    expect(consumes.some((row) => row.target.stockDomain === "DETAIL")).toBe(true);
    expect(consumes.some((row) => row.target.stockDomain === "BLANK")).toBe(true);
    expect(outputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "PRODUCTION_OUTPUT",
          quantityDelta: 1,
          target: { stockDomain: "DETAIL", detailId: "det-1", torcevayaDone: true, ploskostDone: true },
        }),
        expect.objectContaining({
          kind: "PRODUCTION_OUTPUT",
          quantityDelta: 3,
          target: { stockDomain: "DETAIL", detailId: "det-1", torcevayaDone: true, ploskostDone: false },
        }),
      ]),
    );
    expect(plan.effects.some((row) => row.target.stockDomain === "RAIL_LOT")).toBe(false);
  });

  it("fails closed when blank provenance is missing", () => {
    expect(() =>
      planProductionShadowMovements({
        kind: "PRISADKA",
        operation: {
          id: "op-pris",
          clientRequestId: "req-pris",
          lines: [prisadkaLine({ blankMaterialId: null })],
        },
      }),
    ).toThrow(PRODUCTION_BLANK_PROVENANCE_MISSING);
  });

  it("reversed retained lines yield the same portions snapshot", () => {
    const lines = [
      prisadkaLine({ quantity: 1, detailId: "det-b" }),
      prisadkaLine({
        quantity: 2,
        detailId: "det-a",
        sourceIsBlank: false,
        sourceTorcevayaDone: false,
        sourcePloskostDone: false,
        blankMaterialId: null,
        blankLengthM: null,
        blankType: null,
        blankSort: null,
      }),
    ];
    const forward = planProductionShadowMovements({
      kind: "PRISADKA",
      operation: { id: "op-pris", clientRequestId: "req-pris", lines },
    });
    const reversed = planProductionShadowMovements({
      kind: "PRISADKA",
      operation: {
        id: "op-pris",
        clientRequestId: "req-pris",
        lines: [...lines].reverse(),
      },
    });
    expect(reversed.effects).toEqual(forward.effects);
    expect(reversed.causationSnapshot).toEqual(forward.causationSnapshot);
  });
});

describe("planProductionShadowMovements UPAKOVKA", () => {
  it("emits mixed sources, grouped nomenclature, and product output without netting", () => {
    const plan = planProductionShadowMovements({ kind: "UPAKOVKA", operation: upakovkaOp() });
    const consumes = plan.effects.filter((row) => row.role === "consume");
    const outputs = plan.effects.filter((row) => row.role === "output");
    expect(consumes.some((row) => row.target.stockDomain === "BLANK")).toBe(true);
    expect(consumes.some((row) => row.target.stockDomain === "DETAIL")).toBe(true);
    expect(consumes.filter((row) => row.target.stockDomain === "NOMENCLATURE")).toHaveLength(2);
    const fastener = consumes.find(
      (row) => row.target.stockDomain === "NOMENCLATURE" && row.target.nomenclatureId === "nom-fastener",
    );
    expect(fastener?.quantityDelta).toBe(-10);
    expect(outputs).toEqual([
      {
        role: "output",
        kind: "PRODUCTION_OUTPUT",
        quantityDelta: 2,
        target: { stockDomain: "PRODUCT", productId: "prod-1" },
      },
    ]);
    expect(plan.causationSnapshot.clientRequestId).toBe("req-upak:prod-1");
    expect(plan.causationSnapshot.productId).toBe("prod-1");
    expect(plan.causationSnapshot.productQty).toBe(2);
  });

  it("does not emit RAIL_LOT and reversed nomenclature lines stay grouped", () => {
    const forward = planProductionShadowMovements({ kind: "UPAKOVKA", operation: upakovkaOp() });
    const reversed = planProductionShadowMovements({
      kind: "UPAKOVKA",
      operation: upakovkaOp({
        nomenclatureLines: [...upakovkaOp().nomenclatureLines].reverse(),
        lines: [...upakovkaOp().lines].reverse(),
      }),
    });
    expect(forward.effects.some((row) => row.target.stockDomain === "RAIL_LOT")).toBe(false);
    expect(reversed.effects).toEqual(forward.effects);
    expect(reversed.causationSnapshot).toEqual(forward.causationSnapshot);
  });
});

describe("planProductionShadowMovements exhaustiveness", () => {
  it("handles TORCOVKA / PRISADKA / UPAKOVKA with assertNever", () => {
    const src = readFileSync(path.join(root, "src/server/internal/production-movement-plan.ts"), "utf8");
    expect(src).toContain('case "TORCOVKA"');
    expect(src).toContain('case "PRISADKA"');
    expect(src).toContain('case "UPAKOVKA"');
    expect(src).toContain("assertNever");
    expect(src).toContain("default:");
  });
});
