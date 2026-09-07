-- Package 1 cost-flow foundation. ADDITIVE ONLY.
-- COST FLOW NOT ACTIVE: monetary columns nullable; costVersion default 0 = uninitialized.
-- Do not treat NULL/0 as factual cost. No DROP / rename / data backfill / seed.

-- CreateEnum
CREATE TYPE "CostEventType" AS ENUM ('BOOTSTRAP', 'BOOTSTRAP_RAW_TRANSFER', 'RAW_WRITEOFF', 'PURCHASE_VARIANCE', 'TORCOVKA_ZERO_OUTPUT', 'INVENTORY_LOSS', 'INVENTORY_GAIN', 'MANUAL_ADJUSTMENT');

-- AlterTable
ALTER TABLE "BlankStock" ADD COLUMN     "costVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "laborValue" DECIMAL(18,6),
ADD COLUMN     "materialValue" DECIMAL(18,6),
ADD COLUMN     "totalValue" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "DetailStock" ADD COLUMN     "costVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "laborValue" DECIMAL(18,6),
ADD COLUMN     "materialValue" DECIMAL(18,6),
ADD COLUMN     "totalValue" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "NomenclatureStock" ADD COLUMN     "costVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "nomenclatureValue" DECIMAL(18,6),
ADD COLUMN     "totalValue" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "OperationDetailLine" ADD COLUMN     "inputLaborValue" DECIMAL(18,6),
ADD COLUMN     "inputMaterialValue" DECIMAL(18,6),
ADD COLUMN     "outputCostVersion" INTEGER,
ADD COLUMN     "pieceLaborCost" DECIMAL(18,6),
ADD COLUMN     "receiptLaborValue" DECIMAL(18,6),
ADD COLUMN     "receiptMaterialValue" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "OperationNomenclatureLine" ADD COLUMN     "consumedNomenclatureValue" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "ProductCost" ADD COLUMN     "costPeriodId" TEXT,
ADD COLUMN     "directTotal" DECIMAL(18,6),
ADD COLUMN     "fullTotal" DECIMAL(18,6),
ADD COLUMN     "hourlyProductionLabor" DECIMAL(18,6),
ADD COLUMN     "nomenclature" DECIMAL(18,6),
ADD COLUMN     "pieceLabor" DECIMAL(18,6),
ADD COLUMN     "producedQty" INTEGER,
ADD COLUMN     "productionOverhead" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "ProductStock" ADD COLUMN     "costVersion" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "laborValue" DECIMAL(18,6),
ADD COLUMN     "materialValue" DECIMAL(18,6),
ADD COLUMN     "nomenclatureValue" DECIMAL(18,6),
ADD COLUMN     "totalValue" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "ProductionOperation" ADD COLUMN     "consumedRawValue" DECIMAL(18,6),
ADD COLUMN     "outputCostVersion" INTEGER,
ADD COLUMN     "pieceLaborCost" DECIMAL(18,6),
ADD COLUMN     "receiptLaborValue" DECIMAL(18,6),
ADD COLUMN     "receiptMaterialValue" DECIMAL(18,6),
ADD COLUMN     "receiptNomenclatureValue" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "RailLot" ADD COLUMN     "initialValue" DECIMAL(18,6),
ADD COLUMN     "remainingValue" DECIMAL(18,6);

-- CreateTable
CREATE TABLE "CostPeriod" (
    "id" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "CostStatus" NOT NULL DEFAULT 'PRELIMINARY',
    "hourlyProductionLaborPool" DECIMAL(18,6) NOT NULL,
    "productionOverheadPool" DECIMAL(18,6) NOT NULL,
    "unallocatedHourlyProductionLabor" DECIMAL(18,6) NOT NULL,
    "unallocatedProductionOverhead" DECIMAL(18,6) NOT NULL,
    "calculatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostEvent" (
    "id" TEXT NOT NULL,
    "type" "CostEventType" NOT NULL,
    "materialValue" DECIMAL(18,6) NOT NULL,
    "laborValue" DECIMAL(18,6) NOT NULL,
    "nomenclatureValue" DECIMAL(18,6) NOT NULL,
    "totalValue" DECIMAL(18,6) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "batchId" TEXT,
    "operationId" TEXT,
    "inventoryId" TEXT,
    "inventoryLineId" TEXT,
    "stockKind" TEXT,
    "stockId" TEXT,

    CONSTRAINT "CostEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CostPeriod_periodStart_key" ON "CostPeriod"("periodStart");

-- CreateIndex
CREATE INDEX "CostEvent_type_createdAt_idx" ON "CostEvent"("type", "createdAt");

-- CreateIndex
CREATE INDEX "CostEvent_batchId_idx" ON "CostEvent"("batchId");

-- CreateIndex
CREATE INDEX "CostEvent_operationId_idx" ON "CostEvent"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCost_costPeriodId_productId_key" ON "ProductCost"("costPeriodId", "productId");

-- AddForeignKey
ALTER TABLE "ProductCost" ADD CONSTRAINT "ProductCost_costPeriodId_fkey" FOREIGN KEY ("costPeriodId") REFERENCES "CostPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEvent" ADD CONSTRAINT "CostEvent_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEvent" ADD CONSTRAINT "CostEvent_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "ProductionOperation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEvent" ADD CONSTRAINT "CostEvent_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "Inventory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEvent" ADD CONSTRAINT "CostEvent_inventoryLineId_fkey" FOREIGN KEY ("inventoryLineId") REFERENCES "InventoryLine"("id") ON DELETE SET NULL ON UPDATE CASCADE;
