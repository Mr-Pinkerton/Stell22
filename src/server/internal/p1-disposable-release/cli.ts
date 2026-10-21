import {
  finishRehearsal,
  runDisposableReleaseRehearsal,
  type RehearsalRun,
} from "@/server/internal/p1-disposable-release/rehearsal";

const FORBIDDEN_ARGUMENTS = new Set([
  "--authorize",
  "--authorized",
  "--bypass",
  "--database-url",
  "--force",
  "--production",
  "--retry",
  "--ssh",
  "--url",
  "--yes",
]);

export type CliIo = {
  log?: (line: string) => void;
  run?: () => RehearsalRun;
};

export function runCli(argv: readonly string[], io: CliIo = {}): number {
  const log = io.log ?? ((line: string) => console.log(line));
  if (
    argv.length !== 0 ||
    argv.some((token) => FORBIDDEN_ARGUMENTS.has(token) || token.startsWith("--"))
  ) {
    log("STOP MALFORMED_CLI");
    return 2;
  }
  try {
    const outcome = (io.run ?? runDisposableReleaseRehearsal)();
    log(JSON.stringify(outcome.report));
    finishRehearsal(outcome.resources);
    return outcome.report.failure === null ? 0 : 2;
  } catch {
    log("STOP UNEXPECTED_REHEARSAL_FAILURE");
    return 2;
  }
}
