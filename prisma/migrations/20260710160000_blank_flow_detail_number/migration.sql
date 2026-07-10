-- Поток «заготовки» + номер детали в справочнике.
--
-- Идёт напрямую от текущего боевого состояния (Detail.detailNumber уже добавлен
-- как nullable в 20260707140000_detail_number, номера проставлены вручную) к целевой
-- модели. Историческую разноску номеров НЕ делаем: номер задаёт деталь по
-- (длина + присадки), сорт в номер НЕ входит — одна деталь в 1 и 2 сорте имеет общий
-- номер, поэтому уникальность по паре (detailNumber, sort).

-- Detail: номер обязателен, уникальность по (номер, сорт).
-- ВНИМАНИЕ: на проде все detailNumber должны быть заполнены (иначе SET NOT NULL
-- упадёт) и пара (номер, сорт) уникальна (иначе создание индекса упадёт).
ALTER TABLE "Detail" ALTER COLUMN "detailNumber" SET NOT NULL;
CREATE UNIQUE INDEX "Detail_detailNumber_sort_key" ON "Detail"("detailNumber", "sort");

-- OperationDetailLine: торцовка производит заготовку (длина/тип/сорт), конкретная
-- деталь определяется на присадке. detailId становится необязательным, добавляем
-- провенанс заготовки.
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
