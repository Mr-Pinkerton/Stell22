import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ONE_SHOT_IMAGE } from "@/server/internal/p1-isolated-runner/p1-release-gate";
import { ONE_SHOT_LAUNCHER } from "@/server/internal/p1-isolated-runner/p1-release-execute";
import { refusal, RunnerRefusal } from "@/server/internal/p1-isolated-runner/refusal";
import { IMAGE_ID, PRODUCTION_DNS_ALIAS } from "@/server/internal/p1-production-adapter/contract";
import { fileIdentity, sameFileIdentity, type FileIdentity } from "@/server/internal/p1-production-adapter/file-identity";

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

export type CredentialFault = {
  failOwnerWrite?: boolean;
  failSecretWrite?: boolean;
  failOwnerClose?: boolean;
  failSecretClose?: boolean;
};

export type ProductionCredentialClaim = {
  directory: string;
  ownerToken: string;
  files: {
    owner: FileIdentity;
    secret: FileIdentity;
    launcher: FileIdentity;
  };
};

export type OneShotPlan = {
  argv: readonly string[];
  credential: ProductionCredentialClaim;
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
  credentialFault?: CredentialFault;
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
  const credential = claimProductionCredential(input.credentialDir, secretPath, launcherPath, url, input.password, input.credentialFault);
  return { argv, credential };
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

function claimProductionCredential(
  directory: string,
  secretPath: string,
  launcherPath: string,
  url: URL,
  password: string,
  fault: CredentialFault | undefined,
): ProductionCredentialClaim {
  if (credentialPathKind(directory) !== "absent") {
    throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Production credential directory already exists");
  }
  const ownerToken = randomBytes(16).toString("hex");
  let owner: FileIdentity | null = null;
  let secret: FileIdentity | null = null;
  let launcher: FileIdentity | null = null;
  try {
    try {
      fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Production credential directory already exists");
      }
      throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Production credential directory could not be created");
    }
    if (credentialPathKind(directory) !== "directory") {
      throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Production credential directory is not a real directory");
    }
    owner = createOwnedFile(path.join(directory, "owner"), `${ownerToken}\n`, {
      failWrite: fault?.failOwnerWrite === true,
      failClose: fault?.failOwnerClose === true,
    });
    secret = createOwnedFile(secretPath, `DATABASE_URL=${url.href}\n`, {
      failWrite: fault?.failSecretWrite === true,
      failClose: fault?.failSecretClose === true,
    });
    if (LAUNCHER_SOURCE.includes(password) || /postgres(?:ql)?:\/\//i.test(LAUNCHER_SOURCE)) {
      throw refusal("STOP", "CREDENTIAL_LEAK", "Migration launcher contains a credential");
    }
    launcher = createOwnedFile(launcherPath, LAUNCHER_SOURCE, {});
    return { directory, ownerToken, files: { owner, secret, launcher } };
  } catch (error) {
    for (const created of [
      launcher === null ? null : { filePath: launcherPath, identity: launcher },
      secret === null ? null : { filePath: secretPath, identity: secret },
      owner === null ? null : { filePath: path.join(directory, "owner"), identity: owner },
    ]) {
      if (!created) continue;
      try {
        unlinkOwnedFile(created.filePath, created.identity);
      } catch {
        throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Production credential cleanup did not finish");
      }
    }
    if (credentialPathKind(directory) === "directory" && fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
    }
    throw error;
  }
}

