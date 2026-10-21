import { publishRehearsalReport } from "@/server/internal/p1-disposable-release/report";
import {
  finishRehearsal,
  runDisposableReleaseRehearsal,
  type RehearsalCleanup,
  type RehearsalResources,
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
  finish?: (resources: RehearsalResources) => RehearsalCleanup;
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
    let cleanup: RehearsalCleanup;
    try {
      cleanup = (io.finish ?? finishRehearsal)(outcome.resources);
    } catch {
      cleanup = {
        removed: [],
        preserved: [],
        failures: [{ resource: "cleanup", reason: "UNEXPECTED" }],
        status: "FAILED",
      };
    }
    const published = publishRehearsalReport(outcome.report, cleanup);
    log(JSON.stringify(published));
    return published.commandResult === "SUCCESS" ? 0 : 2;
  } catch {
    log("STOP UNEXPECTED_REHEARSAL_FAILURE");
    return 2;
  }
}
