/**
 * Production P1 adapter contract.
 * This module does not authorize a production migration.
 * Image ids are Docker digests. They are not Git SHAs.
 * A caller connection string is not target authority.
 */
import { PRODUCTION_NETWORK_NAME } from "@/server/internal/p1-isolated-runner/p1-release-gate";

export const ADAPTER_MODE = "P1_PRODUCTION_ADAPTER" as const;
export const IMAGE_GIT_SHA = "UNVERIFIED" as const;

export const PRODUCTION_APP_CONTAINER = "stell22-app" as const;
export const PRODUCTION_DB_CONTAINER = "stell22-db-prod" as const;
export const PRODUCTION_DATABASE_NAME = "stell22" as const;
export const PRODUCTION_ROLE_NAME = "stell22" as const;
export const PRODUCTION_DNS_ALIAS = "db" as const;
export const PRODUCTION_POSTGRES_IMAGE = "postgres:17-alpine" as const;
export const PRODUCTION_POSTGRES_MAJOR = 17 as const;

export { PRODUCTION_NETWORK_NAME };

/**
 * Fixed path. The CLI does not accept a flag or environment override for it.
 * This repository does not contain the file.
 */
export const PRODUCTION_DAEMON_PIN_PATH = "/var/lib/stell22/p1-production-daemon-pin.json" as const;

/**
 * Fixed path. The repository does not contain the file.
 * `imageId` is the Docker image id (`sha256:` + 64 hex), not the mutable tag.
 * Installing it is a separate production authorization. The operator never builds the image.
 */
export const PRODUCTION_ONESHOT_IMAGE_PIN_PATH = "/var/lib/stell22/p1-oneshot-image-pin.json" as const;

/**
 * Fixed paths. The repository does not contain these files.
 * The trust path holds an Ed25519 public key only.
 * The executor never reads a private signing key.
 */
export const PRODUCTION_AUTHORIZATION_TRUST_PATH = "/var/lib/stell22/p1-owner-authorization.pub" as const;
export const PRODUCTION_SIGNED_AUTHORIZATION_PATH = "/var/lib/stell22/p1-owner-authorization.json" as const;
/** Directory of exclusive-create replay markers. Not a rewriteable log. */
export const PRODUCTION_AUTHORIZATION_REPLAY_DIR = "/var/lib/stell22/p1-owner-authorization-replay" as const;

export const TEST_ROLE_NAME = "p1pa" as const;

export const EXECUTION_PHASES = [
  "READ_ONLY_PREFLIGHT",
  "RECOVERY_VERIFICATION",
  "EXPLICIT_AUTHORIZATION",
  "P1_ONLY_APPLY",
  "POSTCHECK",
] as const;

export type ExecutionPhase = (typeof EXECUTION_PHASES)[number];
export type AdapterScope = "PRODUCTION" | "TEST_OWNED";
export type AdapterIntent = "PREFLIGHT" | "RECOVERY" | "APPLY";

export const SHORTCUT_FLAGS = [
  "--authorize",
  "--authorized",
  "--yes",
  "--force",
  "--production",
  "--apply-now",
  "--database-url",
  "--url",
] as const;

export const CONTAINER_ID = /^[0-9a-f]{64}$/;
export const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
export const ATTEMPT_ID = /^[0-9a-f]{16}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export const DAEMON_ID = /^[A-Za-z0-9:._-]{8,256}$/;

export function testAppName(attemptId: string): string {
  return `p1pa-app-${attemptId}`;
}

export function testDbName(attemptId: string): string {
  return `p1pa-db-${attemptId}`;
}

export function testNetworkName(attemptId: string): string {
  return `p1pa-net-${attemptId}`;
}

export function testDatabaseName(attemptId: string): string {
  return `p1padb_${attemptId}`;
}

export function testRestoreName(attemptId: string): string {
  return `p1pa-restore-${attemptId}`;
}
