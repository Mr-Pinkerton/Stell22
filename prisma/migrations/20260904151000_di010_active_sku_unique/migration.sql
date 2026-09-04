-- DI-010: partial UNIQUE skuOzon / skuWb among ACTIVE products only.
-- LOCK + recheck + RAISE on dupes. No auto-rename / archive / merge.
-- One explicit PostgreSQL transaction. Prisma 6 classic PostgreSQL
-- migration.sql is not wrapped in a transaction automatically.

BEGIN;

LOCK TABLE "Product" IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  dup text;
BEGIN
  SELECT string_agg(format('%s ozon=%s', id, "skuOzon"), ', ')
  INTO dup
  FROM "Product"
  WHERE status = 'ACTIVE'
    AND "skuOzon" IN (
      SELECT "skuOzon" FROM "Product"
      WHERE status = 'ACTIVE'
      GROUP BY 1 HAVING COUNT(*) > 1
    );

  IF dup IS NOT NULL THEN
    RAISE EXCEPTION
      'DI-010: duplicate ACTIVE skuOzon: %; resolve before migrate (no auto-rename)',
      dup;
  END IF;

  SELECT string_agg(format('%s wb=%s', id, "skuWb"), ', ')
  INTO dup
  FROM "Product"
  WHERE status = 'ACTIVE'
    AND "skuWb" IN (
      SELECT "skuWb" FROM "Product"
      WHERE status = 'ACTIVE'
      GROUP BY 1 HAVING COUNT(*) > 1
    );

  IF dup IS NOT NULL THEN
    RAISE EXCEPTION
      'DI-010: duplicate ACTIVE skuWb: %; resolve before migrate (no auto-rename)',
      dup;
  END IF;
END $$;

CREATE UNIQUE INDEX "Product_skuOzon_active_key"
  ON "Product" ("skuOzon") WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX "Product_skuWb_active_key"
  ON "Product" ("skuWb") WHERE status = 'ACTIVE';

COMMIT;
