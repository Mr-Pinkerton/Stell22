-- Номер детали больше НЕ уникален: это свободная человекочитаемая метка.
-- Сопоставление во всём потоке (торцовка/присадка/упаковка/склад/себестоимость)
-- идёт по detailId, номер нигде не участвует в поиске. Снимаем уникальный
-- индекс (материал, номер, сорт) и оставляем обычный (материал, номер) под поиск.
DROP INDEX "Detail_materialId_detailNumber_sort_key";

CREATE INDEX "Detail_materialId_detailNumber_idx" ON "Detail"("materialId", "detailNumber");
