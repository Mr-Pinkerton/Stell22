/**
 * Runner-side evaluator for the read-only SHADOW soak evidence workflow.
 * Does not open a database and does not mutate production.
 *
 * Usage:
 *   npx tsx scripts/shadow-soak-evidence-policy.ts assert-pin
 *   npx tsx scripts/shadow-soak-evidence-policy.ts assert-snapshot --snapshot=<file>
 *   npx tsx scripts/shadow-soak-evidence-policy.ts evaluate --snapshot=<file>
 */
import fs from "node:fs";

import { assertSuppliedApplicationPin } from "../src/server/internal/inventory-movement-shadow-activation-policy";
import { evaluateShadowSoakEvidence } from "../src/server/internal/inventory-movement-shadow-soak-evidence";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(3)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function writeGithubOutput(pairs: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(pairs).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

function main(): void {
  const command = process.argv[2];
  const expected = process.env.EXPECTED_APPLICATION_SHA ?? "";

  if (command === "assert-pin") {
    const result = assertSuppliedApplicationPin(expected);
    if (!result.ok) {
      console.error(`REFUSE code=${result.code}`);
      process.exit(1);
    }
    writeGithubOutput({ expected_sha: expected });
    console.log(`APPLICATION_SHA_PIN_OK ${expected}`);
    console.log("APPLICATION_SHA_IS_NOT_GITHUB_MAIN=YES");
    return;
  }

  if (command === "assert-snapshot" || command === "evaluate") {
    const path = argValue("snapshot");
    if (!path) {
      console.error("REFUSE code=SNAPSHOT_INVALID");
      process.exit(1);
    }
    const snapshot = fs.readFileSync(path, "utf8");
    const markers = snapshot
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("SHADOW_SOAK SNAPSHOT_MODE="));
    if (markers.length !== 1 || markers[0] !== "SHADOW_SOAK SNAPSHOT_MODE=READ_ONLY") {
      console.error("REFUSE code=SNAPSHOT_INCOMPLETE");
      process.exit(1);
    }
    if (command === "assert-snapshot") {
      console.log("SHADOW_SOAK_SNAPSHOT_COMPLETE");
      return;
    }
    const result = evaluateShadowSoakEvidence({
      expectedApplicationSha: expected,
      snapshot,
    });
    if (!result.ok) {
      console.error(`REFUSE code=${result.code}`);
      process.exit(1);
    }
    for (const line of result.markers) console.log(line);
    return;
  }

  console.error("REFUSE code=UNSUPPORTED_ACTION");
  process.exit(1);
}

main();
