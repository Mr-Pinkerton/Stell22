-- PSR-P2 R-07: InventoryMovement.recordedAt is absolute time (timestamptz).
-- Do not rewrite the already-deployed PSR-P1 migration.
-- InventoryMovement currently has no runtime writers; still refuse conversion
-- if any row exists so naive timestamps cannot be silently reinterpreted.
-- One explicit PostgreSQL transaction: Prisma 6 classic migration.sql
-- is not wrapped automatically.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "InventoryMovement") THEN
    RAISE EXCEPTION 'InventoryMovement contains rows; refusing recordedAt timestamp conversion';
  END IF;
END $$;

ALTER TABLE "InventoryMovement"
  ALTER COLUMN "recordedAt" DROP DEFAULT,
  ALTER COLUMN "recordedAt" TYPE TIMESTAMPTZ(3),
  ALTER COLUMN "recordedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "recordedAt" SET NOT NULL;

COMMIT;
