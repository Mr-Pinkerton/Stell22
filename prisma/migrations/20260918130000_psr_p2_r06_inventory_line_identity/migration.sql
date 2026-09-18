-- PSR-P2 R-06: one Inventory document cannot contain the same physical
-- count target twice. Uniqueness only. No historical Inventory rewrite,
-- no stock quantity mutation, no movement rows, no trigger, no backfill.
-- One explicit PostgreSQL transaction: Prisma 6 classic migration.sql
-- is not wrapped automatically.

BEGIN;

CREATE UNIQUE INDEX "InventoryLine_inventoryId_refType_refId_key"
  ON "InventoryLine"("inventoryId", "refType", "refId");

COMMIT;
