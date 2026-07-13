-- Идемпотентность терминала (A21): уникальный ключ попытки с клиента.
-- AlterTable
ALTER TABLE "ProductionOperation" ADD COLUMN     "clientRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ProductionOperation_clientRequestId_key" ON "ProductionOperation"("clientRequestId");