export function releaseProductionCredential(claim: ProductionCredentialClaim): void {
  const directoryKind = credentialPathKind(claim.directory);
  if (directoryKind === "absent") return;
  if (directoryKind !== "directory") {
    throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Production credential directory is no longer a real directory");
  }
  const ownerPath = path.join(claim.directory, "owner");
  const secretPath = path.join(claim.directory, "database.env");
  const launcherPath = path.join(claim.directory, "migrate.cjs");
  const names = fs.readdirSync(claim.directory).slice().sort();
  if (names.join("\n") !== ["database.env", "migrate.cjs", "owner"].join("\n")) {
    throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Production credential directory holds an unexpected entry");
  }
  const ownerBody = readOwnedFile(ownerPath, claim.files.owner);
  if (ownerBody.toString("utf8") !== `${claim.ownerToken}\n`) {
    throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Production credential owner record is not the record this run created");
  }
  readOwnedFile(secretPath, claim.files.secret);
  readOwnedFile(launcherPath, claim.files.launcher);
  unlinkOwnedFile(secretPath, claim.files.secret);
  unlinkOwnedFile(launcherPath, claim.files.launcher);
  unlinkOwnedFile(ownerPath, claim.files.owner);
  if (fs.readdirSync(claim.directory).length > 0) {
    throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Production credential directory still holds files");
  }
  if (credentialPathKind(claim.directory) !== "directory") {
    throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Production credential directory changed before removal");
  }
  fs.rmdirSync(claim.directory);
}

function readOwnedFile(filePath: string, expected: FileIdentity): Buffer {
  if (credentialPathKind(filePath) !== "file") {
    throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Production credential file is not the regular file this run created");
  }
  const handle = fs.openSync(filePath, "r");
  try {
    const current = fileIdentity(fs.fstatSync(handle));
    if (current === null || !sameFileIdentity(current, expected)) {
      throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Production credential file is not the file this run created");
    }
    return fs.readFileSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function unlinkOwnedFile(filePath: string, expected: FileIdentity): void {
  const current = fs.lstatSync(filePath);
  const identity = fileIdentity(current);
  if (current.isSymbolicLink() || identity === null || !sameFileIdentity(identity, expected)) {
    throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Production credential file changed before removal");
  }
  fs.unlinkSync(filePath);
}

function createOwnedFile(filePath: string, body: string, fault: { failWrite?: boolean; failClose?: boolean }): FileIdentity {
  if (credentialPathKind(filePath) !== "absent") {
    throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Production credential file already exists");
  }
  const handle = fs.openSync(filePath, "wx", 0o600);
  let closed = false;
  let identity: FileIdentity | null = null;
  const closeOnce = () => {
    if (closed) return;
    closed = true;
    fs.closeSync(handle);
  };
  try {
    if (fault.failWrite) {
      fs.writeFileSync(handle, body.slice(0, 1), "utf8");
      throw new Error("injected credential write failure");
    }
    fs.writeFileSync(handle, body, { encoding: "utf8" });
    fs.fsyncSync(handle);
    identity = fileIdentity(fs.fstatSync(handle));
    if (identity === null) {
      throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Production credential file has no file identity");
    }
    if (fault.failClose) throw new Error("injected credential close failure");
    fs.fchmodSync(handle, 0o600);
    closeOnce();
    const settled = fileIdentity(fs.lstatSync(filePath));
    if (settled === null || !sameFileIdentity(settled, identity)) {
      throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Production credential file changed before it was recorded");
    }
    return identity;
  } catch (error) {
    if (identity === null) {
      try {
        identity = fileIdentity(fs.fstatSync(handle));
      } catch {
        identity = null;
      }
    }
    try {
      closeOnce();
    } catch {
      // The partial file stays evidence when it cannot be closed or removed.
    }
    if (identity) {
      try {
        unlinkOwnedFile(filePath, identity);
      } catch {
        // A partial file that cannot be matched is left in place and is not returned as owned.
      }
    }
    if (error instanceof RunnerRefusal) throw error;
    throw refusal("STOP", "SECRET_CLEANUP_FAILED", "Production credential file was not finished");
  }
}

function credentialPathKind(target: string): "absent" | "symlink" | "directory" | "file" | "other" {
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw refusal("STOP", "SECRET_DIRECTORY_COLLISION", "Production credential path could not be classified");
  }
}

function dockerPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const drive = /^([A-Za-z]):\//.exec(normalized);
  if (!drive?.[1]) return normalized;
  return `/${drive[1].toLowerCase()}${normalized.slice(2)}`;
}
