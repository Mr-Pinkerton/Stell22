/**
 * Supported SHADOW write-gate ON/OFF (Q4 / R-10 control plane).
 * Maintenance only: no UI, no API, no Server Action.
 * Does not run against production in the PSR-P2 preconditions task.
 *
 * Usage:
 *   npx tsx scripts/set-inventory-movement-shadow-write.ts --state=on --confirm=INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL
 *   npx tsx scripts/set-inventory-movement-shadow-write.ts --state=off --confirm=INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL
 */
import { PrismaClient } from "@prisma/client";
import { setInventoryMovementShadowWriteGate } from "../src/server/internal/inventory-movement-shadow-write";

export const INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL_CONFIRM =
  "INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL";

if (process.argv.includes("--import-only") || process.env.CLI_IMPORT_SMOKE === "1") {
  console.log("CLI import ok: scripts/set-inventory-movement-shadow-write.ts");
  process.exit(0);
}

function parseState(argv: string[]): boolean {
  let seen: boolean | undefined;
  for (const arg of argv) {
    if (arg === "--state=on") {
      if (seen !== undefined) throw new Error("Отказ: укажите ровно одно --state=on или --state=off.");
      seen = true;
      continue;
    }
    if (arg === "--state=off") {
      if (seen !== undefined) throw new Error("Отказ: укажите ровно одно --state=on или --state=off.");
      seen = false;
      continue;
    }
    if (arg.startsWith("--state=")) {
      throw new Error("Отказ: --state должен быть on или off.");
    }
  }
  if (seen === undefined) {
    throw new Error("Отказ: укажите --state=on или --state=off.");
  }
  return seen;
}

function parseConfirm(argv: string[]): string | undefined {
  for (const arg of argv) {
    if (arg === `--confirm=${INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL_CONFIRM}`) {
      return INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL_CONFIRM;
    }
    if (arg.startsWith("--confirm=")) {
      return arg.slice("--confirm=".length);
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const active = parseState(argv);
  const confirm = parseConfirm(argv);
  if (confirm !== INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL_CONFIRM) {
    throw new Error(
      "Отказ: нужен явный флаг --confirm=INVENTORY_MOVEMENT_SHADOW_WRITE_CONTROL.",
    );
  }

  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(async (tx) =>
      setInventoryMovementShadowWriteGate(tx, active),
    );
    console.log(
      `InventoryMovement SHADOW write gate ${result ? "on" : "off"}. active=${result}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
