import fs from "node:fs";
import { P1_RUNNER_MODE } from "@/server/internal/p1-isolated-runner/contract";
import { createRepoGitSource } from "@/server/internal/p1-isolated-runner/git-source";
import {
  verifyAuthorizedMigrationBytes,
  type GitBlobSource,
} from "@/server/internal/p1-isolated-runner/migration-set";
import { parseDisposableAttestation } from "@/server/internal/p1-isolated-runner/disposable-target";
import { RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";

const FORBIDDEN_FLAGS = new Set([
  "--production",
  "--force",
  "--bypass",
  "--resolve",
  "--database-url",
  "--url",
  "--retry",
  "--sql",
  "--migrate",
]);

export type CliIo = {
  git?: GitBlobSource;
  repoRoot?: string;
  log?: (line: string) => void;
  readFile?: (filePath: string) => string;
};

export function runCli(argv: readonly string[], io: CliIo = {}): number {
  const log = io.log ?? ((line: string) => console.log(line));
  try {
    const parsed = parseRunnerArgs(argv);
    if (parsed.mode === "reject") {
      log(`STOP ${parsed.code}`);
      return 2;
    }
    const git = io.git ?? createRepoGitSource(io.repoRoot ?? process.cwd());
    if (parsed.mode === "plan") {
      const verified = verifyAuthorizedMigrationBytes(git);
      log(`${P1_RUNNER_MODE} PLAN inventory=${verified.files.length} digest=${verified.digest}`);
      log("NO_APPLY");
      return 0;
    }
    const readFile = io.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"));
    const raw = JSON.parse(readFile(parsed.attestationPath)) as unknown;
    parseDisposableAttestation(raw);
    log("STOP LIVE_DISPOSABLE_PROBE_NOT_IMPLEMENTED");
    return 2;
  } catch (error) {
    if (error instanceof RunnerRefusal) {
      log(`${error.verdict} ${error.code}`);
      return 2;
    }
    if (error instanceof SyntaxError) {
      log("STOP MALFORMED_ATTESTATION");
      return 2;
    }
    log("STOP UNEXPECTED_CLI_FAILURE");
    return 2;
  }
}

export function parseRunnerArgs(
  argv: readonly string[],
):
  | { mode: "plan" }
  | { mode: "apply"; attestationPath: string }
  | { mode: "reject"; code: string } {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === "plan")) {
    return { mode: "plan" };
  }
  for (const token of argv) {
    if (
      FORBIDDEN_FLAGS.has(token) ||
      token.startsWith("--database") ||
      token.includes("DATABASE_URL")
    ) {
      return { mode: "reject", code: "MALFORMED_CLI" };
    }
  }
  if (argv[0] !== "apply") {
    return { mode: "reject", code: "MALFORMED_CLI" };
  }
  if (argv.length !== 3 || argv[1] !== "--attestation" || !argv[2] || argv[2].includes("\0")) {
    return { mode: "reject", code: "MALFORMED_CLI" };
  }
  return { mode: "apply", attestationPath: argv[2] };
}
