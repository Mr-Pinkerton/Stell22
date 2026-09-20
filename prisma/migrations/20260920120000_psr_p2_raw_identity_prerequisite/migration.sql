-- PSR-P2: retained identities for createBatch / writeOffBatchRemainder /
-- createSimplePurchase. Empty tables. No historical backfill.
-- No InventoryMovement rows. Scalar IDs only: no foreign keys, no cascade.
-- One explicit PostgreSQL transaction: Prisma 6 classic migration.sql
-- is not wrapped automatically.

BEGIN;

CREATE TABLE "BatchCreationCommand" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "requestSnapshot" JSONB NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchCreationCommand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BatchCreationCommand_requestId_key"
  ON "BatchCreationCommand"("requestId");

CREATE UNIQUE INDEX "BatchCreationCommand_batchId_key"
  ON "BatchCreationCommand"("batchId");

ALTER TABLE "BatchCreationCommand"
  ADD CONSTRAINT "BatchCreationCommand_requestId_nonblank"
  CHECK (char_length(btrim("requestId")) BETWEEN 1 AND 128);

ALTER TABLE "BatchCreationCommand"
  ADD CONSTRAINT "BatchCreationCommand_adminUserId_nonblank"
  CHECK (btrim("adminUserId") <> '');

ALTER TABLE "BatchCreationCommand"
  ADD CONSTRAINT "BatchCreationCommand_batchId_nonblank"
  CHECK (btrim("batchId") <> '');

CREATE TABLE "BatchRemainderWriteOff" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "totalQuantity" INTEGER NOT NULL,
    "effectSnapshot" JSONB NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchRemainderWriteOff_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BatchRemainderWriteOff_requestId_key"
  ON "BatchRemainderWriteOff"("requestId");

CREATE INDEX "BatchRemainderWriteOff_batchId_recordedAt_idx"
  ON "BatchRemainderWriteOff"("batchId", "recordedAt");

ALTER TABLE "BatchRemainderWriteOff"
  ADD CONSTRAINT "BatchRemainderWriteOff_requestId_nonblank"
  CHECK (char_length(btrim("requestId")) BETWEEN 1 AND 128);

ALTER TABLE "BatchRemainderWriteOff"
  ADD CONSTRAINT "BatchRemainderWriteOff_adminUserId_nonblank"
  CHECK (btrim("adminUserId") <> '');

ALTER TABLE "BatchRemainderWriteOff"
  ADD CONSTRAINT "BatchRemainderWriteOff_batchId_nonblank"
  CHECK (btrim("batchId") <> '');

ALTER TABLE "BatchRemainderWriteOff"
  ADD CONSTRAINT "BatchRemainderWriteOff_totalQuantity_positive"
  CHECK ("totalQuantity" > 0);

CREATE TABLE "SimplePurchaseCreationCommand" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "simplePurchaseId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "requestSnapshot" JSONB NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimplePurchaseCreationCommand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SimplePurchaseCreationCommand_requestId_key"
  ON "SimplePurchaseCreationCommand"("requestId");

CREATE UNIQUE INDEX "SimplePurchaseCreationCommand_simplePurchaseId_key"
  ON "SimplePurchaseCreationCommand"("simplePurchaseId");

ALTER TABLE "SimplePurchaseCreationCommand"
  ADD CONSTRAINT "SimplePurchaseCreationCommand_requestId_nonblank"
  CHECK (char_length(btrim("requestId")) BETWEEN 1 AND 128);

ALTER TABLE "SimplePurchaseCreationCommand"
  ADD CONSTRAINT "SimplePurchaseCreationCommand_adminUserId_nonblank"
  CHECK (btrim("adminUserId") <> '');

ALTER TABLE "SimplePurchaseCreationCommand"
  ADD CONSTRAINT "SimplePurchaseCreationCommand_simplePurchaseId_nonblank"
  CHECK (btrim("simplePurchaseId") <> '');

COMMIT;
