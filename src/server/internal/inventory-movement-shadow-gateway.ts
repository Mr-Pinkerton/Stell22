import { randomUUID } from "node:crypto";
import type {
  InventoryMovementCausationKind,
  InventoryMovementKind,
  Prisma,
} from "@prisma/client";
import {
  movementActorColumns,
  type MovementActorSnapshot,
} from "@/server/internal/inventory-movement-actor";
import {
  assertP2ShadowMovementEffect,
  canonicalizeMovementTarget,
  compareEffectKey,
  effectKeyV1,
  InventoryMovementIdentityError,
  type MovementEffect,
} from "@/server/internal/inventory-movement-identity";
import { utcNaiveTimestampString } from "@/server/internal/inventory-movement-time";
import { assertInventoryMovementShadowTransactionClient } from "@/server/internal/inventory-movement-shadow-coordination";
import { isInventoryMovementShadowWriteActiveForWriter } from "@/server/internal/inventory-movement-shadow-write";

export type MovementCausationInput = {
  causationKind: InventoryMovementCausationKind;
  causationId: string;
  causationSnapshot?: Prisma.InputJsonValue | null;
  reason?: string | null;
};

export type AppendShadowInventoryMovementsInput = {
  effectiveAt: Date;
  actor: MovementActorSnapshot;
  causation: MovementCausationInput;
  effects: readonly MovementEffect[];
};

export type AppendShadowInventoryMovementsResult = {
  gateActive: boolean;
  inserted: number;
};

export class InventoryMovementShadowGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InventoryMovementShadowGatewayError";
  }
}

type PreparedRow = {
  effectKey: string;
  kind: InventoryMovementKind;
  quantityDelta: number;
  canonical: ReturnType<typeof canonicalizeMovementTarget>;
};

function requireNonblank(value: string, message: string): string {
  if (!value.trim()) throw new InventoryMovementShadowGatewayError(message);
  return value;
}

function prepareEffects(effects: readonly MovementEffect[]): PreparedRow[] {
  const prepared: PreparedRow[] = [];
  for (const effect of effects) {
    if (!Number.isInteger(effect.quantityDelta) || !Number.isFinite(effect.quantityDelta)) {
      throw new InventoryMovementShadowGatewayError("quantityDelta must be a finite integer");
    }
    try {
      assertP2ShadowMovementEffect(effect);
    } catch (err) {
      if (err instanceof InventoryMovementIdentityError) {
        throw new InventoryMovementShadowGatewayError(err.message);
      }
      throw err;
    }
    if (effect.quantityDelta === 0) continue;
    const canonical = canonicalizeMovementTarget(effect.target);
    let effectKey: string;
    try {
      effectKey = effectKeyV1(effect.role, canonical.targetHashV1, effect.qualifier);
    } catch (err) {
      if (err instanceof InventoryMovementIdentityError) {
        throw new InventoryMovementShadowGatewayError(err.message);
      }
      throw err;
    }
    prepared.push({
      effectKey,
      kind: effect.kind,
      quantityDelta: effect.quantityDelta,
      canonical,
    });
  }
  prepared.sort((a, b) => compareEffectKey(a.effectKey, b.effectKey));
  return prepared;
}

/**
 * Infrastructure-only SHADOW InventoryMovement gateway.
 * Not wired to any physical mutation path in P2-GUARD/CI.
 */
export async function appendShadowInventoryMovements(
  tx: Prisma.TransactionClient,
  input: AppendShadowInventoryMovementsInput,
): Promise<AppendShadowInventoryMovementsResult> {
  assertInventoryMovementShadowTransactionClient(tx);
  const gateActive = await isInventoryMovementShadowWriteActiveForWriter(tx);
  if (!gateActive) {
    return { gateActive: false, inserted: 0 };
  }

  const actor = movementActorColumns(input.actor);
  const causationId = requireNonblank(input.causation.causationId, "causationId is required");
  const reason = input.causation.reason?.trim() ? input.causation.reason : null;
  if (input.causation.causationKind === "MANUAL" && !reason) {
    throw new InventoryMovementShadowGatewayError("MANUAL causation requires a reason");
  }
  if (input.causation.causationKind === "SUPPLY" && input.causation.causationSnapshot == null) {
    throw new InventoryMovementShadowGatewayError("SUPPLY causation requires causationSnapshot");
  }

  const effectiveAtNaive = utcNaiveTimestampString(input.effectiveAt);
  const rows = prepareEffects(input.effects);
  let inserted = 0;
  for (const row of rows) {
    const id = randomUUID();
    await tx.$executeRaw`
      INSERT INTO "InventoryMovement" (
        "id","kind","stockDomain","quantityDelta","authority","epochId",
        "causationKind","causationId","effectKey","causationSnapshot",
        "actorKind","userId","employeeId","systemActorKey","actorDisplaySnapshot","reason",
        "effectiveAt","reversalOfMovementId",
        "railLotId","materialId","lengthM","detailType","sort",
        "detailId","torcevayaDone","ploskostDone","nomenclatureId","productId",
        "targetSnapshot"
      ) VALUES (
        ${id},
        ${row.kind}::"InventoryMovementKind",
        ${row.canonical.stockDomain}::"InventoryStockDomain",
        ${row.quantityDelta},
        'SHADOW'::"InventoryMovementAuthority",
        NULL,
        ${input.causation.causationKind}::"InventoryMovementCausationKind",
        ${causationId},
        ${row.effectKey},
        ${input.causation.causationSnapshot == null ? null : JSON.stringify(input.causation.causationSnapshot)}::jsonb,
        ${actor.actorKind}::"InventoryMovementActorKind",
        ${actor.userId},
        ${actor.employeeId},
        ${actor.systemActorKey},
        ${actor.actorDisplaySnapshot},
        ${reason},
        ${effectiveAtNaive}::timestamp,
        NULL,
        ${row.canonical.railLotId},
        ${row.canonical.materialId},
        ${row.canonical.lengthMFixed4}::decimal,
        ${row.canonical.detailType}::"RailType",
        ${row.canonical.sort}::"Sort",
        ${row.canonical.detailId},
        ${row.canonical.torcevayaDone},
        ${row.canonical.ploskostDone},
        ${row.canonical.nomenclatureId},
        ${row.canonical.productId},
        ${JSON.stringify(row.canonical.targetSnapshot)}::jsonb
      )
    `;
    inserted += 1;
  }
  return { gateActive: true, inserted };
}
