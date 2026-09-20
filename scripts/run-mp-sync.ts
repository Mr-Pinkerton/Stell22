/**
 * Physical marketplace sync from CLI is disabled.
 * Use the authenticated application action syncMarketplaces().
 */
export const MP_SYNC_CLI_PHYSICAL_EXECUTION_DISABLED =
  "MP_SYNC_CLI_PHYSICAL_EXECUTION_DISABLED";

if (process.argv.includes("--import-only") || process.env.CLI_IMPORT_SMOKE === "1") {
  console.log("CLI import ok: scripts/run-mp-sync.ts");
  process.exit(0);
}

console.error(MP_SYNC_CLI_PHYSICAL_EXECUTION_DISABLED);
console.error("Use the authenticated application action syncMarketplaces().");
process.exit(1);
