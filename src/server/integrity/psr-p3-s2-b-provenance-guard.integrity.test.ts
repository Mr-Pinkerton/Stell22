import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  assertSafeIntegrityUrl,
  createIntegrityClients,
  ensureIntegritySchema,
  integrityDatabaseUrl,
} from "./harness";

const enabled = Boolean(process.env.INTEGRITY_TEST_DATABASE_URL);
const ROLE = "psr_p3_s2_b_ordinary";

type Probe = {
  rejected: boolean;
  sqlstate: string | null;
  message: string | null;
  present: boolean;
  snapshot_is_sql_null: boolean;
  same_object: boolean;
  admin: string | null;
  role: string;
  superuser: boolean;
  replication_role: string;
};

const probeFunctionSql = `
CREATE FUNCTION psr_p3_s2_b_guard_probe(op text)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  role_name text;
  is_super boolean;
  repl text;
  rid text := 'psr-p3-p1-' || op;
  req text := 'req-' || op;
  bid text := 'batch-' || op;
  snap jsonb;
  admin text;
  present boolean := false;
  rejected boolean := false;
  err_state text := NULL;
  err_message text := NULL;
  object_snapshot jsonb := '{"a":1,"b":2}'::jsonb;
BEGIN
  SELECT current_user, r.rolsuper, current_setting('session_replication_role')
    INTO role_name, is_super, repl
    FROM pg_roles r
   WHERE r.rolname = current_user;

  IF role_name <> 'psr_p3_s2_b_ordinary' OR is_super IS TRUE OR repl <> 'origin' THEN
    RAISE EXCEPTION 'ordinary role proof failed: % super=% repl=%', role_name, is_super, repl;
  END IF;

  IF op IN (
    'insert_object',
    'insert_null',
    'insert_json_null',
    'insert_array',
    'insert_string',
    'insert_number',
    'insert_bool'
  ) THEN
    BEGIN
      IF op = 'insert_object' THEN
        INSERT INTO "BatchCreationCommand"
          (id, "requestId", "batchId", "adminUserId", "requestSnapshot", "receiptProvenanceSnapshot")
        VALUES (rid, req, bid, 'admin', '{}'::jsonb, object_snapshot);
      ELSIF op = 'insert_null' THEN
        INSERT INTO "BatchCreationCommand"
          (id, "requestId", "batchId", "adminUserId", "requestSnapshot")
        VALUES (rid, req, bid, 'admin', '{}'::jsonb);
      ELSIF op = 'insert_json_null' THEN
        INSERT INTO "BatchCreationCommand"
          (id, "requestId", "batchId", "adminUserId", "requestSnapshot", "receiptProvenanceSnapshot")
        VALUES (rid, req, bid, 'admin', '{}'::jsonb, 'null'::jsonb);
      ELSIF op = 'insert_array' THEN
        INSERT INTO "BatchCreationCommand"
          (id, "requestId", "batchId", "adminUserId", "requestSnapshot", "receiptProvenanceSnapshot")
        VALUES (rid, req, bid, 'admin', '{}'::jsonb, '[]'::jsonb);
      ELSIF op = 'insert_string' THEN
        INSERT INTO "BatchCreationCommand"
          (id, "requestId", "batchId", "adminUserId", "requestSnapshot", "receiptProvenanceSnapshot")
        VALUES (rid, req, bid, 'admin', '{}'::jsonb, '"text"'::jsonb);
      ELSIF op = 'insert_number' THEN
        INSERT INTO "BatchCreationCommand"
          (id, "requestId", "batchId", "adminUserId", "requestSnapshot", "receiptProvenanceSnapshot")
        VALUES (rid, req, bid, 'admin', '{}'::jsonb, '7'::jsonb);
      ELSIF op = 'insert_bool' THEN
        INSERT INTO "BatchCreationCommand"
          (id, "requestId", "batchId", "adminUserId", "requestSnapshot", "receiptProvenanceSnapshot")
        VALUES (rid, req, bid, 'admin', '{}'::jsonb, 'true'::jsonb);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      rejected := true;
      err_state := SQLSTATE;
      err_message := SQLERRM;
    END;
  ELSIF op = 'duplicate_request' OR op = 'duplicate_batch' THEN
    INSERT INTO "BatchCreationCommand"
      (id, "requestId", "batchId", "adminUserId", "requestSnapshot")
    VALUES (rid, req, bid, 'admin', '{}'::jsonb);
    BEGIN
      IF op = 'duplicate_request' THEN
        INSERT INTO "BatchCreationCommand"
          (id, "requestId", "batchId", "adminUserId", "requestSnapshot")
        VALUES (rid || '-2', req, bid || '-2', 'admin', '{}'::jsonb);
      ELSE
        INSERT INTO "BatchCreationCommand"
          (id, "requestId", "batchId", "adminUserId", "requestSnapshot")
        VALUES (rid || '-2', req || '-2', bid, 'admin', '{}'::jsonb);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      rejected := true;
      err_state := SQLSTATE;
      err_message := SQLERRM;
    END;
  ELSE
    IF op IN ('fill_null', 'update_admin_on_null', 'delete_null') THEN
      INSERT INTO "BatchCreationCommand"
        (id, "requestId", "batchId", "adminUserId", "requestSnapshot")
      VALUES (rid, req, bid, 'admin', '{}'::jsonb);
    ELSE
      INSERT INTO "BatchCreationCommand"
        (id, "requestId", "batchId", "adminUserId", "requestSnapshot", "receiptProvenanceSnapshot")
      VALUES (rid, req, bid, 'admin', '{}'::jsonb, object_snapshot);
    END IF;

    BEGIN
      IF op = 'replace_object' THEN
        UPDATE "BatchCreationCommand"
           SET "receiptProvenanceSnapshot" = '{"a":9}'::jsonb
         WHERE id = rid;
      ELSIF op = 'clear_object' THEN
        UPDATE "BatchCreationCommand"
           SET "receiptProvenanceSnapshot" = NULL
         WHERE id = rid;
      ELSIF op = 'fill_null' THEN
        UPDATE "BatchCreationCommand"
           SET "receiptProvenanceSnapshot" = object_snapshot
         WHERE id = rid;
      ELSIF op = 'change_id' THEN
        UPDATE "BatchCreationCommand"
           SET id = rid || '-x'
         WHERE id = rid;
      ELSIF op = 'change_request' THEN
        UPDATE "BatchCreationCommand"
           SET "requestId" = req || '-x'
         WHERE id = rid;
      ELSIF op = 'change_batch' THEN
        UPDATE "BatchCreationCommand"
           SET "batchId" = bid || '-x'
         WHERE id = rid;
      ELSIF op = 'same_json' THEN
        UPDATE "BatchCreationCommand"
           SET "receiptProvenanceSnapshot" = '{"b":2,"a":1}'::jsonb
         WHERE id = rid;
      ELSIF op = 'update_admin_on_object' OR op = 'update_admin_on_null' THEN
        UPDATE "BatchCreationCommand"
           SET "adminUserId" = 'other-admin',
               "requestSnapshot" = '{"note":"unprotected"}'::jsonb
         WHERE id = rid;
      ELSIF op = 'delete_object' OR op = 'delete_null' THEN
        DELETE FROM "BatchCreationCommand" WHERE id = rid;
      ELSE
        RAISE EXCEPTION 'unknown provenance probe %', op;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      rejected := true;
      err_state := SQLSTATE;
      err_message := SQLERRM;
    END;
  END IF;

  SELECT "receiptProvenanceSnapshot", "adminUserId"
    INTO snap, admin
    FROM "BatchCreationCommand"
   WHERE id = rid;
  present := FOUND;

  RETURN jsonb_build_object(
    'rejected', rejected,
    'sqlstate', err_state,
    'message', err_message,
    'present', present,
    'snapshot_is_sql_null', present AND snap IS NULL,
    'same_object', present AND snap = object_snapshot,
    'admin', admin,
    'role', role_name,
    'superuser', is_super,
    'replication_role', repl
  );
END;
$fn$;
`;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyExists(error: unknown): boolean {
  const text = errorText(error);
  return text.includes("42710") || text.includes("42723") || /already exists/i.test(text);
}

