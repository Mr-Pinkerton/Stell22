import { Prisma } from "@prisma/client";
import { allocatePackageCode } from "@/lib/package-code";
import {
  PACKAGE_EDIT_REASON_REQUIRED,
  STALE_PACKAGE_EDIT,
  canonicalPackageEditReason,
  packageSetFingerprint,
  planBatchPackageEdit,
  type PackageLotDraft,
  type PackageLotSnapshot,
} from "@/lib/batch-package-edit";
import type { RailType, Sort } from "@/types/domain";
import { writeChangeLog } from "@/server/change-log";
import { isCostFlowActive } from "@/server/internal/cost-flow-state";
import type { MovementActorSnapshot } from "@/server/internal/inventory-movement-actor";
import { isInventoryMovementShadowWriteActiveForWriter } from "@/server/internal/inventory-movement-shadow-write";
import {
  PURCHASE_REQUEST_ID_REUSE,
  acquirePurchaseCommandRequestLock,
} from "@/server/internal/purchase-command-identity";
import { appendBatchPackageEditShadowMovements } from "@/server/internal/raw-purchase-shadow-write";

export type BatchPackageEditValues = {
  name: string;
  materialId: string;
  purchaseDate: string | null;
  purchaseCost: number | null;
  priceSort1: number | null;
  priceSort2: number | null;
  note: string;
  rails: PackageLotDraft[];
  packageEditReason?: string;
  expectedPackageFingerprint?: string;
};

export type BatchPackageEditOutcome = {
  reallocate: boolean;
  replayed: boolean;
};

