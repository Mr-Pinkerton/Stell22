-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN');

-- CreateEnum
CREATE TYPE "EmployeeStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RailType" AS ENUM ('POLKA', 'KANAVKA');

-- CreateEnum
CREATE TYPE "Sort" AS ENUM ('SORT1', 'SORT2');

-- CreateEnum
CREATE TYPE "BatchStatus" AS ENUM ('IN_WORK', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "NomenclatureType" AS ENUM ('FASTENER', 'PACKAGING', 'OTHER');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OperationType" AS ENUM ('TORCOVKA', 'PRISADKA', 'UPAKOVKA', 'HOURS');

-- CreateEnum
CREATE TYPE "FlowType" AS ENUM ('INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('OPEN', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "InventoryStatus" AS ENUM ('DRAFT', 'CONDUCTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "GoalStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CostStatus" AS ENUM ('PRELIMINARY', 'FINAL');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'ADMIN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "birthDate" TIMESTAMP(3),
    "pin" TEXT NOT NULL,
    "status" "EmployeeStatus" NOT NULL DEFAULT 'ACTIVE',
    "hourlyRate" DECIMAL(14,2),
    "rateTorcovkaSort1" DECIMAL(14,2),
    "rateTorcovkaSort2" DECIMAL(14,2),
    "ratePrisadkaTorcev" DECIMAL(14,2),
    "ratePrisadkaPloskt" DECIMAL(14,2),
    "rateUpakovka" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Batch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sectionWidthMm" DECIMAL(8,2) NOT NULL,
    "sectionHeightMm" DECIMAL(8,2) NOT NULL,
    "purchaseCost" DECIMAL(14,2) NOT NULL,
    "totalCost" DECIMAL(14,2) NOT NULL,
    "priceSort1" DECIMAL(14,2) NOT NULL,
    "priceSort2" DECIMAL(14,2) NOT NULL,
    "status" "BatchStatus" NOT NULL DEFAULT 'IN_WORK',
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "customFields" JSONB,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RailLot" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "lengthM" DECIMAL(12,4) NOT NULL,
    "railType" "RailType" NOT NULL,
    "sort" "Sort" NOT NULL,
    "isPackage" BOOLEAN NOT NULL DEFAULT true,
    "code" TEXT,
    "rows" INTEGER,
    "layers" INTEGER,
    "quantity" INTEGER NOT NULL,
    "remainingQuantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RailLot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimplePurchase" (
    "id" TEXT NOT NULL,
    "nomenclatureId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "purchaseDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SimplePurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NomenclatureItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "NomenclatureType" NOT NULL,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "minStock" INTEGER,

    CONSTRAINT "NomenclatureItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Detail" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lengthM" DECIMAL(12,4) NOT NULL,
    "detailType" "RailType" NOT NULL,
    "sort" "Sort" NOT NULL,
    "prisadkaTorcevaya" BOOLEAN NOT NULL DEFAULT false,
    "prisadkaPloskost" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "minStock" INTEGER,

    CONSTRAINT "Detail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "sort" "Sort" NOT NULL,
    "salePrice" DECIMAL(14,2) NOT NULL,
    "packagingId" TEXT,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "minStock" INTEGER,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductDetail" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "detailId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ProductDetail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductFastener" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "nomenclatureId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "ProductFastener_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductExtra" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "nomenclatureId" TEXT NOT NULL,

    CONSTRAINT "ProductExtra_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductionOperation" (
    "id" TEXT NOT NULL,
    "type" "OperationType" NOT NULL,
    "employeeId" TEXT NOT NULL,
    "workDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "batchId" TEXT,
    "railLotId" TEXT,
    "railsTaken" INTEGER,
    "hours" DECIMAL(8,2),
    "productId" TEXT,
    "productQty" INTEGER,
    "isPaid" BOOLEAN NOT NULL DEFAULT false,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "ProductionOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationDetailLine" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "detailId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "prisadkaTorcevaya" BOOLEAN NOT NULL DEFAULT false,
    "prisadkaPloskost" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OperationDetailLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChangeLog" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "userId" TEXT,
    "oldValues" JSONB,
    "newValues" JSONB,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetailStock" (
    "id" TEXT NOT NULL,
    "detailId" TEXT NOT NULL,
    "torcevayaDone" BOOLEAN NOT NULL DEFAULT false,
    "ploskostDone" BOOLEAN NOT NULL DEFAULT false,
    "quantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DetailStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductStock" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MpStock" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MpStock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventory" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "status" "InventoryStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Inventory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLine" (
    "id" TEXT NOT NULL,
    "inventoryId" TEXT NOT NULL,
    "refType" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "accountedQty" INTEGER NOT NULL,
    "actualQty" INTEGER NOT NULL,
    "deviation" INTEGER NOT NULL,
    "deviationSum" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "InventoryLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "balance" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArticleCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isOverhead" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ArticleCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "flowType" "FlowType" NOT NULL,
    "categoryId" TEXT NOT NULL,
    "parentId" TEXT,
    "description" TEXT,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Counterparty" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "Counterparty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'OPEN',
    "total" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealItem" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "batchId" TEXT,

    CONSTRAINT "DealItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Statement" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT,
    "fileUrl" TEXT,
    "uploadedAt" TIMESTAMP(3),

    CONSTRAINT "Statement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashFlow" (
    "id" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "flowType" "FlowType" NOT NULL,
    "accountId" TEXT NOT NULL,
    "counterpartyId" TEXT,
    "description" TEXT,
    "articleId" TEXT,
    "dealId" TEXT,
    "statementId" TEXT,
    "date" TIMESTAMP(3) NOT NULL,
    "isAutoAssigned" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CashFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutoRule" (
    "id" TEXT NOT NULL,
    "flowType" "FlowType" NOT NULL,
    "counterpartyId" TEXT,
    "articleId" TEXT,
    "dealId" TEXT,

    CONSTRAINT "AutoRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentBatchItem" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,

    CONSTRAINT "PaymentBatchItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Goal" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "month" TIMESTAMP(3) NOT NULL,
    "status" "GoalStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BatchCost" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "status" "CostStatus" NOT NULL DEFAULT 'PRELIMINARY',
    "volumeSort1" DECIMAL(14,6) NOT NULL,
    "volumeSort2" DECIMAL(14,6) NOT NULL,
    "costSort1" DECIMAL(14,2) NOT NULL,
    "costSort2" DECIMAL(14,2) NOT NULL,
    "pricePerM3Sort1" DECIMAL(14,2) NOT NULL,
    "pricePerM3Sort2" DECIMAL(14,2) NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BatchCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCost" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "status" "CostStatus" NOT NULL DEFAULT 'PRELIMINARY',
    "material" DECIMAL(14,2) NOT NULL,
    "work" DECIMAL(14,2) NOT NULL,
    "fasteners" DECIMAL(14,2) NOT NULL,
    "packaging" DECIMAL(14,2) NOT NULL,
    "extras" DECIMAL(14,2) NOT NULL,
    "direct" DECIMAL(14,2) NOT NULL,
    "overhead" DECIMAL(14,2) NOT NULL,
    "full" DECIMAL(14,2) NOT NULL,
    "calculatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sale" (
    "id" TEXT NOT NULL,
    "marketplace" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "productId" TEXT,
    "quantity" INTEGER NOT NULL,
    "revenue" DECIMAL(14,2) NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "CalendarDay" (
    "date" TIMESTAMP(3) NOT NULL,
    "isWorkingDay" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CalendarDay_pkey" PRIMARY KEY ("date")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "RailLot_code_key" ON "RailLot"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ProductDetail_productId_detailId_key" ON "ProductDetail"("productId", "detailId");

-- CreateIndex
CREATE INDEX "ProductionOperation_workDate_idx" ON "ProductionOperation"("workDate");

-- CreateIndex
CREATE INDEX "ProductionOperation_employeeId_workDate_idx" ON "ProductionOperation"("employeeId", "workDate");

-- CreateIndex
CREATE INDEX "ChangeLog_entity_entityId_idx" ON "ChangeLog"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "DetailStock_detailId_torcevayaDone_ploskostDone_key" ON "DetailStock"("detailId", "torcevayaDone", "ploskostDone");

-- CreateIndex
CREATE UNIQUE INDEX "ProductStock_productId_key" ON "ProductStock"("productId");

-- CreateIndex
CREATE INDEX "CashFlow_date_idx" ON "CashFlow"("date");

-- CreateIndex
CREATE INDEX "BatchCost_batchId_idx" ON "BatchCost"("batchId");

-- CreateIndex
CREATE INDEX "ProductCost_productId_periodStart_periodEnd_idx" ON "ProductCost"("productId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "Sale_date_idx" ON "Sale"("date");

-- AddForeignKey
ALTER TABLE "RailLot" ADD CONSTRAINT "RailLot_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimplePurchase" ADD CONSTRAINT "SimplePurchase_nomenclatureId_fkey" FOREIGN KEY ("nomenclatureId") REFERENCES "NomenclatureItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_packagingId_fkey" FOREIGN KEY ("packagingId") REFERENCES "NomenclatureItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductDetail" ADD CONSTRAINT "ProductDetail_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductDetail" ADD CONSTRAINT "ProductDetail_detailId_fkey" FOREIGN KEY ("detailId") REFERENCES "Detail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductFastener" ADD CONSTRAINT "ProductFastener_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductFastener" ADD CONSTRAINT "ProductFastener_nomenclatureId_fkey" FOREIGN KEY ("nomenclatureId") REFERENCES "NomenclatureItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductExtra" ADD CONSTRAINT "ProductExtra_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductExtra" ADD CONSTRAINT "ProductExtra_nomenclatureId_fkey" FOREIGN KEY ("nomenclatureId") REFERENCES "NomenclatureItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOperation" ADD CONSTRAINT "ProductionOperation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOperation" ADD CONSTRAINT "ProductionOperation_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductionOperation" ADD CONSTRAINT "ProductionOperation_railLotId_fkey" FOREIGN KEY ("railLotId") REFERENCES "RailLot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationDetailLine" ADD CONSTRAINT "OperationDetailLine_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "ProductionOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChangeLog" ADD CONSTRAINT "ChangeLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DetailStock" ADD CONSTRAINT "DetailStock_detailId_fkey" FOREIGN KEY ("detailId") REFERENCES "Detail"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductStock" ADD CONSTRAINT "ProductStock_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLine" ADD CONSTRAINT "InventoryLine_inventoryId_fkey" FOREIGN KEY ("inventoryId") REFERENCES "Inventory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ArticleCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealItem" ADD CONSTRAINT "DealItem_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DealItem" ADD CONSTRAINT "DealItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Statement" ADD CONSTRAINT "Statement_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashFlow" ADD CONSTRAINT "CashFlow_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashFlow" ADD CONSTRAINT "CashFlow_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashFlow" ADD CONSTRAINT "CashFlow_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashFlow" ADD CONSTRAINT "CashFlow_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashFlow" ADD CONSTRAINT "CashFlow_statementId_fkey" FOREIGN KEY ("statementId") REFERENCES "Statement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoRule" ADD CONSTRAINT "AutoRule_counterpartyId_fkey" FOREIGN KEY ("counterpartyId") REFERENCES "Counterparty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutoRule" ADD CONSTRAINT "AutoRule_articleId_fkey" FOREIGN KEY ("articleId") REFERENCES "Article"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentBatchItem" ADD CONSTRAINT "PaymentBatchItem_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentBatchItem" ADD CONSTRAINT "PaymentBatchItem_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "ProductionOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Goal" ADD CONSTRAINT "Goal_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BatchCost" ADD CONSTRAINT "BatchCost_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCost" ADD CONSTRAINT "ProductCost_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
