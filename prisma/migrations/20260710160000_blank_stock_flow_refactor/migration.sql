-- Поток «заготовки»: торцовка производит заготовку (по длине/типу/сорту),
-- конкретная деталь определяется на присадке. Номер детали переносится
-- в состав изделия (ProductDetail), у одной детали может быть несколько номеров.

-- Detail: номер детали больше не свойство детали
ALTER TABLE "Detail" DROP COLUMN "detailNumber";

-- ProductDetail: номер детали (мультистроки-номера) + новый уникальный ключ
DROP INDEX "ProductDetail_productId_detailId_key";
ALTER TABLE "ProductDetail" ADD COLUMN "detailNumber" INTEGER NOT NULL;
CREATE UNIQUE INDEX "ProductDetail_productId_detailId_detailNumber_key" ON "ProductDetail"("productId", "detailId", "detailNumber");

-- OperationDetailLine: заготовки торцовки + провенанс заготовки для присадки
ALTER TABLE "OperationDetailLine" ALTER COLUMN "detailId" DROP NOT NULL;
ALTER TABLE "OperationDetailLine" ADD COLUMN "blankLengthM" DECIMAL(12,4);
ALTER TABLE "OperationDetailLine" ADD COLUMN "blankType" "RailType";
ALTER TABLE "OperationDetailLine" ADD COLUMN "blankSort" "Sort";
ALTER TABLE "OperationDetailLine" ADD COLUMN "sourceIsBlank" BOOLEAN NOT NULL DEFAULT false;

-- BlankStock: склад заготовок (нарезанные рейки до присадки)
CREATE TABLE "BlankStock" (
    "id" TEXT NOT NULL,
    "lengthM" DECIMAL(12,4) NOT NULL,
    "detailType" "RailType" NOT NULL,
    "sort" "Sort" NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BlankStock_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "BlankStock_lengthM_detailType_sort_key" ON "BlankStock"("lengthM", "detailType", "sort");
