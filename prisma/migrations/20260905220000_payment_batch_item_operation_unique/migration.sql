-- DI-014: UNIQUE PaymentBatchItem.operationId — at most one item per operation.
-- LOCK + duplicate guard + RAISE. No UPDATE / DELETE / DROP / backfill / dedup.
-- One explicit PostgreSQL transaction. Prisma 6 classic PostgreSQL
-- migration.sql is not wrapped in a transaction automatically.

BEGIN;

LOCK TABLE "PaymentBatchItem" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  duplicate_count integer;
BEGIN
  SELECT COUNT(*)
  INTO duplicate_count
  FROM (
    SELECT "operationId"
    FROM "PaymentBatchItem"
    GROUP BY "operationId"
    HAVING COUNT(*) > 1
  ) d;

  IF duplicate_count > 0 THEN
    RAISE EXCEPTION
      'DI-014: PaymentBatchItem contains % duplicate operationId values',
      duplicate_count;
  END IF;
END $$;

CREATE UNIQUE INDEX
  "PaymentBatchItem_operationId_key"
ON "PaymentBatchItem"("operationId");

COMMIT;
