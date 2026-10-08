-- PSR-P2-INC-001C: durable identity for one upakovka recovery per
-- recorded request and product. Empty table. No backfill.
-- Does not alter ProductionOperation. Scalar IDs only: no foreign keys.
-- One explicit PostgreSQL transaction: Prisma 6 classic migration.sql
-- is not wrapped automatically.

BEGIN;

CREATE TABLE "UpakovkaRecoveryReceipt" (
    "id" TEXT NOT NULL,
    "recordedRequestId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "recoveryRequestId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpakovkaRecoveryReceipt_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UpakovkaRecoveryReceipt_recordedRequestId_productId_key"
  ON "UpakovkaRecoveryReceipt"("recordedRequestId", "productId");

CREATE UNIQUE INDEX "UpakovkaRecoveryReceipt_operationId_key"
  ON "UpakovkaRecoveryReceipt"("operationId");

CREATE INDEX "UpakovkaRecoveryReceipt_recoveryRequestId_idx"
  ON "UpakovkaRecoveryReceipt"("recoveryRequestId");

ALTER TABLE "UpakovkaRecoveryReceipt"
  ADD CONSTRAINT "UpakovkaRecoveryReceipt_recorded_request_len"
  CHECK (char_length(btrim("recordedRequestId")) BETWEEN 1 AND 128);

ALTER TABLE "UpakovkaRecoveryReceipt"
  ADD CONSTRAINT "UpakovkaRecoveryReceipt_recovery_request_len"
  CHECK (char_length(btrim("recoveryRequestId")) BETWEEN 1 AND 128);

ALTER TABLE "UpakovkaRecoveryReceipt"
  ADD CONSTRAINT "UpakovkaRecoveryReceipt_requests_differ"
  CHECK ("recordedRequestId" <> "recoveryRequestId");

ALTER TABLE "UpakovkaRecoveryReceipt"
  ADD CONSTRAINT "UpakovkaRecoveryReceipt_product_nonblank"
  CHECK (btrim("productId") <> '');

ALTER TABLE "UpakovkaRecoveryReceipt"
  ADD CONSTRAINT "UpakovkaRecoveryReceipt_operation_nonblank"
  CHECK (btrim("operationId") <> '');

ALTER TABLE "UpakovkaRecoveryReceipt"
  ADD CONSTRAINT "UpakovkaRecoveryReceipt_employee_nonblank"
  CHECK (btrim("employeeId") <> '');

ALTER TABLE "UpakovkaRecoveryReceipt"
  ADD CONSTRAINT "UpakovkaRecoveryReceipt_quantity_positive"
  CHECK ("quantity" > 0);

COMMIT;
