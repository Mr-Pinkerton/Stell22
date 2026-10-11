/**
 * Disposable-only P1 runner contract.
 * There is no production mode and no override flag.
 */
export const P1_RUNNER_MODE = "DISPOSABLE_ONLY" as const;

export const AUTHORIZED_REPOSITORY_COMMIT = "741d6b221b791345c7653d53ef571addf22f5be3";
export const AUTHORIZED_REPOSITORY_TREE = "83582a3c8680cb55c46ff97a46a3313c6804fd15";
export const HISTORICAL_APPLICATION_COMMIT = "678cbc1d308ddfe568b901ebf53f7e05f9a8c014";

export const P1_MIGRATION_NAME = "20261010210000_psr_p3_s2_b_batch_receipt_provenance";
export const P1_MIGRATION_PATH =
  "prisma/migrations/20261010210000_psr_p3_s2_b_batch_receipt_provenance/migration.sql";
export const P1_GIT_BLOB = "3e54eaaae450f76edf75163024bebf4d7d70c358";
export const P1_SHA256 = "47ff9c932aea0a692b81ecfaf6c4a931b431e3e332e3e9c5b3fca96694550fe5";

export const EXPECTED_HISTORICAL_MIGRATION_COUNT = 45;
export const EXPECTED_MIGRATION_SQL_COUNT = 46;
export const PRISMA_VERSION = "6.19.3";

export const FORBIDDEN_DATABASE_NAMES = [
  "stell22",
  "stell22_integrity",
  "stell22_dev",
  "postgres",
  "template0",
  "template1",
] as const;

export const FORBIDDEN_CONTAINER_IDENTIFIERS = [
  "stell22-db-prod",
  "stell22-app",
  "stell22-caddy",
] as const;

export const FORBIDDEN_HOSTS = ["db", "stell22-db-prod"] as const;

export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;

export const EXECUTION_POLICY = {
  allowProduction: false,
  allowResolve: false,
  allowSqlReplay: false,
  allowRetry: false,
  allowBypass: false,
} as const;

export type RunnerVerdict = "READY_FOR_DISPOSABLE_APPLY" | "ALREADY_APPLIED" | "STOP" | "BLOCKED";
