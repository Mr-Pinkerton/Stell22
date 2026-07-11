-- Материал (порода древесины) как справочник.
--
-- Номера деталей уникальны В ПРЕДЕЛАХ материала: один и тот же номер допускается
-- на разных материалах (хвоя/берёза). Заготовки (BlankStock) тоже разделяются по
-- материалу, иначе заготовки разных пород с одной длиной/типом/сортом слились бы.
--
-- Все существующие данные считаются хвоёй: создаём материал «Хвоя» и заполняем
-- им все партии/детали/изделия/заготовки (безопасный backfill, без потери данных).

-- Material
CREATE TABLE "Material" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Material_name_key" ON "Material"("name");

-- Дефолтный материал для backfill существующих данных.
INSERT INTO "Material" ("id", "name", "status", "sortOrder", "createdAt")
VALUES ('mat_default_hvoya', 'Хвоя', 'ACTIVE', 0, CURRENT_TIMESTAMP);

-- Batch.materialId
ALTER TABLE "Batch" ADD COLUMN "materialId" TEXT;
UPDATE "Batch" SET "materialId" = 'mat_default_hvoya' WHERE "materialId" IS NULL;
ALTER TABLE "Batch" ALTER COLUMN "materialId" SET NOT NULL;

-- Detail.materialId + смена уникальности на (материал, номер, сорт).
ALTER TABLE "Detail" ADD COLUMN "materialId" TEXT;
UPDATE "Detail" SET "materialId" = 'mat_default_hvoya' WHERE "materialId" IS NULL;
ALTER TABLE "Detail" ALTER COLUMN "materialId" SET NOT NULL;
DROP INDEX "Detail_detailNumber_sort_key";
CREATE UNIQUE INDEX "Detail_materialId_detailNumber_sort_key" ON "Detail"("materialId", "detailNumber", "sort");

-- Product.materialId
ALTER TABLE "Product" ADD COLUMN "materialId" TEXT;
UPDATE "Product" SET "materialId" = 'mat_default_hvoya' WHERE "materialId" IS NULL;
ALTER TABLE "Product" ALTER COLUMN "materialId" SET NOT NULL;

-- BlankStock.materialId + смена уникальности на (материал, длина, тип, сорт).
ALTER TABLE "BlankStock" ADD COLUMN "materialId" TEXT;
UPDATE "BlankStock" SET "materialId" = 'mat_default_hvoya' WHERE "materialId" IS NULL;
ALTER TABLE "BlankStock" ALTER COLUMN "materialId" SET NOT NULL;
DROP INDEX "BlankStock_lengthM_detailType_sort_key";
CREATE UNIQUE INDEX "BlankStock_materialId_lengthM_detailType_sort_key" ON "BlankStock"("materialId", "lengthM", "detailType", "sort");

-- OperationDetailLine.blankMaterialId — провенанс материала заготовки для точного
-- возврата на склад заготовок при правке/удалении. Заполняем для строк с заготовкой.
ALTER TABLE "OperationDetailLine" ADD COLUMN "blankMaterialId" TEXT;
UPDATE "OperationDetailLine" SET "blankMaterialId" = 'mat_default_hvoya' WHERE "blankLengthM" IS NOT NULL;

-- Внешние ключи
ALTER TABLE "Batch" ADD CONSTRAINT "Batch_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Detail" ADD CONSTRAINT "Detail_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Product" ADD CONSTRAINT "Product_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BlankStock" ADD CONSTRAINT "BlankStock_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
