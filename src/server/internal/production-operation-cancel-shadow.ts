import type { Prisma } from "@prisma/client";
import type { MovementActorSnapshot } from "@/server/internal/inventory-movement-actor";
import { movementActorColumns } from "@/server/internal/inventory-movement-actor";
import {
  type MovementEffect,
} from "@/server/internal/inventory-movement-identity";
import { appendShadowInventoryMovements } from "@/server/internal/inventory-movement-shadow-gateway";

export const CANCEL_SHADOW_GATE_INVARIANT_VIOLATION = "CANCEL_SHADOW_GATE_INVARIANT_VIOLATION";

function requireUserActor(
  actor: MovementActorSnapshot,
): Extract<MovementActorSnapshot, { actorKind: "USER" }> {
  if (actor.actorKind !== "USER") {
    throw new Error("Аннулирование требует администратора");
  }
  return actor;
}

/** Quantity adjustments for one annulment. Replay must not call this. */
export async function appendCancellationShadowMovements(
  tx: Prisma.TransactionClient,
  input: {
    shadowWriteActive: boolean;
    actor: MovementActorSnapshot;
    cancellation: {
      id: string;
      requestId: string;
      adminUserId: string;
      operationId: string;
      recordedAt: Date;
      reason: string;
    };
    effects: readonly MovementEffect[];
  },
): Promise<void> {
  if (!input.shadowWriteActive || input.effects.length === 0) return;
  const actor = requireUserActor(input.actor);
  if (movementActorColumns(actor).userId !== input.cancellation.adminUserId) {
    throw new Error("Аннулирование: автор команды не совпал");
  }
  const result = await appendShadowInventoryMovements(tx, {
    effectiveAt: input.cancellation.recordedAt,
    actor,
    causation: {
      causationKind: "PRODUCTION_OPERATION_MUTATION",
      causationId: input.cancellation.id,
      reason: input.cancellation.reason,
      causationSnapshot: {
        v: 1,
        type: "CANCEL",
        commandId: input.cancellation.id,
        requestId: input.cancellation.requestId,
        operationId: input.cancellation.operationId,
      },
    },
    effects: input.effects,
  });
  if (result.gateActive === true && result.inserted === input.effects.length) return;
  throw new Error(CANCEL_SHADOW_GATE_INVARIANT_VIOLATION);
}
