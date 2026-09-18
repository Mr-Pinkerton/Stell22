-- PSR-P2 R-04: durable Supply stock-accounting cycle identity.
-- Does not create InventoryMovement rows. Does not fabricate historical events.
-- One explicit PostgreSQL transaction: Prisma 6 classic migration.sql
-- is not wrapped automatically.

BEGIN;

ALTER TABLE "Supply"
  ADD COLUMN "stockAccountingGeneration" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "stockAccountingOpen" BOOLEAN NOT NULL DEFAULT false;

UPDATE "Supply"
SET
  "stockAccountingGeneration" = 1,
  "stockAccountingOpen" = true
WHERE "deductedQty" > 0
   OR "shortfallQty" > 0;

ALTER TABLE "Supply"
  ADD CONSTRAINT "Supply_stockAccountingGeneration_nonnegative"
  CHECK ("stockAccountingGeneration" >= 0);

ALTER TABLE "Supply"
  ADD CONSTRAINT "Supply_stockAccountingOpen_generation"
  CHECK (
    (NOT "stockAccountingOpen")
    OR "stockAccountingGeneration" >= 1
  );

COMMIT;
