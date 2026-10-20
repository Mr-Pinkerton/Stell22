/**
 * Why the app-only candidate is not the production startup path.
 * Reads repository files only. It does not start a container or run Prisma.
 */

import fs from "node:fs";
import path from "node:path";

export type StartupFacts = {
  productionEntrypointRunsMigrate: boolean;
  dockerfileSelectsProductionEntrypoint: boolean;
  composeRestartUnlessStopped: boolean;
  composeNamesProductionApp: boolean;
  composeSelectsAppOnlyEntrypoint: boolean;
  appOnlyScriptRunsMigrate: boolean;
  candidateDockerfileSelectsAppOnly: boolean;
  productionDockerfileSelectsCandidate: boolean;
  appOnlyIsProductionPath: boolean;
};

export function readStartupFacts(root: string): StartupFacts {
  const entrypoint = read(root, "docker-entrypoint.sh");
  const dockerfile = read(root, "Dockerfile");
  const compose = read(root, "docker-compose.prod.yml");
  const appOnly = read(root, "docker-entrypoint-app-only.sh");
  const candidateDockerfile = read(root, "docker/app-only-startup/Dockerfile");
  const productionEntrypointRunsMigrate = entrypoint.includes("npx prisma migrate deploy");
  const dockerfileSelectsProductionEntrypoint = dockerfile.includes('ENTRYPOINT ["./docker-entrypoint.sh"]');
  const composeRestartUnlessStopped = compose.includes("restart: unless-stopped");
  const composeNamesProductionApp = compose.includes("container_name: stell22-app");
  const composeSelectsAppOnlyEntrypoint = compose.includes("docker-entrypoint-app-only");
  const appOnlyScriptRunsMigrate = /prisma\s+migrate\s+deploy/.test(appOnly);
  const candidateDockerfileSelectsAppOnly = candidateDockerfile.includes("docker-entrypoint-app-only.sh");
  const productionDockerfileSelectsCandidate = dockerfile.includes("docker/app-only-startup");
  const appOnlyIsProductionPath =
    composeSelectsAppOnlyEntrypoint &&
    productionDockerfileSelectsCandidate &&
    !dockerfileSelectsProductionEntrypoint;
  return {
    productionEntrypointRunsMigrate,
    dockerfileSelectsProductionEntrypoint,
    composeRestartUnlessStopped,
    composeNamesProductionApp,
    composeSelectsAppOnlyEntrypoint,
    appOnlyScriptRunsMigrate,
    candidateDockerfileSelectsAppOnly,
    productionDockerfileSelectsCandidate,
    appOnlyIsProductionPath,
  };
}

export function startupBlocker(facts: StartupFacts): string {
  if (facts.appOnlyIsProductionPath) return "app-only entrypoint is selected by the production image";
  return "Production Dockerfile ENTRYPOINT is docker-entrypoint.sh, which runs npx prisma migrate deploy. docker-compose.prod.yml restarts that image with unless-stopped and does not select docker-entrypoint-app-only.sh. audit/08.52 remains a separate candidate image.";
}

function read(root: string, relative: string): string {
  return fs.readFileSync(path.join(root, relative), "utf8");
}
