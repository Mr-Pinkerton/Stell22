import fs from "node:fs";
import path from "node:path";
import { ONE_SHOT_IMAGE } from "@/server/internal/p1-isolated-runner/p1-release-gate";
import { ONE_SHOT_LAUNCHER } from "@/server/internal/p1-isolated-runner/p1-release-execute";
import { refusal } from "@/server/internal/p1-isolated-runner/refusal";
import { IMAGE_ID, PRODUCTION_DNS_ALIAS } from "@/server/internal/p1-production-adapter/contract";

export type OneShotImageObservation = {
  tagId: string;
  idInspect: string;
};

/**
 * The tag id and the id inspect must be the same Docker digest.
 * A tag move after the dossier was bound is `ONESHOT_IMAGE_CHANGED`.
 * A different digest than the approved pin is `ONESHOT_IMAGE_UNAPPROVED`.
 */
export function acceptOneShotImage(
  observation: OneShotImageObservation,
  expected: string,
  previouslyBound: string | null,
): string {
  if (!IMAGE_ID.test(observation.tagId) || !IMAGE_ID.test(observation.idInspect) || !IMAGE_ID.test(expected)) {
    throw refusal("STOP", "ONESHOT_IMAGE_MALFORMED", "One-shot image id is not a Docker image digest");
  }
  if (observation.tagId !== observation.idInspect) {
    throw refusal("STOP", "ONESHOT_IMAGE_CHANGED", "One-shot tag and image id diverged");
  }
  if (previouslyBound !== null && observation.tagId !== previouslyBound) {
    throw refusal("STOP", "ONESHOT_IMAGE_CHANGED", "One-shot image id changed before spawn");
  }
  if (observation.tagId !== expected) {
    throw refusal("STOP", "ONESHOT_IMAGE_UNAPPROVED", "One-shot image id is not the approved image");
  }
  return observation.tagId;
}

const LAUNCHER_SOURCE = String.raw`const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const raw = fs.readFileSync("/run/secrets/p1-database.env", "utf8");
const lines = raw.split(/\n/).filter((line) => line.length > 0 && line.startsWith("DATABASE_URL="));
if (lines.length !== 1) process.exit(2);
process.env.DATABASE_URL = lines[0].slice("DATABASE_URL=".length);
const child = spawnSync(process.execPath, [
  "/opt/migrator/node_modules/prisma/build/index.js",
  "migrate",
  "deploy",
  "--schema",
  "/sealed/prisma/schema.prisma",
], { env: process.env, stdio: "inherit" });
if (child.error || child.signal) process.exit(1);
process.exit(child.status === null ? 1 : child.status);
`;

export type OneShotPlan = {
  argv: readonly string[];
};

export function planProductionOneShot(input: {
  networkName: string;
  dnsAlias: string;
  databaseName: string;
  roleName: string;
  password: string;
  sealedRoot: string;
  credentialDir: string;
  appContainerId: string;
  appContainerName: string;
  dbContainerName: string;
  imageId: string;
}): OneShotPlan {
  if (input.dnsAlias !== PRODUCTION_DNS_ALIAS) {
    throw refusal("STOP", "NETWORK_ALIAS_MISMATCH", "One-shot hostname is not the compose dns alias");
  }
  if (input.password.length < 16 || /[\r\n]/.test(input.password)) {
    throw refusal("STOP", "RUNTIME_UNAUTHENTICATED", "Database credential is not usable");
  }
  if (!IMAGE_ID.test(input.imageId)) {
    throw refusal("STOP", "ONESHOT_IMAGE_MALFORMED", "One-shot image id is not a Docker image digest");
  }
  const launcherPath = path.join(input.credentialDir, "migrate.cjs");
  const secretPath = path.join(input.credentialDir, "database.env");
  const url = connectionUrl(input);
  const argv = [
    "run",
    "--rm",
    "--pull",
    "never",
    "--network",
    input.networkName,
    "--entrypoint",
    "node",
    "--workdir",
    "/tmp",
    "-v",
    `${dockerPath(input.sealedRoot)}:/sealed:ro`,
    "-v",
    `${dockerPath(secretPath)}:/run/secrets/p1-database.env:ro`,
    "-v",
    `${dockerPath(launcherPath)}:/opt/${path.basename(ONE_SHOT_LAUNCHER)}:ro`,
    input.imageId,
    ONE_SHOT_LAUNCHER,
  ];
  if (argv.some((arg) => typeof arg !== "string" || arg.length === 0)) {
    throw refusal("STOP", "FORBIDDEN_PRISMA_COMMAND", "One-shot command is incomplete");
  }
  if (
    argv.some(
      (arg) =>
        arg.includes(input.password) ||
        arg.includes("DATABASE_URL=") ||
        /postgres(?:ql)?:\/\//i.test(arg) ||
        arg.includes("docker-entrypoint.sh") ||
        arg === input.appContainerId ||
        arg === input.appContainerName ||
        arg === input.dbContainerName ||
        arg === "--build" ||
        arg === "resolve" ||
        arg === "dev" ||
        arg === "reset" ||
        arg === ONE_SHOT_IMAGE,
    )
  ) {
    throw refusal("STOP", "APP_REPLACEMENT_FORBIDDEN", "One-shot plan is not an isolated migrate deploy");
  }
  if (!argv.includes("--entrypoint") || !argv.includes("node") || !argv.includes(input.networkName)) {
    throw refusal("STOP", "FORBIDDEN_PRISMA_COMMAND", "One-shot command is not migrate deploy");
  }
  writeCredentialFiles(input.credentialDir, secretPath, launcherPath, url, input.password);
  return { argv };
}

function connectionUrl(input: {
  dnsAlias: string;
  databaseName: string;
  roleName: string;
  password: string;
}): URL {
  const url = new URL("postgresql://placeholder");
  url.username = input.roleName;
  url.password = input.password;
  url.hostname = input.dnsAlias;
  url.port = "5432";
  url.pathname = `/${input.databaseName}`;
  url.searchParams.set("schema", "public");
  url.searchParams.set("connect_timeout", "5");
  return url;
}

function writeCredentialFiles(
  directory: string,
  secretPath: string,
  launcherPath: string,
  url: URL,
  password: string,
): void {
  fs.rmSync(directory, { recursive: true, force: true });
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  const handle = fs.openSync(secretPath, "wx", 0o600);
  try {
    fs.writeFileSync(handle, `DATABASE_URL=${url.href}\n`);
  } finally {
    fs.closeSync(handle);
  }
  fs.chmodSync(secretPath, 0o600);
  if (LAUNCHER_SOURCE.includes(password) || /postgres(?:ql)?:\/\//i.test(LAUNCHER_SOURCE)) {
    throw refusal("STOP", "CREDENTIAL_LEAK", "Migration launcher contains a credential");
  }
  fs.writeFileSync(launcherPath, LAUNCHER_SOURCE, { mode: 0o600 });
}

function dockerPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const drive = /^([A-Za-z]):\//.exec(normalized);
  if (!drive?.[1]) return normalized;
  return `/${drive[1].toLowerCase()}${normalized.slice(2)}`;
}
