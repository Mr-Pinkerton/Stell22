-- AlterTable
ALTER TABLE "CashFlow" ADD COLUMN     "importKey" TEXT;

-- CreateIndex
CREATE INDEX "CashFlow_accountId_importKey_idx" ON "CashFlow"("accountId", "importKey");
