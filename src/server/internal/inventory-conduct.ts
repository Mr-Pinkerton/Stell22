import type { Prisma } from "@prisma/client";
import { writeChangeLog } from "@/server/change-log";
import type { UnitCostSnapshot } from "@/server/cost";
import { getUnitCostSnapshot } from "@/server/internal/cost";
import {
  applyActiveInventoryConduct,
  lockActiveInventoryWriteSet,
} from "@/server/internal/cost-flow-downstream";
import { isCostFlowActive } from "@/server/internal/cost-flow-state";
import {
  ALREADY_CONDUCTED,
  applyInactiveInventoryPhysicalEffects,
  assertLiveEqualsAccounted,
  assertNotLegacyInventoryDraft,
  deriveInventoryPhysicalEffects,
  inventoryDeviationSumDecimal,
  loadInventoryPhysicalPlanInput,
  lockInventoryForUpdate,
  lockInventoryStockRows,
} from "@/server/internal/inventory-integrity";
import type { MovementActorSnapshot } from "@/server/internal/inventory-movement-actor";
import { isInventoryMovementShadowWriteActiveForWriter } from "@/server/internal/inventory-movement-shadow-write";

export const INVENTORY_SHADOW_WRITER_NOT_CONNECTED = "INVENTORY_SHADOW_WRITER_NOT_CONNECTED";
export const INVENTORY_DUAL_ACTIVE_UNSUPPORTED = "INVENTORY_DUAL_ACTIVE_UNSUPPORTED";

export type ConductInventoryUserActor = Extract<MovementActorSnapshot, { actorKind: "USER" }>;

export type InventoryShadowSafetyDecision =
  | { action: "proceed" }
  | { action: "fail"; error: typeof INVENTORY_SHADOW_WRITER_NOT_CONNECTED }
  | { action: "fail"; error: typeof INVENTORY_DUAL_ACTIVE_UNSUPPORTED };

type ConductedInventory = Prisma.InventoryGetPayload<{ include: { lines: true } }>;

/**
 * Inventory SHADOW safety before any business/stock lock or projection write.
 * SHADOW ACTIVE + no writer → fail closed. Dual-active → distinct fail closed.
 * Does not mutate either Setting.
 */
export function decideInventoryShadowSafety(input: {
  shadowWriteActive: boolean;
  costFlowActive: boolean;
}): InventoryShadowSafetyDecision {
  if (!input.shadowWriteActive) return { action: "proceed" };
  if (input.costFlowActive) {
    return { action: "fail", error: INVENTORY_DUAL_ACTIVE_UNSUPPORTED };
  }
  return { action: "fail", error: INVENTORY_SHADOW_WRITER_NOT_CONNECTED };
}

export async function evaluateInventoryShadowSafety(
  tx: Prisma.TransactionClient,
): Promise<{ costFlowActive: boolean }> {
  const shadowWriteActive = await isInventoryMovementShadowWriteActiveForWriter(tx);
  const costFlowActive = await isCostFlowActive(tx);
  const decision = decideInventoryShadowSafety({ shadowWriteActive, costFlowActive });
  if (decision.action === "fail") throw new Error(decision.error);
  return { costFlowActive };
}

function requireConductUserActor(actor: MovementActorSnapshot): ConductInventoryUserActor {
  if (actor.actorKind !== "USER") {
    throw new Error("Inventory conduct requires a retained USER actor");
  }
  return actor;
}

function num(value: Prisma.Decimal | number | null): number {
  if (value == null) return 0;
  return typeof value === "object" && "toNumber" in value ? value.toNumber() : Number(value);
}

function unitCostFromSnapshot(
  valuation: UnitCostSnapshot,
  refType: string,
  refId: string,
): number {
  if (refType === "PRODUCT") return valuation.productFull.get(refId) ?? 0;
  if (refType === "NOMENCLATURE") return valuation.nomenclatureUnit.get(refId) ?? 0;
  if (refType === "BLANK") return valuation.blankUnit.get(refId) ?? 0;
  return valuation.detailUnit.get(refId) ?? 0;
}

