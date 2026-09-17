/**
 * Controlled SHADOW purge for InventoryMovement (R-10).
 * Maintenance only: no UI, no API, no Server Action.
 * Does not run against production in the PSR-P2 preconditions task.
 *
 * Usage:
 *   npx tsx scripts/reset-inventory-movement-shadow.ts --confirm=INVENTORY_MOVEMENT_SHADOW_RESET
 */
import { PrismaClient } from "@prisma/client";
import { acquireInventoryMovementShadowControlLock } from "../src/server/internal/inventory-movement-shadow-coordination";
import { readInventoryMovementShadowWriteGate } from "../src/server/internal/inventory-movement-shadow-write";
import {
  evaluateInventoryMovementShadowReset,
  INVENTORY_MOVEMENT_SHADOW_RESET_CONFIRM,
} from "../src/server/internal/inventory-movement-shadow-reset-policy";

if (process.argv.includes("--import-only") || process.env.CLI_IMPORT_SMOKE === "1") {
  console.log("CLI import ok: scripts/reset-inventory-movement-shadow.ts");
  process.exit(0);
}

function parseConfirm(argv: string[]): string | undefined {
  for (const arg of argv) {
    if (arg === `--confirm=${INVENTORY_MOVEMENT_SHADOW_RESET_CONFIRM}`) {
      return INVENTORY_MOVEMENT_SHADOW_RESET_CONFIRM;
    }
    if (arg.startsWith("--confirm=")) {
      return arg.slice("--confirm=".length);
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const confirm = parseConfirm(process.argv.slice(2));
  const confirmDecision = evaluateInventoryMovementShadowReset({
    confirm,
    shadowWriteActive: false,
    authoritativeCount: 0,
  });
  if (!confirmDecision.allowed) {
    throw new Error(confirmDecision.message);
  }

  const prisma = new PrismaClient();
  try {
    const deleted = await prisma.$transaction(async (tx) => {
      await acquireInventoryMovementShadowControlLock(tx);
      const shadowWriteActive = await readInventoryMovementShadowWriteGate(tx);
      const authoritative = await tx.$queryRaw<Array<{ n: bigint }>>`
        SELECT COUNT(*)::bigint AS n
        FROM "InventoryMovement"
        WHERE "authority" = 'AUTHORITATIVE'::"InventoryMovementAuthority"
      `;
      const authoritativeCount = Number(authoritative[0]?.n ?? 0);
      const decision = evaluateInventoryMovementShadowReset({
        confirm,
        shadowWriteActive,
        authoritativeCount,
      });
      if (!decision.allowed) {
        throw new Error(decision.message);
      }
      const count = await tx.$executeRaw`
        DELETE FROM "InventoryMovement" WHERE "authority" = 'SHADOW'::"InventoryMovementAuthority"
      `;
      return Number(count);
    });
    console.log(`InventoryMovement SHADOW reset complete. deleted=${deleted}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
