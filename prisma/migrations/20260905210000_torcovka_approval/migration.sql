-- EXTREME TORCOVKA admin 4-digit approval. No backfill. No drop.

CREATE TABLE "TorcovkaApproval" (
    "id" TEXT NOT NULL,
    "clientRequestId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "employeeId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "railLotId" TEXT NOT NULL,
    "railsTaken" INTEGER NOT NULL,
    "takenM" TEXT NOT NULL,
    "producedM" TEXT NOT NULL,
    "wasteM" TEXT NOT NULL,
    "wastePct" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "notificationKey" TEXT NOT NULL,

    CONSTRAINT "TorcovkaApproval_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TorcovkaApproval_clientRequestId_key" ON "TorcovkaApproval"("clientRequestId");

CREATE INDEX "TorcovkaApproval_expiresAt_idx" ON "TorcovkaApproval"("expiresAt");
