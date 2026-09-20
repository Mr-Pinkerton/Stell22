-- PSR-P2 Package 2: retained identity for production quantity edit (A/B/C).
-- Empty table. No historical backfill. No InventoryMovement rows.
-- Scalar IDs only: no foreign keys and no cascade-delete of edit history.
-- One explicit PostgreSQL transaction: Prisma 6 classic migration.sql
-- is not wrapped automatically.

BEGIN;

CREATE TABLE "ProductionOperationQuantityEdit" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "actorDisplaySnapshot" TEXT NOT NULL,
    "operationType" "OperationType" NOT NULL,
    "targetLineId" TEXT,
    "expectedOldQuantity" INTEGER NOT NULL,
    "newQuantity" INTEGER NOT NULL,
    "expectedStateFingerprint" TEXT NOT NULL,
    "requestSnapshot" JSONB NOT NULL,
    "effectSnapshot" JSONB NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionOperationQuantityEdit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductionOperationQuantityEdit_requestId_key"
  ON "ProductionOperationQuantityEdit"("requestId");

CREATE INDEX "ProductionOperationQuantityEdit_operationId_recordedAt_idx"
  ON "ProductionOperationQuantityEdit"("operationId", "recordedAt");

ALTER TABLE "ProductionOperationQuantityEdit"
  ADD CONSTRAINT "ProductionOperationQuantityEdit_requestId_nonblank"
  CHECK (char_length(btrim("requestId")) BETWEEN 1 AND 128);

ALTER TABLE "ProductionOperationQuantityEdit"
  ADD CONSTRAINT "ProductionOperationQuantityEdit_actor_nonblank"
  CHECK (btrim("actorDisplaySnapshot") <> '');

ALTER TABLE "ProductionOperationQuantityEdit"
  ADD CONSTRAINT "ProductionOperationQuantityEdit_fingerprint_nonblank"
  CHECK (btrim("expectedStateFingerprint") <> '');

ALTER TABLE "ProductionOperationQuantityEdit"
  ADD CONSTRAINT "ProductionOperationQuantityEdit_expectedOld_positive"
  CHECK ("expectedOldQuantity" > 0);

ALTER TABLE "ProductionOperationQuantityEdit"
  ADD CONSTRAINT "ProductionOperationQuantityEdit_new_positive"
  CHECK ("newQuantity" > 0);

ALTER TABLE "ProductionOperationQuantityEdit"
  ADD CONSTRAINT "ProductionOperationQuantityEdit_physical_type"
  CHECK ("operationType" IN ('TORCOVKA', 'PRISADKA', 'UPAKOVKA'));

ALTER TABLE "ProductionOperationQuantityEdit"
  ADD CONSTRAINT "ProductionOperationQuantityEdit_target_by_type"
  CHECK (
    ("operationType" = 'UPAKOVKA' AND "targetLineId" IS NULL)
    OR
    ("operationType" IN ('TORCOVKA', 'PRISADKA') AND "targetLineId" IS NOT NULL)
  );

COMMIT;
