/**
 * PSR-P2 Package 3 A/B/C quantity-edit SHADOW writers.
 * Trigger reject is integrity-only and keyed by actorDisplaySnapshot.
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ set: vi.fn(), delete: vi.fn() })),
  headers: vi.fn(async () => new Headers()),
}));

const adminState = vi.hoisted(() => ({
  current: {
    id: "integrity-admin",
    name: "Admin",
    email: "admin@test.local",
    role: "ADMIN",
  },
}));

vi.mock("@/server/session", () => ({
  requireAdmin: async () => ({ ...adminState.current }),
  requireTerminalEmployee: async (expectedEmployeeId?: string) => ({
    id: expectedEmployeeId ?? "integrity-session-employee",
    fullName: "Integrity Employee",
  }),
}));
vi.mock("@/server/cost-queue", () => ({ enqueueRecalcBatchCosts: async () => {} }));

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { newRequestId } from "@/lib/request-id";
import { PRODUCTION_COST_FLOW_KEY } from "@/server/internal/cost-flow-state";
import { lockProductionOperations } from "@/server/internal/finance-operations";
import { canonicalizeMovementTarget } from "@/server/internal/inventory-movement-identity";
import { userMovementActorFromAdmin } from "@/server/internal/inventory-movement-actor";
import {
  INVENTORY_MOVEMENT_SHADOW_LOCK_KEY,
  INVENTORY_MOVEMENT_SHADOW_LOCK_NS,
} from "@/server/internal/inventory-movement-shadow-coordination";
import { utcNaiveTimestampString } from "@/server/internal/inventory-movement-time";
import {
  INVENTORY_MOVEMENT_SHADOW_WRITE_KEY,
  InventoryMovementShadowWriteConfigError,
  setInventoryMovementShadowWriteGate,
} from "@/server/internal/inventory-movement-shadow-write";
import {
  QUANTITY_EDIT_UPAKOVKA_COST_FLOW_NOT_READY,
  REQUEST_ID_REUSE,
  computeQuantityEditStateFingerprint,
} from "@/server/internal/production-quantity-edit";
import {
  QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID,
  appendQuantityEditShadowMovements,
  parseQuantityEditPhysicalAdjustments,
  quantityEditCausationSnapshotV1,
  quantityEditEffectKey,
  quantityEditMovementTarget,
} from "@/server/internal/production-quantity-edit-shadow-write";
import { editProductionOperationQuantity, updateProductionLineQuantity } from "@/server/production";
import { submitHours, submitPrisadka, submitTorcovka, submitUpakovka } from "@/server/terminal";
import {
  createIntegrityClients,
  ensureIntegritySchema,
  integrityDatabaseUrl,
  resetIntegrityInventory,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const txOpts = { maxWait: 20_000, timeout: 20_000 } as const;
const BARRIER_TIMEOUT_MS = 25_000;
const REJECT_ACTOR = "INTEGRITY_REJECT_IM";
const CONCURRENCY_TIMEOUT_MS = 20_000;

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < BARRIER_TIMEOUT_MS) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`barrier: ${label}`);
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`QueryTimeout: ${label} exceeded ${CONCURRENCY_TIMEOUT_MS}ms`)),
      CONCURRENCY_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(!enabled)("PSR-P2 Package 3 production quantity-edit SHADOW writers", () => {
  let prismaA: ReturnType<typeof createIntegrityClients>["prismaA"];
  let prismaB: ReturnType<typeof createIntegrityClients>["prismaB"];
  let prismaC: PrismaClient;
  let seq = 0;

  beforeAll(async () => {
    ensureIntegritySchema();
    ({ prismaA, prismaB } = createIntegrityClients());
    prismaC = new PrismaClient({ datasourceUrl: integrityDatabaseUrl() });
    await prismaA.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION stell22_integrity_reject_im_insert()
      RETURNS trigger AS $$
      BEGIN
        IF NEW."actorDisplaySnapshot" = '${REJECT_ACTOR}' THEN
          RAISE EXCEPTION 'integrity reject InventoryMovement insert';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prismaA.$executeRawUnsafe(`DROP TRIGGER IF EXISTS stell22_integrity_reject_im_insert ON "InventoryMovement"`);
    await prismaA.$executeRawUnsafe(`
      CREATE TRIGGER stell22_integrity_reject_im_insert
      BEFORE INSERT ON "InventoryMovement"
      FOR EACH ROW EXECUTE FUNCTION stell22_integrity_reject_im_insert();
    `);
  });

  beforeEach(async () => {
    adminState.current = {
      id: "integrity-admin",
      name: "Admin",
      email: "admin@test.local",
      role: "ADMIN",
    };
    await resetIntegrityInventory(prismaA);
    seq += 1;
  });

  afterAll(async () => {
    await prismaA
      ?.$executeRawUnsafe(`DROP TRIGGER IF EXISTS stell22_integrity_reject_im_insert ON "InventoryMovement"`)
      .catch(() => {});
    await prismaA
      ?.$executeRawUnsafe(`DROP FUNCTION IF EXISTS stell22_integrity_reject_im_insert()`)
      .catch(() => {});
    await prismaA?.$executeRawUnsafe(`DELETE FROM "InventoryMovement"`).catch(() => {});
    await prismaA?.$disconnect();
    await prismaB?.$disconnect();
    await prismaC?.$disconnect();
  });

  async function setShadowGate(active: boolean) {
    await prismaA.$transaction(async (tx) => {
      await setInventoryMovementShadowWriteGate(tx, active);
    }, txOpts);
  }

  async function setCostFlowActive(active: boolean) {
    await prismaA.setting.upsert({
      where: { key: PRODUCTION_COST_FLOW_KEY },
      create: { key: PRODUCTION_COST_FLOW_KEY, value: { version: 1, active } },
      update: { value: { version: 1, active } },
    });
  }

  async function advisoryCounts() {
    const rows = await prismaA.$queryRaw<Array<{ mode: string; granted: boolean; n: bigint }>>`
      SELECT mode, granted, count(*)::bigint AS n
      FROM pg_locks
      WHERE locktype = 'advisory'
        AND classid = ${INVENTORY_MOVEMENT_SHADOW_LOCK_NS}
        AND objid = ${INVENTORY_MOVEMENT_SHADOW_LOCK_KEY}
      GROUP BY mode, granted
    `;
    const count = (mode: string, granted: boolean) =>
      Number(rows.find((row) => row.mode === mode && row.granted === granted)?.n ?? 0);
    return {
      sharedGranted: count("ShareLock", true),
      exclusiveGranted: count("ExclusiveLock", true),
      exclusiveWaiting: count("ExclusiveLock", false),
    };
  }

  async function quantityChangeLogs(operationId: string) {
    const logs = await prismaA.changeLog.findMany({
      where: { entity: "ProductionOperation", entityId: operationId },
    });
    return logs.filter((log) => (log.newValues as { field?: string } | null)?.field === "Количество");
  }

  async function seedWorld(suffix: string) {
    const material = await prismaA.material.create({
      data: { name: `mat-${suffix}`, sectionWidthMm: 40, sectionHeightMm: 20 },
    });
    const emp = await prismaA.employee.create({
      data: {
        fullName: `emp-${suffix}`,
        pin: "1234",
        hourlyRate: 200,
        rateTorcovkaSort1: 12,
        ratePrisadkaTorcev: 9,
        rateUpakovka: 6,
      },
    });
    const batch = await prismaA.batch.create({
      data: {
        name: `batch-${suffix}`,
        materialId: material.id,
        sectionWidthMm: 40,
        sectionHeightMm: 20,
        purchaseCost: 1_000,
        totalCost: 1_000,
        priceSort1: 30_000,
        priceSort2: 20_000,
        purchaseDate: new Date("2026-01-15T00:00:00.000Z"),
        status: "IN_WORK",
      },
    });
    const lot = await prismaA.railLot.create({
      data: {
        batchId: batch.id,
        lengthM: new Prisma.Decimal("2"),
        railType: "POLKA",
        sort: "SORT1",
        isPackage: true,
        quantity: 10,
        remainingQuantity: 10,
      },
    });
    const detail = await prismaA.detail.create({
      data: {
        name: `det-${suffix}`,
        materialId: material.id,
        detailNumber: 1,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    const product = await prismaA.product.create({
      data: {
        name: `prod-${suffix}`,
        materialId: material.id,
        skuOzon: `OZ-${suffix}`,
        skuWb: `WB-${suffix}`,
        sort: "SORT1",
      },
    });
    await prismaA.productDetail.create({
      data: { productId: product.id, detailId: detail.id, quantity: 1 },
    });
    return { material, emp, batch, lot, detail, product };
  }

  async function loadOp(id: string) {
    return prismaA.productionOperation.findUniqueOrThrow({
      where: { id },
      include: {
        lines: { orderBy: { id: "asc" } },
        nomenclatureLines: { orderBy: { id: "asc" } },
      },
    });
  }

  function fingerprintFor(op: Awaited<ReturnType<typeof loadOp>>, lineId?: string | null) {
    const line = lineId ? op.lines.find((l) => l.id === lineId) : undefined;
    return computeQuantityEditStateFingerprint({
      operationId: op.id,
      operationType: op.type,
      productId: op.productId,
      productQty: op.productQty,
      line,
      lines: op.lines,
      nomenclatureLines: op.nomenclatureLines,
    });
  }

  async function editQty(input: {
    operationId: string;
    targetLineId?: string | null;
    expectedOldQuantity: number;
    newQuantity: number;
    requestId?: string;
    fingerprint?: string;
  }) {
    const op = await loadOp(input.operationId);
    return editProductionOperationQuantity({
      operationId: input.operationId,
      requestId: input.requestId ?? newRequestId(),
      targetLineId: input.targetLineId,
      expectedOldQuantity: input.expectedOldQuantity,
      newQuantity: input.newQuantity,
      expectedStateFingerprint: input.fingerprint ?? fingerprintFor(op, input.targetLineId),
    });
  }

  async function seedTorcovka(suffix: string, quantity = 2) {
    const world = await seedWorld(suffix);
    const railsTaken = quantity <= 1 ? 1 : 2;
    await submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken,
      clientRequestId: `test:p3:tor:${suffix}`,
      picks: [{ lengthM: 1.8, sort: "SORT1", quantity }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "TORCOVKA", batchId: world.batch.id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    return { world, op, line: op.lines[0]! };
  }

  async function seedPrisadka(suffix: string, quantity = 2) {
    const world = await seedWorld(suffix);
    const railsTaken = quantity <= 1 ? 1 : 2;
    await submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken,
      clientRequestId: `test:p3:pris-t:${suffix}`,
      picks: [{ lengthM: 1.8, sort: "SORT1", quantity }],
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `test:p3:pris:${suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA", employeeId: world.emp.id },
      include: { lines: { orderBy: { id: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
    return { world, op, line: op.lines[0]! };
  }

  async function seedUpakovka(suffix: string, quantity = 1) {
    const world = await seedWorld(suffix);
    await submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 2,
      clientRequestId: `test:p3:up-t:${suffix}`,
      picks: [{ lengthM: 1.8, sort: "SORT1", quantity: Math.max(quantity, 2) }],
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `test:p3:up-p:${suffix}`,
      picks: [{ detailId: world.detail.id, kind: "torcev", quantity: Math.max(quantity, 2) }],
    });
    await submitUpakovka({
      employeeId: world.emp.id,
      clientRequestId: `test:p3:up:${suffix}`,
      picks: [{ productId: world.product.id, quantity }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "UPAKOVKA", productId: world.product.id },
      include: { lines: { orderBy: { id: "asc" } }, nomenclatureLines: true },
    });
    return { world, op };
  }

  async function seedActiveTorcevFromBlankWithPloskSource(suffix: string) {
    const world = await seedWorld(suffix);
    await prismaA.employee.update({
      where: { id: world.emp.id },
      data: { ratePrisadkaPloskt: 4 },
    });
    await prismaA.railLot.update({
      where: { id: world.lot.id },
      data: {
        initialValue: new Prisma.Decimal("10000"),
        remainingValue: new Prisma.Decimal("10000"),
      },
    });
    const both = await prismaA.detail.create({
      data: {
        name: `det-p3a-${suffix}`,
        materialId: world.material.id,
        detailNumber: 8,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: true,
      },
    });
    await setCostFlowActive(true);
    await submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 2,
      clientRequestId: `test:p3:act-t:${suffix}`,
      picks: [{ lengthM: 1.8, sort: "SORT1", quantity: 2 }],
    });
    await submitPrisadka({
      employeeId: world.emp.id,
      clientRequestId: `test:p3:act-p:${suffix}`,
      picks: [{ detailId: both.id, kind: "torcev", quantity: 2 }],
    });
    await prismaA.detailStock.upsert({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: both.id,
          torcevayaDone: false,
          ploskostDone: true,
        },
      },
      create: {
        detailId: both.id,
        torcevayaDone: false,
        ploskostDone: true,
        quantity: 2,
        materialValue: new Prisma.Decimal("160"),
        laborValue: new Prisma.Decimal("10"),
        totalValue: new Prisma.Decimal("170"),
        costVersion: 1,
      },
      update: {
        quantity: 2,
        materialValue: new Prisma.Decimal("160"),
        laborValue: new Prisma.Decimal("10"),
        totalValue: new Prisma.Decimal("170"),
        costVersion: 1,
      },
    });
    await prismaA.detailStock.deleteMany({
      where: { detailId: both.id, torcevayaDone: true, ploskostDone: true, quantity: 0 },
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "PRISADKA", employeeId: world.emp.id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    return { world, both, op };
  }

  async function expectRetainedAdjustmentsMirrored(row: {
    id: string;
    requestId: string;
    operationId: string;
    adminUserId: string;
    actorDisplaySnapshot: string;
    operationType: string;
    targetLineId: string | null;
    expectedOldQuantity: number;
    newQuantity: number;
    recordedAt: Date;
    effectSnapshot: unknown;
  }) {
    const adjustments = parseQuantityEditPhysicalAdjustments(row.effectSnapshot);
    const movements = await prismaA.inventoryMovement.findMany({
      where: { causationKind: "PRODUCTION_OPERATION_MUTATION", causationId: row.id },
    });
    expect(movements).toHaveLength(adjustments.length);
    expect(movements.every((m) => m.kind === "ADJUSTMENT")).toBe(true);
    expect(movements.every((m) => m.authority === "SHADOW")).toBe(true);
    expect(movements.every((m) => m.reason === null)).toBe(true);
    expect(movements.every((m) => m.reversalOfMovementId === null)).toBe(true);
    expect(movements.every((m) => m.actorKind === "USER")).toBe(true);
    expect(movements.every((m) => m.userId === row.adminUserId)).toBe(true);
    expect(movements.every((m) => m.actorDisplaySnapshot === row.actorDisplaySnapshot)).toBe(true);
    expect(movements.every((m) => m.employeeId === null)).toBe(true);
    expect(movements.every((m) => m.systemActorKey === null)).toBe(true);
    const expectedSnapshot = quantityEditCausationSnapshotV1({
      id: row.id,
      requestId: row.requestId,
      operationId: row.operationId,
      operationType: row.operationType as "TORCOVKA" | "PRISADKA" | "UPAKOVKA",
      targetLineId: row.targetLineId,
      expectedOldQuantity: row.expectedOldQuantity,
      newQuantity: row.newQuantity,
    });
    for (const movement of movements) {
      expect(movement.causationSnapshot).toEqual(expectedSnapshot);
      expect(movement.effectKey).toMatch(/^imfx1:adjust:[0-9a-f]{64}$/);
      expect(utcNaiveTimestampString(row.recordedAt)).toBe(utcNaiveTimestampString(movement.effectiveAt));
    }
    for (const adj of adjustments) {
      const target = quantityEditMovementTarget(adj);
      const key = quantityEditEffectKey(target);
      const movement = movements.find((m) => m.effectKey === key);
      expect(movement, `missing movement for ${adj.targetType}`).toBeTruthy();
      expect(movement!.quantityDelta).toBe(adj.quantityDelta);
      expect(movement!.stockDomain).toBe(canonicalizeMovementTarget(target).stockDomain);
    }
    expect(movements.some((m) => m.kind === "REVERSAL")).toBe(false);
    expect(JSON.stringify(movements.map((m) => m.causationSnapshot))).not.toMatch(/amount|money|cost|price|value/i);
  }

  it("TORCOVKA SHADOW OFF succeeds with 0 InventoryMovement", async () => {
    const { op, line } = await seedTorcovka(`off-${seq}`);
    const result = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
    });
    expect(result.replayed).toBe(false);
    expect((await loadOp(op.id)).lines[0]!.quantity).toBe(1);
    expect(await prismaA.productionOperationQuantityEdit.count()).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect(await quantityChangeLogs(op.id)).toHaveLength(1);
  });

  it("TORCOVKA SHADOW ON writes exact signed ADJUSTMENT with actor/causation/effectKey/effectiveAt", async () => {
    const { op, line } = await seedTorcovka(`on-${seq}`);
    await setShadowGate(true);
    const result = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
    });
    const row = await prismaA.productionOperationQuantityEdit.findUniqueOrThrow({
      where: { requestId: result.requestId },
    });
    await expectRetainedAdjustmentsMirrored(row);
    const adj = parseQuantityEditPhysicalAdjustments(row.effectSnapshot);
    expect(adj.some((a) => a.targetType === "BLANK" && a.quantityDelta === -1)).toBe(true);
    expect(row.adminUserId).toBe("integrity-admin");
    expect(row.actorDisplaySnapshot).toBe("Admin");
  });

  it("TORCOVKA sequential replay and concurrent same request apply once without extra IM", async () => {
    const { op, line } = await seedTorcovka(`rp-${seq}`);
    await setShadowGate(true);
    const requestId = `p3:tor:rp:${op.id}`;
    const fingerprint = fingerprintFor(await loadOp(op.id), line.id);
    const first = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
      requestId,
      fingerprint,
    });
    const imAfterFirst = await prismaA.inventoryMovement.count();
    const logs = await quantityChangeLogs(op.id);
    const replay = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
      requestId,
      fingerprint,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.quantityEditId).toBe(first.quantityEditId);
    expect(await prismaA.inventoryMovement.count()).toBe(imAfterFirst);
    expect(await quantityChangeLogs(op.id)).toHaveLength(logs.length);

    const { op: op2, line: line2 } = await seedTorcovka(`cc-${seq}`);
    const concurrentId = `p3:tor:cc:${op2.id}`;
    const concurrentFp = fingerprintFor(await loadOp(op2.id), line2.id);
    const settled = await withTimeout(
      Promise.allSettled([
        editQty({
          operationId: op2.id,
          targetLineId: line2.id,
          expectedOldQuantity: line2.quantity,
          newQuantity: 1,
          requestId: concurrentId,
          fingerprint: concurrentFp,
        }),
        editQty({
          operationId: op2.id,
          targetLineId: line2.id,
          expectedOldQuantity: line2.quantity,
          newQuantity: 1,
          requestId: concurrentId,
          fingerprint: concurrentFp,
        }),
      ]),
      "p3 concurrent same request",
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(2);
    expect(await prismaA.productionOperationQuantityEdit.count({ where: { requestId: concurrentId } })).toBe(1);
    const concurrentRow = await prismaA.productionOperationQuantityEdit.findUniqueOrThrow({
      where: { requestId: concurrentId },
    });
    await expectRetainedAdjustmentsMirrored(concurrentRow);
  });

  it("PRISADKA INACTIVE SHADOW ON mirrors source and destination signed adjustments only", async () => {
    const { world, op, line } = await seedPrisadka(`pi-${seq}`);
    const sourceB = await prismaA.detailStock.create({
      data: {
        detailId: world.detail.id,
        torcevayaDone: false,
        ploskostDone: false,
        quantity: 5,
      },
    });
    await setShadowGate(true);
    const result = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
    });
    const row = await prismaA.productionOperationQuantityEdit.findUniqueOrThrow({
      where: { requestId: result.requestId },
    });
    const adj = parseQuantityEditPhysicalAdjustments(row.effectSnapshot);
    expect(adj.some((a) => a.targetType === "DETAIL" && a.detailId === world.detail.id && a.quantityDelta !== 0)).toBe(
      true,
    );
    const sourceAdj = adj.find(
      (a) =>
        a.targetType === "DETAIL" &&
        a.detailId === world.detail.id &&
        a.torcevayaDone === false &&
        a.ploskostDone === false,
    );
    expect(sourceAdj?.quantityDelta).toBe(-1);
    expect((await prismaA.detailStock.findUniqueOrThrow({ where: { id: sourceB.id } })).quantity).toBe(4);
    await expectRetainedAdjustmentsMirrored(row);
    expect(await prismaA.inventoryMovement.count({ where: { kind: "REVERSAL" } })).toBe(0);
    expect(await prismaA.inventoryMovement.count({ where: { kind: "CONSUMPTION" } })).toBe(0);
    expect(await prismaA.inventoryMovement.count({ where: { kind: "PRODUCTION_OUTPUT" } })).toBe(0);
  });

  it("PRISADKA ACTIVE SHADOW ON mirrors command-only net set, dest-sharing, and excludes untouched", async () => {
    const { world, both, op } = await seedActiveTorcevFromBlankWithPloskSource(`pa-${seq}`);
    const extra = await prismaA.detail.create({
      data: {
        name: `det-p3-untouched-${seq}`,
        materialId: world.material.id,
        detailNumber: 9,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    const untouched = await prismaA.operationDetailLine.create({
      data: {
        operationId: op.id,
        detailId: extra.id,
        quantity: 1,
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
        sourceIsBlank: true,
        blankLengthM: new Prisma.Decimal("1.8000"),
        blankType: "POLKA",
        blankSort: "SORT1",
        blankMaterialId: world.material.id,
      },
    });
    await setShadowGate(true);
    const line = op.lines[0]!;
    const result = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
    });
    const row = await prismaA.productionOperationQuantityEdit.findUniqueOrThrow({
      where: { requestId: result.requestId },
    });
    const adj = parseQuantityEditPhysicalAdjustments(row.effectSnapshot);
    expect(adj.some((a) => a.targetType === "DETAIL" && a.detailId === both.id)).toBe(true);
    expect(adj.some((a) => a.targetType === "DETAIL" && a.detailId === extra.id)).toBe(false);
    await expectRetainedAdjustmentsMirrored(row);
    expect(await prismaA.operationDetailLine.count({ where: { id: untouched.id } })).toBe(1);
  });

  it("PRISADKA ACTIVE concurrent stock writer remains serialized and frozen write-set stays command-only", async () => {
    const { both, op } = await seedActiveTorcevFromBlankWithPloskSource(`lock-${seq}`);
    await setShadowGate(true);
    const line = op.lines[0]!;
    let started!: Promise<PromiseSettledResult<Awaited<ReturnType<typeof editProductionOperationQuantity>>>[]>;
    await prismaB.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Detail" WHERE id = ${both.id} FOR UPDATE`;
        started = Promise.allSettled([
          editQty({
            operationId: op.id,
            targetLineId: line.id,
            expectedOldQuantity: line.quantity,
            newQuantity: 1,
          }),
        ]);
        await waitUntil(async () => {
          const rows = await tx.$queryRaw<Array<{ n: number }>>`
            SELECT count(*)::int AS n
            FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND pid <> pg_backend_pid()
          `;
          return (rows[0]?.n ?? 0) >= 1;
        }, "p3 active detail parent lock wait");
        await tx.detailStock.upsert({
          where: {
            detailId_torcevayaDone_ploskostDone: {
              detailId: both.id,
              torcevayaDone: true,
              ploskostDone: true,
            },
          },
          create: {
            detailId: both.id,
            torcevayaDone: true,
            ploskostDone: true,
            quantity: 3,
            materialValue: new Prisma.Decimal("90"),
            laborValue: new Prisma.Decimal("9"),
            totalValue: new Prisma.Decimal("99"),
            costVersion: 1,
          },
          update: {
            quantity: 3,
            materialValue: new Prisma.Decimal("90"),
            laborValue: new Prisma.Decimal("9"),
            totalValue: new Prisma.Decimal("99"),
            costVersion: 1,
          },
        });
      },
      txOpts,
    );
    const settled = await withTimeout(started, "p3 active parent lock");
    expect(settled[0]?.status).toBe("fulfilled");
    const row = await prismaA.productionOperationQuantityEdit.findFirstOrThrow({
      where: { operationId: op.id },
    });
    const destTTAfter = await prismaA.detailStock.findUniqueOrThrow({
      where: {
        detailId_torcevayaDone_ploskostDone: {
          detailId: both.id,
          torcevayaDone: true,
          ploskostDone: true,
        },
      },
    });
    const adj = parseQuantityEditPhysicalAdjustments(row.effectSnapshot).find(
      (a) =>
        a.targetType === "DETAIL" &&
        a.detailId === both.id &&
        a.torcevayaDone === true &&
        a.ploskostDone === true,
    );
    expect(adj?.quantityDelta).toBe(destTTAfter.quantity - 3);
    await expectRetainedAdjustmentsMirrored(row);
  });

  it("UPAKOVKA INACTIVE SHADOW ON writes PRODUCT and changed-current-BOM DETAIL without cross-target netting", async () => {
    const { world, op } = await seedUpakovka(`ub-${seq}`, 1);
    const extra = await prismaA.detail.create({
      data: {
        name: `det-p3-extra-${seq}`,
        materialId: world.material.id,
        detailNumber: 2,
        lengthM: new Prisma.Decimal("1.8000"),
        detailType: "POLKA",
        sort: "SORT1",
        prisadkaTorcevaya: true,
        prisadkaPloskost: false,
      },
    });
    await prismaA.productDetail.create({
      data: { productId: world.product.id, detailId: extra.id, quantity: 1 },
    });
    await prismaA.detailStock.create({
      data: {
        detailId: extra.id,
        torcevayaDone: true,
        ploskostDone: false,
        quantity: 7,
      },
    });
    await prismaA.detailStock.updateMany({
      where: { detailId: world.detail.id, torcevayaDone: true, ploskostDone: false },
      data: { quantity: { increment: 3 } },
    });
    await setShadowGate(true);
    const result = await editQty({
      operationId: op.id,
      targetLineId: null,
      expectedOldQuantity: op.productQty ?? 1,
      newQuantity: 2,
    });
    const row = await prismaA.productionOperationQuantityEdit.findUniqueOrThrow({
      where: { requestId: result.requestId },
    });
    const adj = parseQuantityEditPhysicalAdjustments(row.effectSnapshot);
    expect(adj.some((a) => a.targetType === "PRODUCT" && a.productId === world.product.id && a.quantityDelta === 1)).toBe(
      true,
    );
    expect(adj.some((a) => a.targetType === "DETAIL" && a.detailId === extra.id && a.quantityDelta === -2)).toBe(true);
    const productAdj = adj.find((a) => a.targetType === "PRODUCT");
    const extraAdj = adj.find((a) => a.targetType === "DETAIL" && a.detailId === extra.id);
    expect(productAdj?.quantityDelta).not.toBe((productAdj?.quantityDelta ?? 0) + (extraAdj?.quantityDelta ?? 0));
    await expectRetainedAdjustmentsMirrored(row);
  });

  it("OFF→ON replay is not backfill; ON→OFF replay is not duplicate; mismatch is REQUEST_ID_REUSE", async () => {
    const { op, line } = await seedTorcovka(`flip-rp-${seq}`);
    const requestId = `p3:offon:${op.id}`;
    const fingerprint = fingerprintFor(await loadOp(op.id), line.id);
    await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
      requestId,
      fingerprint,
    });
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    await setShadowGate(true);
    const replayOffOn = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
      requestId,
      fingerprint,
    });
    expect(replayOffOn.replayed).toBe(true);
    expect(await prismaA.inventoryMovement.count()).toBe(0);

    const { op: opOn, line: lineOn } = await seedTorcovka(`onoff-${seq}`);
    await setShadowGate(true);
    const onId = `p3:onoff:${opOn.id}`;
    const onFp = fingerprintFor(await loadOp(opOn.id), lineOn.id);
    await editQty({
      operationId: opOn.id,
      targetLineId: lineOn.id,
      expectedOldQuantity: lineOn.quantity,
      newQuantity: 1,
      requestId: onId,
      fingerprint: onFp,
    });
    const imOn = await prismaA.inventoryMovement.count({
      where: {
        causationId: (await prismaA.productionOperationQuantityEdit.findUniqueOrThrow({ where: { requestId: onId } }))
          .id,
      },
    });
    expect(imOn).toBeGreaterThan(0);
    await setShadowGate(false);
    const replayOnOff = await editQty({
      operationId: opOn.id,
      targetLineId: lineOn.id,
      expectedOldQuantity: lineOn.quantity,
      newQuantity: 1,
      requestId: onId,
      fingerprint: onFp,
    });
    expect(replayOnOff.replayed).toBe(true);
    expect(
      await prismaA.inventoryMovement.count({
        where: {
          causationId: (await prismaA.productionOperationQuantityEdit.findUniqueOrThrow({ where: { requestId: onId } }))
            .id,
        },
      }),
    ).toBe(imOn);

    await expect(
      editQty({
        operationId: opOn.id,
        targetLineId: lineOn.id,
        expectedOldQuantity: lineOn.quantity,
        newQuantity: 2,
        requestId: onId,
        fingerprint: onFp,
      }),
    ).rejects.toThrow(REQUEST_ID_REUSE);
    adminState.current = { ...adminState.current, id: "other-admin", name: "Other" };
    await prismaA.user.upsert({
      where: { id: "other-admin" },
      create: {
        id: "other-admin",
        email: "other@test.local",
        passwordHash: "x",
        name: "Other",
        role: "ADMIN",
      },
      update: {},
    });
    await expect(
      editQty({
        operationId: opOn.id,
        targetLineId: lineOn.id,
        expectedOldQuantity: lineOn.quantity,
        newQuantity: 1,
        requestId: onId,
        fingerprint: onFp,
      }),
    ).rejects.toThrow(REQUEST_ID_REUSE);
  });

  it("second legitimate edit with a new requestId gets a new quantityEdit causation", async () => {
    const { op, line } = await seedTorcovka(`second-${seq}`);
    await setShadowGate(true);
    const first = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
    });
    const afterFirst = await loadOp(op.id);
    const second = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: afterFirst.lines[0]!.quantity,
      newQuantity: 2,
    });
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.quantityEditId).not.toBe(first.quantityEditId);
    const rows = await prismaA.productionOperationQuantityEdit.findMany({
      where: { operationId: op.id },
      orderBy: { recordedAt: "asc" },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]!.id).not.toBe(rows[1]!.id);
    await expectRetainedAdjustmentsMirrored(rows[0]!);
    await expectRetainedAdjustmentsMirrored(rows[1]!);
    expect(await prismaA.inventoryMovement.count({ where: { causationId: rows[0]!.id } })).toBeGreaterThan(0);
    expect(await prismaA.inventoryMovement.count({ where: { causationId: rows[1]!.id } })).toBeGreaterThan(0);
  });

  it("missing/INACTIVE gate writes no IM; ACTIVE writes IM; malformed fails closed including replay", async () => {
    const missing = await seedTorcovka(`gate-${seq}`);
    await editQty({
      operationId: missing.op.id,
      targetLineId: missing.line.id,
      expectedOldQuantity: missing.line.quantity,
      newQuantity: 1,
    });
    expect(
      await prismaA.inventoryMovement.count({ where: { causationKind: "PRODUCTION_OPERATION_MUTATION" } }),
    ).toBe(0);

    const inact = await seedTorcovka(`gate-off-${seq}`);
    await setShadowGate(false);
    await editQty({
      operationId: inact.op.id,
      targetLineId: inact.line.id,
      expectedOldQuantity: inact.line.quantity,
      newQuantity: 1,
    });
    expect(
      await prismaA.inventoryMovement.count({ where: { causationKind: "PRODUCTION_OPERATION_MUTATION" } }),
    ).toBe(0);

    const active = await seedTorcovka(`gate-on-${seq}`);
    const replayOp = await seedTorcovka(`gate-bad-${seq}`);
    const newBad = await seedTorcovka(`gate-newbad-${seq}`);
    await setShadowGate(true);
    const on = await editQty({
      operationId: active.op.id,
      targetLineId: active.line.id,
      expectedOldQuantity: active.line.quantity,
      newQuantity: 1,
    });
    expect(
      await prismaA.inventoryMovement.count({
        where: { causationKind: "PRODUCTION_OPERATION_MUTATION", causationId: on.quantityEditId! },
      }),
    ).toBeGreaterThan(0);

    const badId = `p3:malformed:${replayOp.op.id}`;
    const badFp = fingerprintFor(await loadOp(replayOp.op.id), replayOp.line.id);
    await setShadowGate(false);
    await editQty({
      operationId: replayOp.op.id,
      targetLineId: replayOp.line.id,
      expectedOldQuantity: replayOp.line.quantity,
      newQuantity: 1,
      requestId: badId,
      fingerprint: badFp,
    });
    const mutationCountAfterReplayCommit = await prismaA.inventoryMovement.count({
      where: { causationKind: "PRODUCTION_OPERATION_MUTATION" },
    });
    await prismaA.setting.upsert({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
      create: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY, value: { version: 99, active: true } },
      update: { value: { version: 99, active: true } },
    });
    await expect(
      editQty({
        operationId: replayOp.op.id,
        targetLineId: replayOp.line.id,
        expectedOldQuantity: replayOp.line.quantity,
        newQuantity: 1,
        requestId: badId,
        fingerprint: badFp,
      }),
    ).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
    await expect(
      editQty({
        operationId: newBad.op.id,
        targetLineId: newBad.line.id,
        expectedOldQuantity: newBad.line.quantity,
        newQuantity: 1,
      }),
    ).rejects.toBeInstanceOf(InventoryMovementShadowWriteConfigError);
    expect((await loadOp(newBad.op.id)).lines[0]!.quantity).toBe(newBad.line.quantity);
    expect(await prismaA.productionOperationQuantityEdit.count({ where: { operationId: newBad.op.id } })).toBe(0);
    expect(
      await prismaA.inventoryMovement.count({ where: { causationKind: "PRODUCTION_OPERATION_MUTATION" } }),
    ).toBe(mutationCountAfterReplayCommit);
  });

  it("OFF→ON gate flip waits; command that started OFF commits without IM", async () => {
    const { op, line } = await seedTorcovka(`flip-off-${seq}`);
    const hold = { release: () => {}, ready: false };
    const holding = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      await lockProductionOperations(tx, [op.id]);
      hold.ready = true;
      await holding;
    }, txOpts);
    await waitUntil(() => hold.ready, "operation held");
    const submit = editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
    });
    await waitUntil(async () => (await advisoryCounts()).sharedGranted >= 1, "SHARED granted");
    let gateFinished = false;
    const gateOn = prismaC
      .$transaction(async (tx) => {
        await setInventoryMovementShadowWriteGate(tx, true);
        gateFinished = true;
        return true;
      }, txOpts)
      .catch((err) => err as Error);
    await waitUntil(async () => (await advisoryCounts()).exclusiveWaiting >= 1, "EXCLUSIVE waiting");
    expect(gateFinished).toBe(false);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    hold.release();
    await holder;
    await submit;
    await gateOn;
    expect(gateFinished).toBe(true);
    expect((await loadOp(op.id)).lines[0]!.quantity).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    const gate = await prismaA.setting.findUniqueOrThrow({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
    });
    expect(gate.value).toMatchObject({ version: 1, active: true });
  });

  it("ON→OFF gate flip waits; command that started ON commits with IM", async () => {
    const { op, line } = await seedTorcovka(`flip-on-${seq}`);
    await setShadowGate(true);
    const hold = { release: () => {}, ready: false };
    const holding = new Promise<void>((resolve) => {
      hold.release = resolve;
    });
    const holder = prismaB.$transaction(async (tx) => {
      await lockProductionOperations(tx, [op.id]);
      hold.ready = true;
      await holding;
    }, txOpts);
    await waitUntil(() => hold.ready, "operation held");
    const submit = editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
    });
    await waitUntil(async () => (await advisoryCounts()).sharedGranted >= 1, "SHARED granted");
    let gateFinished = false;
    const gateOff = prismaC
      .$transaction(async (tx) => {
        await setInventoryMovementShadowWriteGate(tx, false);
        gateFinished = true;
        return true;
      }, txOpts)
      .catch((err) => err as Error);
    await waitUntil(async () => (await advisoryCounts()).exclusiveWaiting >= 1, "EXCLUSIVE waiting");
    expect(gateFinished).toBe(false);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    hold.release();
    await holder;
    await submit;
    await gateOff;
    expect(gateFinished).toBe(true);
    expect((await loadOp(op.id)).lines[0]!.quantity).toBe(1);
    expect(await prismaA.inventoryMovement.count()).toBeGreaterThan(0);
    const gate = await prismaA.setting.findUniqueOrThrow({
      where: { key: INVENTORY_MOVEMENT_SHADOW_WRITE_KEY },
    });
    expect(gate.value).toMatchObject({ version: 1, active: false });
  });

  it("writer-stage INSERT reject rolls back stock, quantity-edit, IM, and ChangeLog", async () => {
    const { op, line } = await seedTorcovka(`rb-${seq}`);
    await setShadowGate(true);
    adminState.current = { ...adminState.current, name: REJECT_ACTOR };
    const blankBefore = await prismaA.blankStock.findFirstOrThrow();
    const logsBefore = await prismaA.changeLog.count();
    await expect(
      editQty({
        operationId: op.id,
        targetLineId: line.id,
        expectedOldQuantity: line.quantity,
        newQuantity: 1,
      }),
    ).rejects.toThrow(/integrity reject InventoryMovement insert/);
    expect((await loadOp(op.id)).lines[0]!.quantity).toBe(line.quantity);
    expect((await prismaA.blankStock.findUniqueOrThrow({ where: { id: blankBefore.id } })).quantity).toBe(
      blankBefore.quantity,
    );
    expect(await prismaA.productionOperationQuantityEdit.count()).toBe(0);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect(await prismaA.changeLog.count()).toBe(logsBefore);
  });

  it("retained snapshot validation fails closed without inserting movements", async () => {
    await setShadowGate(true);
    const actor = userMovementActorFromAdmin(adminState.current);
    const base = {
      id: "qedit-invalid",
      requestId: "req-invalid",
      operationId: "op-invalid",
      adminUserId: "integrity-admin",
      actorDisplaySnapshot: "Admin",
      operationType: "TORCOVKA" as const,
      targetLineId: "line-1",
      expectedOldQuantity: 2,
      newQuantity: 1,
      recordedAt: new Date("2026-09-21T12:00:00.000Z"),
    };
    const cases: unknown[] = [
      { v: 2, physicalAdjustments: [] },
      { v: 1, physicalAdjustments: [{ targetType: "RAIL_LOT", railLotId: "lot-1", quantityDelta: 1 }] },
      {
        v: 1,
        physicalAdjustments: [{ targetType: "BLANK", materialId: "m", quantityDelta: 1 }],
      },
      {
        v: 1,
        physicalAdjustments: [
          {
            targetType: "BLANK",
            materialId: "m",
            lengthM: "1.8000",
            detailType: "POLKA",
            sort: "SORT1",
            quantityDelta: 0,
          },
        ],
      },
      {
        v: 1,
        physicalAdjustments: [
          {
            targetType: "BLANK",
            materialId: "m",
            lengthM: "1.8000",
            detailType: "POLKA",
            sort: "SORT1",
            quantityDelta: 1.5,
          },
        ],
      },
      {
        v: 1,
        physicalAdjustments: [
          {
            targetType: "BLANK",
            materialId: "m",
            lengthM: "1.8000",
            detailType: "POLKA",
            sort: "SORT1",
            quantityDelta: 1,
          },
          {
            targetType: "BLANK",
            materialId: "m",
            lengthM: "1.8000",
            detailType: "POLKA",
            sort: "SORT1",
            quantityDelta: -1,
          },
        ],
      },
    ];
    for (const effectSnapshot of cases) {
      expect(() => parseQuantityEditPhysicalAdjustments(effectSnapshot)).toThrow(
        QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID,
      );
      await expect(
        prismaA.$transaction(async (tx) => {
          await appendQuantityEditShadowMovements(tx, {
            shadowWriteActive: true,
            actor,
            quantityEdit: { ...base, effectSnapshot },
          });
        }, txOpts),
      ).rejects.toThrow(QUANTITY_EDIT_SHADOW_SNAPSHOT_INVALID);
    }
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });

  it("TORCOVKA ACTIVE + SHADOW ON mirrors the committed physical delta", async () => {
    const world = await seedWorld(`t-act-${seq}`);
    await prismaA.railLot.update({
      where: { id: world.lot.id },
      data: {
        initialValue: new Prisma.Decimal("10000"),
        remainingValue: new Prisma.Decimal("10000"),
      },
    });
    await setCostFlowActive(true);
    await submitTorcovka({
      employeeId: world.emp.id,
      batchId: world.batch.id,
      railLotId: world.lot.id,
      railsTaken: 2,
      clientRequestId: `test:p3:tor-act:${seq}`,
      picks: [{ lengthM: 1.8, sort: "SORT1", quantity: 2 }],
    });
    const op = await prismaA.productionOperation.findFirstOrThrow({
      where: { type: "TORCOVKA", batchId: world.batch.id },
      include: { lines: { orderBy: { id: "asc" } } },
    });
    const line = op.lines[0]!;
    expect(op.consumedRawValue).not.toBeNull();
    await setShadowGate(true);
    const result = await editQty({
      operationId: op.id,
      targetLineId: line.id,
      expectedOldQuantity: line.quantity,
      newQuantity: 1,
    });
    const row = await prismaA.productionOperationQuantityEdit.findUniqueOrThrow({
      where: { requestId: result.requestId },
    });
    await expectRetainedAdjustmentsMirrored(row);
  });

  it("UPAKOVKA ACTIVE remains fail-closed with ARCH-P1-001 open and no IM", async () => {
    const { world, op } = await seedUpakovka(`u-act-${seq}`, 1);
    await setCostFlowActive(true);
    await setShadowGate(true);
    const productBefore = await prismaA.productStock.findUnique({ where: { productId: world.product.id } });
    await expect(
      editQty({
        operationId: op.id,
        targetLineId: null,
        expectedOldQuantity: op.productQty ?? 1,
        newQuantity: 2,
      }),
    ).rejects.toThrow(QUANTITY_EDIT_UPAKOVKA_COST_FLOW_NOT_READY);
    expect(await prismaA.productionOperationQuantityEdit.count()).toBe(0);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
    expect(await quantityChangeLogs(op.id)).toHaveLength(0);
    expect((await loadOp(op.id)).productQty).toBe(op.productQty);
    expect(await prismaA.productStock.findUnique({ where: { productId: world.product.id } })).toEqual(productBefore);
  });

  it("HOURS remains isolated from Package 3 even when SHADOW is ACTIVE", async () => {
    const world = await seedWorld(`hours-${seq}`);
    await setShadowGate(true);
    await submitHours(world.emp.id, 2, `test:p3:hours:${seq}`);
    const op = await prismaA.productionOperation.findFirstOrThrow({ where: { type: "HOURS" } });
    const updated = await updateProductionLineQuantity(op.id, 0, 3);
    expect(updated.quantity).toBe(3);
    expect(await prismaA.productionOperationQuantityEdit.count()).toBe(0);
    expect(await prismaA.inventoryMovement.count()).toBe(0);
  });
});
