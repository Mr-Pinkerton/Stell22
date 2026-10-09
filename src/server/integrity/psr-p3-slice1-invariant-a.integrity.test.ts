import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
} from "@/server/internal/inventory-movement-identity";
import {
  readSlice1InvariantA,
  Slice1DiagnosticExecutionError,
} from "@/server/internal/psr-p3-slice1-invariant-a";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);

function railKey(role: "adjust" | "writeoff", railLotId: string, qualifier?: string) {
  const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId });
  return {
    effectKey: effectKeyV1(role, canonical.targetHashV1, qualifier),
    targetSnapshot: canonical.targetSnapshot,
  };
}

function nomenclatureKey(nomenclatureId: string) {
  const canonical = canonicalizeMovementTarget({
    stockDomain: "NOMENCLATURE",
    nomenclatureId,
  });
  return {
    effectKey: effectKeyV1("receipt", canonical.targetHashV1),
    targetSnapshot: canonical.targetSnapshot,
  };
}

describe.skipIf(!enabled)("PSR-P3 slice 1 invariant A", () => {
  let prismaA: PrismaClient;

  beforeAll(() => {
    ensureIntegritySchema();
    prismaA = createIntegrityClients().prismaA;
  });

  beforeEach(async () => {
    await resetIntegrityInventory(prismaA);
  });

  afterAll(async () => {
    await prismaA.$disconnect();
  });

  async function counts() {
    const [movements, corrections, writeOffs, purchases, nomenclatureStock, railLots] =
      await Promise.all([
        prismaA.inventoryMovement.count(),
        prismaA.productionOperationCorrection.count(),
        prismaA.batchRemainderWriteOff.count(),
        prismaA.simplePurchase.count(),
        prismaA.nomenclatureStock.count(),
        prismaA.railLot.count(),
      ]);
    return { movements, corrections, writeOffs, purchases, nomenclatureStock, railLots };
  }

  async function insertMovement(input: {
    id: string;
    kind: "ADJUSTMENT" | "RECEIPT";
    stockDomain: "RAIL_LOT" | "NOMENCLATURE";
    quantityDelta: number;
    authority?: "SHADOW" | "AUTHORITATIVE";
    epochId?: string | null;
    causationKind: "PRODUCTION_OPERATION_MUTATION" | "BATCH" | "SIMPLE_PURCHASE";
    causationId: string;
    effectKey: string;
    railLotId?: string | null;
    nomenclatureId?: string | null;
    targetSnapshot: Prisma.InputJsonValue | Record<string, unknown>;
  }) {
    await prismaA.inventoryMovement.create({
      data: {
        id: input.id,
        kind: input.kind,
        stockDomain: input.stockDomain,
        quantityDelta: input.quantityDelta,
        authority: input.authority ?? "SHADOW",
        epochId: input.epochId ?? null,
        causationKind: input.causationKind,
        causationId: input.causationId,
        effectKey: input.effectKey,
        actorKind: "SYSTEM",
        systemActorKey: "psr-p3-s1-fixture",
        actorDisplaySnapshot: "psr-p3-s1-fixture",
        effectiveAt: new Date("2026-10-09T00:00:00.000Z"),
        railLotId: input.railLotId ?? null,
        nomenclatureId: input.nomenclatureId ?? null,
        targetSnapshot: input.targetSnapshot as Prisma.InputJsonValue,
      },
    });
  }

  it("reads an R-05 correction and ignores other authorities and causations", async () => {
    const correction = await prismaA.productionOperationCorrection.create({
      data: {
        id: "s1-corr",
        requestId: "s1-corr-req",
        operationId: "s1-op",
        adminUserId: "integrity-admin",
        railLotId: "s1-lot",
        batchId: "s1-batch",
        expectedOldRailsTaken: 10,
        newRailsTaken: 7,
        deltaReturned: 3,
        reason: "short",
      },
    });
    const matched = railKey("adjust", "s1-lot", "rails-taken");
    await insertMovement({
      id: "s1-corr-shadow",
      kind: "ADJUSTMENT",
      stockDomain: "RAIL_LOT",
      quantityDelta: 3,
      causationKind: "PRODUCTION_OPERATION_MUTATION",
      causationId: correction.id,
      effectKey: matched.effectKey,
      railLotId: "s1-lot",
      targetSnapshot: matched.targetSnapshot,
    });
    await insertMovement({
      id: "s1-corr-auth",
      kind: "ADJUSTMENT",
      stockDomain: "RAIL_LOT",
      quantityDelta: 3,
      authority: "AUTHORITATIVE",
      epochId: "epoch-s1",
      causationKind: "PRODUCTION_OPERATION_MUTATION",
      causationId: correction.id,
      effectKey: `${matched.effectKey}:auth`,
      railLotId: "s1-lot",
      targetSnapshot: matched.targetSnapshot,
    });
    await insertMovement({
      id: "s1-corr-other",
      kind: "ADJUSTMENT",
      stockDomain: "RAIL_LOT",
      quantityDelta: 3,
      causationKind: "PRODUCTION_OPERATION_MUTATION",
      causationId: "s1-corr-other",
      effectKey: matched.effectKey,
      railLotId: "s1-lot",
      targetSnapshot: matched.targetSnapshot,
    });
    const before = await counts();
    const result = await readSlice1InvariantA(prismaA, {
      contour: "R05_CORRECTION",
      causationId: correction.id,
    });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.invariantB).toBe("NOT_EVALUABLE");
    expect(result.observedShadowMovementCount).toBe(1);
    expect(result.expectedEffectCount).toBe(1);
    expect(await counts()).toEqual(before);
  });

  it("returns GATE_UNKNOWN when the R-05 source has no SHADOW rows", async () => {
    const correction = await prismaA.productionOperationCorrection.create({
      data: {
        id: "s1-corr-empty",
        requestId: "s1-corr-empty-req",
        operationId: "s1-op",
        adminUserId: "integrity-admin",
        railLotId: "s1-lot",
        batchId: "s1-batch",
        expectedOldRailsTaken: 4,
        newRailsTaken: 1,
        deltaReturned: 3,
        reason: "short",
      },
    });
    const result = await readSlice1InvariantA(prismaA, {
      contour: "R05_CORRECTION",
      causationId: correction.id,
    });
    expect(result.invariantA).toBe("GATE_UNKNOWN");
    expect(result.invariantB).toBe("NOT_EVALUABLE");
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("matches a multi-lot write-off from the retained snapshot", async () => {
    const writeOff = await prismaA.batchRemainderWriteOff.create({
      data: {
        id: "s1-wo",
        requestId: "s1-wo-req",
        batchId: "s1-batch",
        adminUserId: "integrity-admin",
        totalQuantity: 6,
        effectSnapshot: {
          v: 1,
          d: "BATCH_REMAINDER_WRITEOFF",
          batchId: "s1-batch",
          effects: [
            { railLotId: "lot-b", quantityBefore: 2, quantityDelta: -2 },
            { railLotId: "lot-a", quantityBefore: 4, quantityDelta: -4 },
          ],
        },
      },
    });
    for (const lot of [
      { id: "lot-a", quantity: -4 },
      { id: "lot-b", quantity: -2 },
    ]) {
      const key = railKey("writeoff", lot.id);
      await insertMovement({
        id: `s1-wo-${lot.id}`,
        kind: "ADJUSTMENT",
        stockDomain: "RAIL_LOT",
        quantityDelta: lot.quantity,
        causationKind: "BATCH",
        causationId: writeOff.id,
        effectKey: key.effectKey,
        railLotId: lot.id,
        targetSnapshot: key.targetSnapshot,
      });
    }
    const before = await counts();
    const result = await readSlice1InvariantA(prismaA, {
      contour: "BATCH_REMAINDER_WRITEOFF",
      causationId: writeOff.id,
    });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.expectedEffectCount).toBe(2);
    expect(result.observedShadowMovementCount).toBe(2);
    expect(result.invariantB).toBe("NOT_EVALUABLE");
    expect(await counts()).toEqual(before);
  });

  it("classifies a persisted impossible zero write-off as INVALID_SOURCE", async () => {
    const constraint = "BatchRemainderWriteOff_totalQuantity_positive";
    let dropped = false;
    await prismaA.$executeRawUnsafe(
      `ALTER TABLE "BatchRemainderWriteOff" DROP CONSTRAINT "${constraint}"`,
    );
    dropped = true;
    try {
      const writeOff = await prismaA.batchRemainderWriteOff.create({
        data: {
          id: "s1-wo-zero",
          requestId: "s1-wo-zero-req",
          batchId: "s1-batch",
          adminUserId: "integrity-admin",
          totalQuantity: 0,
          effectSnapshot: {
            v: 1,
            d: "BATCH_REMAINDER_WRITEOFF",
            batchId: "s1-batch",
            effects: [],
          },
        },
      });
      const absent = await readSlice1InvariantA(prismaA, {
        contour: "BATCH_REMAINDER_WRITEOFF",
        causationId: writeOff.id,
      });
      expect(absent.invariantA).toBe("INVALID_SOURCE");
      expect(absent.invariantA).not.toBe("MATCH_OBSERVED");
      expect(absent.invariantA).not.toBe("GATE_UNKNOWN");
      expect(absent.invariantB).toBe("NOT_EVALUABLE");

      const key = railKey("writeoff", "lot-a");
      await insertMovement({
        id: "s1-wo-zero-shadow",
        kind: "ADJUSTMENT",
        stockDomain: "RAIL_LOT",
        quantityDelta: -1,
        causationKind: "BATCH",
        causationId: writeOff.id,
        effectKey: key.effectKey,
        railLotId: "lot-a",
        targetSnapshot: key.targetSnapshot,
      });
      const present = await readSlice1InvariantA(prismaA, {
        contour: "BATCH_REMAINDER_WRITEOFF",
        causationId: writeOff.id,
      });
      expect(present.invariantA).toBe("INVALID_SOURCE");
      expect(present.invariantB).toBe("NOT_EVALUABLE");
      expect(await prismaA.inventoryMovement.count()).toBe(1);
    } finally {
      if (dropped) {
        await prismaA.batchRemainderWriteOff.deleteMany({ where: { id: "s1-wo-zero" } });
        await prismaA.$executeRawUnsafe(
          `ALTER TABLE "BatchRemainderWriteOff" ADD CONSTRAINT "${constraint}" CHECK ("totalQuantity" > 0)`,
        );
      }
    }
  });

  it("matches a SimplePurchase receipt and does not use the creation command id", async () => {
    const item = await prismaA.nomenclatureItem.create({
      data: { name: "s1-screw", type: "FASTENER", unitPrice: new Prisma.Decimal(10) },
    });
    const purchase = await prismaA.simplePurchase.create({
      data: {
        id: "s1-sp",
        nomenclatureId: item.id,
        quantity: 5,
        unitPrice: new Prisma.Decimal("1.00"),
        purchaseDate: new Date("2026-10-09T00:00:00.000Z"),
      },
    });
    await prismaA.simplePurchaseCreationCommand.create({
      data: {
        id: "s1-sp-cmd",
        requestId: "s1-sp-req",
        simplePurchaseId: purchase.id,
        adminUserId: "integrity-admin",
        requestSnapshot: {
          v: 1,
          d: "SIMPLE_PURCHASE_CREATE",
          nomenclatureId: item.id,
          quantity: 5,
          unitPrice: "1.00",
          purchaseDateInput: "2026-10-09",
        },
      },
    });
    const key = nomenclatureKey(item.id);
    await insertMovement({
      id: "s1-sp-shadow",
      kind: "RECEIPT",
      stockDomain: "NOMENCLATURE",
      quantityDelta: 5,
      causationKind: "SIMPLE_PURCHASE",
      causationId: purchase.id,
      effectKey: key.effectKey,
      nomenclatureId: item.id,
      targetSnapshot: key.targetSnapshot,
    });
    const before = await counts();
    const result = await readSlice1InvariantA(prismaA, {
      contour: "SIMPLE_PURCHASE_RECEIPT",
      causationId: purchase.id,
    });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.causationId).toBe(purchase.id);
    expect(result.expectedEffectCount).toBe(1);
    expect(result.observedShadowMovementCount).toBe(1);
    expect(result.invariantB).toBe("NOT_EVALUABLE");
    expect(await counts()).toEqual(before);
    const byCommand = await readSlice1InvariantA(prismaA, {
      contour: "SIMPLE_PURCHASE_RECEIPT",
      causationId: "s1-sp-cmd",
    });
    expect(byCommand.invariantA).toBe("SOURCE_UNAVAILABLE");
  });

  it("reports a stored targetSnapshot disagreement as MISMATCH", async () => {
    const correction = await prismaA.productionOperationCorrection.create({
      data: {
        id: "s1-corr-snap",
        requestId: "s1-corr-snap-req",
        operationId: "s1-op",
        adminUserId: "integrity-admin",
        railLotId: "s1-lot",
        batchId: "s1-batch",
        expectedOldRailsTaken: 8,
        newRailsTaken: 5,
        deltaReturned: 3,
        reason: "short",
      },
    });
    const matched = railKey("adjust", "s1-lot", "rails-taken");
    await insertMovement({
      id: "s1-corr-snap-row",
      kind: "ADJUSTMENT",
      stockDomain: "RAIL_LOT",
      quantityDelta: 3,
      causationKind: "PRODUCTION_OPERATION_MUTATION",
      causationId: correction.id,
      effectKey: matched.effectKey,
      railLotId: "s1-lot",
      targetSnapshot: { v: 1, d: "RAIL_LOT", railLotId: "other-lot" },
    });
    const result = await readSlice1InvariantA(prismaA, {
      contour: "R05_CORRECTION",
      causationId: correction.id,
    });
    expect(result.invariantA).toBe("MISMATCH");
    expect(result.differences.map((item) => item.code)).toContain("TARGET_SNAPSHOT");
  });

  it("fails closed on a database read error and does not return a diagnostic status", async () => {
    const dead = new PrismaClient({
      datasourceUrl: "postgresql://slice1:slice1@127.0.0.1:1/stell22_integrity?connect_timeout=1",
    });
    try {
      await expect(
        readSlice1InvariantA(dead, { contour: "R05_CORRECTION", causationId: "missing" }),
      ).rejects.toBeInstanceOf(Slice1DiagnosticExecutionError);
    } finally {
      await dead.$disconnect();
    }
  });
});
