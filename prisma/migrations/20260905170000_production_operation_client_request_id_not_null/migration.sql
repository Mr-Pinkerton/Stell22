-- DI-008 C: ProductionOperation.clientRequestId NOT NULL, UNIQUE сохраняется.
-- LOCK + recheck + RAISE при NULL. Без UPDATE / backfill / DELETE.
-- Существующий UNIQUE INDEX ProductionOperation_clientRequestId_key не трогать.
-- Одна явная транзакция PostgreSQL: Prisma 6 classic PostgreSQL migration.sql
-- не оборачивается в транзакцию автоматически.

BEGIN;

LOCK TABLE "ProductionOperation" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  n_null integer;
  detail text;
BEGIN
  SELECT count(*) INTO n_null
  FROM "ProductionOperation"
  WHERE "clientRequestId" IS NULL;

  IF n_null > 0 THEN
    SELECT string_agg(
             format(
               'id=%s type=%s employeeId=%s workDate=%s createdAt=%s',
               id,
               type,
               "employeeId",
               "workDate",
               "createdAt"
             ),
             '; ' ORDER BY "createdAt", id
           )
    INTO detail
    FROM "ProductionOperation"
    WHERE "clientRequestId" IS NULL;

    RAISE EXCEPTION
      'DI-008: % ProductionOperation row(s) have NULL clientRequestId: %; resolve before migrate (no backfill/delete)',
      n_null, detail;
  END IF;
END $$;

ALTER TABLE "ProductionOperation"
  ALTER COLUMN "clientRequestId" SET NOT NULL;

COMMIT;
