-- DI-016 / BD-16.1: partial UNIQUE — не более одной Inventory со status = 'DRAFT'.
-- LOCK + recheck + RAISE при >1 DRAFT. Без auto-delete / auto-conduct / выбора «победителя».
-- Одна явная транзакция PostgreSQL: Prisma 6 classic PostgreSQL migration.sql
-- не оборачивается в транзакцию автоматически.
-- Без CREATE INDEX CONCURRENTLY (несовместимо с транзакцией и с LOCK-моделью).

BEGIN;

LOCK TABLE "Inventory" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  dup   text;
  n_dup integer;
BEGIN
  SELECT count(*) INTO n_dup FROM "Inventory" WHERE status = 'DRAFT';

  IF n_dup > 1 THEN
    SELECT string_agg(
             format(
               'id=%s status=%s createdAt=%s date=%s lines=%s',
               i.id,
               i.status,
               i."createdAt",
               i.date,
               (SELECT count(*) FROM "InventoryLine" l WHERE l."inventoryId" = i.id)
             ),
             '; ' ORDER BY i."createdAt", i.id
           )
    INTO dup
    FROM "Inventory" i
    WHERE i.status = 'DRAFT';

    RAISE EXCEPTION
      'DI-016: % DRAFT inventories exist, expected <= 1: %; resolve before migrate (no auto-delete/auto-conduct)',
      n_dup, dup;
  END IF;
END $$;

CREATE UNIQUE INDEX "Inventory_status_draft_key"
  ON "Inventory" ("status")
  WHERE "status" = 'DRAFT';

COMMIT;
