import fs from "node:fs";
import { DAEMON_ID, PRODUCTION_DAEMON_PIN_PATH, SHORTCUT_FLAGS } from "@/server/internal/p1-production-adapter/contract";

/**
 * Operator entry.
 * preflight and verify-recovery do not apply P1.
 * apply is not wired. A JSON file is not production authority.
 * The daemon pin is a daemon identity record, not an owner signature.
 */

export type CliIo = {
  log?: (line: string) => void;
  readPin?: () => string | null;
  preflight?: () => string;
  verifyRecovery?: () => string;
};

export function runProductionAdapterCli(argv: readonly string[], io: CliIo = {}): number {
  const log = io.log ?? ((line: string) => console.log(line));
  if (argv.some((token) => SHORTCUT_FLAGS.includes(token as (typeof SHORTCUT_FLAGS)[number]) || token.includes("DATABASE_URL"))) {
    log("STOP SHORTCUT_AUTHORIZATION");
    return 2;
  }
  const command = argv[0];
  if (command === "preflight") {
    if (!io.preflight) {
      log("STOP PREFLIGHT_RUNTIME_REQUIRED");
      return 2;
    }
    log(io.preflight());
    log("NO_APPLY");
    return 0;
  }
  if (command === "verify-recovery") {
    if (!io.verifyRecovery) {
      log("STOP RECOVERY_RUNTIME_REQUIRED");
      return 2;
    }
    log(io.verifyRecovery());
    log("NO_APPLY");
    return 0;
  }
  if (command !== "apply") {
    log("STOP MALFORMED_CLI");
    return 2;
  }
  const authorizationFlag = argv.indexOf("--authorization");
  if (authorizationFlag < 0 || !argv[authorizationFlag + 1]) {
    log("STOP AUTHORIZATION_REQUIRED");
    return 2;
  }
  const readPin = io.readPin ?? readInstalledDaemonPin;
  const pin = readPin();
  if (pin === null || !DAEMON_ID.test(pin)) {
    log("STOP PRODUCTION_DAEMON_UNPINNED");
    return 2;
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    log("STOP PRODUCTION_SCOPE_FORBIDDEN_IN_CI");
    return 2;
  }
  log("STOP PRODUCTION_APPLY_NOT_WIRED_TO_THIS_CLI");
  return 2;
}

export function readInstalledDaemonPin(): string | null {
  if (!fs.existsSync(PRODUCTION_DAEMON_PIN_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(PRODUCTION_DAEMON_PIN_PATH, "utf8")) as Record<string, unknown>;
    if (parsed.kind !== "PRODUCTION_DAEMON_PIN") return null;
    return typeof parsed.daemonId === "string" ? parsed.daemonId : null;
  } catch {
    return null;
  }
}
