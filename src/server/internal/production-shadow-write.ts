import { Prisma } from "@prisma/client";
import { appendShadowInventoryMovements } from "@/server/internal/inventory-movement-shadow-gateway";
import type { MovementActorSnapshot } from "@/server/internal/inventory-movement-actor";
import type { ProductionShadowPlan } from "@/server/internal/production-movement-plan";

export const PRODUCTION_SHADOW_GATE_INVARIANT_VIOLATION =
  "PRODUCTION_SHADOW_GATE_INVARIANT_VIOLATION";

/** Gateway omits quantityDelta=0; expected insert count is the nonzero mapped set. */
export function expectedProductionShadowInsertCount(
  effects: readonly { quantityDelta: number }[],
): number {
  return effects.filter((effect) => effect.quantityDelta !== 0).length;
}

/**
 * Fail closed if an ACTIVE production writer observes an inactive gateway
 * result or a mismatched insert count. Rolls back the same TX.
 * Legal zero-effect operations may accept 0 → 0.
 */
export function assertProductionShadowGatewayResult(input: {
  result: { gateActive: boolean; inserted: number };
  expectedInserted: number;
}): void {
  if (input.result.gateActive && input.result.inserted === input.expectedInserted) return;
  throw new Error(PRODUCTION_SHADOW_GATE_INVARIANT_VIOLATION);
}

export async function appendProductionShadowMovements(
  tx: Prisma.TransactionClient,
  input: {
    shadowWriteActive: boolean;
    actor: MovementActorSnapshot;
    occurredAt: Date;
    operationId: string;
    plan: ProductionShadowPlan;
  },
): Promise<void> {
  if (!input.shadowWriteActive) return;
  const expectedInserted = expectedProductionShadowInsertCount(input.plan.effects);
  const result = await appendShadowInventoryMovements(tx, {
    effectiveAt: input.occurredAt,
    actor: input.actor,
    causation: {
      causationKind: "PRODUCTION_OPERATION",
      causationId: input.operationId,
      causationSnapshot: input.plan.causationSnapshot as Prisma.InputJsonValue,
    },
    effects: input.plan.effects,
  });
  assertProductionShadowGatewayResult({ result, expectedInserted });
}
