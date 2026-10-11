import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  canonicalizeMovementTarget,
  effectKeyV1,
} from "@/server/internal/inventory-movement-identity";
import { setInventoryMovementShadowWriteGate } from "@/server/internal/inventory-movement-shadow-write";
import {
  BatchReceiptDiagnosticExecutionError,
  readBatchReceiptInvariantA,
} from "@/server/internal/psr-p3-batch-receipt-invariant-a";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;

function receiptKey(railLotId: string) {
  const canonical = canonicalizeMovementTarget({ stockDomain: "RAIL_LOT", railLotId });
  return {
    effectKey: effectKeyV1("receipt", canonical.targetHashV1),
    targetSnapshot: canonical.targetSnapshot,
  };
}

function provenance(
  commandId: string,
  batchId: string,
  pairs: Array<{ railLotId: string; quantity: number }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    v: 1,
    d: "BATCH_RECEIPT_PROVENANCE",
    commandId,
    batchId,
    pairs,
    ...overrides,
  };
}

describe.skipIf(!enabled)("PSR-P3 S2-B P3 batch receipt invariant A", () => {
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
    const [movements, commands, changeLogs, settings, railLots, authoritative] = await Promise.all([
      prismaA.inventoryMovement.count(),
      prismaA.batchCreationCommand.count(),
      prismaA.changeLog.count(),
      prismaA.setting.count(),
      prismaA.railLot.count(),
      prismaA.inventoryMovement.count({ where: { authority: "AUTHORITATIVE" } }),
    ]);
    return { movements, commands, changeLogs, settings, railLots, authoritative };
  }

  async function insertCommand(input: {
    id: string;
    requestId: string;
    batchId: string;
    provenance: Prisma.InputJsonValue | null;
  }) {
    await prismaA.batchCreationCommand.create({
      data: {
        id: input.id,
        requestId: input.requestId,
        batchId: input.batchId,
        adminUserId: "integrity-admin",
        requestSnapshot: { v: 1, d: "BATCH_CREATE" },
        receiptProvenanceSnapshot:
          input.provenance === null ? Prisma.DbNull : input.provenance,
      },
    });
  }

  async function insertMovement(input: {
    id: string;
    kind?: "RECEIPT" | "ADJUSTMENT";
    stockDomain?: "RAIL_LOT" | "NOMENCLATURE";
    quantityDelta: number;
    authority?: "SHADOW" | "AUTHORITATIVE";
    epochId?: string | null;
    causationKind?: "BATCH" | "SIMPLE_PURCHASE";
    causationId: string;
    effectKey: string;
    railLotId?: string | null;
    targetSnapshot: Prisma.InputJsonValue;
  }) {
    await prismaA.inventoryMovement.create({
      data: {
        id: input.id,
        kind: input.kind ?? "RECEIPT",
        stockDomain: input.stockDomain ?? "RAIL_LOT",
        quantityDelta: input.quantityDelta,
        authority: input.authority ?? "SHADOW",
        epochId: input.epochId ?? null,
        causationKind: input.causationKind ?? "BATCH",
        causationId: input.causationId,
        effectKey: input.effectKey,
        actorKind: "SYSTEM",
        systemActorKey: "psr-p3-s2-b-p3-fixture",
        actorDisplaySnapshot: "psr-p3-s2-b-p3-fixture",
        effectiveAt: new Date("2026-10-11T00:00:00.000Z"),
        railLotId: input.railLotId ?? null,
        targetSnapshot: input.targetSnapshot,
      },
    });
  }

  it("matches one positive receipt and does not write", async () => {
    const key = receiptKey("lot-a");
    await insertCommand({
      id: "p3-cmd-match",
      requestId: "p3-req-match",
      batchId: "p3-batch-match",
      provenance: provenance("p3-cmd-match", "p3-batch-match", [
        { railLotId: "lot-a", quantity: 4 },
      ]),
    });
    await insertMovement({
      id: "p3-mv-match",
      quantityDelta: 4,
      causationId: "p3-cmd-match",
      effectKey: key.effectKey,
      railLotId: "lot-a",
      targetSnapshot: key.targetSnapshot as Prisma.InputJsonValue,
    });
    const before = await counts();
    const result = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-match" });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.invariantB).toBe("NOT_EVALUABLE");
    expect(result.contour).toBe("BATCH_RECEIPT");
    expect(result.causationKind).toBe("BATCH");
    expect(result.causationId).toBe("p3-cmd-match");
    expect(result.expectedEffectCount).toBe(1);
    expect(result.observedShadowMovementCount).toBe(1);
    expect(await counts()).toEqual(before);
  });

  it("matches several receipts and ignores another causation and an authoritative row", async () => {
    const keyA = receiptKey("lot-a");
    const keyB = receiptKey("lot-b");
    await insertCommand({
      id: "p3-cmd-multi",
      requestId: "p3-req-multi",
      batchId: "p3-batch-multi",
      provenance: provenance("p3-cmd-multi", "p3-batch-multi", [
        { railLotId: "lot-a", quantity: 2 },
        { railLotId: "lot-b", quantity: 5 },
      ]),
    });
    await insertMovement({
      id: "p3-mv-b",
      quantityDelta: 5,
      causationId: "p3-cmd-multi",
      effectKey: keyB.effectKey,
      railLotId: "lot-b",
      targetSnapshot: keyB.targetSnapshot as Prisma.InputJsonValue,
    });
    await insertMovement({
      id: "p3-mv-a",
      quantityDelta: 2,
      causationId: "p3-cmd-multi",
      effectKey: keyA.effectKey,
      railLotId: "lot-a",
      targetSnapshot: keyA.targetSnapshot as Prisma.InputJsonValue,
    });
    await insertMovement({
      id: "p3-mv-other",
      quantityDelta: 2,
      causationId: "p3-cmd-other",
      effectKey: keyA.effectKey,
      railLotId: "lot-a",
      targetSnapshot: keyA.targetSnapshot as Prisma.InputJsonValue,
    });
    await insertMovement({
      id: "p3-mv-auth",
      quantityDelta: 2,
      authority: "AUTHORITATIVE",
      epochId: "epoch-p3",
      causationId: "p3-cmd-multi",
      effectKey: `${keyA.effectKey}:auth`,
      railLotId: "lot-a",
      targetSnapshot: keyA.targetSnapshot as Prisma.InputJsonValue,
    });
    const before = await counts();
    const result = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-multi" });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.observedShadowMovementCount).toBe(2);
    expect(result.invariantB).toBe("NOT_EVALUABLE");
    expect(await counts()).toEqual(before);
    expect(before.authoritative).toBe(1);
  });

  it("returns GATE_UNKNOWN for a positive provenance and zero movements while the gate is inactive", async () => {
    await insertCommand({
      id: "p3-cmd-gate",
      requestId: "p3-req-gate",
      batchId: "p3-batch-gate",
      provenance: provenance("p3-cmd-gate", "p3-batch-gate", [{ railLotId: "lot-a", quantity: 4 }]),
    });
    const before = await counts();
    const result = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-gate" });
    expect(result.invariantA).toBe("GATE_UNKNOWN");
    expect(result.invariantA).not.toBe("MISMATCH");
    expect(result.invariantB).toBe("NOT_EVALUABLE");
    expect(result.expectedEffectCount).toBe(1);
    expect(result.observedShadowMovementCount).toBe(0);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect(await counts()).toEqual(before);
  });

  it("does not treat a later ACTIVE gate reading as preservation proof", async () => {
    await insertCommand({
      id: "p3-cmd-active",
      requestId: "p3-req-active",
      batchId: "p3-batch-active",
      provenance: provenance("p3-cmd-active", "p3-batch-active", [
        { railLotId: "lot-a", quantity: 4 },
      ]),
    });
    await prismaA.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, true);
    }, txOpts);
    const result = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-active" });
    expect(result.invariantA).toBe("GATE_UNKNOWN");
    expect(result.invariantA).not.toBe("MISMATCH");
    expect(result.invariantB).toBe("NOT_EVALUABLE");
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("returns NOT_EVALUABLE for legacy SQL NULL, including when no live lot exists", async () => {
    await insertCommand({
      id: "p3-cmd-null",
      requestId: "p3-req-null",
      batchId: "p3-batch-null",
      provenance: null,
    });
    const stored = await prismaA.batchCreationCommand.findUniqueOrThrow({
      where: { id: "p3-cmd-null" },
    });
    expect(stored.receiptProvenanceSnapshot).toBeNull();
    expect(await prismaA.railLot.count()).toBe(0);
    const result = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-null" });
    expect(result.invariantA).toBe("NOT_EVALUABLE");
    expect(result.invariantA).not.toBe("MATCH_OBSERVED");
    expect(result.invariantB).toBe("NOT_EVALUABLE");
    expect(await prismaA.railLot.count()).toBe(0);
  });

  it("returns SOURCE_UNAVAILABLE for a missing command and does not use requestId as causation", async () => {
    await insertCommand({
      id: "p3-cmd-replay",
      requestId: "p3-req-replay",
      batchId: "p3-batch-replay",
      provenance: provenance("p3-cmd-replay", "p3-batch-replay", [
        { railLotId: "lot-a", quantity: 1 },
      ]),
    });
    const missing = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-absent" });
    const byRequest = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-req-replay" });
    expect(missing.invariantA).toBe("SOURCE_UNAVAILABLE");
    expect(byRequest.invariantA).toBe("SOURCE_UNAVAILABLE");
    expect(await prismaA.batchCreationCommand.count()).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("returns INVALID_SOURCE for a duplicate railLotId stored on the command", async () => {
    await insertCommand({
      id: "p3-cmd-dup",
      requestId: "p3-req-dup",
      batchId: "p3-batch-dup",
      provenance: provenance("p3-cmd-dup", "p3-batch-dup", [
        { railLotId: "lot-a", quantity: 1 },
        { railLotId: "lot-a", quantity: 1 },
      ]),
    });
    const result = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-dup" });
    expect(result.invariantA).toBe("INVALID_SOURCE");
    expect(result.invariantB).toBe("NOT_EVALUABLE");
  });

  it("returns INVALID_SOURCE for a wrong binding, a bad quantity, and unsorted pairs", async () => {
    await insertCommand({
      id: "p3-cmd-bad",
      requestId: "p3-req-bad",
      batchId: "p3-batch-bad",
      provenance: provenance("p3-cmd-other", "p3-batch-bad", [{ railLotId: "lot-a", quantity: 1 }]),
    });
    await insertCommand({
      id: "p3-cmd-neg",
      requestId: "p3-req-neg",
      batchId: "p3-batch-neg",
      provenance: provenance("p3-cmd-neg", "p3-batch-neg", [{ railLotId: "lot-a", quantity: -1 }]),
    });
    await insertCommand({
      id: "p3-cmd-order",
      requestId: "p3-req-order",
      batchId: "p3-batch-order",
      provenance: provenance("p3-cmd-order", "p3-batch-order", [
        { railLotId: "lot-b", quantity: 1 },
        { railLotId: "lot-a", quantity: 1 },
      ]),
    });
    expect(
      (await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-bad" })).invariantA,
    ).toBe("INVALID_SOURCE");
    expect(
      (await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-neg" })).invariantA,
    ).toBe("INVALID_SOURCE");
    expect(
      (await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-order" })).invariantA,
    ).toBe("INVALID_SOURCE");
  });

  it("matches a proven zero after the original batch and lots are gone", async () => {
    const material = await prismaA.material.create({
      data: { name: "p3-material", sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    await prismaA.batch.create({
      data: {
        id: "p3-live-batch",
        name: "p3-live-batch",
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 1000,
        totalCost: 1000,
        priceSort1: 30000,
        priceSort2: 20000,
        purchaseDate: new Date("2026-10-11T00:00:00.000Z"),
      },
    });
    await prismaA.railLot.create({
      data: {
        id: "p3-live-lot",
        batchId: "p3-live-batch",
        lengthM: 2,
        railType: "POLKA",
        sort: "SORT1",
        quantity: 0,
        remainingQuantity: 0,
      },
    });
    await insertCommand({
      id: "p3-cmd-retain",
      requestId: "p3-req-retain",
      batchId: "p3-live-batch",
      provenance: provenance("p3-cmd-retain", "p3-live-batch", [
        { railLotId: "p3-live-lot", quantity: 0 },
      ]),
    });
    await prismaA.railLot.delete({ where: { id: "p3-live-lot" } });
    await prismaA.batch.delete({ where: { id: "p3-live-batch" } });
    expect(await prismaA.railLot.count()).toBe(0);
    expect(await prismaA.batch.count()).toBe(0);
    const before = await counts();
    const result = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-retain" });
    expect(result.invariantA).toBe("MATCH_OBSERVED");
    expect(result.expectedEffectCount).toBe(0);
    expect(result.invariantB).toBe("NOT_EVALUABLE");
    expect(await prismaA.batchCreationCommand.count()).toBe(1);
    expect(await counts()).toEqual(before);
  });

  it("reports an extra movement and a duplicate observed target as MISMATCH", async () => {
    const keyA = receiptKey("lot-a");
    const keyB = receiptKey("lot-b");
    await insertCommand({
      id: "p3-cmd-extra",
      requestId: "p3-req-extra",
      batchId: "p3-batch-extra",
      provenance: provenance("p3-cmd-extra", "p3-batch-extra", [{ railLotId: "lot-a", quantity: 4 }]),
    });
    await insertMovement({
      id: "p3-mv-extra-a",
      quantityDelta: 4,
      causationId: "p3-cmd-extra",
      effectKey: keyA.effectKey,
      railLotId: "lot-a",
      targetSnapshot: keyA.targetSnapshot as Prisma.InputJsonValue,
    });
    await insertMovement({
      id: "p3-mv-extra-b",
      quantityDelta: 1,
      causationId: "p3-cmd-extra",
      effectKey: keyB.effectKey,
      railLotId: "lot-b",
      targetSnapshot: keyB.targetSnapshot as Prisma.InputJsonValue,
    });
    const extra = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-extra" });
    expect(extra.invariantA).toBe("MISMATCH");
    expect(extra.differences.map((item) => item.code)).toContain("UNEXPECTED_EFFECT");
    expect(extra.invariantB).toBe("NOT_EVALUABLE");

    await prismaA.inventoryMovement.deleteMany();
    await insertCommand({
      id: "p3-cmd-split",
      requestId: "p3-req-split",
      batchId: "p3-batch-split",
      provenance: provenance("p3-cmd-split", "p3-batch-split", [{ railLotId: "lot-a", quantity: 4 }]),
    });
    await insertMovement({
      id: "p3-mv-split-1",
      quantityDelta: 2,
      causationId: "p3-cmd-split",
      effectKey: keyA.effectKey,
      railLotId: "lot-a",
      targetSnapshot: keyA.targetSnapshot as Prisma.InputJsonValue,
    });
    await insertMovement({
      id: "p3-mv-split-2",
      quantityDelta: 2,
      causationId: "p3-cmd-split",
      effectKey: "imfx1:receipt:duplicate-target",
      railLotId: "lot-a",
      targetSnapshot: keyA.targetSnapshot as Prisma.InputJsonValue,
    });
    const split = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-split" });
    expect(split.invariantA).toBe("MISMATCH");
    expect(split.observedShadowMovementCount).toBe(2);
    expect(split.invariantA).not.toBe("MATCH_OBSERVED");
  });

  it("reports a wrong kind, effectKey, quantity, and snapshot as MISMATCH", async () => {
    const key = receiptKey("lot-a");
    await insertCommand({
      id: "p3-cmd-wrong",
      requestId: "p3-req-wrong",
      batchId: "p3-batch-wrong",
      provenance: provenance("p3-cmd-wrong", "p3-batch-wrong", [{ railLotId: "lot-a", quantity: 4 }]),
    });
    await insertMovement({
      id: "p3-mv-kind",
      kind: "ADJUSTMENT",
      quantityDelta: 4,
      causationId: "p3-cmd-wrong",
      effectKey: key.effectKey,
      railLotId: "lot-a",
      targetSnapshot: key.targetSnapshot as Prisma.InputJsonValue,
    });
    const kind = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-wrong" });
    expect(kind.invariantA).toBe("MISMATCH");
    expect(kind.differences.map((item) => item.code)).toContain("KIND");

    await prismaA.inventoryMovement.deleteMany();
    await insertMovement({
      id: "p3-mv-key",
      quantityDelta: 4,
      causationId: "p3-cmd-wrong",
      effectKey: "imfx1:receipt:not-canonical",
      railLotId: "lot-a",
      targetSnapshot: key.targetSnapshot as Prisma.InputJsonValue,
    });
    const effectKey = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-wrong" });
    expect(effectKey.differences.map((item) => item.code)).toContain("EFFECT_KEY");

    await prismaA.inventoryMovement.deleteMany();
    await insertMovement({
      id: "p3-mv-qty",
      quantityDelta: 9,
      causationId: "p3-cmd-wrong",
      effectKey: key.effectKey,
      railLotId: "lot-a",
      targetSnapshot: key.targetSnapshot as Prisma.InputJsonValue,
    });
    const quantity = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-wrong" });
    expect(quantity.differences.map((item) => item.code)).toContain("QUANTITY");

    await prismaA.inventoryMovement.deleteMany();
    await insertMovement({
      id: "p3-mv-snap",
      quantityDelta: 4,
      causationId: "p3-cmd-wrong",
      effectKey: key.effectKey,
      railLotId: "lot-a",
      targetSnapshot: { v: 1, d: "RAIL_LOT", railLotId: "lot-other" },
    });
    const snapshot = await readBatchReceiptInvariantA(prismaA, { causationId: "p3-cmd-wrong" });
    expect(snapshot.invariantA).toBe("MISMATCH");
    expect(snapshot.differences.map((item) => item.code)).toContain("TARGET_SNAPSHOT");
    expect(snapshot.invariantB).toBe("NOT_EVALUABLE");
  });

  it("fails closed on a database read error and does not return a diagnostic status", async () => {
    const dead = new PrismaClient({
      datasourceUrl:
        "postgresql://slice1:slice1@127.0.0.1:1/stell22_integrity?connect_timeout=1",
    });
    try {
      await expect(
        readBatchReceiptInvariantA(dead, { causationId: "p3-missing" }),
      ).rejects.toBeInstanceOf(BatchReceiptDiagnosticExecutionError);
    } finally {
      await dead.$disconnect();
    }
  });
});
