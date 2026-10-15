import fs from "node:fs";
import {
  DAEMON_ID,
  PRODUCTION_DAEMON_PIN_PATH,
  SHORTCUT_FLAGS,
} from "@/server/internal/p1-production-adapter/contract";

/**
 * Operator entry.
 * preflight and verify-recovery do not apply P1.
 * apply has no shortcut flag. A missing daemon pin file stops production apply.
 */

export type CliIo = {
  log?: (line: string) => void;
  readPin?: () => string | null;
  readAuthorization?: (filePath: string) => unknown;
  execute?: (authorization: unknown, daemonPin: string) => { code: string };
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
  try {
    const readAuthorization = io.readAuthorization ?? ((filePath: string) => JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
    const authorization = readAuthorization(argv[authorizationFlag + 1] ?? "");
    const execute = io.execute;
    if (!execute) {
      log("STOP PRODUCTION_APPLY_NOT_WIRED_TO_THIS_CLI");
      return 2;
    }
    const result = execute(authorization, pin);
    log(result.code);
    return result.code === "P1_APPLIED" ? 0 : 2;
  } catch {
    log("STOP AUTHORIZATION_REQUIRED");
    return 2;
  }
}

export function readInstalledDaemonPin(): string | null {
  if (!fs.existsSync(PRODUCTION_DAEMON_PIN_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(PRODUCTION_DAEMON_PIN_PATH, "utf8")) as Record<string, unknown>;
    if (parsed.kind !== "PRODUCTION_DAEMON_PIN" || parsed.source !== "OWNER_RECORDED_READONLY") return null;
    return typeof parsed.daemonId === "string" ? parsed.daemonId : null;
  } catch {
    return null;
  }
}