function stableJson(value: unknown): string {
  const sortValue = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sortValue);
    if (input && typeof input === "object") {
      const rec = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(rec).sort()) out[key] = sortValue(rec[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(sortValue(value));
}

function requestSnapshot(input: {
  batchId: string;
  reason: string;
  fingerprint: string;
  values: BatchPackageEditValues;
}) {
  const rails = input.values.rails
    .map((rail) => ({
      id: rail.id?.trim().startsWith("draft-") ? null : (rail.id?.trim() || null),
      mode: rail.mode,
      lengthM: rail.lengthM,
      railType: rail.railType,
      sort: rail.sort,
      quantity: rail.quantity,
      rows: rail.rows ?? null,
      layers: rail.layers ?? null,
    }))
    .sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  return {
    v: 1,
    batchId: input.batchId,
    reason: input.reason,
    fingerprint: input.fingerprint,
    name: input.values.name.trim(),
    materialId: input.values.materialId,
    purchaseDate: input.values.purchaseDate,
    purchaseCost: input.values.purchaseCost ?? 0,
    priceSort1: input.values.priceSort1 ?? 0,
    priceSort2: input.values.priceSort2 ?? 0,
    note: input.values.note.trim(),
    rails,
  };
}

function numLength(value: Prisma.Decimal | number | string): string {
  return typeof value === "object" && "toString" in value ? value.toString() : String(value);
}

/**
 * Applies the rail-package half of an admin batch edit.
 * Caller already holds Deal → RailLot → Batch locks.
 */
export async function applyBatchPackageEditInTx(
  tx: Prisma.TransactionClient,
  input: {
    actor: MovementActorSnapshot;
    adminUserId: string;
    batchId: string;
    requestId: string;
    values: BatchPackageEditValues;
  },
): Promise<BatchPackageEditOutcome> {
  const shadowWriteActive = await isInventoryMovementShadowWriteActiveForWriter(tx);
  await acquirePurchaseCommandRequestLock(tx, "batch-edit", input.requestId);
  const reason = canonicalPackageEditReason(input.values.packageEditReason ?? "");
  if (!reason) throw new Error(PACKAGE_EDIT_REASON_REQUIRED);
  const expectedFingerprint = input.values.expectedPackageFingerprint?.trim() ?? "";
  if (!expectedFingerprint) throw new Error(STALE_PACKAGE_EDIT);

  const incoming = requestSnapshot({
    batchId: input.batchId,
    reason,
    fingerprint: expectedFingerprint,
    values: input.values,
  });
  const existing = await tx.batchPackageEditCommand.findUnique({
    where: { requestId: input.requestId },
  });
  if (existing) {
    if (existing.adminUserId !== input.adminUserId || stableJson(existing.requestSnapshot) !== stableJson(incoming)) {
      throw new Error(PURCHASE_REQUEST_ID_REUSE);
    }
    return { reallocate: false, replayed: true };
  }

  const [lots, operations] = await Promise.all([
    tx.railLot.findMany({ where: { batchId: input.batchId } }),
    tx.productionOperation.findMany({
      where: { batchId: input.batchId, railLotId: { not: null } },
      select: { railLotId: true, cancelledAt: true },
    }),
  ]);
  const operationCount = new Map<string, { all: number; active: number }>();
  for (const op of operations) {
    if (!op.railLotId) continue;
    const cur = operationCount.get(op.railLotId) ?? { all: 0, active: 0 };
    cur.all += 1;
    if (!op.cancelledAt) cur.active += 1;
    operationCount.set(op.railLotId, cur);
  }
  const snapshots: PackageLotSnapshot[] = lots.map((lot) => {
    const counts = operationCount.get(lot.id) ?? { all: 0, active: 0 };
    return {
      id: lot.id,
      lengthM: numLength(lot.lengthM),
      railType: lot.railType as RailType,
      sort: lot.sort as Sort,
      isPackage: lot.isPackage,
      quantity: lot.quantity,
      remainingQuantity: lot.remainingQuantity,
      rows: lot.rows,
      layers: lot.layers,
      operationCount: counts.all,
      activeOperationCount: counts.active,
    };
  });
  const fingerprint = packageSetFingerprint(snapshots);
  if (fingerprint !== expectedFingerprint) throw new Error(STALE_PACKAGE_EDIT);

  const batch = await tx.batch.findUnique({ where: { id: input.batchId }, select: { frozenAt: true } });
  if (!batch) throw new Error("Партия не найдена");
  const costFlowActive = await isCostFlowActive(tx);
  const plan = planBatchPackageEdit({
    frozen: batch.frozenAt != null,
    costFlowActive,
    lots: snapshots,
    drafts: input.values.rails,
  });

  const deltas: Array<{ railLotId: string; quantityDelta: number }> = [];
  const beforeById = new Map(snapshots.map((lot) => [lot.id, lot]));
  for (const update of plan.updates) {
    const before = beforeById.get(update.id);
    if (!before) throw new Error(STALE_PACKAGE_EDIT);
    deltas.push({ railLotId: update.id, quantityDelta: update.remainingQuantity - before.remainingQuantity });
    await tx.railLot.update({
      where: { id: update.id },
      data: {
        lengthM: new Prisma.Decimal(update.lengthM),
        railType: update.railType,
        sort: update.sort,
        isPackage: update.isPackage,
        quantity: update.quantity,
        remainingQuantity: update.remainingQuantity,
        rows: update.rows,
        layers: update.layers,
      },
    });
  }
  for (const id of plan.deletes) {
    const before = beforeById.get(id);
    if (!before) throw new Error(STALE_PACKAGE_EDIT);
    deltas.push({ railLotId: id, quantityDelta: -before.remainingQuantity });
    await tx.railLot.delete({ where: { id } });
  }

  const usedCodes = new Set(
    (
      await tx.railLot.findMany({
        where: { code: { not: null } },
        select: { code: true },
      })
    ).map((row) => row.code as string),
  );
  const createdIds: string[] = [];
  for (const draft of plan.creates) {
    const created = await tx.railLot.create({
      data: {
        batchId: input.batchId,
        lengthM: new Prisma.Decimal(draft.lengthM),
        railType: draft.railType,
        sort: draft.sort,
        isPackage: draft.mode === "package",
        code:
          draft.mode === "package"
            ? allocatePackageCode(draft.lengthM, draft.quantity, draft.sort, usedCodes)
            : null,
        rows: draft.rows ?? null,
        layers: draft.layers ?? null,
        quantity: draft.quantity,
        remainingQuantity: draft.quantity,
      },
    });
    createdIds.push(created.id);
    deltas.push({ railLotId: created.id, quantityDelta: draft.quantity });
  }

  const effectSnapshot = {
    v: 1,
    updates: plan.updates.map((update) => ({
      id: update.id,
      quantity: update.quantity,
      remainingQuantity: update.remainingQuantity,
      lengthM: update.lengthM,
      railType: update.railType,
      sort: update.sort,
      preserveMoney: update.preserveMoney,
    })),
    deletes: plan.deletes,
    creates: createdIds,
    deltas,
  };
  const command = await tx.batchPackageEditCommand.create({
    data: {
      requestId: input.requestId,
      batchId: input.batchId,
      adminUserId: input.adminUserId,
      reason,
      requestSnapshot: incoming as Prisma.InputJsonValue,
      effectSnapshot: effectSnapshot as Prisma.InputJsonValue,
    },
  });
  await appendBatchPackageEditShadowMovements(tx, {
    shadowWriteActive,
    actor: input.actor,
    command: { ...command, batchId: input.batchId },
    deltas,
  });
  await writeChangeLog(
    {
      entity: "Batch",
      entityId: input.batchId,
      userId: input.adminUserId,
      oldValues: {
        packages: snapshots.map((lot) => ({
          id: lot.id,
          quantity: lot.quantity,
          remainingQuantity: lot.remainingQuantity,
          lengthM: lot.lengthM,
          railType: lot.railType,
          sort: lot.sort,
        })),
      },
      newValues: {
        reason,
        requestId: input.requestId,
        commandId: command.id,
        packages: effectSnapshot.updates,
        created: createdIds,
        deleted: plan.deletes,
      },
    },
    tx,
  );
  return { reallocate: plan.reallocate, replayed: false };
}
