/**
 * Hash one migration file with the statement-period normalization.
 * Prints a code only. It does not migrate or print the file.
 */
import fs from "node:fs";
import {
  IMAGE_COUNT,
  MIGRATION_NAME,
  MIGRATION_SHA256,
  migrationSha256,
} from "../src/server/internal/statement-period-release/decide.mjs";

const file = process.argv[2] ?? "";
const count = process.argv[3] ?? "";
let hash = "";
try {
  hash = migrationSha256(fs.readFileSync(file));
} catch {
  process.stdout.write("CODE=STOP_TARGET_CHECKSUM\n");
  process.exit(1);
}
if (hash !== MIGRATION_SHA256 || String(count) !== String(IMAGE_COUNT)) {
  process.stdout.write("CODE=STOP_TARGET_CHECKSUM\n");
  process.exit(1);
}
process.stdout.write(`CODE=CHECKSUM_MATCHED\nSHA256=${hash}\nNAME=${MIGRATION_NAME}\n`);
