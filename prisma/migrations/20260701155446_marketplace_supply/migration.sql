-- AlterTable
ALTER TABLE "MpStock" ADD COLUMN     "inWay" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reserved" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Sale" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "isReturn" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Supply" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "number" TEXT,
    "sku" TEXT NOT NULL,
    "productId" TEXT,
    "quantity" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "warehouseName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Supply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Supply_createdAt_idx" ON "Supply"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Supply_marketplace_externalId_sku_key" ON "Supply"("marketplace", "externalId", "sku");

-- CreateIndex
CREATE UNIQUE INDEX "Sale_marketplace_externalId_key" ON "Sale"("marketplace", "externalId");
