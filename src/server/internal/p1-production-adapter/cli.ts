import { readInstalledSignedAuthorization } from "@/server/internal/p1-production-adapter/authorization";
import { ATTEMPT_ID, DAEMON_ID, IMAGE_ID, SHORTCUT_FLAGS } from "@/server/internal/p1-production-adapter/contract";
import {
  formatOperatorResult,
  formatUnsignedStop,
  readInstalledDaemonPin,
  readInstalledOneShotImagePin,
  runOperatorCommand,
  type OperatorCommand,
} from "@/server/internal/p1-production-adapter/operator";

/**
 * Operator entry.
 * preflight is read-only.
 * verify-recovery is the only command that creates a backup and a disposable restore.
 * apply reads the installed pin, trust key, and signed approval. A caller path is not authority.
 * None of these commands infer an image Git SHA.
 */

export { readInstalledDaemonPin };

export function runProductionAdapterCli(argv: readonly string[], log: (line: string) => void = (line) => console.log(line)): number {
  if (argv.some((token) => SHORTCUT_FLAGS.includes(token as (typeof SHORTCUT_FLAGS)[number]) || token.includes("DATABASE_URL"))) {
    log(formatUnsignedStop("SHORTCUT_AUTHORIZATION", null));
    return 2;
  }
  if (argv.includes("--authorization")) {
    log(formatUnsignedStop("AUTHORIZATION_PATH_REJECTED", null));
    return 2;
  }
  const parsed = parseCommand(argv);
  if ("error" in parsed) {
    log(formatUnsignedStop(parsed.error.replace(/^STOP /, ""), null));
    return 2;
  }
  if (process.env.GITHUB_ACTIONS === "true") {
    log(formatUnsignedStop("PRODUCTION_SCOPE_FORBIDDEN_IN_CI", parsed.attemptId));
    return 2;
  }
  const pin = readInstalledDaemonPin();
  if (pin === null || !DAEMON_ID.test(pin)) {
    log(formatUnsignedStop("PRODUCTION_DAEMON_UNPINNED", parsed.attemptId));
    return 2;
  }
  const imagePin = readInstalledOneShotImagePin();
  if (imagePin === null || !IMAGE_ID.test(imagePin)) {
    log(formatUnsignedStop("ONESHOT_IMAGE_UNPINNED", parsed.attemptId));
    return 2;
  }
  if (parsed.command === "apply") {
    let installed: unknown;
    try {
      installed = readInstalledSignedAuthorization();
    } catch {
      log(formatUnsignedStop("AUTHORIZATION_REQUIRED", parsed.attemptId));
      return 2;
    }
    if (installed === undefined) {
      log(formatUnsignedStop("AUTHORIZATION_REQUIRED", parsed.attemptId));
      return 2;
    }
  }
  const result = runOperatorCommand({
    command: parsed.command,
    attemptId: parsed.attemptId,
    scope: "PRODUCTION",
  });
  log(formatOperatorResult(result));
  if (parsed.command !== "apply") log("NO_APPLY");
  return result.verdict === "STOP" || result.verdict === "BLOCKED" ? 2 : 0;
}

function parseCommand(argv: readonly string[]): { command: OperatorCommand; attemptId: string } | { error: string } {
  const command = argv[0];
  if (command !== "preflight" && command !== "verify-recovery" && command !== "apply") {
    return { error: "STOP MALFORMED_CLI" };
  }
  const attemptFlag = argv.indexOf("--attempt");
  const attemptId = attemptFlag >= 0 ? argv[attemptFlag + 1] : undefined;
  if (!attemptId || !ATTEMPT_ID.test(attemptId) || argv.length !== 3 || attemptFlag !== 1) {
    return { error: "STOP ATTEMPT_REQUIRED" };
  }
  return { command, attemptId };
}
