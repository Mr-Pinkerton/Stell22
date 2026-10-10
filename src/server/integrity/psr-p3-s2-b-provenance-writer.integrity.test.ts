/**
 * PSR-P3 Slice 2-B P2: createBatch writes durable receipt provenance.
 * Disposable stell22_integrity only. No checker classification.
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => ({
    id: "integrity-admin",
    name: "Admin",
    email: "admin@test.local",
    role: "ADMIN",
  }),
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BATCH_RECEIPT_PROVENANCE_INVALID } from "@/server/internal/batch-receipt-provenance";
import {
  PURCHASE_REPLAY_TARGET_MISSING,
  PURCHASE_REQUEST_ID_REUSE,
} from "@/server/internal/purchase-command-identity";
import { batchCreateReceiptEffectKey } from "@/server/internal/raw-purchase-shadow-write";
import { setInventoryMovementShadowWriteGate } from "@/server/internal/inventory-movement-shadow-write";
import {
  createBatch,
  deleteBatch,
  writeOffBatchRemainder,
  type BatchFormValues,
} from "@/server/purchases";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
const REJECT_FUNCTION = "psr_p3_s2_b_p2_reject_im";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function postgresCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "meta" in error) {
    const code = (error as { meta?: { code?: unknown } }).meta?.code;
    if (typeof code === "string") return code;
  }
  return errorText(error).match(/\b(42710|42723)\b/)?.[1] ?? "";
}

type RejectFixtureClient = {
  $executeRawUnsafe: (query: string) => Promise<unknown>;
};

async function dropOwnedRejectFixture(
  db: RejectFixtureClient,
  owned: { functionCreatedByThisInvocation: boolean; triggerCreatedByThisInvocation: boolean },
): Promise<void> {
  const failures: unknown[] = [];
  if (owned.triggerCreatedByThisInvocation) {
    try {
      await db.$executeRawUnsafe(
        `DROP TRIGGER ${REJECT_FUNCTION} ON "InventoryMovement"`,
      );
      owned.triggerCreatedByThisInvocation = false;
    } catch (error) {
      failures.push(error);
    }
  }
  if (owned.functionCreatedByThisInvocation) {
    try {
      await db.$executeRawUnsafe(`DROP FUNCTION ${REJECT_FUNCTION}()`);
      owned.functionCreatedByThisInvocation = false;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.map(errorText).join("\n"));
  }
}

type Provenance = {
  v: number;
  d: string;
  commandId: string;
  batchId: string;
  pairs: Array<{ railLotId: string; quantity: number }>;
};

describe.skipIf(!enabled)("PSR-P3 S2-B P2 receipt provenance writer", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];

  beforeAll(() => {
    ensureIntegritySchema();
    ({ prismaA } = createIntegrityClients());
  });

  beforeEach(async () => {
    await resetIntegrityInventory(prismaA);
  });

  afterAll(async () => {
    await prismaA?.$disconnect();
  });

  async function setShadowGate(active: boolean) {
    await prismaA.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, active);
    }, txOpts);
  }

  async function seedMaterial(suffix: string) {
    return prismaA.material.create({
      data: { name: `p2prov-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
  }

  function values(
    suffix: string,
    materialId: string,
    rails: BatchFormValues["rails"],
  ): BatchFormValues {
    return {
      name: `p2-batch-${suffix}`,
      materialId,
      purchaseDate: "2026-01-15",
      sectionWidthMm: 40,
      sectionHeightMm: 20,
      purchaseCost: 10_000,
      priceSort1: 30_000,
      priceSort2: 20_000,
      note: "",
      rails,
    };
  }

  function packageRail(quantity: number, lengthM = 2): BatchFormValues["rails"][number] {
    return { mode: "package", lengthM, railType: "POLKA", sort: "SORT1", quantity };
  }

  async function provenanceFor(requestId: string): Promise<{
    commandId: string;
    batchId: string;
    requestSnapshot: unknown;
    provenance: Provenance;
  }> {
    const command = await prismaA.batchCreationCommand.findUniqueOrThrow({
      where: { requestId },
    });
    const provenance = command.receiptProvenanceSnapshot as Provenance;
    return {
      commandId: command.id,
      batchId: command.batchId,
      requestSnapshot: command.requestSnapshot,
      provenance,
    };
  }

  function expectBound(row: Awaited<ReturnType<typeof provenanceFor>>) {
    expect(Object.keys(row.provenance).sort()).toEqual([
      "batchId",
      "commandId",
      "d",
      "pairs",
      "v",
    ]);
    expect(row.provenance.v).toBe(1);
    expect(row.provenance.d).toBe("BATCH_RECEIPT_PROVENANCE");
    expect(row.provenance.commandId).toBe(row.commandId);
    expect(row.provenance.batchId).toBe(row.batchId);
    expect(JSON.stringify(row.requestSnapshot)).not.toContain("railLotId");
    expect(JSON.stringify(row.requestSnapshot)).toContain("BATCH_CREATE");
  }

  it("stores one pair and one matching RECEIPT when SHADOW is active", async () => {
    await setShadowGate(true);
    const suffix = `one-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const requestId = `p2:one:${suffix}`;
    const created = await createBatch(values(suffix, material.id, [packageRail(6)]), requestId);
    const row = await provenanceFor(requestId);
    expectBound(row);
    expect(row.batchId).toBe(created.id);
    expect(row.provenance.pairs).toEqual([{ railLotId: expect.any(String), quantity: 6 }]);
    const lotId = row.provenance.pairs[0]?.railLotId ?? "";
    const movements = await prismaA.inventoryMovement.findMany();
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({
      kind: "RECEIPT",
      quantityDelta: 6,
      causationId: row.commandId,
      effectKey: batchCreateReceiptEffectKey(lotId),
    });
    const causation = movements[0]?.causationSnapshot as { d?: string };
    expect(causation.d).not.toBe("BATCH_RECEIPT_PROVENANCE");
  });

  it("stores one sorted pair per lot, including identical specifications", async () => {
    await setShadowGate(true);
    const suffix = `many-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const requestId = `p2:many:${suffix}`;
    await createBatch(
      values(suffix, material.id, [packageRail(2, 3), packageRail(4, 2), packageRail(4, 2)]),
      requestId,
    );
    const row = await provenanceFor(requestId);
    expect(row.provenance.pairs).toHaveLength(3);
    const sorted = row.provenance.pairs.map((pair) => pair.railLotId).slice().sort((a, b) => a.localeCompare(b));
    expect(row.provenance.pairs.map((pair) => pair.railLotId)).toEqual(sorted);
    const equalSpecs = row.provenance.pairs.filter((pair) => pair.quantity === 4);
    expect(equalSpecs).toHaveLength(2);
    expect(new Set(equalSpecs.map((pair) => pair.railLotId)).size).toBe(2);
    expect(await prismaA.inventoryMovement.count()).toBe(3);
  });

  it("retains a zero pair and writes no RECEIPT for that lot", async () => {
    await setShadowGate(true);
    const suffix = `zero-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const requestId = `p2:zero:${suffix}`;
    await createBatch(
      values(suffix, material.id, [packageRail(0, 2), packageRail(5, 3)]),
      requestId,
    );
    const row = await provenanceFor(requestId);
    expect(row.provenance.pairs.map((pair) => pair.quantity).sort((a, b) => a - b)).toEqual([0, 5]);
    const zero = row.provenance.pairs.find((pair) => pair.quantity === 0);
    const movements = await prismaA.inventoryMovement.findMany();
    expect(movements).toHaveLength(1);
    expect(movements[0]?.quantityDelta).toBe(5);
    expect(movements[0]?.effectKey).not.toBe(batchCreateReceiptEffectKey(zero?.railLotId ?? ""));
  });

  it("rolls back a negative quantity before any command, lot, or movement is committed", async () => {
    await setShadowGate(true);
    const suffix = `neg-${Date.now()}`;
    const material = await seedMaterial(suffix);
    await expect(
      createBatch(values(suffix, material.id, [packageRail(-3)]), `p2:neg:${suffix}`),
    ).rejects.toThrow(BATCH_RECEIPT_PROVENANCE_INVALID);
    expect(await prismaA.batch.count()).toBe(0);
    expect(await prismaA.railLot.count()).toBe(0);
    expect(await prismaA.batchCreationCommand.count()).toBe(0);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("rolls back the receipt when SHADOW append fails before commit", async () => {
    await setShadowGate(true);
    const owned = {
      functionCreatedByThisInvocation: false,
      triggerCreatedByThisInvocation: false,
    };
    let testError: unknown;
    try {
      try {
        await prismaA.$executeRawUnsafe(`
          CREATE FUNCTION ${REJECT_FUNCTION}()
          RETURNS trigger AS $$
          BEGIN
            RAISE EXCEPTION 'psr_p3_s2_b_p2 forced receipt failure';
          END;
          $$ LANGUAGE plpgsql;
        `);
      } catch (error) {
        if (postgresCode(error) === "42723") {
          throw new Error(
            `Refusing to replace pre-existing function ${REJECT_FUNCTION}().`,
            { cause: error },
          );
        }
        throw error;
      }
      owned.functionCreatedByThisInvocation = true;
      try {
        await prismaA.$executeRawUnsafe(`
          CREATE TRIGGER ${REJECT_FUNCTION}
          BEFORE INSERT ON "InventoryMovement"
          FOR EACH ROW EXECUTE FUNCTION ${REJECT_FUNCTION}();
        `);
      } catch (error) {
        if (postgresCode(error) === "42710") {
          throw new Error(
            `Refusing to replace pre-existing trigger ${REJECT_FUNCTION} on InventoryMovement.`,
            { cause: error },
          );
        }
        throw error;
      }
      owned.triggerCreatedByThisInvocation = true;

      const suffix = `fail-${Date.now()}`;
      const material = await seedMaterial(suffix);
      await expect(
        createBatch(values(suffix, material.id, [packageRail(4)]), `p2:fail:${suffix}`),
      ).rejects.toThrow(/psr_p3_s2_b_p2 forced receipt failure/);
      expect(await prismaA.batch.count()).toBe(0);
      expect(await prismaA.railLot.count()).toBe(0);
      expect(await prismaA.batchCreationCommand.count()).toBe(0);
      expect(await prismaA.inventoryMovement.count()).toBe(0);
    } catch (error) {
      testError = error;
    }
    let cleanupError: unknown;
    try {
      await dropOwnedRejectFixture(prismaA, owned);
    } catch (error) {
      cleanupError = error;
    }
    if (testError && cleanupError) {
      throw new Error(`${errorText(testError)}\n${errorText(cleanupError)}`, { cause: testError });
    }
    if (cleanupError) throw cleanupError;
    if (testError) throw testError;
    const [functions, triggers] = await Promise.all([
      prismaA.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ${REJECT_FUNCTION}
      `,
      prismaA.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'InventoryMovement'
          AND t.tgname = ${REJECT_FUNCTION}
          AND NOT t.tgisinternal
      `,
    ]);
    expect(functions[0]?.n ?? 0).toBe(0);
    expect(triggers[0]?.n ?? 0).toBe(0);
  });

  it("replay of the same request adds no second batch, command, provenance, or RECEIPT", async () => {
    await setShadowGate(true);
    const suffix = `replay-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const form = values(suffix, material.id, [packageRail(6), packageRail(2, 3)]);
    const requestId = `p2:replay:${suffix}`;
    const first = await createBatch(form, requestId);
    const before = await provenanceFor(requestId);
    const replay = await createBatch(form, requestId);
    const after = await provenanceFor(requestId);
    expect(replay.id).toBe(first.id);
    expect(after).toEqual(before);
    expect(await prismaA.batch.count()).toBe(1);
    expect(await prismaA.batchCreationCommand.count()).toBe(1);
    expect(await prismaA.railLot.count()).toBe(2);
    expect(await prismaA.inventoryMovement.count()).toBe(2);
  });

  it("rejects a mismatched requestId reuse and leaves the original provenance", async () => {
    await setShadowGate(true);
    const suffix = `reuse-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const form = values(suffix, material.id, [packageRail(6)]);
    const requestId = `p2:reuse:${suffix}`;
    await createBatch(form, requestId);
    const before = JSON.stringify(await provenanceFor(requestId));
    await expect(createBatch({ ...form, note: "other" }, requestId)).rejects.toThrow(
      PURCHASE_REQUEST_ID_REUSE,
    );
    expect(JSON.stringify(await provenanceFor(requestId))).toBe(before);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
  });

  it("writes provenance and zero movements when SHADOW is inactive", async () => {
    await setShadowGate(false);
    const suffix = `off-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const requestId = `p2:off:${suffix}`;
    await createBatch(values(suffix, material.id, [packageRail(6)]), requestId);
    const row = await provenanceFor(requestId);
    expectBound(row);
    expect(row.provenance.pairs).toHaveLength(1);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("keeps the original provenance after write-off and legal deleteBatch", async () => {
    await setShadowGate(true);
    const suffix = `keep-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const form = values(suffix, material.id, [packageRail(6), packageRail(0, 3)]);
    const requestId = `p2:keep:${suffix}`;
    const created = await createBatch(form, requestId);
    const before = await provenanceFor(requestId);
    await writeOffBatchRemainder(created.id, `p2:keep-wo:${suffix}`);
    await deleteBatch(created.id);
    expect(await prismaA.batch.count({ where: { id: created.id } })).toBe(0);
    expect(await prismaA.railLot.count({ where: { batchId: created.id } })).toBe(0);
    const after = await provenanceFor(requestId);
    expect(after).toEqual(before);
    expect(after.provenance.pairs).toHaveLength(2);
    await expect(createBatch(form, requestId)).rejects.toThrow(PURCHASE_REPLAY_TARGET_MISSING);
    expect(await provenanceFor(requestId)).toEqual(before);
    expect(await prismaA.batchCreationCommand.count({ where: { requestId } })).toBe(1);
  });

  it("does not fill an existing SQL NULL command", async () => {
    await setShadowGate(false);
    await prismaA.batchCreationCommand.create({
      data: {
        id: "legacy-null-command",
        requestId: "legacy-null-request",
        batchId: "legacy-null-batch",
        adminUserId: "integrity-admin",
        requestSnapshot: { v: 1, d: "BATCH_CREATE" },
      },
    });
    const suffix = `legacy-${Date.now()}`;
    const material = await seedMaterial(suffix);
    await createBatch(values(suffix, material.id, [packageRail(1)]), `p2:legacy:${suffix}`);
    const legacy = await prismaA.batchCreationCommand.findUniqueOrThrow({
      where: { id: "legacy-null-command" },
    });
    expect(legacy.receiptProvenanceSnapshot).toBeNull();
    const created = await provenanceFor(`p2:legacy:${suffix}`);
    expect(created.provenance.v).toBe(1);
  });

  it("leaves the P1 trigger blocking a later provenance mutation", async () => {
    await setShadowGate(false);
    const suffix = `guard-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const requestId = `p2:guard:${suffix}`;
    await createBatch(values(suffix, material.id, [packageRail(1)]), requestId);
    const before = JSON.stringify((await provenanceFor(requestId)).provenance);
    await expect(
      prismaA.$executeRaw`
        UPDATE "BatchCreationCommand"
        SET "receiptProvenanceSnapshot" = '{"v":9}'::jsonb
        WHERE "requestId" = ${requestId}
      `,
    ).rejects.toThrow(/batch creation command provenance is immutable/);
    expect(JSON.stringify((await provenanceFor(requestId)).provenance)).toBe(before);
  });

  it("concurrent same requestId creates one receipt", async () => {
    await setShadowGate(true);
    const suffix = `race-${Date.now()}`;
    const material = await seedMaterial(suffix);
    const form = values(suffix, material.id, [packageRail(6)]);
    const requestId = `p2:race:${suffix}`;
    const settled = await Promise.allSettled([
      createBatch(form, requestId),
      createBatch(form, requestId),
    ]);
    expect(settled.every((row) => row.status === "fulfilled")).toBe(true);
    expect(await prismaA.batch.count({ where: { name: form.name } })).toBe(1);
    expect(await prismaA.batchCreationCommand.count({ where: { requestId } })).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(1);
    expect((await provenanceFor(requestId)).provenance.pairs).toHaveLength(1);
  });
});
