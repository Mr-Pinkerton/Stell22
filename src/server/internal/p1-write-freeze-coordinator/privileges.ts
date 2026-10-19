import { COORDINATOR_ROLES, type RestrictionReport } from "@/server/internal/p1-write-freeze-coordinator/contract";
import { assertCoordinatorDatabase } from "@/server/internal/p1-write-freeze-coordinator/identity";

const APP = COORDINATOR_ROLES.application;
const MIGRATOR = COORDINATOR_ROLES.migrator;
const BREAK_GLASS = COORDINATOR_ROLES.breakglass;

/** One transaction. LOGIN is not the freeze, and a maintenance flag is not used. */
export function freezeTransactionSql(database: string): string {
  assertCoordinatorDatabase(database);
  const quoted = quoteIdent(database);
  return `
BEGIN;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA public FROM ${APP}, PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${APP}, PUBLIC;
REVOKE CREATE ON SCHEMA public FROM ${APP}, PUBLIC;
REVOKE CREATE ON DATABASE ${quoted} FROM ${APP}, PUBLIC;
GRANT CONNECT ON DATABASE ${quoted} TO ${APP};
GRANT USAGE ON SCHEMA public TO ${APP};
GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${APP};
DO $p1wc$
DECLARE rec record;
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_auth_members am
    JOIN pg_roles member_role ON member_role.oid = am.member
    JOIN pg_roles granted_role ON granted_role.oid = am.roleid
    WHERE member_role.rolname = '${APP}' AND granted_role.rolname = '${MIGRATOR}'
  ) THEN
    EXECUTE 'REVOKE ${MIGRATOR} FROM ${APP}';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members am
    JOIN pg_roles member_role ON member_role.oid = am.member
    JOIN pg_roles granted_role ON granted_role.oid = am.roleid
    WHERE member_role.rolname = '${APP}' AND granted_role.rolname = '${BREAK_GLASS}'
  ) THEN
    EXECUTE 'REVOKE ${BREAK_GLASS} FROM ${APP}';
  END IF;
  FOR rec IN
    SELECT table_schema, table_name, column_name, privilege_type, grantee
    FROM information_schema.column_privileges
    WHERE table_schema = 'public'
      AND grantee IN ('${APP}', 'PUBLIC')
      AND privilege_type IN ('INSERT', 'UPDATE', 'REFERENCES')
  LOOP
    IF rec.grantee = 'PUBLIC' THEN
      EXECUTE format(
        'REVOKE %s (%I) ON TABLE %I.%I FROM PUBLIC',
        rec.privilege_type, rec.column_name, rec.table_schema, rec.table_name
      );
    ELSE
      EXECUTE format(
        'REVOKE %s (%I) ON TABLE %I.%I FROM %I',
        rec.privilege_type, rec.column_name, rec.table_schema, rec.table_name, rec.grantee
      );
    END IF;
  END LOOP;
  FOR rec IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM ${APP}, PUBLIC', rec.signature);
  END LOOP;
END
$p1wc$;
ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR} IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON TABLES FROM ${APP}, PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR} IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM ${APP}, PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE ${MIGRATOR} IN SCHEMA public
  GRANT SELECT ON TABLES TO ${APP};
COMMIT;`.trim();
}

/** Restores ordinary DML. It does not grant schema or database CREATE. */
export function unfreezeTransactionSql(database: string): string {
  assertCoordinatorDatabase(database);
  return `
BEGIN;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO ${APP};
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${APP};
COMMIT;`.trim();
}

export function digestSql(): string {
  return `
SELECT md5(coalesce(string_agg(line, E'\\n' ORDER BY line), ''))
FROM (
  SELECT 'inventory|' || id::text || '|' || sku || '|' || qty::text AS line FROM p1wc_inventory
  UNION ALL
  SELECT 'production|' || id::text || '|' || output_qty::text FROM p1wc_production
  UNION ALL
  SELECT 'purchase|' || id::text || '|' || amount::text FROM p1wc_purchase
  UNION ALL
  SELECT 'cost|' || id::text || '|' || amount::text FROM p1wc_cost
  UNION ALL
  SELECT 'finance|' || id::text || '|' || amount::text FROM p1wc_finance
  UNION ALL
  SELECT 'notification|' || id::text || '|' || body FROM p1wc_notification
  UNION ALL
  SELECT 'migration|' || id::text || '|' || name || '|' || checksum FROM p1wc_migration_history
  UNION ALL
  SELECT 'batch|' || id || '|' || "requestId" || '|' || "batchId" FROM "BatchCreationCommand"
) rows`.trim();
}

export function canaryStatements(): Record<keyof RestrictionReport, string> {
  return {
    setRoleInsert: `SET ROLE ${APP}; INSERT INTO p1wc_inventory (id, sku, qty) VALUES (9001, 'set-role', 1);`,
    loginSelect: "SELECT count(*) FROM p1wc_inventory;",
    loginInsert: "INSERT INTO p1wc_inventory (id, sku, qty) VALUES (9002, 'insert', 1);",
    loginUpdate: "UPDATE p1wc_inventory SET qty = qty + 1 WHERE id = 1;",
    loginDelete: "DELETE FROM p1wc_inventory WHERE id = 1;",
    loginTruncate: "TRUNCATE p1wc_inventory;",
    loginNextval: "SELECT nextval('p1wc_business_seq');",
    loginSetval: "SELECT setval('p1wc_business_seq', 10);",
    loginCreate: "CREATE TABLE p1wc_should_not_exist (id int);",
    loginSetRole: `SET ROLE ${MIGRATOR};`,
    securityDefiner: "SELECT p1wc_hidden_write();",
  };
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
