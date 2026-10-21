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
  /** App service uses build: . and does not replace the image ENTRYPOINT. command overrides CMD only. */
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
  return buildsDot && entrypointEffect(service) === "inherit";
}

/** Compose `command` replaces image CMD. Only an effective `entrypoint` replaces image ENTRYPOINT. */
function entrypointEffect(service: readonly string[]): "inherit" | "disable" | "override" {
  const indent = servicePropertyIndent(service);
  const key = new RegExp(`^ {${indent}}entrypoint:\\s*(.*)$`);
  let effect: "inherit" | "disable" | "override" = "inherit";
  for (let index = 0; index < service.length; index += 1) {
    const match = key.exec(service[index] ?? "");
    if (!match) continue;
    const value = stripYamlComment(match[1] ?? "").trim();
    if (value !== "") {
      effect = classifyEntrypointValue(value);
      continue;
    }
    const nested = nestedBlock(service, index + 1, indent);
    effect = nested.length === 0 ? "inherit" : "override";
  }
  return effect;
}

function classifyEntrypointValue(value: string): "inherit" | "disable" | "override" {
  if (/^(?:null|Null|NULL|~)$/.test(value)) return "inherit";
  if (/^\[\s*\]$/.test(value) || value === '""' || value === "''") return "disable";
  return "override";
}

function servicePropertyIndent(service: readonly string[]): number {
  let indent = Number.POSITIVE_INFINITY;
  for (const line of service) {
    if (line.trim() === "") continue;
    const width = /^ */.exec(line)?.[0].length ?? 0;
    if (width < indent) indent = width;
  }
  return Number.isFinite(indent) ? indent : 0;
}

function nestedBlock(service: readonly string[], start: number, indent: number): string[] {
  const nested: string[] = [];
  for (let index = start; index < service.length; index += 1) {
    const line = service[index] ?? "";
    if (line.trim() === "") continue;
    const width = /^ */.exec(line)?.[0].length ?? 0;
    if (width <= indent) break;
    nested.push(line);
  }
  return nested;
}

function stripYamlComment(raw: string): string {
  const value = raw.trimStart();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    for (let index = 1; index < value.length; index += 1) {
      if (quote === '"' && value[index] === "\\") {
        index += 1;
        continue;
      }
      if (value[index] === quote) return value.slice(0, index + 1);
    }
    return value;
  }
  return value.split(/\s+#/)[0] ?? value;
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