/**
 * Transaction-local Inventory conduct core.
 * Caller captures authenticated admin OUTSIDE the TX and passes the USER actor.
 * Does not insert InventoryMovement. The actor is the retained causal USER for
 * ChangeLog and the future SHADOW writer PR.
 */
export async function conductInventoryInTransaction(
  tx: Prisma.TransactionClient,
  input: { docId: string; actor: MovementActorSnapshot },
): Promise<ConductedInventory> {
  const actor = requireConductUserActor(input.actor);
  const { costFlowActive } = await evaluateInventoryShadowSafety(tx);

  const locked = await lockInventoryForUpdate(tx, input.docId);
  if (!locked) throw new Error("Инвентаризация не найдена");
  if (locked.status !== "DRAFT") throw new Error(ALREADY_CONDUCTED);

  const doc = await tx.inventory.findUnique({
    where: { id: input.docId },
    include: { lines: true },
  });
  if (!doc) throw new Error("Инвентаризация не найдена");

  await assertNotLegacyInventoryDraft(tx, doc.lines);

  if (costFlowActive) {
    await lockActiveInventoryWriteSet(tx, doc.lines);
  } else {
    await lockInventoryStockRows(tx, doc.lines);
  }
  await assertLiveEqualsAccounted(tx, doc.lines);

  const effects = deriveInventoryPhysicalEffects(
    await loadInventoryPhysicalPlanInput(tx, doc.lines),
  );

  const valuation = await getUnitCostSnapshot();

  if (costFlowActive) {
    await applyActiveInventoryConduct(tx, doc);
  } else {
    await applyInactiveInventoryPhysicalEffects(tx, effects);
  }

  for (const line of doc.lines) {
    const deviation = line.actualQty - line.accountedQty;
    const deviationSum = inventoryDeviationSumDecimal(
      deviation,
      unitCostFromSnapshot(valuation, line.refType, line.refId),
    );

    await tx.inventoryLine.update({
      where: { id: line.id },
      data: { deviation, deviationSum },
    });
  }

  const flipped = await tx.inventory.updateMany({
    where: { id: input.docId, status: "DRAFT" },
    data: { status: "CONDUCTED", date: new Date() },
  });
  if (flipped.count !== 1) throw new Error(ALREADY_CONDUCTED);

  await writeChangeLog(
    {
      entity: "Inventory",
      entityId: input.docId,
      userId: actor.userId,
      oldValues: { status: "DRAFT" },
      newValues: {
        status: "CONDUCTED",
        lines: doc.lines.length,
        actorKind: actor.actorKind,
        actorDisplaySnapshot: actor.actorDisplaySnapshot,
      },
    },
    tx,
  );
  for (const line of doc.lines) {
    const newValues: Record<string, unknown> = {
      inventoryId: input.docId,
      refType: line.refType,
      refId: line.refId,
      after: line.actualQty,
      delta: line.actualQty - line.accountedQty,
    };
    if (line.refType === "BLANK") {
      const blank = await tx.blankStock.findUnique({ where: { id: line.refId } });
      newValues.blankStockId = line.refId;
      if (blank) {
        newValues.materialId = blank.materialId;
        newValues.lengthM = num(blank.lengthM);
        newValues.detailType = blank.detailType;
        newValues.sort = blank.sort;
        newValues.before = line.accountedQty;
        newValues.after = line.actualQty;
        newValues.delta = line.actualQty - line.accountedQty;
      }
    }
    await writeChangeLog(
      {
        entity: "InventoryLine",
        entityId: line.id,
        userId: actor.userId,
        oldValues: {
          inventoryId: input.docId,
          refType: line.refType,
          refId: line.refId,
          before: line.accountedQty,
        },
        newValues,
      },
      tx,
    );
  }

  return tx.inventory.findUniqueOrThrow({
    where: { id: input.docId },
    include: { lines: true },
  });
}
