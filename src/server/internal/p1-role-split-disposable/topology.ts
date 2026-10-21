/**
 * Disposable role topology.
 * This module does not install roles in production and does not change the startup gate.
 * `stell22` remains the production login. `stell22_migrator` is the existing proposed migrator.
 */

import { PROPOSED_MIGRATOR_ROLE } from "@/server/internal/p1-production-adapter/contract";

export const DISPOSABLE_APP_ROLE = "stell22_app" as const;
export const DISPOSABLE_ADMIN_ROLE = "p1as_admin" as const;
export const MIGRATOR_ROLE = PROPOSED_MIGRATOR_ROLE;

const DATABASE_NAME = /^p1as_[0-9a-f]{8}$/;
const PASSWORD = /^[0-9a-f]{32}$/;

export function roleTopologySql(input: { databaseName: string; appPassword: string; migratorPassword: string }): string {
  if (!DATABASE_NAME.test(input.databaseName)) throw new Error("disposable database name is not accepted");
  if (input.databaseName === "stell22") throw new Error("production database name is refused");
  if (!PASSWORD.test(input.appPassword) || !PASSWORD.test(input.migratorPassword)) throw new Error("test credential is not hex");
  if (input.appPassword === input.migratorPassword) throw new Error("application and migrator credentials must differ");
  const database = input.databaseName;
  return [
    `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`,
    "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
    "REVOKE USAGE ON SCHEMA public FROM PUBLIC",
    `CREATE ROLE ${DISPOSABLE_APP_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${input.appPassword}'`,
    `CREATE ROLE ${MIGRATOR_ROLE} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${input.migratorPassword}'`,
    `GRANT CONNECT ON DATABASE ${database} TO ${DISPOSABLE_APP_ROLE}`,
    `GRANT CONNECT ON DATABASE ${database} TO ${MIGRATOR_ROLE}`,
    `GRANT USAGE ON SCHEMA public TO ${DISPOSABLE_APP_ROLE}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATOR_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${DISPOSABLE_APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${DISPOSABLE_APP_ROLE}`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`,
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR_ROLE} IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${DISPOSABLE_APP_ROLE}`,
  ].join(";\n");
}

export function migrationHistoryPrivilegesSql(): string {
  return [
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE public."_prisma_migrations" FROM ${DISPOSABLE_APP_ROLE}`,
    `GRANT SELECT ON TABLE public."_prisma_migrations" TO ${DISPOSABLE_APP_ROLE}`,
  ].join(";\n");
}
