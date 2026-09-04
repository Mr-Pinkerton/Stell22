-- Partial UNIQUE: at most one BatchCost FINAL per batch.
-- LOCK + recheck + RAISE on duplicate FINAL. No auto-delete / merge.
-- One explicit PostgreSQL transaction. Prisma 6 classic PostgreSQL
-- migration.sql is not wrapped in a transaction automatically.

BEGIN;

LOCK TABLE "BatchCost" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(
           format(
             'batchId=%s id=%s calculatedAt=%s costSort1=%s costSort2=%s',
             "batchId",
             id,
             "calculatedAt",
             "costSort1",
             "costSort2"
           ),
           '; '
         )
  INTO dup
  FROM "BatchCost"
  WHERE status = 'FINAL'
    AND "batchId" IN (
      SELECT "batchId"
      FROM "BatchCost"
      WHERE status = 'FINAL'
      GROUP BY 1
      HAVING COUNT(*) > 1
    );

  IF dup IS NOT NULL THEN
    RAISE EXCEPTION
      'DI-005: duplicate BatchCost FINAL: %; resolve before migrate (no auto-delete/merge)',
      dup;
  END IF;
END $$;

CREATE UNIQUE INDEX "BatchCost_batchId_final_key"
  ON "BatchCost" ("batchId")
  WHERE status = 'FINAL';

COMMIT;
