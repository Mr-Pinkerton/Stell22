-- Номер — уникальный идентификатор детали (длина + присадки). Возвращаем номер
-- в справочник деталей и убираем его из состава изделия: в ProductDetail снова
-- просто ссылка на конкретную деталь (номер у неё уже есть).

-- ProductDetail: убрать номер, вернуть уникальность (изделие, деталь)
DROP INDEX "ProductDetail_productId_detailId_detailNumber_key";
ALTER TABLE "ProductDetail" DROP COLUMN "detailNumber";
CREATE UNIQUE INDEX "ProductDetail_productId_detailId_key" ON "ProductDetail"("productId", "detailId");

-- Detail: вернуть номер. Сорт в номер НЕ входит — одна деталь в 1 и 2 сорте имеет
-- один номер (две записи, общий номер). Уникальность — по паре (номер, сорт).
-- Таблица пустая на dev (после reset), поэтому добавляем NOT NULL сразу; на непустой
-- БД потребуется отдельная разноска номеров.
ALTER TABLE "Detail" ADD COLUMN "detailNumber" INTEGER NOT NULL;
CREATE UNIQUE INDEX "Detail_detailNumber_sort_key" ON "Detail"("detailNumber", "sort");
