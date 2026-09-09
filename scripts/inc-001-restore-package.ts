/**
 * INC-001 one-off: restore RailLot remainingQuantity 0 -> 1280 so the worker
 * can replay factual TORCOVKA through the normal terminal.
 *
 * Default: DRY RUN (reads + preconditions, no persistent mutation).
 * Production write only:
 *   npx tsx scripts/inc-001-restore-package.ts --execute INC-001-RESTORE-1280
 */
import { prisma } from "../src/server/db";
import {
  EXPECTED_CODE,
  INC_001_EXECUTE_TOKEN,
  INCIDENT_ID,
  RAIL_LOT_ID,
  describeDatabaseUrl,
  formatInc001DryRun,
  restoreInc001SourcePackage,
} from "../src/server/internal/inc-001-restore-package";

const DRY_RUN_ROLLBACK = "INC-001-DRY-RUN-ROLLBACK";

function parseMode(argv: string[]): { execute: boolean } {
  const idx = argv.indexOf("--execute");
  if (idx === -1) return { execute: false };
  const token = argv[idx + 1];
  if (token !== INC_001_EXECUTE_TOKEN) {
    throw new Error(
      `INC-001 restore: --execute requires exact token ${INC_001_EXECUTE_TOKEN}; got ${token ?? "<missing>"}`,
    );
  }
  return { execute: true };
}

async function main(): Promise<void> {
  const { execute } = parseMode(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const db = describeDatabaseUrl(url);

  console.log(`MODE: ${execute ? "EXECUTE" : "DRY-RUN"}`);
  console.log(`INCIDENT: ${INCIDENT_ID}`);
  console.log(`TARGET LOT: ${RAIL_LOT_ID} / ${EXPECTED_CODE}`);
  console.log(`DATABASE HOST: ${db.host}`);
  console.log(`DATABASE NAME: ${db.database}`);
  if (db.port) console.log(`DATABASE PORT: ${db.port}`);

  if (execute) {
    const plan = await prisma.$transaction(async (tx) =>
      restoreInc001SourcePackage({ tx, execute: true }),
    );
    console.log("INC-001 RESTORE EXECUTED");
    console.log(`READY TO EXECUTE was YES; remainingQuantity now ${plan.targetRemaining}`);
    return;
  }

  try {
    await prisma.$transaction(async (tx) => {
      const result = await restoreInc001SourcePackage({ tx, execute: false });
      throw Object.assign(new Error(DRY_RUN_ROLLBACK), { plan: result });
    });
  } catch (err) {
    if (err instanceof Error && err.message === DRY_RUN_ROLLBACK && "plan" in err) {
      const rolled = err as Error & { plan: Parameters<typeof formatInc001DryRun>[0] };
      console.log(formatInc001DryRun(rolled.plan, db));
      return;
    }
    throw err;
  }
}

main()
  .catch((err) => {
    console.error("\nINC-001 RESTORE FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
