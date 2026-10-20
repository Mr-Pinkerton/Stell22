/**
 * Disposable offline-admission proof.
 * There is no production mode, no production DSN, and no owner signer.
 */

export const PROOF_SCOPE = "TEST_OWNED" as const;
export const PROOF_LABEL = "stell22.p1.offline-writer-admission" as const;
export const APP_IMAGE_REF = "postgres:17-alpine" as const;
export const NAME_PREFIX = "stell22-p1owa-" as const;

export const FORBIDDEN_RESOURCE_NAMES = [
  "stell22-db-prod",
  "stell22-app",
  "stell22-caddy",
  "stell22-db",
  "stell22",
] as const;

export const UNCOVERED_PRODUCTION_CHANNELS = [
  "terminal and ERP Server Actions",
  "production Caddy and public HTTPS",
  "POST /api/cron/fetch-statements",
  "host crontab and other schedulers",
  "getNotifications, pollNotifications, and mark-read",
  "in-process cost queue after a real mutation",
  "historical or production Prisma pool",
  "scripts/fetch-statements.ts",
  "marketplace sync",
  "GitHub workflow_dispatch",
  "docker-entrypoint.sh prisma migrate deploy",
  "physical terminal disconnection",
  "Docker daemon restart",
] as const;

export type AdmissionState = "open" | "closed";

export type Admission = {
  app: AdmissionState;
  proxy: AdmissionState;
};
