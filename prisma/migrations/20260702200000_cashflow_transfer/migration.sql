-- AlterTable
ALTER TABLE "CashFlow" ADD COLUMN     "isTransfer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transferId" TEXT;

-- CreateIndex
CREATE INDEX "CashFlow_transferId_idx" ON "CashFlow"("transferId");
