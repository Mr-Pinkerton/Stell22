/**
 * Runner-side evaluator for the SHADOW activation control workflows.
 * Reads a read-only snapshot. Does not open a database and does not mutate the gate.
 *
 * Usage:
 *   npx tsx scripts/shadow-activation-policy.ts assert-pin
 *   npx tsx scripts/shadow-activation-policy.ts cli-state
 *   npx tsx scripts/shadow-activation-policy.ts precheck --snapshot=<file>
 *   npx tsx scripts/shadow-activation-policy.ts post-activate --before=<file> --after=<file>
 *   npx tsx scripts/shadow-activation-policy.ts post-deactivate --before=<file> --after=<file>
 *   npx tsx scripts/shadow-activation-policy.ts verify-active --snapshot=<file>
 *
 * Environment:
 *   EXPECTED_APPLICATION_SHA
 *   SHADOW_CONTROL_ACTION=activate|deactivate
 */
import fs from "node:fs";

import {
  assertSuppliedApplicationPin,
  cliStateForAction,
  evaluateShadowActiveVerify,
  evaluateShadowControlPrecheck,
  evaluateShadowPostActivate,
  evaluateShadowPostDeactivate,
  parseShadowControlSnapshot,
} from "../src/server/internal/inventory-movement-shadow-activation-policy";

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(3)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function readSnapshot(path: string | undefined): string {
  if (!path) throw new Error("REFUSE code=SNAPSHOT_INVALID");
  return fs.readFileSync(path, "utf8");
}

function writeGithubOutput(pairs: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const lines = Object.entries(pairs).map(([key, value]) => `${key}=${value}`);
  fs.appendFileSync(file, `${lines.join("\n")}\n`);
}

function snapshotOrExit(text: string) {
  const parsed = parseShadowControlSnapshot(text);
  if ("ok" in parsed) {
    console.error(`REFUSE code=${parsed.code}`);
    process.exit(1);
  }
  return parsed;
}

function main(): void {
  const command = process.argv[2];
  const expected = process.env.EXPECTED_APPLICATION_SHA ?? "";
  const action = process.env.SHADOW_CONTROL_ACTION ?? "";

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

  if (command === "cli-state") {
    const result = cliStateForAction(action);
    if (typeof result !== "string") {
      console.error(`REFUSE code=${result.code}`);
      process.exit(1);
    }
    const expectedPrior = result === "on" ? "ABSENT_OR_INACTIVE" : "ACTIVE";
    writeGithubOutput({ cli_state: result, expected_prior: expectedPrior, action });
    console.log(`SHADOW_CONTROL_CLI_STATE=${result}`);
    console.log(`SHADOW_CONTROL_EXPECTED_PRIOR=${expectedPrior}`);
    console.log("PSR_P2_DUAL_WRITE_STARTED=NO");
    return;
  }

  if (command === "precheck") {
    const snapshot = snapshotOrExit(readSnapshot(argValue("snapshot")));
    const result = evaluateShadowControlPrecheck({
      action,
      expectedApplicationSha: expected,
      snapshot,
    });
    if (!result.ok) {
      console.error(`REFUSE code=${result.code}`);
      process.exit(1);
    }
    writeGithubOutput({
      cli_state: result.cliState,
      expected_prior: result.expectedPrior,
    });
    console.log(`SHADOW_CONTROL_PRECHECK_OK action=${action}`);
    console.log(`SHADOW_CONTROL_CLI_STATE=${result.cliState}`);
    console.log(`SHADOW_CONTROL_EXPECTED_PRIOR=${result.expectedPrior}`);
    console.log("PSR_P2_DUAL_WRITE_STARTED=NO");
    return;
  }

  if (command === "post-activate" || command === "post-deactivate") {
    const before = snapshotOrExit(readSnapshot(argValue("before")));
    const after = snapshotOrExit(readSnapshot(argValue("after")));
    const result =
      command === "post-activate"
        ? evaluateShadowPostActivate({ expectedApplicationSha: expected, before, after })
        : evaluateShadowPostDeactivate({ expectedApplicationSha: expected, before, after });
    if (!result.ok) {
      console.error(`REFUSE code=${result.code}`);
      process.exit(1);
    }
    console.log(`SHADOW_CONTROL_POSTCHECK_OK gate=${result.shadowGate}`);
    console.log("PSR_P2_DUAL_WRITE_STARTED=NO");
    console.log("SHADOW_GATE_ACTIVATION_IS_NOT_DUAL_WRITE_START=YES");
    return;
  }

  if (command === "verify-active") {
    const snapshot = snapshotOrExit(readSnapshot(argValue("snapshot")));
    const result = evaluateShadowActiveVerify({
      expectedApplicationSha: expected,
      snapshot,
    });
    if (!result.ok) {
      console.error(`REFUSE code=${result.code}`);
      process.exit(1);
    }
    console.log(`PRODUCTION_APP_SHA=${result.productionAppSha}`);
    console.log("SHADOW_GATE_ACTIVATED=YES");
    console.log(`SHADOW_COUNT=${result.shadowCount}`);
    console.log(`AUTHORITATIVE_COUNT=${result.authoritativeCount}`);
    console.log(`NONEMPTY_EPOCH_COUNT=${result.nonemptyEpochCount}`);
    console.log(`COST_FLOW_SETTING=${result.costFlowSetting}`);
    console.log(`SHADOW_ROW_EVIDENCE=${result.shadowRowEvidence}`);
    console.log("PSR_P2_DUAL_WRITE_STARTED=NO");
    console.log("SHADOW_GATE_ACTIVATION_IS_NOT_DUAL_WRITE_START=YES");
    console.log("SHADOW_POST_ACTIVATION_VERIFY_OK");
    return;
  }

  console.error("REFUSE code=UNSUPPORTED_ACTION");
  process.exit(1);
}

main();