describe.skipIf(!enabled)("PSR-P3 Slice 2-B P1 provenance guard", () => {
  let prisma: ReturnType<typeof createIntegrityClients>["prismaA"];
  let retainedBefore = 0;
  let roleCreatedByThisInvocation = false;
  let functionCreatedByThisInvocation = false;
  let cleaned = false;

  async function cleanupOwnedObjects(): Promise<void> {
    if (!prisma || cleaned) return;
    const failures: unknown[] = [];
    const run = async (sql: string) => {
      try {
        await prisma.$executeRawUnsafe(sql);
      } catch (error) {
        failures.push(error);
      }
    };
    if (roleCreatedByThisInvocation && functionCreatedByThisInvocation) {
      await run(`REVOKE EXECUTE ON FUNCTION psr_p3_s2_b_guard_probe(text) FROM ${ROLE}`);
    }
    if (roleCreatedByThisInvocation) {
      await run(`REVOKE ALL ON TABLE "BatchCreationCommand" FROM ${ROLE}`);
      await run(`REVOKE USAGE ON SCHEMA public FROM ${ROLE}`);
    }
    if (functionCreatedByThisInvocation) {
      await run(`DROP FUNCTION psr_p3_s2_b_guard_probe(text)`);
      if (!failures.length) functionCreatedByThisInvocation = false;
    }
    if (roleCreatedByThisInvocation) {
      const failuresBeforeRoleDrop = failures.length;
      await run(`DROP ROLE ${ROLE}`);
      if (failures.length === failuresBeforeRoleDrop) roleCreatedByThisInvocation = false;
    }
    try {
      await prisma.$disconnect();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 0) cleaned = true;
    if (failures.length > 0) {
      throw new Error(failures.map(errorText).join("\n"));
    }
  }

  beforeAll(async () => {
    const url = integrityDatabaseUrl();
    assertSafeIntegrityUrl(url);
    ensureIntegritySchema();
    ({ prismaA: prisma } = createIntegrityClients());
    try {
      try {
        await prisma.$executeRawUnsafe(`CREATE ROLE ${ROLE} NOLOGIN NOINHERIT`);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new Error(
            `Refusing to reuse pre-existing cluster role ${ROLE}. Database name does not isolate CREATE ROLE.`,
            { cause: error },
          );
        }
        throw error;
      }
      roleCreatedByThisInvocation = true;
      await prisma.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
      await prisma.$executeRawUnsafe(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "BatchCreationCommand" TO ${ROLE}`,
      );
      try {
        await prisma.$executeRawUnsafe(probeFunctionSql);
      } catch (error) {
        if (isAlreadyExists(error)) {
          throw new Error(
            "Refusing to replace pre-existing function psr_p3_s2_b_guard_probe(text).",
            { cause: error },
          );
        }
        throw error;
      }
      functionCreatedByThisInvocation = true;
      await prisma.$executeRawUnsafe(
        `GRANT EXECUTE ON FUNCTION psr_p3_s2_b_guard_probe(text) TO ${ROLE}`,
      );
      const before = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM "BatchCreationCommand"
        WHERE "receiptProvenanceSnapshot" IS NOT NULL
      `;
      retainedBefore = before[0]?.n ?? 0;
    } catch (error) {
      let cleanupError: unknown;
      try {
        await cleanupOwnedObjects();
      } catch (cleanupFailure) {
        cleanupError = cleanupFailure;
      }
      if (cleanupError) {
        throw new Error(`${errorText(error)}\n${errorText(cleanupError)}`, { cause: error });
      }
      throw error;
    }
  });

  afterAll(async () => {
    if (!prisma) return;
    let countError: unknown;
    try {
      const after = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n
        FROM "BatchCreationCommand"
        WHERE "receiptProvenanceSnapshot" IS NOT NULL
      `;
      expect(after[0]?.n ?? 0).toBe(retainedBefore);
    } catch (error) {
      countError = error;
    }
    let cleanupError: unknown;
    try {
      await cleanupOwnedObjects();
    } catch (error) {
      cleanupError = error;
    }
    if (countError && cleanupError) {
      throw new Error(`${errorText(countError)}\n${errorText(cleanupError)}`, { cause: countError });
    }
    if (cleanupError) throw cleanupError;
    if (countError) throw countError;
  });

  async function probe(op: string): Promise<Probe> {
    let result: Probe | undefined;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${ROLE}`);
        const rows = await tx.$queryRaw<Array<{ result: Probe }>>(
          Prisma.sql`SELECT psr_p3_s2_b_guard_probe(${op}) AS result`,
        );
        result = rows[0]?.result;
        throw new Error("ROLLBACK_PROBE");
      });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("ROLLBACK_PROBE")) {
        throw error;
      }
    }
    if (!result) {
      throw new Error(`probe ${op} returned no result`);
    }
    expect(result.role).toBe(ROLE);
    expect(result.superuser).toBe(false);
    expect(result.replication_role).toBe("origin");
    return result;
  }

  it("records the applied migration, nullable column, check, and enabled trigger", async () => {
    const applied = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM "_prisma_migrations"
      WHERE migration_name = '20261010210000_psr_p3_s2_b_batch_receipt_provenance'
        AND finished_at IS NOT NULL
        AND rolled_back_at IS NULL
    `;
    expect(applied[0]?.n).toBe(1);

    const column = await prisma.$queryRaw<
      Array<{ is_nullable: string; column_default: string | null; data_type: string }>
    >`
      SELECT is_nullable, column_default, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'BatchCreationCommand'
        AND column_name = 'receiptProvenanceSnapshot'
    `;
    expect(column).toEqual([
      { is_nullable: "YES", column_default: null, data_type: "jsonb" },
    ]);

    const checks = await prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conrelid = '"BatchCreationCommand"'::regclass
        AND conname = 'BatchCreationCommand_receiptProvenanceSnapshot_shape'
    `;
    expect(checks[0]?.def).toMatch(/jsonb_typeof/);
    expect(checks[0]?.def).toMatch(/IS NULL/);

    const fks = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
      FROM pg_constraint
      WHERE conrelid = '"BatchCreationCommand"'::regclass
        AND contype = 'f'
    `;
    expect(fks[0]?.n).toBe(0);

    const trigger = await prisma.$queryRaw<
      Array<{ tgenabled: string; definer: boolean; definition: string }>
    >`
      SELECT t.tgenabled::text AS tgenabled,
             p.prosecdef AS definer,
             pg_get_triggerdef(t.oid) AS definition
      FROM pg_trigger t
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = '"BatchCreationCommand"'::regclass
        AND NOT t.tgisinternal
        AND t.tgname = 'batch_creation_command_provenance_guard'
    `;
    expect(trigger).toHaveLength(1);
    expect(trigger[0]?.tgenabled).toBe("O");
    expect(trigger[0]?.definer).toBe(false);
    expect(trigger[0]?.definition).toMatch(/BEFORE (UPDATE OR DELETE|DELETE OR UPDATE)/);
  });

  it("accepts an object and SQL NULL, and rejects JSON null, arrays, and scalars", async () => {
    const objectRow = await probe("insert_object");
    expect(objectRow.rejected).toBe(false);
    expect(objectRow.present).toBe(true);
    expect(objectRow.same_object).toBe(true);

    const nullRow = await probe("insert_null");
    expect(nullRow.rejected).toBe(false);
    expect(nullRow.present).toBe(true);
    expect(nullRow.snapshot_is_sql_null).toBe(true);

    for (const op of ["insert_json_null", "insert_array", "insert_string", "insert_number", "insert_bool"]) {
      const rejected = await probe(op);
      expect(rejected.rejected, op).toBe(true);
      expect(rejected.present, op).toBe(false);
      expect(rejected.sqlstate, op).toBe("23514");
    }
  });

  it("keeps SQL NULL distinct from JSON null", async () => {
    const sqlNull = await probe("insert_null");
    const jsonNull = await probe("insert_json_null");
    expect(sqlNull.snapshot_is_sql_null).toBe(true);
    expect(jsonNull.rejected).toBe(true);
    expect(jsonNull.present).toBe(false);
    expect(jsonNull.message ?? "").not.toMatch(/immutable|retained|cannot be filled/);
  });

  it("rejects object replacement, clearing, and legacy NULL fill", async () => {
    const replaced = await probe("replace_object");
    expect(replaced.rejected).toBe(true);
    expect(replaced.present).toBe(true);
    expect(replaced.same_object).toBe(true);
    expect(replaced.message).toMatch(/immutable/);

    const cleared = await probe("clear_object");
    expect(cleared.rejected).toBe(true);
    expect(cleared.snapshot_is_sql_null).toBe(false);
    expect(cleared.same_object).toBe(true);

    const filled = await probe("fill_null");
    expect(filled.rejected).toBe(true);
    expect(filled.present).toBe(true);
    expect(filled.snapshot_is_sql_null).toBe(true);
    expect(filled.message).toMatch(/cannot be filled/);
  });

  it("rejects identity changes on a retained object and allows the same JSON value", async () => {
    for (const op of ["change_id", "change_request", "change_batch"]) {
      const rejected = await probe(op);
      expect(rejected.rejected, op).toBe(true);
      expect(rejected.present, op).toBe(true);
      expect(rejected.same_object, op).toBe(true);
      expect(rejected.message, op).toMatch(/immutable/);
    }

    const same = await probe("same_json");
    expect(same.rejected).toBe(false);
    expect(same.same_object).toBe(true);
  });

  it("allows an unprotected update and rejects delete only when an object is stored", async () => {
    const objectUpdate = await probe("update_admin_on_object");
    expect(objectUpdate.rejected).toBe(false);
    expect(objectUpdate.admin).toBe("other-admin");
    expect(objectUpdate.same_object).toBe(true);

    const nullUpdate = await probe("update_admin_on_null");
    expect(nullUpdate.rejected).toBe(false);
    expect(nullUpdate.admin).toBe("other-admin");
    expect(nullUpdate.snapshot_is_sql_null).toBe(true);

    const deletedObject = await probe("delete_object");
    expect(deletedObject.rejected).toBe(true);
    expect(deletedObject.present).toBe(true);
    expect(deletedObject.same_object).toBe(true);
    expect(deletedObject.message).toMatch(/retained/);

    const deletedNull = await probe("delete_null");
    expect(deletedNull.rejected).toBe(false);
    expect(deletedNull.present).toBe(false);
  });

  it("preserves requestId and batchId uniqueness for an old-writer insert", async () => {
    const request = await probe("duplicate_request");
    expect(request.rejected).toBe(true);
    expect(request.sqlstate).toBe("23505");
    expect(request.present).toBe(true);
    expect(request.snapshot_is_sql_null).toBe(true);

    const batch = await probe("duplicate_batch");
    expect(batch.rejected).toBe(true);
    expect(batch.sqlstate).toBe("23505");
    expect(batch.snapshot_is_sql_null).toBe(true);
  });
});
