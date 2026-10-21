/**
 * Contract for the main application image startup path.
 * A passing result is a development candidate. It is not production approval.
 */

const MIGRATION_COMMAND = /prisma\s+(?:migrate(?:\s+deploy|\s+reset)?|db\s+push)\b/;

export type MainImageStartupInput = {
  dockerfile: string;
  selectedEntrypoint: string;
};

export type MainImageStartupDecision = { ok: true } | { ok: false; code: string };

const REQUIRED_RUNNER_SNIPPETS = [
  "NODE_ENV=production",
  "/app/node_modules",
  "/app/.next",
  "/app/public",
  "/app/package.json",
  "/app/next.config.ts",
  "/app/tsconfig.json",
  "/app/prisma",
  "/app/src",
  "docker-entrypoint-app-only.sh",
  "chmod +x docker-entrypoint-app-only.sh",
] as const;

export function evaluateMainImageStartup(input: MainImageStartupInput): MainImageStartupDecision {
  const instructions = instructionLines(input.dockerfile);
  const entrypoints = instructions.filter((line) => line.startsWith("ENTRYPOINT"));
  if (entrypoints.length !== 1) return refuse("ENTRYPOINT_COUNT");
  if (entrypoints[0] !== 'ENTRYPOINT ["./docker-entrypoint-app-only.sh"]') return refuse("ENTRYPOINT");
  const executable = executableLines(input.selectedEntrypoint);
  if (executable.includes("docker-entrypoint.sh")) return refuse("LEGACY_ENTRYPOINT");
  if (MIGRATION_COMMAND.test(executable)) return refuse("AUTOMATIC_MIGRATION");
  if (/\bSKIP\b|\bBYPASS\b|APP_ONLY_REPOSITORY_ROOT|APP_ONLY_STARTUP_FIXTURE/.test(executable)) {
    return refuse("BYPASS");
  }
  if (!executable.includes("src/server/internal/p1-app-only-startup/run.ts")) return refuse("GATE_MISSING");
  if (!executable.includes("exec npm run start")) return refuse("START_MISSING");

  const npmCi = instructions.findIndex((line) => line.startsWith("RUN npm ci"));
  const productionEnv = instructions.findIndex((line) => line.includes("NODE_ENV=production"));
  if (npmCi < 0 || productionEnv < 0 || productionEnv < npmCi) return refuse("DEPENDENCY");
  if (!instructions.some((line) => line === "RUN npx prisma generate")) return refuse("DEPENDENCY");

  const stages = splitStages(instructions);
  const runner = stages[stages.length - 1] ?? [];
  if (runner.length === 0) return refuse("DEPENDENCY");
  const runnerText = runner.join("\n");
  if (MIGRATION_COMMAND.test(runnerText)) return refuse("AUTOMATIC_MIGRATION");
  if (runnerText.includes("docker-entrypoint.sh")) return refuse("LEGACY_ENTRYPOINT");
  for (const snippet of REQUIRED_RUNNER_SNIPPETS) {
    if (!runnerText.includes(snippet)) return refuse("DEPENDENCY");
  }
  return { ok: true };
}

export function legacyEntrypointViolatesContract(dockerfile: string, legacyEntrypoint: string): MainImageStartupDecision {
  if (!MIGRATION_COMMAND.test(legacyEntrypoint)) return refuse("LEGACY_ENTRYPOINT_NOT_MIGRATING");
  return evaluateMainImageStartup({ dockerfile, selectedEntrypoint: legacyEntrypoint });
}

function executableLines(script: string): string {
  return script
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

function instructionLines(dockerfile: string): string[] {
  return dockerfile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function splitStages(instructions: readonly string[]): string[][] {
  const stages: string[][] = [];
  for (const line of instructions) {
    if (line.startsWith("FROM ")) stages.push([line]);
    else (stages[stages.length - 1] ?? stages[stages.push([]) - 1]).push(line);
  }
  return stages;
}

function refuse(code: string): MainImageStartupDecision {
  return { ok: false, code };
}
