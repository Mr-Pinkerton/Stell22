-- PSR-P2 R-05: retained identity for correctTorcovkaRailsTaken.
-- Empty table. No historical backfill. No InventoryMovement rows.
-- Scalar IDs only: no foreign keys and no cascade-delete of correction history.
-- One explicit PostgreSQL transaction: Prisma 6 classic migration.sql
-- is not wrapped automatically.

BEGIN;

CREATE TABLE "ProductionOperationCorrection" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "railLotId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "expectedOldRailsTaken" INTEGER NOT NULL,
    "newRailsTaken" INTEGER NOT NULL,
    "deltaReturned" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionOperationCorrection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductionOperationCorrection_requestId_key"
  ON "ProductionOperationCorrection"("requestId");

CREATE INDEX "ProductionOperationCorrection_operationId_recordedAt_idx"
  ON "ProductionOperationCorrection"("operationId", "recordedAt");

ALTER TABLE "ProductionOperationCorrection"
  ADD CONSTRAINT "ProductionOperationCorrection_requestId_nonblank"
  CHECK (char_length(btrim("requestId")) BETWEEN 1 AND 128);

ALTER TABLE "ProductionOperationCorrection"
  ADD CONSTRAINT "ProductionOperationCorrection_expectedOld_positive"
  CHECK ("expectedOldRailsTaken" > 0);

ALTER TABLE "ProductionOperationCorrection"
  ADD CONSTRAINT "ProductionOperationCorrection_new_positive"
  CHECK ("newRailsTaken" > 0);

ALTER TABLE "ProductionOperationCorrection"
  ADD CONSTRAINT "ProductionOperationCorrection_expected_gt_new"
  CHECK ("expectedOldRailsTaken" > "newRailsTaken");

ALTER TABLE "ProductionOperationCorrection"
  ADD CONSTRAINT "ProductionOperationCorrection_delta_positive"
  CHECK ("deltaReturned" > 0);

ALTER TABLE "ProductionOperationCorrection"
  ADD CONSTRAINT "ProductionOperationCorrection_delta_identity"
  CHECK ("deltaReturned" = "expectedOldRailsTaken" - "newRailsTaken");

ALTER TABLE "ProductionOperationCorrection"
  ADD CONSTRAINT "ProductionOperationCorrection_reason_nonblank"
  CHECK (btrim("reason") <> '');

COMMIT;
