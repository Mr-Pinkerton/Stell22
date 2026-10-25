-- Admin corrections: package edit identity and retained operation annulment.
-- Does not delete ProductionOperation, InventoryMovement, or finance history.

ALTER TABLE "ProductionOperation" ADD COLUMN "cancelledAt" TIMESTAMP(3);

CREATE INDEX "ProductionOperation_cancelledAt_idx" ON "ProductionOperation"("cancelledAt");

CREATE TABLE "BatchPackageEditCommand" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestSnapshot" JSONB NOT NULL,
    "effectSnapshot" JSONB NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchPackageEditCommand_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BatchPackageEditCommand_requestId_key" ON "BatchPackageEditCommand"("requestId");
CREATE INDEX "BatchPackageEditCommand_batchId_recordedAt_idx" ON "BatchPackageEditCommand"("batchId", "recordedAt");

CREATE TABLE "ProductionOperationCancellation" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "operationType" "OperationType" NOT NULL,
    "reason" TEXT NOT NULL,
    "expectedStateFingerprint" TEXT NOT NULL,
    "effectSnapshot" JSONB NOT NULL,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductionOperationCancellation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProductionOperationCancellation_requestId_key" ON "ProductionOperationCancellation"("requestId");
CREATE UNIQUE INDEX "ProductionOperationCancellation_operationId_key" ON "ProductionOperationCancellation"("operationId");
CREATE INDEX "ProductionOperationCancellation_operationId_recordedAt_idx" ON "ProductionOperationCancellation"("operationId", "recordedAt");
