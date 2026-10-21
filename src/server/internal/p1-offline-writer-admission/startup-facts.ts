/**
 * Repository-only startup configuration.
 * A new Compose build can inherit the image ENTRYPOINT.
 * That reading does not inspect the deployed production runtime.
 */

import fs from "node:fs";
import path from "node:path";

const APP_ONLY_ENTRYPOINT = 'ENTRYPOINT ["./docker-entrypoint-app-only.sh"]';
const LEGACY_ENTRYPOINT = 'ENTRYPOINT ["./docker-entrypoint.sh"]';

export type StartupFacts = {
  productionEntrypointRunsMigrate: boolean;
  dockerfileSelectsProductionEntrypoint: boolean;
  composeRestartUnlessStopped: boolean;
  composeNamesProductionApp: boolean;
  composeSelectsAppOnlyEntrypoint: boolean;
  appOnlyScriptRunsMigrate: boolean;
  candidateDockerfileSelectsAppOnly: boolean;
  productionDockerfileSelectsCandidate: boolean;
  /** Accepted deployed production path. Repository text does not establish it. */
  appOnlyIsProductionPath: boolean;
  /** App service uses build: . and sets neither entrypoint nor command. */
  configuredBuildInheritsImageEntrypoint: boolean;
  /** The inherited image ENTRYPOINT is the app-only script. */
  configuredNextBuildSelectsAppOnly: boolean;
  /** This reader does not contact a running host. */
  deployedRuntimeVerified: false;
};

export type StartupSources = {
  legacyEntrypoint: string;
  dockerfile: string;
  compose: string;
  appOnlyEntrypoint: string;
  candidateDockerfile: string;
};

export function readStartupFacts(root: string): StartupFacts {
  return evaluateStartupFiles({
    legacyEntrypoint: read(root, "docker-entrypoint.sh"),
    dockerfile: read(root, "Dockerfile"),
    compose: read(root, "docker-compose.prod.yml"),
    appOnlyEntrypoint: read(root, "docker-entrypoint-app-only.sh"),
    candidateDockerfile: read(root, "docker/app-only-startup/Dockerfile"),
  });
}

export function evaluateStartupFiles(input: StartupSources): StartupFacts {
  const imageEntrypoint = lastInstruction(input.dockerfile, "ENTRYPOINT");
  const appService = serviceLines(input.compose, "app");
  const configuredBuildInheritsImageEntrypoint = inheritsImageEntrypoint(appService);
  const dockerfileSelectsAppOnly = imageEntrypoint === APP_ONLY_ENTRYPOINT;
  const dockerfileSelectsProductionEntrypoint = imageEntrypoint === LEGACY_ENTRYPOINT;
  const productionEntrypointRunsMigrate = input.legacyEntrypoint.includes("npx prisma migrate deploy");
  const composeRestartUnlessStopped = input.compose.includes("restart: unless-stopped");
  const composeNamesProductionApp = input.compose.includes("container_name: stell22-app");
  const composeSelectsAppOnlyEntrypoint = appService.some((line) => line.includes("docker-entrypoint-app-only"));
  const appOnlyScriptRunsMigrate = /prisma\s+migrate\s+deploy/.test(input.appOnlyEntrypoint);
  const candidateDockerfileSelectsAppOnly = input.candidateDockerfile.includes("docker-entrypoint-app-only.sh");
  const productionDockerfileSelectsCandidate = input.dockerfile.includes("docker/app-only-startup");
  return {
    productionEntrypointRunsMigrate,
    dockerfileSelectsProductionEntrypoint,
    composeRestartUnlessStopped,
    composeNamesProductionApp,
    composeSelectsAppOnlyEntrypoint,
    appOnlyScriptRunsMigrate,
    candidateDockerfileSelectsAppOnly,
    productionDockerfileSelectsCandidate,
    appOnlyIsProductionPath: false,
    configuredBuildInheritsImageEntrypoint,
    configuredNextBuildSelectsAppOnly: configuredBuildInheritsImageEntrypoint && dockerfileSelectsAppOnly,
    deployedRuntimeVerified: false,
  };
}

export function startupBlocker(facts: StartupFacts): string {
  if (facts.appOnlyIsProductionPath) return "app-only entrypoint is selected by the production image";
  if (facts.configuredNextBuildSelectsAppOnly) {
    return "A new Compose build uses build: . and does not override ENTRYPOINT, so it inherits docker-entrypoint-app-only.sh. docker-entrypoint.sh still contains npx prisma migrate deploy and is not that image entrypoint. docker-compose.prod.yml restarts stell22-app with unless-stopped. The deployed production runtime is NOT VERIFIED. This repository inspection does not mean production was upgraded. scripts/deploy.sh still assumes prisma migrate deploy during application start. HARD RELEASE BLOCKER: the production login is incompatible with this candidate. This is not an accepted production path.";
  }
  if (!facts.dockerfileSelectsProductionEntrypoint) {
    return "Main Dockerfile ENTRYPOINT is docker-entrypoint-app-only.sh. docker-entrypoint.sh still contains npx prisma migrate deploy and is not the image entrypoint. docker-compose.prod.yml restarts the application with unless-stopped and does not select docker-entrypoint-app-only.sh. scripts/deploy.sh still assumes prisma migrate deploy during application start. HARD RELEASE BLOCKER: the production login is incompatible with this candidate. This is not an accepted production path.";
  }
  return "Production Dockerfile ENTRYPOINT is docker-entrypoint.sh, which runs npx prisma migrate deploy. docker-compose.prod.yml restarts that image with unless-stopped and does not select docker-entrypoint-app-only.sh. audit/08.52 remains a separate candidate image.";
}

function inheritsImageEntrypoint(service: readonly string[]): boolean {
  const buildsDot = service.some((line) => /^build:\s*\.\s*$/.test(line.trim()));
  const overridesEntrypoint = service.some((line) => /^entrypoint:/.test(line.trim()));
  const overridesCommand = service.some((line) => /^command:/.test(line.trim()));
  return buildsDot && !overridesEntrypoint && !overridesCommand;
}

function serviceLines(compose: string, name: string): string[] {
  const lines = compose.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  if (start < 0) return [];
  const body: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^ {2}[A-Za-z]/.test(line) || /^[A-Za-z]/.test(line)) break;
    if (line.trim().startsWith("#")) continue;
    body.push(line);
  }
  return body;
}

function lastInstruction(dockerfile: string, keyword: string): string | null {
  const matches = dockerfile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(keyword) && !line.startsWith("#"));
  return matches.length === 0 ? null : matches[matches.length - 1] ?? null;
}

function read(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}
